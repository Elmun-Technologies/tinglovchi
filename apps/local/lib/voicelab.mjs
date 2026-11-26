// Nutqni matnga aylantirish: VoiceLab (voicelab.uz) STT API — o'zbek, rus, ingliz, spikerlarni ajratish.
// Oqim: POST /v1/stt (audio) → GET /v1/stt/transcriptions/{id} (status "completed" bo'lguncha).
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { SttError } from './stt-error.mjs';

const BASE = (process.env.VOICELAB_BASE_URL || 'https://api.voicelab.uz').replace(/\/$/, '');
const POLL_TIMEOUT_MS = Number(process.env.VOICELAB_POLL_TIMEOUT_MS) || 45 * 60 * 1000;
const POLL_MIN_MS = Number(process.env.VOICELAB_POLL_MS) || 3000;

const MIME = {
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.mp4': 'audio/mp4',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
};

// Sozlamalardagi til kodlari (ElevenLabs uslubi) → VoiceLab (uz/ru/en). «auto» — til yuborilmaydi.
const LANG = { uzb: 'uz', uz: 'uz', rus: 'ru', ru: 'ru', eng: 'en', en: 'en' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function errorFrom(res) {
  const text = await res.text().catch(() => '');
  let code = '';
  let message = text.slice(0, 300);
  try {
    const j = JSON.parse(text);
    code = j.error?.code || '';
    message = j.error?.message || j.message || message;
  } catch {
    // JSON emas — xom matn ishlatiladi
  }
  if (res.status === 401 || res.status === 403)
    return new SttError(
      `VoiceLab kaliti noto'g'ri yoki ruxsat yo'q (${res.status}${code ? ' ' + code : ''}). API kalitda «stt:write» ruxsati yoqilganini tekshiring. ${message}`,
      { retryable: false },
    );
  if (res.status === 402 || code === 'insufficient_credits')
    return new SttError(`VoiceLab balansi yetarli emas (402). Hisobni to'ldiring. ${message}`, {
      retryable: false,
    });
  if (res.status === 400 || res.status === 413 || res.status === 415 || res.status === 422)
    return new SttError(`VoiceLab so'rovni rad etdi (${res.status}): ${message}`, {
      retryable: false,
    });
  return new SttError(`VoiceLab xatosi ${res.status}${code ? ' ' + code : ''}: ${message}`, {
    retryable: res.status === 429 || res.status >= 500,
  });
}

async function call(url, init) {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(15 * 60 * 1000), ...init });
  } catch (err) {
    throw new SttError(`VoiceLab bilan aloqa yo'q: ${err.message}`);
  }
}

async function upload(bytes, { apiKey, language, name, mime }) {
  const form = new FormData();
  form.append('audio', new Blob([bytes], { type: mime || 'application/octet-stream' }), name);
  const lang = LANG[language];
  if (lang) form.append('language', lang);
  form.append('include_speakers', 'true');
  const res = await call(`${BASE}/v1/stt`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Idempotency-Key': crypto.randomUUID() },
    body: form,
  });
  if (![200, 201, 202].includes(res.status)) throw await errorFrom(res);
  return res.json();
}

async function waitFor(job, apiKey) {
  let cur = job;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let wait = POLL_MIN_MS;
  while (cur.status !== 'completed') {
    if (cur.status === 'failed')
      throw new SttError(
        `VoiceLab transkripsiyani bajara olmadi: ${cur.error?.message || cur.error?.code || 'noma’lum xato'}`,
      );
    if (Date.now() > deadline)
      throw new SttError(
        'VoiceLab javobi juda kech keldi (45 daqiqa) — keyinroq qayta urinib ko‘ring.',
      );
    if (!cur.id) throw new SttError('VoiceLab javobida ish ID si yo‘q', { retryable: false });
    await sleep(wait);
    wait = Math.min(wait * 1.4, 15000);
    const res = await call(`${BASE}/v1/stt/transcriptions/${encodeURIComponent(cur.id)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw await errorFrom(res);
    cur = await res.json();
  }
  return cur;
}

/** VoiceLab natijasini ElevenLabs bilan bir xil shaklga keltiradi: {language, words:[{text,start,end,speaker}]} (soniyada). */
export function normalizeVoicelab(data) {
  const speakerIds = [];
  const speakerNo = (id) => {
    if (id == null || id === '') return 'speaker_0';
    let i = speakerIds.indexOf(id);
    if (i < 0) i = speakerIds.push(id) - 1;
    return `speaker_${i}`;
  };
  for (const s of data.speakers || []) speakerNo(s.id); // tartib barqaror bo'lishi uchun
  const words = [];
  for (const seg of data.segments || []) {
    const speaker = speakerNo(seg.speaker);
    const sStart = (Number(seg.start_ms) || 0) / 1000;
    const sEnd = Math.max(sStart, (Number(seg.end_ms) || 0) / 1000);
    if (Array.isArray(seg.words) && seg.words.length) {
      for (const w of seg.words) {
        const text = String(w.text || '').trim();
        if (!text) continue;
        const start = (Number(w.start_ms) || 0) / 1000;
        words.push({ text, start, end: Math.max(start, (Number(w.end_ms) || 0) / 1000), speaker });
      }
      continue;
    }
    // So'z vaqtlari yo'q — qism matnini vaqt bo'yicha teng bo'lib chiqamiz.
    const parts = String(seg.text || '')
      .split(/\s+/)
      .filter(Boolean);
    const step = parts.length ? (sEnd - sStart) / parts.length : 0;
    parts.forEach((text, i) =>
      words.push({ text, start: sStart + i * step, end: sStart + (i + 1) * step, speaker }),
    );
  }
  if (!words.length && data.transcript) {
    words.push({ text: String(data.transcript).trim(), start: 0, end: 0, speaker: 'speaker_0' });
  }
  return { language: data.language || null, words };
}

export async function transcribeVoicelab(filePath, { apiKey, language }) {
  if (!apiKey)
    throw new SttError('VoiceLab API kaliti kiritilmagan (Sozlamalar).', { retryable: false });
  const bytes = await fsp.readFile(filePath);
  if (bytes.length < 2000) return { language: null, words: [] };
  const job = await upload(bytes, {
    apiKey,
    language,
    name: path.basename(filePath),
    mime: MIME[path.extname(filePath).toLowerCase()],
  });
  const done = await waitFor(job, apiKey);
  return normalizeVoicelab(done);
}

/** Kalitni haqiqiy yuklash so'rovi bilan tekshiradi (natijani kutmaydi — arzon). */
export async function checkVoicelab(apiKey) {
  if (!apiKey) return { ok: false, message: 'Kalit kiritilmagan' };
  try {
    const wav = Buffer.alloc(44 + 32000);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(36 + 32000, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(32000, 40);
    const job = await upload(wav, { apiKey, language: 'uz', name: 'sinov.wav', mime: 'audio/wav' });
    return { ok: true, message: `Ulandi (VoiceLab${job.id ? ', ish ' + job.id : ''})` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}
