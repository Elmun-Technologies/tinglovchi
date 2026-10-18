/**
 * Browser-side safety net for the recorder: every piece MediaRecorder delivers (one per few seconds) is
 * written to IndexedDB as it arrives, so a closed tab, a crashed browser or a failed upload never loses a
 * conversation. The entry is removed only after the server has accepted the upload.
 *
 * Pieces are stored one record each and never rewritten, so a six-hour meeting costs one small write per
 * piece rather than rewriting the whole recording every few seconds.
 */

const DB_NAME = 'suhbat-recorder';
const RECORDINGS = 'recordings';
const CHUNKS = 'chunks';

export type LocalRecordingMeta = {
  id: string;
  startedAt: string;
  mimeType: string;
  recordedMs: number;
  chunkCount: number;
};

export type LocalRecording = Omit<LocalRecordingMeta, 'chunkCount'> & { chunks: Blob[] };

type ChunkRecord = { recordingId: string; index: number; blob: Blob };

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Version 1 kept every piece inside one record; it is replaced, not migrated.
      for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
      db.createObjectStore(RECORDINGS, { keyPath: 'id' });
      db.createObjectStore(CHUNKS, { keyPath: ['recordingId', 'index'] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(
  stores: string[],
  mode: IDBTransactionMode,
  action: (transaction: IDBTransaction) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const transaction = db.transaction(stores, mode);
      const request = action(transaction);
      transaction.oncomplete = () => resolve(request ? request.result : undefined);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

function chunkRange(recordingId: string): IDBKeyRange {
  return IDBKeyRange.bound([recordingId, 0], [recordingId, Number.MAX_SAFE_INTEGER]);
}

/** Stores one new piece and the updated recording details in a single transaction. */
export async function appendLocalChunk(meta: LocalRecordingMeta, blob: Blob): Promise<void> {
  await run([RECORDINGS, CHUNKS], 'readwrite', (transaction) => {
    const chunk: ChunkRecord = { recordingId: meta.id, index: meta.chunkCount - 1, blob };
    transaction.objectStore(CHUNKS).put(chunk);
    transaction.objectStore(RECORDINGS).put(meta);
  });
}

export async function saveLocalRecordingMeta(meta: LocalRecordingMeta): Promise<void> {
  await run([RECORDINGS], 'readwrite', (transaction) => {
    transaction.objectStore(RECORDINGS).put(meta);
  });
}

export async function loadLocalRecording(id: string): Promise<LocalRecording | null> {
  const meta = await run<LocalRecordingMeta>([RECORDINGS], 'readonly', (transaction) =>
    transaction.objectStore(RECORDINGS).get(id),
  );
  if (!meta) return null;
  const chunks = await run<ChunkRecord[]>([CHUNKS], 'readonly', (transaction) =>
    transaction.objectStore(CHUNKS).getAll(chunkRange(id)),
  );
  return {
    id: meta.id,
    startedAt: meta.startedAt,
    mimeType: meta.mimeType,
    recordedMs: meta.recordedMs,
    chunks: (chunks ?? []).sort((a, b) => a.index - b.index).map((chunk) => chunk.blob),
  };
}

export async function deleteLocalRecording(id: string): Promise<void> {
  await run([RECORDINGS, CHUNKS], 'readwrite', (transaction) => {
    transaction.objectStore(CHUNKS).delete(chunkRange(id));
    transaction.objectStore(RECORDINGS).delete(id);
  });
}

export async function listLocalRecordings(): Promise<LocalRecordingMeta[]> {
  try {
    const all = await run<LocalRecordingMeta[]>([RECORDINGS], 'readonly', (transaction) =>
      transaction.objectStore(RECORDINGS).getAll(),
    );
    return (all ?? []).filter((recording) => recording.chunkCount > 0);
  } catch {
    // Private mode or blocked storage: the recorder still works, just without the safety net.
    return [];
  }
}
