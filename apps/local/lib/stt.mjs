// Nutqni matnga aylantirish: ElevenLabs Scribe (o'zbek, rus, ingliz va 90+ til, spikerlarni ajratish).
import fsp from 'node:fs/promises';
import path from 'node:path';
import { SttError } from './stt-error.mjs';
import { transcribeVoicelab, checkVoicelab } from './voicelab.mjs';

export { SttError };

const ENDPOINT = `${(process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/$/, '')}/v1/speech-to-text`;
const MODELS = (process.env.ELEVENLABS_STT_MODEL || 'scribe_v1,scribe_v2')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Bir marta ishlagan model keyingi so'rovlarda birinchi bo'lib sinaladi.
let workingModel = null;
const modelOrder = () =>
  workingModel ? [workingModel, ...MODELS.filter((m) => m !== workingModel)] : MODELS;

const MIME = {
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.mp4': 'audio/mp4',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
};

/**
 * Qaysi xizmat ishlatilishini aniqlaydi: sozlamada aniq tanlangan bo'lsa — o'sha;
 * «avto» bo'lsa — VoiceLab kaliti bor bo'lsa VoiceLab, aks holda ElevenLabs.
 * @returns {{provider: 'voicelab'|'elevenlabs', apiKey: string}}
 */
export function sttConfig(settings) {
  const pick = settings.sttProvider;
  const provider =
    pick === 'voicelab' || pick === 'elevenlabs'
      ? pick
      : settings.voicelabApiKey
        ? 'voicelab'
        : 'elevenlabs';
  return {
    provider,
    apiKey: provider === 'voicelab' ? settings.voicelabApiKey : settings.elevenlabsApiKey,
  };
}

export const providerLabel = (provider) => (provider === 'voicelab' ? 'VoiceLab' : 'ElevenLabs');

/** Tanlangan xizmat orqali bitta audio faylni transkripsiya qiladi. */
export function transcribeWith(settings, filePath) {
  const { provider, apiKey } = sttConfig(settings);
  return provider === 'voicelab'
    ? transcribeVoicelab(filePath, { apiKey, language: settings.language })
    : transcribeFile(filePath, { apiKey, language: settings.language });
}

/** Tanlangan xizmat kalitini tekshiradi. */
export function checkStt(settings) {
  const { provider, apiKey } = sttConfig(settings);
  return provider === 'voicelab' ? checkVoicelab(apiKey) : checkElevenlabs(apiKey);
}

/**
 * Bitta audio faylni transkripsiya qiladi.
 * @returns {Promise<{language: string|null, words: Array<{text:string,start:number,end:number,speaker:string}>}>}
 */
export async function transcribeFile(filePath, { apiKey, language }) {
  if (!apiKey)
    throw new SttError('ElevenLabs API kaliti kiritilmagan (Sozlamalar).', { retryable: false });
  const bytes = await fsp.readFile(filePath);
  if (bytes.length < 2000) return { language: null, words: [] };
  const ext = path.extname(filePath).toLowerCase();
  return transcribeBytes(bytes, {
    apiKey,
    language,
    name: path.basename(filePath),
    mime: MIME[ext],
  });
}

async function transcribeBytes(bytes, { apiKey, language, name, mime }) {
  const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });

  let lastError = null;
  for (const model of modelOrder()) {
    const form = new FormData();
    form.append('model_id', model);
    form.append('file', blob, name);
    form.append('diarize', 'true');
    form.append('tag_audio_events', 'false');
    form.append('timestamps_granularity', 'word');
    if (language && language !== 'auto') form.append('language_code', language);

    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey },
        body: form,
        signal: AbortSignal.timeout(15 * 60 * 1000),
      });
    } catch (err) {
      throw new SttError(`ElevenLabs bilan aloqa yo'q: ${err.message}`);
    }
    if (res.ok) {
      const data = await res.json();
      workingModel = model;
      return normalize(data);
    }
    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new SttError(
        `ElevenLabs kaliti noto'g'ri yoki ruxsat yo'q (${res.status}). ${text.slice(0, 300)}`,
        {
          retryable: false,
        },
      );
    }
    // Model nomi eskirgan/yangi bo'lsa, keyingi modelni sinab ko'ramiz.
    if ((res.status === 400 || res.status === 422) && /model/i.test(text)) {
      lastError = new SttError(`ElevenLabs model xatosi (${model}): ${text.slice(0, 300)}`, {
        retryable: false,
      });
      continue;
    }
    throw new SttError(`ElevenLabs xatosi ${res.status}: ${text.slice(0, 400)}`, {
      retryable: res.status === 429 || res.status >= 500,
    });
  }
  throw lastError || new SttError('ElevenLabs: mos model topilmadi', { retryable: false });
}

function normalize(data) {
  const words = [];
  for (const w of data.words || []) {
    if (w.type && w.type !== 'word') continue;
    const text = String(w.text || '').trim();
    if (!text) continue;
    words.push({
      text,
      start: Number(w.start) || 0,
      end: Number(w.end) || Number(w.start) || 0,
      speaker: w.speaker_id ? String(w.speaker_id) : 'speaker_0',
    });
  }
  if (!words.length && data.text) {
    words.push({ text: String(data.text).trim(), start: 0, end: 0, speaker: 'speaker_0' });
  }
  return { language: data.language_code || null, words };
}

/** So'zlarni spiker bo'yicha replikalarga yig'adi. */
export function wordsToUtterances(words, { offsetSec = 0, segmentNo = 1 } = {}) {
  const out = [];
  let cur = null;
  for (const w of words) {
    const gap = cur ? offsetSec + w.start - cur.end : 0;
    if (!cur || cur.raw !== w.speaker || gap > 2.5 || cur.text.length > 600) {
      if (cur) out.push(cur);
      cur = {
        start: offsetSec + w.start,
        end: offsetSec + w.end,
        raw: w.speaker,
        speaker: `Q${segmentNo}/S${Number(String(w.speaker).replace(/\D/g, '') || 0) + 1}`,
        text: w.text,
      };
    } else {
      cur.text += (/^[,.!?;:)»]/.test(w.text) ? '' : ' ') + w.text;
      cur.end = offsetSec + w.end;
    }
  }
  if (cur) out.push(cur);
  return out.map((u) => ({ start: u.start, end: u.end, speaker: u.speaker, text: u.text }));
}

/** 1 soniyalik sinov signali (WAV) — kalit va model ishlashini arzon tekshirish uchun. */
function testWav() {
  const rate = 16000;
  const samples = rate;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    buf.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 3000), 44 + i * 2);
  return buf;
}

/** Kalitni haqiqiy (juda qisqa) transkripsiya so'rovi bilan tekshiradi. */
export async function checkElevenlabs(apiKey) {
  if (!apiKey) return { ok: false, message: 'Kalit kiritilmagan' };
  try {
    await transcribeBytes(testWav(), {
      apiKey,
      language: 'auto',
      name: 'sinov.wav',
      mime: 'audio/wav',
    });
    return { ok: true, message: `Ulandi (model: ${workingModel})` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}
