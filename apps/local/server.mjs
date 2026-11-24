#!/usr/bin/env node
// SUHBAT Lokal — faqat shu kompyuterda ishlaydigan kichik server (127.0.0.1).
// Brauzer mikrofon orqali yozadi, server audio bo'laklarni diskka saqlaydi va tahlil qiladi.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

if (Number(process.versions.node.split('.')[0]) < 20) {
  console.error(
    `Node.js ${process.versions.node} juda eski. https://nodejs.org saytidan LTS versiyasini o'rnating.`,
  );
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.join(HERE, '.env'));
} catch {
  // .env ixtiyoriy
}

const {
  DATA_DIR,
  readSettings,
  saveSettings,
  createMeeting,
  loadMeeting,
  saveMeeting,
  deleteMeeting,
  listMeetings,
  meetingFile,
  isValidMeetingId,
} = await import('./lib/store.mjs');
const { processMeeting, transcribeSegment, isProcessing, whenIdle, DEMO } =
  await import('./lib/pipeline.mjs');
const { renderPresentation } = await import('./lib/presentation.mjs');
const { checkElevenlabs } = await import('./lib/stt.mjs');
const { checkAnthropic } = await import('./lib/analyze.mjs');
const { DEMO_ANALYSIS } = await import('./lib/demo.mjs');

const PORT = Number(process.env.SUHBAT_PORT || 4780);
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(HERE, 'public');
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
const AUDIO_EXT = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};
const UPLOAD_EXT = new Set(['webm', 'ogg', 'm4a', 'mp4', 'mp3', 'wav', 'aac', 'flac', 'opus']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'So‘rov hajmi juda katta');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBody(req, 1024 * 1024);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON noto‘g‘ri');
  }
}

