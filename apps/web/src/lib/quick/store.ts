import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  sessionSchema,
  type AnalysisLanguage,
  type CaptureMode,
  type Session,
  type SessionSource,
  type SessionSummary,
} from './types';

/**
 * Disk-backed storage for the one-button flow: `<SUHBAT_DATA_DIR>/sessions/<id>/{session.json,audio.*}`.
 *
 * In production the directory must be a persistent volume (see docs/ISHGA-TUSHIRISH.md); a container's own
 * filesystem is wiped on every deploy and every restart.
 */

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function dataDir(): string {
  return resolve(process.env.SUHBAT_DATA_DIR?.trim() || join(process.cwd(), '.suhbat-data'));
}

function sessionsDir(): string {
  return join(dataDir(), 'sessions');
}

export function isSessionId(value: string): boolean {
  return ID_PATTERN.test(value);
}

function sessionDir(id: string): string {
  if (!isSessionId(id)) throw new Error('Invalid session id.');
  return join(sessionsDir(), id);
}

// Browser recordings, phone dictaphone apps (m4a, amr, 3gp), Telegram voice (ogg/opus) and video files,
// whose sound the transcription providers extract themselves.
const AUDIO_EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/mp4a-latm': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/amr': 'amr',
  'audio/3gpp': '3gp',
  'video/3gpp': '3gp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

export function audioExtension(mimeType: string): string | null {
  return AUDIO_EXTENSIONS[mimeType.split(';')[0]!.trim().toLowerCase()] ?? null;
}

// Writes to one session are serialized in-process so a status update never overwrites a newer one.
const locks = new Map<string, Promise<unknown>>();

