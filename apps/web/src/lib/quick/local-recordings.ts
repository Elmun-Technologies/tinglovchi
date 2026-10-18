/**
 * Browser-side safety net for the recorder: every few seconds the recorded audio so far is written to
 * IndexedDB, so a closed tab, a crashed browser or a failed upload never loses a conversation. The entry is
 * removed only after the server has accepted the upload.
 */

const DB_NAME = 'suhbat-recorder';
const STORE = 'recordings';

export type LocalRecording = {
  id: string;
  startedAt: string;
  mimeType: string;
  recordedMs: number;
  chunks: Blob[];
};

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export async function saveLocalRecording(recording: LocalRecording): Promise<void> {
  await run('readwrite', (store) => store.put(recording));
}

export async function deleteLocalRecording(id: string): Promise<void> {
  await run('readwrite', (store) => store.delete(id));
}

export async function listLocalRecordings(): Promise<LocalRecording[]> {
  try {
    const all = await run<LocalRecording[]>('readonly', (store) => store.getAll());
    return all.filter((recording) => recording.chunks.length > 0);
  } catch {
    // Private mode or blocked storage: the recorder still works, just without the safety net.
    return [];
  }
}