// Faqat shu kompyuterdagi brauzerdan kelgan so'rovlarga ruxsat (DNS-rebinding va begona saytlardan himoya).
function assertLocal(req) {
  const allowedHosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
  if (!allowedHosts.has(String(req.headers.host || '').toLowerCase()))
    throw new HttpError(403, 'Ruxsat yo‘q');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (!origin || !allowedHosts.has(origin.replace(/^http:\/\//, '')))
      throw new HttpError(403, 'Ruxsat yo‘q');
  }
}

function publicMeeting(m) {
  return {
    id: m.id,
    createdAt: m.createdAt,
    status: m.status,
    source: m.source,
    title: m.title,
    client: m.client || '',
    note: m.note || '',
    durationMs: m.durationMs || 0,
    stage: m.stage,
    error: m.error,
    counts: m.counts || null,
    segments: m.segments.length,
    transcribed: m.segments.filter((s) => s.stt === 'done').length,
  };
}

function publicSettings() {
  const s = readSettings();
  return {
    hasAnthropic: Boolean(s.anthropicApiKey) || DEMO,
    hasElevenlabs: Boolean(s.elevenlabsApiKey) || DEMO,
    companyName: s.companyName,
    teamMembers: s.teamMembers,
    language: s.language,
    dataDir: DATA_DIR,
    demo: DEMO,
  };
}

const padSeg = (n) => String(n).padStart(3, '0');
const intParam = (url, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const v = Number(url.searchParams.get(name));
  if (!Number.isInteger(v) || v < min || v > max) throw new HttpError(400, `${name} noto‘g‘ri`);
  return v;
};

// Har bir bo'lak uchun navbatdagi kutilayotgan parcha raqami (takroriy yuborishdan himoya).
const nextSeq = new Map();

async function handleChunk(req, res, url, meeting) {
  if (meeting.status !== 'recording') throw new HttpError(409, 'Suhbat yozilayotgan holatda emas');
  const index = intParam(url, 'seg', { min: 1, max: 9999 });
  const seq = intParam(url, 'seq', { max: 1e6 });
  const startMs = intParam(url, 'startMs', { max: 1e9 });
  const elapsedMs = intParam(url, 't', { max: 1e9 });
  const mime = String(req.headers['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const ext = AUDIO_EXT[mime] || 'webm';
  const body = await readBody(req, MAX_CHUNK_BYTES);

  let seg = meeting.segments.find((s) => s.index === index);
  if (!seg) {
    seg = {
      index,
      file: `seg-${padSeg(index)}.${ext}`,
      startMs,
      durationMs: 0,
      bytes: 0,
      closed: false,
      stt: 'pending',
    };
    meeting.segments.push(seg);
  }
  const key = `${meeting.id}:${index}`;
  const expected = nextSeq.get(key) ?? 0;
  if (seq < expected) return send(res, 200, { ok: true, duplicate: true });
  if (seq > expected)
    throw new HttpError(409, `Parcha tartibi buzildi (kutilgan ${expected}, kelgan ${seq})`);
  if (seg.closed) throw new HttpError(409, 'Bu qism yopilgan');

  await fsp.appendFile(meetingFile(meeting.id, `audio/${seg.file}`), body);
  nextSeq.set(key, expected + 1);
  seg.bytes += body.length;
  seg.durationMs = Math.max(seg.durationMs, elapsedMs - seg.startMs);
  meeting.durationMs = Math.max(meeting.durationMs || 0, elapsedMs);
  await saveMeeting(meeting);
  send(res, 200, { ok: true, bytes: seg.bytes });
}

async function handleSegmentDone(req, res, url, meeting) {
  const index = intParam(url, 'seg', { min: 1, max: 9999 });
  const seg = meeting.segments.find((s) => s.index === index);
  if (seg && !seg.closed) {
    seg.closed = true;
    nextSeq.delete(`${meeting.id}:${index}`);
    await saveMeeting(meeting);
    // Suhbat davom etayotganda ham tayyor qismlarni transkripsiya qilib boramiz — oxirida kutish qisqaradi.
    const s = readSettings();
    if (seg.bytes > 0 && (s.elevenlabsApiKey || DEMO))
      transcribeSegment(meeting.id, index).catch(() => {});
  }
  send(res, 200, { ok: true });
}

async function handleUpload(req, res, url) {
  const name = String(url.searchParams.get('name') || 'audio');
  const ext = (path.extname(name).slice(1) || 'webm').toLowerCase();
  if (!UPLOAD_EXT.has(ext))
    throw new HttpError(400, 'Bu fayl turi qo‘llab-quvvatlanmaydi (mp3, m4a, wav, webm, ogg)');
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Fayl juda katta (2 GB dan oshmasin)');
  const meeting = await createMeeting({
    source: 'upload',
    status: 'processing',
    note: name.slice(0, 200),
    stage: 'Fayl saqlanmoqda',
  });
  const file = `seg-001.${ext}`;
  const dest = fs.createWriteStream(meetingFile(meeting.id, `audio/${file}`));
  let bytes = 0;
  try {
    for await (const c of req) {
      bytes += c.length;
      if (bytes > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Fayl juda katta (2 GB dan oshmasin)');
      if (!dest.write(c)) await new Promise((r) => dest.once('drain', r));
    }
    await new Promise((resolve, reject) => dest.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    dest.destroy();
    await deleteMeeting(meeting.id);
    throw err;
  }
  const durationMs = Math.max(0, Math.min(Number(url.searchParams.get('durationMs')) || 0, 1e9));
  meeting.segments.push({
    index: 1,
    file,
    startMs: 0,
    durationMs,
    bytes,
    closed: true,
    stt: 'pending',
  });
  meeting.durationMs = durationMs;
  await saveMeeting(meeting);
  processMeeting(meeting.id);
  send(res, 200, { meeting: publicMeeting(meeting) });
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const m = req.method;

  if (parts[1] === 'state' && m === 'GET') {
    const meetings = await listMeetings();
    return send(res, 200, { settings: publicSettings(), meetings: meetings.map(publicMeeting) });
  }
  if (parts[1] === 'settings' && m === 'POST') {
    await saveSettings(await readJson(req));
    return send(res, 200, { settings: publicSettings() });
  }
  if (parts[1] === 'check' && m === 'POST') {
    // Ikkala xizmatga juda qisqa haqiqiy so'rov yuborib, kalitlar ishlashini tekshiradi.
    const s = readSettings();
    if (DEMO)
      return send(res, 200, {
        elevenlabs: { ok: true, message: 'Sinov rejimi' },
        anthropic: { ok: true, message: 'Sinov rejimi' },
      });
    const [elevenlabs, anthropic] = await Promise.all([
      checkElevenlabs(s.elevenlabsApiKey),
      checkAnthropic(s.anthropicApiKey),
    ]);
    return send(res, 200, { elevenlabs, anthropic });
  }
  if (parts[1] === 'upload' && m === 'POST') return handleUpload(req, res, url);
  if (parts[1] === 'meetings' && parts.length === 2 && m === 'POST') {
    const body = await readJson(req);
    const meeting = await createMeeting({ note: String(body.note || '').slice(0, 500) });
    return send(res, 200, { meeting: publicMeeting(meeting) });
  }

  if (parts[1] === 'meetings' && parts[2]) {
    if (!isValidMeetingId(parts[2])) throw new HttpError(404, 'Suhbat topilmadi');
    const meeting = await loadMeeting(parts[2]).catch(() => {
      throw new HttpError(404, 'Suhbat topilmadi');
    });
    const action = parts[3];
    if (!action && m === 'GET') return send(res, 200, { meeting: publicMeeting(meeting) });
    if (!action && m === 'DELETE') {
      if (meeting.status === 'processing')
        throw new HttpError(409, 'Suhbat hozir qayta ishlanmoqda');
      await whenIdle(meeting.id); // holat «xato», lekin yozuv hali tugamagan bo'lishi mumkin
      await deleteMeeting(meeting.id);
      return send(res, 200, { ok: true });
    }
    if (action === 'chunk' && m === 'POST') return handleChunk(req, res, url, meeting);
    if (action === 'segment-done' && m === 'POST') return handleSegmentDone(req, res, url, meeting);
    if (action === 'finish' && m === 'POST') {
      const body = await readJson(req);
      if (meeting.status === 'recording' || meeting.status === 'interrupted') {
        const d = Number(body.durationMs);
        if (Number.isFinite(d) && d > 0)
          meeting.durationMs = Math.max(meeting.durationMs || 0, Math.min(d, 1e9));
        if (typeof body.note === 'string' && body.note.trim())
          meeting.note = body.note.trim().slice(0, 500);
        for (const seg of meeting.segments) seg.closed = true;
        meeting.status = 'processing';
        meeting.stage = 'Navbatda';
        await saveMeeting(meeting);
        processMeeting(meeting.id);
      }
      return send(res, 200, { meeting: publicMeeting(meeting) });
    }
    if (action === 'retry' && m === 'POST') {
      if (meeting.status === 'recording') throw new HttpError(409, 'Suhbat hali yozilmoqda');
      if (!isProcessing(meeting.id)) {
        for (const seg of meeting.segments) {
          seg.closed = true;
          if (seg.stt !== 'done') seg.stt = 'pending';
        }
        meeting.status = 'processing';
        meeting.stage = 'Navbatda';
        meeting.error = null;
        await saveMeeting(meeting);
        processMeeting(meeting.id);
      }
      return send(res, 200, { meeting: publicMeeting(meeting) });
    }
  }
  throw new HttpError(404, 'Topilmadi');
}

async function serveFile(res, file, { download } = {}) {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat || !stat.isFile()) throw new HttpError(404, 'Topilmadi');
  const type = STATIC_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(download ? { 'Content-Disposition': `attachment; filename="${download}"` } : {}),
  });
  fs.createReadStream(file).pipe(res);
}

const MEETING_FILES = new Set([
  'presentation.html',
  'transcript.txt',
  'xulosa.md',
  'analysis.json',
]);

async function route(req, res) {
  assertLocal(req);
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD')
    throw new HttpError(405, 'Ruxsat etilmagan usul');

  if (url.pathname === '/namuna') {
    const html = renderPresentation(DEMO_ANALYSIS, {
      createdAt: new Date().toISOString(),
      durationMs: 3 * 3600_000 + 40 * 60_000,
    });
    return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
  }
  // /m/<id>/<fayl>
  const mm = url.pathname.match(/^\/m\/([^/]+)\/([^/]+)$/);
  if (mm) {
    if (!isValidMeetingId(mm[1]) || !MEETING_FILES.has(mm[2]))
      throw new HttpError(404, 'Topilmadi');
    return serveFile(
      res,
      meetingFile(mm[1], mm[2]),
      url.searchParams.has('download') ? { download: `${mm[1]}-${mm[2]}` } : {},
    );
  }
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'Topilmadi');
  return serveFile(res, file);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: err.message || 'Xato' });
    else res.destroy();
  });
});
// Uzun fayl yuklash va sekin so'rovlar uzilmasligi uchun.
server.requestTimeout = 0;
server.headersTimeout = 60_000;

