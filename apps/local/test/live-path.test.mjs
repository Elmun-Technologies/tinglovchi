// Haqiqiy (sinov rejimisiz) zanjirni soxta ElevenLabs va Anthropic serverlariga qarshi tekshiradi:
// multipart yuklash, model zaxirasi, Anthropic SDK oqimli javobi, JSON-sxema rad etilganda zaxira yo'l.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_ANALYSIS } from '../lib/demo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4792;
const MOCK_PORT = 4793;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = { Origin: `http://127.0.0.1:${PORT}` };
const seen = { stt: [], claude: [] };
let rejectStructured = false;
let child;
let child2; // standart (oddiy JSON) rejimdagi ikkinchi server
let dataDir2;
const PORT2 = 4797;
let mock;
let dataDir;

const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const [type, data] of events)
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.end();
};

before(async () => {
  mock = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (req.url === '/v1/speech-to-text') {
      const raw = body.toString('latin1');
      const field = (name) => raw.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`))?.[1];
      seen.stt.push({
        key: req.headers['xi-api-key'],
        model: field('model_id'),
        language: field('language_code'),
        diarize: field('diarize'),
        hasFile: /name="file"; filename="seg-001\.webm"/.test(raw),
      });
      if (req.headers['xi-api-key'] !== 'el-key')
        return res.writeHead(401).end('{"detail":"invalid_api_key"}');
      if (field('model_id') === 'scribe_v1')
        return res
          .writeHead(400)
          .end('{"detail":{"message":"model_id scribe_v1 is not supported"}}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          language_code: 'uzb',
          text: 'Salom. Shartnomani juma kuni yuboramiz.',
          words: [
            { text: 'Salom.', start: 0.2, end: 0.6, type: 'word', speaker_id: 'speaker_0' },
            { text: ' ', start: 0.6, end: 0.7, type: 'spacing', speaker_id: 'speaker_0' },
            { text: 'Shartnomani', start: 3.5, end: 4.0, type: 'word', speaker_id: 'speaker_1' },
            { text: 'juma', start: 4.1, end: 4.3, type: 'word', speaker_id: 'speaker_1' },
            { text: 'kuni', start: 4.4, end: 4.6, type: 'word', speaker_id: 'speaker_1' },
            { text: 'yuboramiz.', start: 4.7, end: 5.2, type: 'word', speaker_id: 'speaker_1' },
          ],
        }),
      );
    }
    if (req.url.startsWith('/v1/messages')) {
      const json = JSON.parse(body.toString('utf8'));
      // SDK 1.x kalitni `Authorization: Bearer` sarlavhasida yuboradi (eski versiyalar — `x-api-key`).
      const key =
        req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer /, '');
      seen.claude.push({ key, beta: req.headers['anthropic-beta'], body: json });
      if (key !== 'sk-ant-api03-test') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(
          '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
        );
      }
      if (rejectStructured && json.output_config?.format) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(
          '{"type":"error","error":{"type":"invalid_request_error","message":"output_config.format: schema not supported"}}',
        );
      }
      const answer = JSON.stringify({ ...DEMO_ANALYSIS, title: 'Soxta server tahlili' });
      const text = json.output_config?.format
        ? answer
        : 'Mana natija:\n```json\n' + answer + '\n```';
      const message = {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: json.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      };
      if (!json.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            ...message,
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
          }),
        );
      }
      return sse(res, [
        ['message_start', { message }],
        ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
        [
          'content_block_delta',
          { index: 0, delta: { type: 'text_delta', text: text.slice(0, 50) } },
        ],
        ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(50) } }],
        ['content_block_stop', { index: 0 }],
        [
          'message_delta',
          { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 99 } },
        ],
        ['message_stop', {}],
      ]);
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-live-'));
  dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-live2-'));
  const env = {
    ...process.env,
    SUHBAT_NO_OPEN: '1',
    SUHBAT_STRUCTURED_OUTPUT: '1', // bu server qat'iy sxema yo'lini sinaydi
    SUHBAT_PORT: String(PORT),
    SUHBAT_DATA_DIR: dataDir,
    ELEVENLABS_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
  };
  for (const k of [
    'SUHBAT_DEMO',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ELEVENLABS_API_KEY',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'https_proxy',
    'http_proxy',
  ])
    delete env[k];
  const start = (e) => {
    const proc = spawn(process.execPath, [path.join(HERE, '..', 'server.mjs')], {
      env: e,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    return new Promise((resolve, reject) => {
      proc.stdout.on('data', (d) => String(d).includes('ishga tushdi') && resolve(proc));
      proc.on('exit', (code) => reject(new Error(`server chiqib ketdi: ${code}`)));
    });
  };
  child = await start(env);
  const env2 = { ...env, SUHBAT_PORT: String(PORT2), SUHBAT_DATA_DIR: dataDir2 };
  delete env2.SUHBAT_STRUCTURED_OUTPUT;
  child2 = await start(env2);
});
after(async () => {
  child.removeAllListeners('exit');
  child.kill();
  child2.removeAllListeners('exit');
  child2.kill();
  fs.rmSync(dataDir2, { recursive: true, force: true });
  await new Promise((r) => mock.close(r));
  mock.closeAllConnections?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const post = (url, { body, json, headers = {} } = {}) =>
  fetch(BASE + url, {
    method: 'POST',
    headers: { ...ORIGIN, ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: json ? JSON.stringify(json) : body,
  });

async function record() {
  const { meeting } = await (await post('/api/meetings', { json: {} })).json();
  await post(`/api/meetings/${meeting.id}/chunk?seg=1&seq=0&startMs=0&t=6000`, {
    body: Buffer.alloc(6000, 1),
    headers: { 'Content-Type': 'audio/webm;codecs=opus' },
  });
  await post(`/api/meetings/${meeting.id}/finish`, { json: { durationMs: 6000 } });
  return meeting.id;
}
async function settle(id) {
  for (let i = 0; i < 150; i++) {
    const { meeting } = await (await fetch(`${BASE}/api/meetings/${id}`)).json();
    if (meeting.status !== 'processing') return meeting;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('tugamadi');
}

test('kalitlarsiz: yozuv saqlanadi, tahlil tushunarli xabar bilan to‘xtaydi; kalit kiritilgach «Qayta urinish» ishlaydi', async () => {
  const id = await record();
  const failed = await settle(id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /ElevenLabs API kaliti kiritilmagan/);
  assert.equal(seen.stt.length, 0);

  await post('/api/settings', {
    json: {
      elevenlabsApiKey: 'el-key',
      anthropicApiKey: 'sk-ant-api03-test',
      companyName: 'Elmun',
      teamMembers: 'Sardor (menejer)',
    },
  });
  const check = await (await post('/api/check')).json();
  assert.equal(check.elevenlabs.ok, true, check.elevenlabs.message);
  assert.equal(check.anthropic.ok, true, check.anthropic.message);
  assert.match(check.elevenlabs.message, /scribe_v2/); // scribe_v1 rad etildi → keyingi model

  seen.stt.length = 0;
  seen.claude.length = 0;
  await post(`/api/meetings/${id}/retry`, { json: {} });
  const ready = await settle(id);
  assert.equal(ready.status, 'ready', ready.error);
  assert.equal(ready.title, 'Soxta server tahlili');

  // ElevenLabs so'rovi: kalit, fayl, til va spikerlarni ajratish yuborilgan; ishlagan model eslab qolingan
  assert.deepEqual(seen.stt, [
    { key: 'el-key', model: 'scribe_v2', language: 'uzb', diarize: 'true', hasFile: true },
  ]);

  // Claude so'rovi: model, oqim, tuzilgan javob sxemasi, transkript va kontekst
  assert.equal(seen.claude.length, 1);
  const { body, beta } = seen.claude[0];
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.stream, true);
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.equal(body.fallbacks, 'default');
  assert.match(beta, /server-side-fallback-2026-07-01/);
  const prompt = body.messages[0].content;
  assert.match(prompt, /\[00:00:00\] Q1\/S1: Salom\./);
  assert.match(prompt, /\[00:00:03\] Q1\/S2: Shartnomani juma kuni yuboramiz\./);
  assert.match(prompt, /Bizning kompaniya: Elmun/);

  const transcript = await (await fetch(`${BASE}/m/${id}/transcript.txt`)).text();
  assert.equal(transcript.trim().split('\n').length, 2);
});

test('Claude tuzilgan javob rejimini rad etsa, zaxira yo‘l bilan baribir natija chiqadi', async () => {
  rejectStructured = true;
  seen.claude.length = 0;
  const id = await record();
  const ready = await settle(id);
  rejectStructured = false;
  assert.equal(ready.status, 'ready', ready.error);
  assert.equal(seen.claude.length, 2);
  assert.equal(seen.claude[1].body.output_config.format, undefined);
  assert.equal(seen.claude[1].body.output_config.effort, 'high');
  assert.match(seen.claude[1].body.system, /JSON Schema/);
  const html = await (await fetch(`${BASE}/m/${id}/presentation.html`)).text();
  assert.ok(html.includes('Soxta server tahlili'));
});

test('noto‘g‘ri kalitlar: tekshiruv aniq sababni ko‘rsatadi', async () => {
  await post('/api/settings', { json: { elevenlabsApiKey: 'xato', anthropicApiKey: 'xato' } });
  const check = await (await post('/api/check')).json();
  assert.equal(check.elevenlabs.ok, false);
  assert.match(check.elevenlabs.message, /kaliti noto'g'ri/);
  assert.equal(check.anthropic.ok, false);
  assert.match(check.anthropic.message, /401/);
  await post('/api/settings', {
    json: { elevenlabsApiKey: 'el-key', anthropicApiKey: 'sk-ant-api03-test' },
  });
});

test('standart rejim: sxema ko‘rsatmada beriladi, qat’iy format so‘ralmaydi («grammar too large» bo‘lmasligi uchun)', async () => {
  const base = `http://127.0.0.1:${PORT2}`;
  const origin = { Origin: base };
  const call = (url, init = {}) =>
    fetch(base + url, { ...init, headers: { ...origin, ...(init.headers || {}) } });
  await call('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ elevenlabsApiKey: 'el-key', anthropicApiKey: 'sk-ant-api03-test' }),
  });
  seen.claude.length = 0;
  const { meeting } = await (
    await call('/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
  ).json();
  await call(`/api/meetings/${meeting.id}/chunk?seg=1&seq=0&startMs=0&t=6000`, {
    method: 'POST',
    body: Buffer.alloc(6000, 1),
    headers: { 'Content-Type': 'audio/webm' },
  });
  await call(`/api/meetings/${meeting.id}/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ durationMs: 6000 }),
  });
  let done;
  for (let i = 0; i < 150; i++) {
    done = (await (await call(`/api/meetings/${meeting.id}`)).json()).meeting;
    if (done.status !== 'processing') break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(done.status, 'ready', done.error);
  assert.equal(seen.claude.length, 1, 'bitta so‘rov, qayta urinishsiz');
  const { body } = seen.claude[0];
  assert.equal(body.output_config.format, undefined);
  assert.equal(body.output_config.effort, 'high');
  assert.equal(body.fallbacks, 'default');
  assert.match(body.system, /JSON Schema/);
  const html = await (await call(`/m/${meeting.id}/presentation.html`)).text();
  assert.ok(html.includes('Soxta server tahlili'));
});
