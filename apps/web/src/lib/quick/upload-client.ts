import type { LocalRecording } from './local-recordings';

/**
 * Sends a recording in 4 MB parts. Each part is retried on its own, so a dropped mobile connection during a
 * six-hour meeting's upload costs one part, not the whole file; and because the upload id is kept on the
 * device, a later retry (even after a reload) only sends the parts the server does not have yet.
 */

export const PART_BYTES = 4 * 1024 * 1024;
const PART_ATTEMPTS = 5;

export class UploadError extends Error {}

async function api<T>(url: string, init: RequestInit): Promise<{ status: number; body: T }> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new UploadError('Internet aloqasi yo‘q. Yozuv qurilmada saqlandi.');
  }
  const body = (await response.json().catch(() => ({}))) as T;
  return { status: response.status, body };
}

async function putPart(uploadId: string, index: number, blob: Blob): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(`/api/quick/uploads/${uploadId}/parts/${index}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: blob,
      });
      if (response.ok) return;
      // A client error will not fix itself on retry.
      if (response.status < 500 && response.status !== 429) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new UploadError(body.error ?? `Server xatosi (${response.status})`);
      }
    } catch (cause) {
      if (cause instanceof UploadError) throw cause;
    }
    if (attempt >= PART_ATTEMPTS) {
      throw new UploadError(
        'Internet aloqasi uzildi. Yozuv qurilmada saqlandi — keyinroq yuboring.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
  }
}

export async function uploadRecording(
  recording: LocalRecording,
  options: {
    onProgress: (fraction: number) => void;
    /** Persists the upload id as soon as the server issues it. */
    onUploadId: (uploadId: string) => Promise<void>;
  },
): Promise<string> {
  const type = recording.mimeType || recording.chunks[0]?.type || 'audio/webm';
  const audio = new Blob(recording.chunks, { type });
  const partCount = Math.max(1, Math.ceil(audio.size / PART_BYTES));

  let uploadId = recording.uploadId ?? null;
  let present = new Set<number>();
  if (uploadId) {
    const existing = await api<{ parts?: number[] }>(`/api/quick/uploads/${uploadId}`, {});
    if (existing.status === 200) present = new Set(existing.body.parts ?? []);
    else uploadId = null; // Expired or unknown on this server: start a fresh upload.
  }
  if (!uploadId) {
    const started = await api<{ uploadId?: string; error?: string }>('/api/quick/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mimeType: type }),
    });
    if (started.status !== 201 || !started.body.uploadId) {
      throw new UploadError(started.body.error ?? `Server xatosi (${started.status})`);
    }
    uploadId = started.body.uploadId;
    await options.onUploadId(uploadId);
  }

  let done = present.size;
  options.onProgress(done / partCount);
  for (let index = 0; index < partCount; index += 1) {
    if (present.has(index)) continue;
    await putPart(uploadId, index, audio.slice(index * PART_BYTES, (index + 1) * PART_BYTES));
    done += 1;
    options.onProgress(done / partCount);
  }

  const finished = await api<{ id?: string; error?: string }>(
    `/api/quick/uploads/${uploadId}/finish`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        partCount,
        recordedMs: Math.round(recording.recordedMs),
        language: recording.language ?? 'uz',
        captureMode: recording.captureMode ?? 'mic',
      }),
    },
  );
  if (finished.status !== 201 || !finished.body.id) {
    throw new UploadError(finished.body.error ?? `Server xatosi (${finished.status})`);
  }
  return finished.body.id;
}
