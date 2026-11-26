// Suhbatni qayta ishlash zanjiri: audio bo'laklar → transkript → tahlil → prezentatsiya.
import fsp from 'node:fs/promises';
import { loadMeeting, saveMeeting, meetingFile, readSettings } from './store.mjs';
import { transcribeWith, wordsToUtterances } from './stt.mjs';
import { analyzeTranscript } from './analyze.mjs';
import { renderPresentation, renderMarkdown } from './presentation.mjs';
import { demoWords, DEMO_ANALYSIS } from './demo.mjs';

export const DEMO = process.env.SUHBAT_DEMO === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Transkripsiya navbati (bir vaqtda ko'pi bilan 2 ta bo'lak) ----
const STT_CONCURRENCY = 2;
let sttActive = 0;
const sttWaiters = [];
async function withSttSlot(fn) {
  if (sttActive >= STT_CONCURRENCY) await new Promise((r) => sttWaiters.push(r));
  sttActive++;
  try {
    return await fn();
  } finally {
    sttActive--;
    sttWaiters.shift()?.();
  }
}

const sttInFlight = new Map(); // `${meetingId}:${index}` -> Promise

/** Yopilgan bo'lakni transkripsiya qiladi (natija audio/seg-NNN.json ga yoziladi). Takroriy chaqiruv xavfsiz. */
export function transcribeSegment(meetingId, index) {
  const key = `${meetingId}:${index}`;
  if (sttInFlight.has(key)) return sttInFlight.get(key);
  const p = (async () => {
    const meeting = await loadMeeting(meetingId);
    const seg = meeting.segments.find((s) => s.index === index);
    if (!seg || seg.stt === 'done') return;
    const settings = readSettings();
    seg.stt = 'running';
    seg.sttError = null;
    await saveMeeting(meeting);
    try {
      const result = await withSttSlot(() => runStt(meeting, seg, settings));
      await fsp.writeFile(
        meetingFile(meetingId, `audio/seg-${pad(index)}.json`),
        JSON.stringify(result),
      );
      seg.stt = 'done';
      seg.words = result.words.length;
    } catch (err) {
      seg.stt = 'failed';
      seg.sttError = err.message;
      seg.sttRetryable = err.retryable !== false;
    }
    await saveMeeting(meeting);
  })().finally(() => sttInFlight.delete(key));
  sttInFlight.set(key, p);
  return p;
}

async function runStt(meeting, seg, settings) {
  if (DEMO) {
    await sleep(600);
    return { language: 'uzb', words: demoWords(seg.index) };
  }
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await transcribeWith(settings, meetingFile(meeting.id, `audio/${seg.file}`));
    } catch (err) {
      lastErr = err;
      if (err.retryable === false) break;
      await sleep(3000 * 2 ** attempt);
    }
  }
  throw lastErr;
}

const pad = (n) => String(n).padStart(3, '0');

export function formatClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export async function buildTranscript(meeting) {
  const lines = [];
  const segments = [...meeting.segments].sort((a, b) => a.index - b.index);
  for (const seg of segments) {
    if (seg.stt !== 'done') continue;
    const raw = JSON.parse(
      await fsp.readFile(meetingFile(meeting.id, `audio/seg-${pad(seg.index)}.json`), 'utf8'),
    );
    const utterances = wordsToUtterances(raw.words, {
      offsetSec: (seg.startMs || 0) / 1000,
      segmentNo: seg.index,
    });
    for (const u of utterances) lines.push(`[${formatClock(u.start)}] ${u.speaker}: ${u.text}`);
  }
  return lines.join('\n');
}

const running = new Map(); // meetingId -> Promise

/** Suhbatni oxirigacha qayta ishlaydi. Bajarilgan bosqichlar qayta ishlatiladi. */
export function processMeeting(meetingId) {
  if (running.has(meetingId)) return running.get(meetingId);
  const p = run(meetingId).finally(() => running.delete(meetingId));
  running.set(meetingId, p);
  return p;
}

export const isProcessing = (meetingId) => running.has(meetingId);

/** Qayta ishlash tugaguncha kutadi (ishlamayotgan bo'lsa — darrov qaytadi). */
export const whenIdle = (meetingId) =>
  (running.get(meetingId) || Promise.resolve()).catch(() => {});

async function setStage(meeting, stage, extra = {}) {
  Object.assign(meeting, { stage, ...extra });
  await saveMeeting(meeting);
}

