import 'server-only';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sessionSchema, type Session, type SessionSummary } from './types';

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

const AUDIO_EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/aac': 'aac',
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

export async function createSession(input: {
  audio: Uint8Array;
  mimeType: string;
  recordedMs: number;
  title: string | null;
}): Promise<Session> {
  const extension = audioExtension(input.mimeType);
  if (!extension) throw new Error(`Unsupported audio type: ${input.mimeType}`);

  const id = randomUUID();
  const dir = sessionDir(id);
  await mkdir(dir, { recursive: true });
  const audioFile = `audio.${extension}`;
  await writeFile(join(dir, audioFile), input.audio);

  const now = new Date().toISOString();
  const session: Session = {
    id,
    createdAt: now,
    updatedAt: now,
    status: 'uploaded',
    title: input.title,
    audioFile,
    audioMimeType: input.mimeType.split(';')[0]!.trim().toLowerCase(),
    audioBytes: input.audio.byteLength,
    recordedMs: input.recordedMs,
    providerJobId: null,
    transcript: null,
    speakerStats: [],
    analysis: null,
    error: null,
    attempts: 0,
  };
  await writeJsonAtomic(join(dir, 'session.json'), session);
  return session;
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
    .map(({ id, createdAt, status, title, recordedMs, error }) => ({
      id,
      createdAt,
      status,
      title,
      recordedMs,
      error,
    }));
}
