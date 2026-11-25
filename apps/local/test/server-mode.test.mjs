// Server rejimi (Hetzner kabi): parol bilan kirish, begona domen/manzillardan himoya, xavfsiz ishga tushish.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const PORT = 4794;
const PUBLIC = 'https://suhbat.example.test';
const PASSWORD = 'juda-maxfiy-parol-123';
let child;
let dataDir;

function run(env, { waitFor = 'ishga tushdi' } = {}) {
  const proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      SUHBAT_NO_OPEN: '1',
      SUHBAT_DEMO: '1',
      SUHBAT_DATA_DIR: dataDir,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  return new Promise((resolve) => {
    const done = (code) => resolve({ proc, out, code });
    proc.stdout.on('data', (d) => {
      out += d;
      if (waitFor && out.includes(waitFor)) done(null);
    });
    proc.stderr.on('data', (d) => (out += d));
    proc.on('exit', (code) => done(code));
  });
}

/** Caddy proksi orqali kelgandek so'rov: Host = ommaviy domen. */
function req(pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: pathname,
        method,
        headers: { Host: 'suhbat.example.test', ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const post = (pathname, json, headers = {}) =>
  req(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: PUBLIC, ...headers },
    body: JSON.stringify(json),
  });

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-srv-'));
  const r = await run({
    SUHBAT_PUBLIC_URL: PUBLIC,
    SUHBAT_PASSWORD: PASSWORD,
    SUHBAT_PORT: String(PORT),
    SUHBAT_HOST: '127.0.0.1',
    SUHBAT_TRUST_PROXY: '1',
  });
  assert.equal(r.code, null, r.out);
  child = r.proc;
});
after(() => {
  child.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('parolsiz yoki qisqa parol bilan server rejimi ishga tushmaydi', async () => {
  const a = await run({ SUHBAT_PUBLIC_URL: PUBLIC, SUHBAT_PORT: '4795' }, { waitFor: null });
  assert.equal(a.code, 1);
  assert.match(a.out, /SUHBAT_PASSWORD/);
  const b = await run({ SUHBAT_HOST: '0.0.0.0', SUHBAT_PORT: '4796' }, { waitFor: null });
  assert.equal(b.code, 1, 'parolsiz tashqi tarmoqqa ochilmasligi kerak');
});

test('kirmagan foydalanuvchi: kirish sahifasi, API 401, fayllar yopiq', async () => {
  const home = await req('/');
  assert.equal(home.status, 200);
  assert.match(home.body, /id="login"/);
  assert.equal(home.headers['strict-transport-security'], 'max-age=31536000');
  assert.equal((await req('/api/state')).status, 401);
  assert.equal((await req('/app.js')).status, 302);
  assert.equal((await req('/namuna')).status, 302);
  assert.equal((await req('/style.css')).status, 200);
  assert.equal((await req('/fonts/outfit-latin-wght-normal.woff2')).status, 200);
  assert.equal((await post('/api/meetings', {})).status, 401);
});

test('noto‘g‘ri parol rad etiladi, ko‘p urinishdan keyin bloklanadi', async () => {
  const ip = { 'X-Forwarded-For': '203.0.113.7' };
  for (let i = 0; i < 10; i++)
    assert.equal((await post('/api/login', { password: 'xato' }, ip)).status, 401);
  assert.equal((await post('/api/login', { password: PASSWORD }, ip)).status, 429);
  // boshqa IP bloklanmagan
  assert.equal(
    (await post('/api/login', { password: PASSWORD }, { 'X-Forwarded-For': '203.0.113.8' })).status,
    200,
  );
});

test('to‘g‘ri parol: xavfsiz cookie, keyin hamma narsa ishlaydi; chiqish', async () => {
  const login = await post(
    '/api/login',
    { password: PASSWORD },
    { 'X-Forwarded-For': '198.51.100.1' },
  );
  assert.equal(login.status, 200);
  const cookie = login.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  const session = cookie.split(';')[0];

  const state = await req('/api/state', { headers: { Cookie: session } });
  assert.equal(state.status, 200);
  assert.equal(JSON.parse(state.body).settings.serverMode, true);
  const app = await req('/', { headers: { Cookie: session } });
  assert.match(app.body, /btn-start/);
  const created = await post('/api/meetings', {}, { Cookie: session });
  assert.equal(created.status, 200);

  // soxtalashtirilgan cookie ishlamaydi
  const forged = session.replace(/\.[^.]+$/, '.AAAA');
  assert.equal((await req('/api/state', { headers: { Cookie: forged } })).status, 401);
  // begona sayt nomidan so'rov (CSRF) — cookie bo'lsa ham rad etiladi
  assert.equal(
    (await post('/api/meetings', {}, { Cookie: session, Origin: 'https://evil.test' })).status,
    403,
  );
  // begona domen orqali kirish (Host) — rad etiladi
  assert.equal(
    (await req('/api/state', { headers: { Cookie: session, Host: 'evil.test' } })).status,
    403,
  );

  const out = await post('/api/logout', {}, { Cookie: session });
  assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
});