async function run(meetingId) {
  const meeting = await loadMeeting(meetingId);
  try {
    meeting.status = 'processing';
    meeting.error = null;
    await setStage(meeting, 'Transkripsiya boshlanmoqda');

    // Bo'sh (ovoz yozilmagan) bo'laklarni tashlab yuboramiz.
    for (const seg of meeting.segments) {
      if (seg.bytes === undefined) {
        const stat = await fsp.stat(meetingFile(meetingId, `audio/${seg.file}`)).catch(() => null);
        seg.bytes = stat ? stat.size : 0;
      }
    }
    const segments = meeting.segments.filter((s) => (s.bytes || 0) > 0 || DEMO);
    if (!segments.length) throw fatal('Audio yozilmagan — tahlil qiladigan narsa yo‘q.');

    const pending = segments.filter((s) => s.stt !== 'done');
    let done = segments.length - pending.length;
    await setStage(meeting, `Transkripsiya: ${done}/${segments.length} qism`);
    await Promise.all(
      pending.map(async (seg) => {
        await transcribeSegment(meetingId, seg.index);
        done = segments.filter((s) => s.stt === 'done').length;
        await setStage(meeting, `Transkripsiya: ${done}/${segments.length} qism`);
      }),
    );
    const failed = segments.filter((s) => s.stt !== 'done');
    if (failed.length) {
      const first = failed[0];
      throw Object.assign(
        new Error(`Transkripsiya xatosi (${failed.length} qism): ${first.sttError || 'noma’lum'}`),
        {
          retryable: true,
        },
      );
    }

    const transcript = await buildTranscript(meeting);
    await fsp.writeFile(meetingFile(meetingId, 'transcript.txt'), transcript + '\n');
    if (transcript.trim().length < 40) {
      throw fatal(
        'Yozuvda nutq aniqlanmadi (mikrofon o‘chirilgan yoki juda uzoqda bo‘lgan bo‘lishi mumkin).',
      );
    }

    await setStage(meeting, 'Tahlil qilinmoqda');
    const settings = readSettings();
    const analysis = DEMO
      ? (await sleep(1200), structuredClone(DEMO_ANALYSIS))
      : await analyzeTranscript({
          transcriptText: transcript,
          settings,
          meeting,
          onProgress: (msg) => setStage(meeting, msg).catch(() => {}),
        });
    await fsp.writeFile(meetingFile(meetingId, 'analysis.json'), JSON.stringify(analysis, null, 2));

    await setStage(meeting, 'Prezentatsiya tayyorlanmoqda');
    await renderOutputs(meeting, analysis);
    meeting.title = analysis.title || meeting.title;
    meeting.client = analysis.client || '';
    meeting.counts = {
      tasks: (analysis.tasks || []).length,
      p1: (analysis.tasks || []).filter((t) => t.priority === 'P1').length,
      requirements: (analysis.requirements || []).length,
    };
    meeting.status = 'ready';
    await setStage(meeting, null, { readyAt: new Date().toISOString() });
  } catch (err) {
    console.error(`[${meetingId}] xato:`, err);
    meeting.status = 'failed';
    meeting.error = humanError(err);
    await setStage(meeting, null);
  }
}

export async function renderOutputs(meeting, analysis) {
  await fsp.writeFile(
    meetingFile(meeting.id, 'presentation.html'),
    renderPresentation(analysis, meeting),
  );
  await fsp.writeFile(meetingFile(meeting.id, 'xulosa.md'), renderMarkdown(analysis, meeting));
}

function fatal(message) {
  return Object.assign(new Error(message), { retryable: false });
}

function humanError(err) {
  const status = err?.status;
  if (status === 401) return 'Anthropic (Claude) API kaliti noto‘g‘ri. Sozlamalarda tekshiring.';
  if (status === 429)
    return 'Claude limiti to‘ldi yoki balans yetarli emas. Birozdan so‘ng qayta urinib ko‘ring.';
  if (status >= 500)
    return 'Claude serveri vaqtincha javob bermayapti. Birozdan so‘ng qayta urinib ko‘ring.';
  if (
    err?.name === 'APIConnectionError' ||
    /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(String(err?.message))
  ) {
    return 'Internet aloqasi yo‘q yoki uzildi. Audio saqlangan — internet tiklangach «Qayta urinish»ni bosing.';
  }
  return String(err?.message || err);
}
