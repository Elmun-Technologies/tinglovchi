import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MemoryStorageProvider,
  R2StorageProvider,
  buildRecordingChunkStorageKey,
  computeSha256Hex,
  createStorageProviderFromEnv,
  isMultipartOrMd5ETag,
  parseRecordingChunkStorageKey,
} from '@suhbat/database/storage';
import { redactObservabilityMetadata } from '@suhbat/database/phase4';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const meetingId = '22222222-2222-4222-8222-222222222222';
const recordingId = '33333333-3333-4333-8333-333333333333';
const sourceId = '44444444-4444-4444-8444-444444444444';

describe('Phase 4 — Storage Provider, Key Privacy, Checksum Verification & Redaction', () => {
  it('constructs canonical private object keys using UUIDs only and never meeting titles', () => {
    const key = buildRecordingChunkStorageKey({
      workspaceId,
      meetingId,
      recordingId,
      sourceId,
      sequenceNo: 7,
      container: 'wav',
    });
    expect(key).toBe(
      `workspace/${workspaceId}/meetings/${meetingId}/recordings/${recordingId}/sources/${sourceId}/chunks/000007.wav`,
    );

    const parsed = parseRecordingChunkStorageKey(key);
    expect(parsed).toEqual({
      workspaceId: workspaceId.toLowerCase(),
      meetingId: meetingId.toLowerCase(),
      recordingId: recordingId.toLowerCase(),
      sourceId: sourceId.toLowerCase(),
      sequenceNo: 7,
      container: 'wav',
    });

    // Rejects path traversal or free-form titles in storage keys
    expect(
      parseRecordingChunkStorageKey(
        `workspace/${workspaceId}/meetings/Confidential-Board-Meeting/recordings/${recordingId}/sources/${sourceId}/chunks/000007.wav`,
      ),
    ).toBeNull();
    expect(parseRecordingChunkStorageKey(`../secret/000001.wav`)).toBeNull();
  });

  it('never treats an S3/R2 MD5 or multipart ETag as a SHA-256 digest and verifies actual SHA-256 bytes', async () => {
    const bytes = new TextEncoder().encode('canonical-chunk-audio-payload');
    const sha256 = computeSha256Hex(bytes);
    const md5LikeEtag = '"d41d8cd98f00b204e9800998ecf8427e-2"';

    expect(isMultipartOrMd5ETag(md5LikeEtag)).toBe(true);
    expect(isMultipartOrMd5ETag('"d41d8cd98f00b204e9800998ecf8427e"')).toBe(true);

    // An R2 provider that returns an MD5/multipart ETag WITHOUT x-amz-checksum-sha256 or x-amz-meta-sha256
    // must NOT treat the ETag as a valid SHA-256 checksum
    const r2WithMd5Only = new R2StorageProvider(
      {
        accountId: 'example-account',
        bucket: 'suhbat-private-audio',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
      {
        fetchImpl: async () =>
          new Response(null, {
            status: 200,
            headers: {
              'content-length': String(bytes.byteLength),
              etag: md5LikeEtag,
              'content-type': 'audio/wav',
            },
          }),
      },
    );

    const key = buildRecordingChunkStorageKey({
      workspaceId,
      meetingId,
      recordingId,
      sourceId,
      sequenceNo: 0,
      container: 'wav',
    });

    const verified = await r2WithMd5Only.verifyObject({
      storageKey: key,
      expectedByteSize: bytes.byteLength,
      expectedSha256: sha256,
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.reason).toBe('checksum_unavailable');
      expect(verified.actualSha256).toBeNull();
    }
  });

  it('supports optional R2 SigV4 presigning without live credentials and fails closed in production when unconfigured', async () => {
    const requests: { url: string; method: string }[] = [];
    const bytes = new TextEncoder().encode('r2-audio-bytes');
    const sha256 = computeSha256Hex(bytes);

    const r2 = new R2StorageProvider(
      {
        accountId: 'example-account',
        bucket: 'suhbat-private-audio',
        endpoint: 'https://example-account.r2.cloudflarestorage.com',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
      {
        fetchImpl: async (input, init) => {
          const url = typeof input === 'string' ? input : input.toString();
          const method = init?.method ?? 'GET';
          requests.push({ url, method });
          if (method === 'HEAD') {
            return new Response(null, {
              status: 200,
              headers: {
                'content-length': String(bytes.byteLength),
                etag: `"${sha256}"`,
                'x-amz-meta-sha256': sha256,
                'content-type': 'audio/wav',
              },
            });
          }
          if (method === 'DELETE') {
            return new Response(null, { status: 204 });
          }
          return new Response(bytes, { status: 200 });
        },
      },
    );

    const key = buildRecordingChunkStorageKey({
      workspaceId,
      meetingId,
      recordingId,
      sourceId,
      sequenceNo: 2,
      container: 'wav',
    });

    const presigned = await r2.createUploadAuthorization({
      storageKey: key,
      contentType: 'audio/wav',
      expectedByteSize: bytes.byteLength,
      expectedSha256: sha256,
      expiresInSeconds: 300,
      now: new Date('2026-10-07T10:00:00.000Z'),
    });

    expect(presigned.method).toBe('PUT');
    expect(presigned.uploadUrl).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(presigned.uploadUrl).toContain('X-Amz-Signature=');
    expect(presigned.uploadUrl).not.toContain('wJalrXUtnFEMI');

    const head = await r2.headObject(key);
    expect(head?.byteSize).toBe(bytes.byteLength);
    expect(head?.sha256).toBe(sha256);

    const del = await r2.deleteObject(key);
    expect(del.deleted).toBe(true);
    expect(requests.map((r) => r.method)).toEqual(['HEAD', 'DELETE']);

    // Fails closed in production if R2 env vars are missing
    expect(() =>
      createStorageProviderFromEnv({
        NODE_ENV: 'production',
      }),
    ).toThrow(/Production environment requires STORAGE_PROVIDER=r2/);

    // Defaults to MemoryStorageProvider in development/test
    const devProvider = createStorageProviderFromEnv({
      NODE_ENV: 'test',
      STORAGE_PROVIDER: 'memory',
    });
    expect(devProvider).toBeInstanceOf(MemoryStorageProvider);
  });

  it('redacts sensitive secrets, signed URLs, auth tokens, and audio bytes from structured observability metadata', () => {
    const redacted = redactObservabilityMetadata({
      workspaceId,
      chunkId: 'chunk-1',
      uploadUrl: 'https://r2.example.com/presigned?X-Amz-Signature=secret123',
      authorizationHeader: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      rawAudioBytes: new Uint8Array([1, 2, 3, 4]),
      serviceRoleKey: 'sb_secret_123',
      byteSize: 4096,
    });

    expect(redacted.workspaceId).toBe(workspaceId);
    expect(redacted.chunkId).toBe('chunk-1');
    expect(redacted.byteSize).toBe(4096);
    expect(redacted.uploadUrl).toBe('[REDACTED]');
    expect(redacted.authorizationHeader).toBe('[REDACTED]');
    expect(redacted.rawAudioBytes).toBe('[REDACTED]');
    expect(redacted.serviceRoleKey).toBe('[REDACTED]');
  });

  it('keeps public database config and desktop renderer free of service-role keys and forbidden AI/STT/Telegram SDKs', () => {
    const dbConfigSrc = readFileSync(resolve('packages/database/src/config.ts'), 'utf8');
    expect(dbConfigSrc).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(dbConfigSrc).not.toContain('R2_SECRET_ACCESS_KEY');

    const rootPkg = readFileSync(resolve('package.json'), 'utf8');
    expect(rootPkg).not.toContain('openai');
    expect(rootPkg).not.toContain('assemblyai');
    expect(rootPkg).not.toContain('telegraf');
  });
});
