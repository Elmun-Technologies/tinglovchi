// Server rejimi (masalan, Hetzner) uchun parol bilan kirish.
// Lokal rejimda (shu kompyuterda) parol kerak emas — server faqat 127.0.0.1 da tinglaydi.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const COOKIE = 'suhbat_session';
const SESSION_DAYS = 30;
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** Sessiya imzosi uchun maxfiy kalit: muhitdan yoki ma'lumotlar papkasida bir marta yaratiladi. */
function loadSecret(dataDir) {
  if (process.env.SUHBAT_SESSION_SECRET) return process.env.SUHBAT_SESSION_SECRET;
  const file = path.join(dataDir, '.session-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function createAuth({ password, dataDir, secure, trustProxy }) {
  // Parol o'zgarsa, eski sessiyalar avtomatik bekor bo'ladi.
  const key = crypto.createHmac('sha256', loadSecret(dataDir)).update(sha256(password)).digest();
  const sign = (payload) => crypto.createHmac('sha256', key).update(payload).digest('base64url');
  const attempts = new Map(); // ip -> { count, since }

  const clientIp = (req) => {
    if (trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] || '')
        .split(',')[0]
        .trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress || 'unknown';
  };

  return {
    isAuthenticated(req) {
      const raw = parseCookies(req.headers.cookie)[COOKIE];
      if (!raw) return false;
      const [expires, sig] = raw.split('.');
      if (!expires || !sig || Number(expires) < Date.now()) return false;
      const expected = Buffer.from(sign(expires));
      const given = Buffer.from(sig);
      return expected.length === given.length && crypto.timingSafeEqual(expected, given);
    },

    /** Parolni tekshiradi. Juda ko'p noto'g'ri urinish bo'lsa, vaqtincha bloklaydi. */
    login(req, given) {
      const ip = clientIp(req);
      const now = Date.now();
      const rec = attempts.get(ip);
      if (rec && now - rec.since < WINDOW_MS && rec.count >= MAX_ATTEMPTS) {
        return {
          ok: false,
          status: 429,
          error: 'Juda ko‘p urinish. 15 daqiqadan so‘ng qayta urining.',
        };
      }
      const ok = crypto.timingSafeEqual(sha256(given), sha256(password));
      if (!ok) {
        const fresh = !rec || now - rec.since >= WINDOW_MS;
        attempts.set(ip, { count: fresh ? 1 : rec.count + 1, since: fresh ? now : rec.since });
        return { ok: false, status: 401, error: 'Parol noto‘g‘ri' };
      }
      attempts.delete(ip);
      const expires = String(now + SESSION_DAYS * 86400_000);
      const cookie = `${COOKIE}=${expires}.${sign(expires)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
      return { ok: true, cookie };
    },

    logoutCookie() {
      return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
    },
  };
}