function openBrowser(target) {
  if (process.env.SUHBAT_NO_OPEN === '1') return;
  const cmd =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', target]]
      : process.platform === 'darwin'
        ? ['open', [target]]
        : ['xdg-open', [target]];
  try {
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref();
  } catch {
    // brauzerni qo'lda ochish mumkin
  }
}

// Oldingi ishga tushirishdan qolgan holatlarni tiklash.
async function recover() {
  for (const meeting of await listMeetings()) {
    if (meeting.status === 'recording') {
      // Yozuv paytida dastur yoki kompyuter o'chib qolgan — saqlangan audio yo'qolmaydi.
      meeting.status = 'interrupted';
      for (const seg of meeting.segments) seg.closed = true;
      await saveMeeting(meeting);
    } else if (meeting.status === 'processing') {
      for (const seg of meeting.segments) if (seg.stt === 'running') seg.stt = 'pending';
      processMeeting(meeting.id);
    }
  }
}

const appUrl = `http://localhost:${PORT}`;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`SUHBAT Lokal allaqachon ishlab turibdi: ${appUrl}`);
    openBrowser(appUrl);
    process.exit(0);
  }
  throw err;
});
await recover();
server.listen(PORT, HOST, () => {
  console.log(`\n  SUHBAT Lokal ishga tushdi:  ${appUrl}`);
  console.log(`  Ma'lumotlar papkasi:        ${DATA_DIR}`);
  if (DEMO)
    console.log(
      '  SINOV REJIMI: haqiqiy transkripsiya/tahlil o‘rniga namuna ma’lumot ishlatiladi.',
    );
  console.log('  To‘xtatish uchun: Ctrl+C\n');
  openBrowser(appUrl);
});
