// Serverni sinov rejimida (SUHBAT_DEMO=1) alohida jarayonda ishga tushirib, to'liq oqimni tekshiradi.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4791;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = { Origin: `http://127.0.0.1:${PORT}` };
let child;
let dataDir;

function startServer() {
  child = spawn(process.execPath, [path.join(HERE, '..', 'server.mjs')], {
    env: {
      ...process.env,
      SUHBAT_DEMO: '1',
      SUHBAT_NO_OPEN: '1',
      SUHBAT_PORT: String(PORT),
      SUHBAT_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => String(d).includes('ishga tushdi') && resolve());
    child.on('exit', (code) => reject(new Error(`server chiqib ketdi: ${code}`)));
  });
}
const stopServer = () =>
  new Promise((resolve) => {
    child.removeAllListeners('exit');
    child.on('exit', resolve);
    child.kill();
  });

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-test-'));
  await startServer();
});
after(async () => {
  await stopServer();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const post = (url, { body, json, headers = {} } = {}) =>
  fetch(BASE + url, {
    method: 'POST',
    headers: { ...ORIGIN, ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: json ? JSON.stringify(json) : body,
  });
const chunk = (id, seg, seq, { startMs = 0, t = 5000, size = 4000 } = {}) =>
  post(`/api/meetings/${id}/chunk?seg=${seg}&seq=${seq}&startMs=${startMs}&t=${t}`, {
    body: Buffer.alloc(size, seq + 1),
    headers: { 'Content-Type': 'audio/webm' },
  });

async function waitFor(id, status) {
  for (let i = 0; i < 100; i++) {
    const { meeting } = await (await fetch(`${BASE}/api/meetings/${id}`)).json();
    if (meeting.status === status) return meeting;
    if (meeting.status === 'failed' && status !== 'failed')
      throw new Error(`failed: ${meeting.error}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`"${status}" holatiga yetmadi`);
}

test('begona sayt yoki begona Host’dan kelgan so‘rovlar rad etiladi', async () => {
  // DNS-rebinding: boshqa domen nomi orqali kelgan so'rov (fetch Host sarlavhasini o'zgartira olmaydi, shuning uchun http.get)
  const status = await new Promise((resolve, reject) =>
    http
      .get(
        { host: '127.0.0.1', port: PORT, path: '/api/state', headers: { Host: 'evil.example' } },
        (r) => resolve(r.statusCode),
      )
      .on('error', reject),
  );
  assert.equal(status, 403);
  assert.equal(
    (
      await fetch(`${BASE}/api/meetings`, {
        method: 'POST',
        headers: { Origin: 'http://evil.example' },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(`${BASE}/api/meetings`, { method: 'POST' })).status, 403);
  assert.equal((await fetch(`${BASE}/..%2f..%2fserver.mjs`)).status, 404);
  assert.equal((await fetch(`${BASE}/m/..%2f..%2fetc/presentation.html`)).status, 404);
});

test('to‘liq oqim: yozuv bo‘laklari → tugatish → transkript, tahlil va prezentatsiya fayllari', async () => {
  const { meeting } = await (await post('/api/meetings', { json: {} })).json();
  const id = meeting.id;
  assert.equal(meeting.status, 'recording');

  assert.equal((await chunk(id, 1, 0)).status, 200);
  assert.equal((await chunk(id, 1, 1, { t: 10_000 })).status, 200);
  // Takroriy yuborilgan parcha faylga ikkinchi marta yozilmaydi; tartib buzilsa rad etiladi.
  assert.equal((await (await chunk(id, 1, 1, { t: 10_000 })).json()).duplicate, true);
  assert.equal((await chunk(id, 1, 5)).status, 409);
  assert.equal((await post(`/api/meetings/${id}/segment-done?seg=1`)).status, 200);
  assert.equal((await chunk(id, 1, 2)).status, 409); // yopilgan bo'lakka yozib bo'lmaydi
  assert.equal((await chunk(id, 2, 0, { startMs: 10_000, t: 15_000 })).status, 200);
  assert.equal(
    fs.statSync(path.join(dataDir, 'suhbatlar', id, 'audio', 'seg-001.webm')).size,
    8000,
  );

  assert.equal(
    (await post(`/api/meetings/${id}/finish`, { json: { durationMs: 15_000 } })).status,
    200,
  );
  const done = await waitFor(id, 'ready');
  assert.equal(done.durationMs, 15_000);
  assert.equal(done.segments, 2);
  assert.equal(done.transcribed, 2);
  assert.ok(done.title);

  const html = await (await fetch(`${BASE}/m/${id}/presentation.html`)).text();
  assert.ok(html.includes('Kim nimani yuborishi kerak'));
  const transcript = await (await fetch(`${BASE}/m/${id}/transcript.txt`)).text();
  assert.match(transcript, /^\[00:00:01\] Q1\/S1: Assalomu alaykum/);
  assert.match(transcript, /\[00:00:1\d\] Q2\/S1: /); // ikkinchi bo'lak vaqti 10 soniyaga surilgan
  assert.equal((await fetch(`${BASE}/m/${id}/xulosa.md`)).status, 200);
  assert.equal((await fetch(`${BASE}/m/${id}/meeting.json`)).status, 404); // faqat ruxsat etilgan fayllar

  // Yozuv tugagach yangi parcha qabul qilinmaydi
  assert.equal((await chunk(id, 3, 0)).status, 409);
});

test('yozuv paytida dastur o‘chib qolsa: audio saqlanib qoladi va qayta ishga tushgach tahlil qilinadi', async () => {
  const { meeting } = await (await post('/api/meetings', { json: {} })).json();
  await chunk(meeting.id, 1, 0, { t: 5000 });
  await chunk(meeting.id, 1, 1, { t: 10_000 });
  await stopServer();
  await startServer();
  const { meeting: after1 } = await (await fetch(`${BASE}/api/meetings/${meeting.id}`)).json();
  assert.equal(after1.status, 'interrupted');
  assert.equal(after1.durationMs, 10_000);
  await post(`/api/meetings/${meeting.id}/finish`, { json: {} });
  assert.equal((await waitFor(meeting.id, 'ready')).transcribed, 1);
});

test('ovozsiz (bo‘sh) yozuv tushunarli xato bilan tugaydi, o‘chirish ishlaydi', async () => {
  const { meeting } = await (await post('/api/meetings', { json: {} })).json();
  await post(`/api/meetings/${meeting.id}/finish`, { json: { durationMs: 1000 } });
  // Sinov rejimida bo'laklarsiz suhbat — "audio yozilmagan"
  const failed = await waitFor(meeting.id, 'failed');
  assert.match(failed.error, /Audio yozilmagan/);
  assert.equal(
    (await fetch(`${BASE}/api/meetings/${meeting.id}`, { method: 'DELETE', headers: ORIGIN }))
      .status,
    200,
  );
  assert.equal((await fetch(`${BASE}/api/meetings/${meeting.id}`)).status, 404);
});

test('tayyor audio faylni yuklash ham xuddi shu zanjirdan o‘tadi; noto‘g‘ri fayl turi rad etiladi', async () => {
  assert.equal((await post('/api/upload?name=virus.exe', { body: Buffer.alloc(10) })).status, 400);
  const res = await post('/api/upload?name=uchrashuv.mp3&durationMs=60000', {
    body: Buffer.alloc(5000, 7),
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  assert.equal(res.status, 200);
  const { meeting } = await res.json();
  const done = await waitFor(meeting.id, 'ready');
  assert.equal(done.source, 'upload');
});

test('sozlamalar: kalitlar saqlanadi, lekin hech qachon brauzerga qaytarilmaydi', async () => {
  await post('/api/settings', {
    json: { anthropicApiKey: 'sk-ant-SECRET', elevenlabsApiKey: 'sk_SECRET', companyName: 'Elmun' },
  });
  await post('/api/settings', { json: { anthropicApiKey: '', companyName: 'Elmun Technologies' } }); // bo'sh kalit eskisini o'chirmaydi
  const raw = await (await fetch(`${BASE}/api/state`)).text();
  assert.ok(!raw.includes('SECRET'));
  assert.equal(JSON.parse(raw).settings.companyName, 'Elmun Technologies');
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'sozlamalar.json'), 'utf8'));
  assert.equal(saved.anthropicApiKey, 'sk-ant-SECRET');
});