async function withLock<T>(id: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  locks.set(id, next);
  try {
    return await next;
  } finally {
    if (locks.get(id) === next) locks.delete(id);
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await rename(temporary, path);
}

export type NewSessionFields = {
  mimeType: string;
  recordedMs: number;
  title: string | null;
  language?: AnalysisLanguage;
  captureMode?: CaptureMode;
  source?: SessionSource;
  telegramChatId?: number | null;
};

async function writeNewSession(
  id: string,
  fields: NewSessionFields,
  audioFile: string,
  audioBytes: number,
): Promise<Session> {
  const now = new Date().toISOString();
  const session: Session = {
    id,
    createdAt: now,
    updatedAt: now,
    status: 'uploaded',
    title: fields.title,
    audioFile,
    audioMimeType: fields.mimeType.split(';')[0]!.trim().toLowerCase(),
    audioBytes,
    recordedMs: fields.recordedMs,
    language: fields.language ?? 'uz',
    captureMode: fields.captureMode ?? 'mic',
    source: fields.source ?? 'web',
    telegramChatId: fields.telegramChatId ?? null,
    providerJobId: null,
    transcript: null,
    speakerStats: [],
    analysis: null,
    usage: null,
    error: null,
    attempts: 0,
  };
  await writeJsonAtomic(join(sessionDir(id), 'session.json'), session);
  return session;
}

export async function createSession(
  input: NewSessionFields & { audio: Uint8Array },
): Promise<Session> {
  const extension = audioExtension(input.mimeType);
  if (!extension) throw new Error(`Unsupported audio type: ${input.mimeType}`);

  const id = randomUUID();
  await mkdir(sessionDir(id), { recursive: true });
  const audioFile = `audio.${extension}`;
  await writeFile(join(sessionDir(id), audioFile), input.audio);
  return writeNewSession(id, input, audioFile, input.audio.byteLength);
}

/* ------------------------------------------------------- chunked uploads
 * A multi-hour recording is sent in parts so a dropped mobile connection costs one part, not the whole
 * upload. Parts land in `<data>/uploads/<id>/`, and finishing concatenates them into a new session.
 */

function uploadDir(id: string): string {
  if (!isSessionId(id)) throw new Error('Invalid upload id.');
  return join(dataDir(), 'uploads', id);
}

const PART_DIGITS = 6;

function partName(index: number): string {
  return `part-${String(index).padStart(PART_DIGITS, '0')}`;
}

const ABANDONED_UPLOAD_MS = 7 * 24 * 60 * 60_000;

/** Removes uploads nobody finished within a week; the recording is still on the device that made it. */
async function purgeAbandonedUploads(): Promise<void> {
  const root = join(dataDir(), 'uploads');
  const entries = await readdir(root).catch(() => [] as string[]);
  const cutoff = Date.now() - ABANDONED_UPLOAD_MS;
  await Promise.all(
    entries.filter(isSessionId).map(async (id) => {
      const info = await stat(join(root, id)).catch(() => null);
      if (info && info.mtimeMs < cutoff) await rm(join(root, id), { recursive: true, force: true });
    }),
  );
}

export async function startUpload(mimeType: string): Promise<string> {
  if (!audioExtension(mimeType)) throw new Error(`Unsupported audio type: ${mimeType}`);
  await purgeAbandonedUploads();
  const id = randomUUID();
  await mkdir(uploadDir(id), { recursive: true });
  await writeJsonAtomic(join(uploadDir(id), 'upload.json'), {
    mimeType,
    createdAt: new Date().toISOString(),
  });
  return id;
}

export async function uploadExists(id: string): Promise<boolean> {
  if (!isSessionId(id)) return false;
  return stat(join(uploadDir(id), 'upload.json')).then(
    () => true,
    () => false,
  );
}

/** Writes one part; re-sending the same index overwrites it, so a retried part is never duplicated. */
export async function writeUploadPart(id: string, index: number, bytes: Uint8Array): Promise<void> {
  if (!Number.isInteger(index) || index < 0 || index >= 10 ** PART_DIGITS) {
    throw new Error('Invalid part index.');
  }
  const temporary = join(uploadDir(id), `${partName(index)}.${randomUUID()}.tmp`);
  await writeFile(temporary, bytes);
  await rename(temporary, join(uploadDir(id), partName(index)));
}

/** Indexes of the parts already stored, so a client can resume after a reload. */
export async function uploadedParts(id: string): Promise<number[]> {
  const entries = await readdir(uploadDir(id));
  return entries
    .filter((name) => /^part-\d+$/.test(name))
    .map((name) => Number(name.slice(5)))
    .sort((a, b) => a - b);
}

export async function finishUpload(
  id: string,
  fields: Omit<NewSessionFields, 'mimeType'> & { partCount: number },
): Promise<Session> {
  const dir = uploadDir(id);
  const meta = JSON.parse(await readFile(join(dir, 'upload.json'), 'utf8')) as { mimeType: string };
  const present = new Set(await uploadedParts(id));
  const missing: number[] = [];
  for (let index = 0; index < fields.partCount; index += 1) {
    if (!present.has(index)) missing.push(index);
  }
  if (fields.partCount < 1 || missing.length > 0) {
    throw new MissingPartsError(missing);
  }

  const extension = audioExtension(meta.mimeType)!;
  const sessionId = randomUUID();
  await mkdir(sessionDir(sessionId), { recursive: true });
  const audioFile = `audio.${extension}`;
  const target = join(sessionDir(sessionId), audioFile);
  let total = 0;
  for (let index = 0; index < fields.partCount; index += 1) {
    const bytes = await readFile(join(dir, partName(index)));
    await appendFile(target, bytes);
    total += bytes.byteLength;
  }
  const session = await writeNewSession(
    sessionId,
    { ...fields, mimeType: meta.mimeType },
    audioFile,
    total,
  );
  await rm(dir, { recursive: true, force: true });
  return session;
}

export class MissingPartsError extends Error {
  constructor(readonly missing: number[]) {
    super(`Upload is missing parts: ${missing.slice(0, 20).join(', ')}`);
    this.name = 'MissingPartsError';
  }
}

export async function readSession(id: string): Promise<Session | null> {
  if (!isSessionId(id)) return null;
  try {
    const raw = await readFile(join(sessionDir(id), 'session.json'), 'utf8');
    return sessionSchema.parse(JSON.parse(raw));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw cause;
  }
}

export async function updateSession(
  id: string,
  patch: (current: Session) => Partial<Session>,
): Promise<Session> {
  return withLock(id, async () => {
    const current = await readSession(id);
    if (!current) throw new Error(`Session ${id} not found.`);
    const next: Session = { ...current, ...patch(current), updatedAt: new Date().toISOString() };
    await writeJsonAtomic(join(sessionDir(id), 'session.json'), next);
    return next;
  });
}

export async function readAudio(session: Session): Promise<Buffer> {
  return readFile(join(sessionDir(session.id), session.audioFile));
}

export async function audioPath(session: Session): Promise<{ path: string; size: number }> {
  const path = join(sessionDir(session.id), session.audioFile);
  const info = await stat(path);
  return { path, size: info.size };
}

export async function deleteSession(id: string): Promise<void> {
  await withLock(id, () => rm(sessionDir(id), { recursive: true, force: true }));
}

export async function listSessions(): Promise<SessionSummary[]> {
  let entries: string[];
  try {
    entries = await readdir(sessionsDir());
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw cause;
  }
  const sessions = await Promise.all(
    entries.filter(isSessionId).map((id) => readSession(id).catch(() => null)),
  );
  return sessions
    .filter((session): session is Session => session !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ id, createdAt, status, title, recordedMs, error, usage }) => ({
      id,
      createdAt,
      status,
      title,
      recordedMs,
      error,
      usage,
    }));
}
