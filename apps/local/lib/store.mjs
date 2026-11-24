// Ma'lumotlar papkasi: sozlamalar, suhbatlar (audio bo'laklar, transkript, tahlil, prezentatsiya).
// Hammasi foydalanuvchi kompyuterida, oddiy fayllar sifatida saqlanadi.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = path.resolve(
  process.env.SUHBAT_DATA_DIR || path.join(os.homedir(), 'Suhbat-AI'),
);
export const MEETINGS_DIR = path.join(DATA_DIR, 'suhbatlar');
const SETTINGS_FILE = path.join(DATA_DIR, 'sozlamalar.json');

fs.mkdirSync(MEETINGS_DIR, { recursive: true });

const DEFAULT_SETTINGS = {
  anthropicApiKey: '',
  elevenlabsApiKey: '',
  companyName: '',
  teamMembers: '',
  language: 'uzb',
};

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  // 0600: sozlamalar faylida API kalitlari bor — faqat shu foydalanuvchi o'qiy olsin.
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, file);
}

export function readSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    saved = {};
  }
  const merged = { ...DEFAULT_SETTINGS, ...saved };
  // Muhit o'zgaruvchilari (yoki .env) sozlamalar faylidan ustun turadi.
  if (process.env.ANTHROPIC_API_KEY) merged.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (process.env.ELEVENLABS_API_KEY) merged.elevenlabsApiKey = process.env.ELEVENLABS_API_KEY;
  return merged;
}

export async function saveSettings(patch) {
  let saved = {};
  try {
    saved = JSON.parse(await fsp.readFile(SETTINGS_FILE, 'utf8'));
  } catch {
    saved = {};
  }
  const next = { ...DEFAULT_SETTINGS, ...saved };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (typeof patch[key] !== 'string') continue;
    const value = patch[key].trim();
    // Kalit maydonlari bo'sh yuborilsa, eskisi saqlanib qoladi (UI kalitni qayta ko'rsatmaydi).
    if ((key === 'anthropicApiKey' || key === 'elevenlabsApiKey') && value === '') continue;
    next[key] = value;
  }
  await writeJsonAtomic(SETTINGS_FILE, next);
  return next;
}

export function newMeetingId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
  return `${stamp}_${crypto.randomBytes(3).toString('hex')}`;
}

const ID_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}_[0-9a-f]{6}$/;
export function isValidMeetingId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

export function meetingDir(id) {
  if (!isValidMeetingId(id)) throw new Error('Noto‘g‘ri suhbat ID');
  return path.join(MEETINGS_DIR, id);
}

export function meetingFile(id, name) {
  return path.join(meetingDir(id), name);
}

const cache = new Map();

export async function createMeeting(fields) {
  const id = newMeetingId();
  await fsp.mkdir(path.join(meetingDir(id), 'audio'), { recursive: true });
  const meeting = {
    id,
    createdAt: new Date().toISOString(),
    status: 'recording', // recording | interrupted | processing | ready | failed
    source: 'recorder',
    title: null,
    note: '',
    durationMs: 0,
    segments: [],
    stage: null,
    error: null,
    ...fields,
  };
  await saveMeeting(meeting);
  return meeting;
}

export async function loadMeeting(id) {
  if (cache.has(id)) return cache.get(id);
  const raw = await fsp.readFile(meetingFile(id, 'meeting.json'), 'utf8');
  const meeting = JSON.parse(raw);
  cache.set(id, meeting);
  return meeting;
}

// Bitta suhbat uchun yozuvlar ketma-ket bajariladi, shunda parallel so'rovlar bir-birini o'chirmaydi.
const writeChains = new Map();
export function saveMeeting(meeting) {
  cache.set(meeting.id, meeting);
  const prev = writeChains.get(meeting.id) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => writeJsonAtomic(meetingFile(meeting.id, 'meeting.json'), meeting));
  writeChains.set(meeting.id, next);
  return next;
}

export async function listMeetings() {
  const entries = await fsp.readdir(MEETINGS_DIR, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || !isValidMeetingId(e.name)) continue;
    try {
      out.push(await loadMeeting(e.name));
    } catch {
      // buzilgan yoki yarim yaratilgan papka — e'tiborsiz qoldiramiz
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

export async function deleteMeeting(id) {
  await (writeChains.get(id) || Promise.resolve()).catch(() => {});
  cache.delete(id);
  writeChains.delete(id);
  await fsp.rm(meetingDir(id), { recursive: true, force: true });
}
