import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  RESOURCE_ID_SCHEMA_PATTERN,
  audioContainerExtSchema,
  type AudioContainerExt,
  type StorageBackend,
} from '@suhbat/contracts';

const UUID_REGEX = new RegExp(RESOURCE_ID_SCHEMA_PATTERN.source, 'i');

const CANONICAL_KEY_REGEX =
  /^workspace\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/meetings\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/recordings\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/sources\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/chunks\/([0-9]{6})\.(wav|ogg|opus|flac|m4a)$/;

const CANONICAL_TRANSCRIPTION_ASSET_KEY_REGEX =
  /^workspace\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/meetings\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/recordings\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/transcription-assets\/v([0-9]{4})\.(wav|ogg|opus|flac|m4a)$/;

export type CanonicalChunkKeyScope = {
  workspaceId: string;
  meetingId: string;
  recordingId: string;
  sourceId: string;
  sequenceNo: number;
  container: AudioContainerExt;
};

export type CanonicalTranscriptionAssetKeyScope = {
  workspaceId: string;
  meetingId: string;
  recordingId: string;
  assetVersion: number;
  container: AudioContainerExt;
};

export function computeSha256Hex(data: Uint8Array | Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256HexToBase64(sha256Hex: string): string {
  if (!/^[0-9a-f]{64}$/i.test(sha256Hex)) {
    throw new Error('Expected a 64-character hexadecimal SHA-256 digest.');
  }
  return Buffer.from(sha256Hex, 'hex').toString('base64');
}

export function sha256Base64ToHex(sha256Base64: string): string | null {
  try {
    const buf = Buffer.from(sha256Base64, 'base64');
    if (buf.length !== 32) return null;
    return buf.toString('hex');
  } catch {
    return null;
  }
}

/**
 * S3/R2 ETags are commonly MD5 digests (32 hex chars) or multipart digests (`<hex>-<parts>`).
 * Never treat an ETag as a SHA-256 checksum.
 */
export function isMultipartOrMd5ETag(etag: string | null | undefined): boolean {
  if (!etag) return false;
  const cleaned = etag.replace(/^"+|"+$/g, '').trim();
  return cleaned.includes('-') || /^[0-9a-f]{32}$/i.test(cleaned);
}

/**
 * Builds a private canonical object key from verified UUIDs and sequence number.
 * User-supplied meeting titles or filenames are never included in storage keys.
 */
export function buildRecordingChunkStorageKey(scope: CanonicalChunkKeyScope): string {
  for (const [label, id] of [
    ['workspaceId', scope.workspaceId],
    ['meetingId', scope.meetingId],
    ['recordingId', scope.recordingId],
    ['sourceId', scope.sourceId],
  ] as const) {
    if (!UUID_REGEX.test(id)) {
      throw new Error(`Invalid ${label} for canonical storage key.`);
    }
  }
  if (!Number.isInteger(scope.sequenceNo) || scope.sequenceNo < 0 || scope.sequenceNo > 999_999) {
    throw new Error('Invalid sequenceNo for canonical storage key.');
  }
  const container = audioContainerExtSchema.parse(scope.container);
  const paddedSequence = String(scope.sequenceNo).padStart(6, '0');
  return [
    'workspace',
    scope.workspaceId.toLowerCase(),
    'meetings',
    scope.meetingId.toLowerCase(),
    'recordings',
    scope.recordingId.toLowerCase(),
    'sources',
    scope.sourceId.toLowerCase(),
    'chunks',
    `${paddedSequence}.${container}`,
  ].join('/');
}

export function parseRecordingChunkStorageKey(storageKey: string): CanonicalChunkKeyScope | null {
  if (storageKey.includes('..') || storageKey.includes('?') || storageKey.includes('#')) {
    return null;
  }
  const match = CANONICAL_KEY_REGEX.exec(storageKey);
  if (!match) return null;
  return {
    workspaceId: match[1]!,
    meetingId: match[2]!,
    recordingId: match[3]!,
    sourceId: match[4]!,
    sequenceNo: Number.parseInt(match[5]!, 10),
    container: match[6] as AudioContainerExt,
  };
}

export function buildTranscriptionAssetStorageKey(
  scope: CanonicalTranscriptionAssetKeyScope,
): string {
  for (const [label, id] of [
    ['workspaceId', scope.workspaceId],
    ['meetingId', scope.meetingId],
    ['recordingId', scope.recordingId],
  ] as const) {
    if (!UUID_REGEX.test(id)) {
      throw new Error(`Invalid ${label} for canonical transcription asset storage key.`);
    }
  }
  if (
    !Number.isInteger(scope.assetVersion) ||
    scope.assetVersion <= 0 ||
    scope.assetVersion > 9999
  ) {
    throw new Error('Invalid assetVersion for canonical transcription asset storage key.');
  }
  const container = audioContainerExtSchema.parse(scope.container);
  const paddedVersion = String(scope.assetVersion).padStart(4, '0');
  return [
    'workspace',
    scope.workspaceId.toLowerCase(),
    'meetings',
    scope.meetingId.toLowerCase(),
    'recordings',
    scope.recordingId.toLowerCase(),
    'transcription-assets',
    `v${paddedVersion}.${container}`,
  ].join('/');
}

export function parseTranscriptionAssetStorageKey(
  storageKey: string,
): CanonicalTranscriptionAssetKeyScope | null {
  if (storageKey.includes('..') || storageKey.includes('?') || storageKey.includes('#')) {
    return null;
  }
  const match = CANONICAL_TRANSCRIPTION_ASSET_KEY_REGEX.exec(storageKey);
  if (!match) return null;
  return {
    workspaceId: match[1]!,
    meetingId: match[2]!,
    recordingId: match[3]!,
    assetVersion: Number.parseInt(match[4]!, 10),
    container: match[5] as AudioContainerExt,
  };
}

export function isCanonicalPrivateStorageKey(storageKey: string): boolean {
  return (
    parseRecordingChunkStorageKey(storageKey) !== null ||
    parseTranscriptionAssetStorageKey(storageKey) !== null
  );
}

export function assertPrivateCanonicalStorageKey(
  storageKey: string,
  expected: CanonicalChunkKeyScope,
): void {
  const expectedKey = buildRecordingChunkStorageKey(expected);
  if (storageKey !== expectedKey) {
    throw new Error(
      'Storage key does not match the canonical workspace/meeting/recording/source key.',
    );
  }
}

export type CreateUploadAuthorizationInput = {
  storageKey: string;
  expectedByteSize: number;
  expectedSha256: string;
  contentType?: string;
  expiresInSeconds?: number;
  now?: Date;
};

export type UploadAuthorization = {
  authorizationId: string;
  storageBackend: StorageBackend;
  storageKey: string;
  method: 'PUT';
  uploadUrl: string;
  headers: Record<string, string>;
  expiresAt: string;
};

export type CreateReadAuthorizationInput = {
  storageKey: string;
  expiresInSeconds?: number;
  now?: Date;
};

export type ReadAuthorization = {
  storageBackend: StorageBackend;
  storageKey: string;
  method: 'GET';
  readUrl: string;
  expiresAt: string;
};

export type StoredObjectMetadata = {
  storageBackend: StorageBackend;
  storageKey: string;
  byteSize: number;
  /** Verified SHA-256 hex digest of object bytes; null if provider could not supply SHA-256. */
  sha256: string | null;
  /** Raw provider ETag (never substituted for SHA-256). */
  eTag: string | null;
  contentType: string | null;
  uploadedAt: string;
  verificationMethod:
    'digest_computed_from_bytes' | 'provider_checksum_sha256' | 'signed_metadata_sha256';
};

export type VerifyObjectInput = {
  storageKey: string;
  expectedByteSize: number;
  expectedSha256: string;
};

export type ObjectVerificationFailureReason =
  | 'object_missing'
  | 'size_mismatch'
  | 'checksum_mismatch'
  | 'checksum_unavailable'
  | 'storage_error';

export type ObjectVerificationResult =
  | {
      ok: true;
      metadata: StoredObjectMetadata;
      verificationMethod: StoredObjectMetadata['verificationMethod'];
    }
  | {
      ok: false;
      reason: ObjectVerificationFailureReason;
      detail: string;
      actualByteSize: number | null;
      actualSha256: string | null;
    };

export type DeleteObjectResult = {
  deleted: boolean;
  alreadyAbsent: boolean;
};

export interface StorageProvider {
  readonly backend: StorageBackend;
  createUploadAuthorization(input: CreateUploadAuthorizationInput): Promise<UploadAuthorization>;
  headObject(storageKey: string): Promise<StoredObjectMetadata | null>;
  getObjectMetadata(storageKey: string): Promise<StoredObjectMetadata | null>;
  verifyObject(input: VerifyObjectInput): Promise<ObjectVerificationResult>;
  deleteObject(storageKey: string): Promise<DeleteObjectResult>;
  createReadAuthorization(input: CreateReadAuthorizationInput): Promise<ReadAuthorization>;
  getObjectBytes?(storageKey: string): Promise<Uint8Array | null> | Uint8Array | null;
  putObjectBytes?(
    storageKey: string,
    bytes: Uint8Array,
    options?: { contentType?: string; now?: Date },
  ): Promise<StoredObjectMetadata> | StoredObjectMetadata;
}

export class StorageProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = true) {
    super(message);
    this.name = 'StorageProviderError';
    this.code = code;
    this.retryable = retryable;
  }
}

export async function verifyStoredObjectWithProvider(
  provider: Pick<StorageProvider, 'getObjectMetadata'>,
  input: VerifyObjectInput,
): Promise<ObjectVerificationResult> {
  if (!isCanonicalPrivateStorageKey(input.storageKey)) {
    return {
      ok: false,
      reason: 'storage_error',
      detail: 'Storage key is not a canonical private storage key.',
      actualByteSize: null,
      actualSha256: null,
    };
  }

  let metadata: StoredObjectMetadata | null;
  try {
    metadata = await provider.getObjectMetadata(input.storageKey);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      reason: 'storage_error',
      detail: `Failed to query object storage metadata: ${message}`,
      actualByteSize: null,
      actualSha256: null,
    };
  }

  if (!metadata) {
    return {
      ok: false,
      reason: 'object_missing',
      detail: 'Expected object does not exist in private object storage.',
      actualByteSize: null,
      actualSha256: null,
    };
  }

  if (metadata.byteSize !== input.expectedByteSize) {
    return {
      ok: false,
      reason: 'size_mismatch',
      detail: `Object byte size (${metadata.byteSize}) does not match expected byte size (${input.expectedByteSize}).`,
      actualByteSize: metadata.byteSize,
      actualSha256: metadata.sha256,
    };
  }

  if (!metadata.sha256) {
    return {
      ok: false,
      reason: 'checksum_unavailable',
      detail: 'Object storage metadata did not expose a verifiable SHA-256 digest.',
      actualByteSize: metadata.byteSize,
      actualSha256: null,
    };
  }

  if (metadata.sha256.toLowerCase() !== input.expectedSha256.toLowerCase()) {
    return {
      ok: false,
      reason: 'checksum_mismatch',
      detail: 'Stored object SHA-256 digest does not match expected chunk checksum.',
      actualByteSize: metadata.byteSize,
      actualSha256: metadata.sha256,
    };
  }

  return {
    ok: true,
    metadata,
    verificationMethod: metadata.verificationMethod,
  };
}

type StoredMemoryRecord = {
  bytes: Uint8Array;
  metadata: StoredObjectMetadata;
};

type IssuedUploadToken = {
  authorizationId: string;
  storageKey: string;
  expectedByteSize: number;
  expectedSha256: string;
  contentType: string;
  expiresAtMs: number;
  signature: string;
};

export const MAX_CHUNK_UPLOAD_BYTE_SIZE = 512 * 1024 * 1024; // 512 MiB hard upload ceiling per chunk

/**
 * Deterministic in-memory/development storage provider.
 *
 * Simulates private S3/R2 signed upload URLs, real SHA-256 digest calculation over uploaded bytes,
 * metadata inspection, object deletion, and failure injection for tests without requiring external credentials.
 */
export class MemoryStorageProvider implements StorageProvider {
  readonly backend: StorageBackend;
  private readonly signingSecret: string;
  private readonly objects = new Map<string, StoredMemoryRecord>();
  private readonly issuedTokens = new Map<string, IssuedUploadToken>();
  private readonly failingDeleteKeys = new Map<string, string>();
  private temporaryOutageMessage: string | null = null;

  constructor(options: { backend?: StorageBackend; signingSecret?: string } = {}) {
    this.backend = options.backend ?? 'memory';
    this.signingSecret = options.signingSecret ?? randomBytes(32).toString('hex');
  }

  setTemporaryOutage(message: string | null): void {
    this.temporaryOutageMessage = message;
  }

  private assertNotInOutage(): void {
    if (this.temporaryOutageMessage) {
      throw new StorageProviderError('storage_unavailable', this.temporaryOutageMessage, true);
    }
  }

  private signToken(payload: string): string {
    return createHmac('sha256', this.signingSecret).update(payload).digest('hex');
  }

  async createUploadAuthorization(
    input: CreateUploadAuthorizationInput,
  ): Promise<UploadAuthorization> {
    if (!isCanonicalPrivateStorageKey(input.storageKey)) {
      throw new StorageProviderError(
        'invalid_storage_key',
        'Refusing to authorize upload for a non-canonical storage key.',
        false,
      );
    }
    if (
      !Number.isInteger(input.expectedByteSize) ||
      input.expectedByteSize <= 0 ||
      input.expectedByteSize > MAX_CHUNK_UPLOAD_BYTE_SIZE
    ) {
      throw new StorageProviderError(
        'invalid_byte_size',
        `Expected byte size must be a positive integer up to ${MAX_CHUNK_UPLOAD_BYTE_SIZE} bytes.`,
        false,
      );
    }
    if (!/^[0-9a-f]{64}$/i.test(input.expectedSha256)) {
      throw new StorageProviderError(
        'invalid_checksum',
        'Expected SHA-256 checksum must be a 64-character hex digest.',
        false,
      );
    }

    const nowMs = (input.now ?? new Date()).getTime();
    const ttlSeconds = Math.min(Math.max(input.expiresInSeconds ?? 300, 1), 900);
    const expiresAtMs = nowMs + ttlSeconds * 1000;
    const expiresAt = new Date(expiresAtMs).toISOString();
    const authorizationId = randomBytes(16).toString('hex');
    const contentType = input.contentType ?? 'audio/wav';
    const canonicalPayload = [
      authorizationId,
      input.storageKey,
      String(input.expectedByteSize),
      input.expectedSha256.toLowerCase(),
      String(expiresAtMs),
    ].join(':');
    const signature = this.signToken(canonicalPayload);

    this.issuedTokens.set(authorizationId, {
      authorizationId,
      storageKey: input.storageKey,
      expectedByteSize: input.expectedByteSize,
      expectedSha256: input.expectedSha256.toLowerCase(),
      contentType,
      expiresAtMs,
      signature,
    });

    return {
      authorizationId,
      storageBackend: this.backend,
      storageKey: input.storageKey,
      method: 'PUT',
      uploadUrl: `storage://${this.backend}/${input.storageKey}?auth=${authorizationId}&exp=${expiresAtMs}&sig=${signature}`,
      headers: {
        'content-type': contentType,
        'content-length': String(input.expectedByteSize),
        'x-amz-checksum-sha256': sha256HexToBase64(input.expectedSha256),
      },
      expiresAt,
    };
  }

  /**
   * Simulates the client uploading raw chunk bytes directly to private object storage using a signed capability.
   * Computes the true SHA-256 digest and byte size from the uploaded payload so server verification is genuine.
   */
  async putObjectViaSignedUrl(
    uploadUrl: string,
    bytes: Uint8Array | Buffer,
    options: { now?: Date } = {},
  ): Promise<StoredObjectMetadata> {
    let parsed: URL;
    try {
      parsed = new URL(uploadUrl);
    } catch {
      throw new StorageProviderError('invalid_upload_url', 'Malformed signed upload URL.', false);
    }

    const authId = parsed.searchParams.get('auth') ?? '';
    const sig = parsed.searchParams.get('sig') ?? '';
    const token = this.issuedTokens.get(authId);
    if (!token || token.signature !== sig) {
      throw new StorageProviderError(
        'invalid_upload_signature',
        'Signed upload authorization is invalid or unknown.',
        false,
      );
    }

    const nowMs = (options.now ?? new Date()).getTime();
    if (nowMs > token.expiresAtMs) {
      throw new StorageProviderError(
        'upload_url_expired',
        'Signed upload authorization has expired.',
        true,
      );
    }

    return this.storeObjectBytes(token.storageKey, bytes, {
      contentType: token.contentType,
      now: options.now,
    });
  }

  /**
   * Stores object bytes at `storageKey` and computes true byte size, MD5-style ETag, and SHA-256 digest.
   */
  storeObjectBytes(
    storageKey: string,
    bytes: Uint8Array | Buffer,
    options: {
      contentType?: string;
      now?: Date;
      overrideSha256?: string | null;
      verificationMethod?: StoredObjectMetadata['verificationMethod'];
    } = {},
  ): StoredObjectMetadata {
    if (!isCanonicalPrivateStorageKey(storageKey)) {
      throw new StorageProviderError(
        'invalid_storage_key',
        'Cannot store object under non-canonical storage key.',
        false,
      );
    }
    const copy = new Uint8Array(bytes);
    const actualSha256 =
      options.overrideSha256 !== undefined ? options.overrideSha256 : computeSha256Hex(copy);
    // Simulate realistic S3/R2 multipart/MD5 ETag so tests prove verification never confuses ETag with SHA-256.
    const md5Hex = createHash('md5').update(copy).digest('hex');
    const metadata: StoredObjectMetadata = {
      storageBackend: this.backend,
      storageKey,
      byteSize: copy.byteLength,
      sha256: actualSha256,
      eTag: `"${md5Hex}-1"`,
      contentType: options.contentType ?? 'audio/wav',
      uploadedAt: (options.now ?? new Date()).toISOString(),
      verificationMethod: options.verificationMethod ?? 'digest_computed_from_bytes',
    };
    this.objects.set(storageKey, { bytes: copy, metadata });
    return metadata;
  }

  getObjectBytes(storageKey: string): Uint8Array | null {
    this.assertNotInOutage();
    const record = this.objects.get(storageKey);
    return record ? new Uint8Array(record.bytes) : null;
  }

  putObjectBytes(
    storageKey: string,
    bytes: Uint8Array,
    options?: { contentType?: string; now?: Date },
  ): StoredObjectMetadata {
    this.assertNotInOutage();
    return this.storeObjectBytes(storageKey, bytes, options);
  }

  async headObject(storageKey: string): Promise<StoredObjectMetadata | null> {
    this.assertNotInOutage();
    const record = this.objects.get(storageKey);
    return record ? { ...record.metadata } : null;
  }

  async getObjectMetadata(storageKey: string): Promise<StoredObjectMetadata | null> {
    return this.headObject(storageKey);
  }

  async verifyObject(input: VerifyObjectInput): Promise<ObjectVerificationResult> {
    return verifyStoredObjectWithProvider(this, input);
  }

  async deleteObject(storageKey: string): Promise<DeleteObjectResult> {
    this.assertNotInOutage();
    const injectedFailure = this.failingDeleteKeys.get(storageKey);
    if (injectedFailure) {
      throw new StorageProviderError('storage_delete_failed', injectedFailure, true);
    }
    const existed = this.objects.delete(storageKey);
    return {
      deleted: existed,
      alreadyAbsent: !existed,
    };
  }

  async createReadAuthorization(input: CreateReadAuthorizationInput): Promise<ReadAuthorization> {
    if (!isCanonicalPrivateStorageKey(input.storageKey)) {
      throw new StorageProviderError(
        'invalid_storage_key',
        'Refusing to authorize read for a non-canonical storage key.',
        false,
      );
    }
    const nowMs = (input.now ?? new Date()).getTime();
    const ttlSeconds = Math.min(Math.max(input.expiresInSeconds ?? 120, 1), 600);
    const expiresAtMs = nowMs + ttlSeconds * 1000;
    const sig = this.signToken(`GET:${input.storageKey}:${expiresAtMs}`);
    return {
      storageBackend: this.backend,
      storageKey: input.storageKey,
      method: 'GET',
      readUrl: `storage://${this.backend}/${input.storageKey}?op=read&exp=${expiresAtMs}&sig=${sig}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  failDeleteForKey(storageKey: string, reason = 'Simulated object store delete failure'): void {
    this.failingDeleteKeys.set(storageKey, reason);
  }

  clearDeleteFailureForKey(storageKey: string): void {
    this.failingDeleteKeys.delete(storageKey);
  }

  hasObject(storageKey: string): boolean {
    return this.objects.has(storageKey);
  }

  listKeys(): string[] {
    return [...this.objects.keys()].sort();
  }
}

/**
 * Disk-backed private object storage provider (`LocalDiskStorageProvider`).
 *
 * Persists object payloads directly on disk under `rootDir` (avoiding keeping large PCM WAV files in RAM)
 * while maintaining the exact signed upload/read authorization and SHA-256 verification semantics.
 */
export class LocalDiskStorageProvider extends MemoryStorageProvider {
  readonly rootDir: string;
  private readonly diskMetadata = new Map<string, StoredObjectMetadata>();

  constructor(options: { rootDir: string; signingSecret?: string }) {
    super({ backend: 'local', signingSecret: options.signingSecret });
    this.rootDir = options.rootDir;
    mkdirSync(this.rootDir, { recursive: true });
  }

  private resolveDiskPath(storageKey: string): string {
    if (!isCanonicalPrivateStorageKey(storageKey)) {
      throw new StorageProviderError(
        'invalid_storage_key',
        'Cannot resolve disk path for non-canonical storage key.',
        false,
      );
    }
    return join(this.rootDir, storageKey);
  }

  override storeObjectBytes(
    storageKey: string,
    bytes: Uint8Array | Buffer,
    options: {
      contentType?: string;
      now?: Date;
      overrideSha256?: string | null;
      verificationMethod?: StoredObjectMetadata['verificationMethod'];
    } = {},
  ): StoredObjectMetadata {
    const filePath = this.resolveDiskPath(storageKey);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, bytes);
    const actualSha256 =
      options.overrideSha256 !== undefined ? options.overrideSha256 : computeSha256Hex(bytes);
    const md5Hex = createHash('md5').update(bytes).digest('hex');
    const metadata: StoredObjectMetadata = {
      storageBackend: 'local',
      storageKey,
      byteSize: bytes.byteLength,
      sha256: actualSha256,
      eTag: `"${md5Hex}-1"`,
      contentType: options.contentType ?? 'audio/wav',
      uploadedAt: (options.now ?? new Date()).toISOString(),
      verificationMethod: options.verificationMethod ?? 'digest_computed_from_bytes',
    };
    this.diskMetadata.set(storageKey, metadata);
    return metadata;
  }

  override getObjectBytes(storageKey: string): Uint8Array | null {
    const filePath = this.resolveDiskPath(storageKey);
    if (!existsSync(filePath)) return null;
    return new Uint8Array(readFileSync(filePath));
  }

  override async headObject(storageKey: string): Promise<StoredObjectMetadata | null> {
    const meta = this.diskMetadata.get(storageKey);
    if (!meta) return null;
    const filePath = this.resolveDiskPath(storageKey);
    if (!existsSync(filePath)) return null;
    return { ...meta };
  }

  override async deleteObject(storageKey: string): Promise<DeleteObjectResult> {
    const filePath = this.resolveDiskPath(storageKey);
    const existed = existsSync(filePath);
    if (existed) {
      rmSync(filePath, { force: true });
    }
    this.diskMetadata.delete(storageKey);
    return {
      deleted: existed,
      alreadyAbsent: !existed,
    };
  }

  override hasObject(storageKey: string): boolean {
    const filePath = this.resolveDiskPath(storageKey);
    return existsSync(filePath);
  }

  override listKeys(): string[] {
    return [...this.diskMetadata.keys()].sort();
  }
}

export type R2StorageConfig = {
  accountId: string;
  bucket: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
};

function amzDateParts(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

function uriEncodePath(path: string): string {
  return path
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');
}

/**
 * Cloudflare R2 / S3-compatible private object storage adapter.
 *
 * Uses AWS Signature V4 (`AWS4-HMAC-SHA256`) and binds `x-amz-checksum-sha256` on uploads.
 * Does not require credentials at compile or test time; credentials are injected via runtime configuration.
 *
 * Checksum verification note:
 * R2/S3 supports `x-amz-checksum-sha256` (returned on HEAD when requested with `x-amz-checksum-mode: ENABLED`)
 * and `x-amz-meta-sha256`. Multipart/MD5 `ETag` headers are never accepted as SHA-256 digests.
 */
export class R2StorageProvider implements StorageProvider {
  readonly backend: StorageBackend = 'r2';
  private readonly config: Required<R2StorageConfig>;
  private readonly fetchImpl: typeof fetch;

  constructor(config: R2StorageConfig, options: { fetchImpl?: typeof fetch } = {}) {
    const accountId = config.accountId.trim();
    const bucket = config.bucket.trim();
    const accessKeyId = config.accessKeyId.trim();
    const secretAccessKey = config.secretAccessKey.trim();
    if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
      throw new StorageProviderError(
        'r2_not_configured',
        'R2StorageProvider requires accountId, bucket, accessKeyId, and secretAccessKey.',
        false,
      );
    }
    const endpoint = (
      config.endpoint?.trim() || `https://${accountId}.r2.cloudflarestorage.com`
    ).replace(/\/+$/, '');
    const parsedEndpoint = new URL(endpoint);
    if (parsedEndpoint.protocol !== 'https:') {
      throw new StorageProviderError('r2_invalid_endpoint', 'R2 endpoint must use HTTPS.', false);
    }

    this.config = {
      accountId,
      bucket,
      endpoint,
      accessKeyId,
      secretAccessKey,
      region: config.region?.trim() || 'auto',
    };
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  private buildPresignedUrl(params: {
    method: 'PUT' | 'GET';
    storageKey: string;
    expiresInSeconds: number;
    now: Date;
    signedHeaders?: Record<string, string>;
  }): { url: string; expiresAt: string } {
    const ttl = Math.min(Math.max(params.expiresInSeconds, 1), 900);
    const { amzDate, dateStamp } = amzDateParts(params.now);
    const endpointUrl = new URL(this.config.endpoint);
    const host = endpointUrl.host;
    const canonicalUri = uriEncodePath(`/${this.config.bucket}/${params.storageKey}`);
    const credentialScope = `${dateStamp}/${this.config.region}/s3/aws4_request`;

    const headerMap: Record<string, string> = {
      host,
      ...Object.fromEntries(
        Object.entries(params.signedHeaders ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()]),
      ),
    };
    const sortedHeaderKeys = Object.keys(headerMap).sort();
    const signedHeadersList = sortedHeaderKeys.join(';');
    const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${headerMap[k]}\n`).join('');

    const queryEntries: Array<[string, string]> = [
      ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
      ['X-Amz-Credential', `${this.config.accessKeyId}/${credentialScope}`],
      ['X-Amz-Date', amzDate],
      ['X-Amz-Expires', String(ttl)],
      ['X-Amz-SignedHeaders', signedHeadersList],
    ];
    queryEntries.sort(([a], [b]) => a.localeCompare(b));
    const canonicalQuery = queryEntries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    const canonicalRequest = [
      params.method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeadersList,
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
    ].join('\n');

    const signingKey = deriveSigningKey(
      this.config.secretAccessKey,
      dateStamp,
      this.config.region,
      's3',
    );
    const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

    const url = `${this.config.endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
    const expiresAt = new Date(params.now.getTime() + ttl * 1000).toISOString();
    return { url, expiresAt };
  }

  private signRequestHeaders(params: {
    method: 'HEAD' | 'DELETE';
    storageKey: string;
    now: Date;
    extraHeaders?: Record<string, string>;
  }): { url: string; headers: Record<string, string> } {
    const { amzDate, dateStamp } = amzDateParts(params.now);
    const endpointUrl = new URL(this.config.endpoint);
    const host = endpointUrl.host;
    const canonicalUri = uriEncodePath(`/${this.config.bucket}/${params.storageKey}`);
    const emptyPayloadHash = createHash('sha256').update('').digest('hex');
    const credentialScope = `${dateStamp}/${this.config.region}/s3/aws4_request`;

    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': emptyPayloadHash,
      'x-amz-date': amzDate,
      ...(params.extraHeaders ?? {}),
    };
    const sortedKeys = Object.keys(headers).sort();
    const signedHeaders = sortedKeys.join(';');
    const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}\n`).join('');

    const canonicalRequest = [
      params.method,
      canonicalUri,
      '',
      canonicalHeaders,
      signedHeaders,
      emptyPayloadHash,
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
    ].join('\n');

    const signingKey = deriveSigningKey(
      this.config.secretAccessKey,
      dateStamp,
      this.config.region,
      's3',
    );
    const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

    return {
      url: `${this.config.endpoint}${canonicalUri}`,
      headers: {
        ...headers,
        authorization: `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
    };
  }

  async createUploadAuthorization(
    input: CreateUploadAuthorizationInput,
  ): Promise<UploadAuthorization> {
    if (!isCanonicalPrivateStorageKey(input.storageKey)) {
      throw new StorageProviderError(
        'invalid_storage_key',
        'Refusing to authorize upload for a non-canonical storage key.',
        false,
      );
    }
    if (
      !Number.isInteger(input.expectedByteSize) ||
      input.expectedByteSize <= 0 ||
      input.expectedByteSize > MAX_CHUNK_UPLOAD_BYTE_SIZE
    ) {
      throw new StorageProviderError(
        'invalid_byte_size',
        `Expected byte size must be a positive integer up to ${MAX_CHUNK_UPLOAD_BYTE_SIZE} bytes.`,
        false,
      );
    }
    if (!/^[0-9a-f]{64}$/i.test(input.expectedSha256)) {
      throw new StorageProviderError(
        'invalid_checksum',
        'Expected SHA-256 checksum must be a 64-character hex digest.',
        false,
      );
    }
    const now = input.now ?? new Date();
    const contentType = input.contentType ?? 'audio/wav';
    const checksumBase64 = sha256HexToBase64(input.expectedSha256);
    const headers: Record<string, string> = {
      'content-type': contentType,
      'content-length': String(input.expectedByteSize),
      'x-amz-checksum-sha256': checksumBase64,
      'x-amz-meta-sha256': input.expectedSha256.toLowerCase(),
    };
    const { url, expiresAt } = this.buildPresignedUrl({
      method: 'PUT',
      storageKey: input.storageKey,
      expiresInSeconds: input.expiresInSeconds ?? 300,
      now,
      signedHeaders: {
        'x-amz-checksum-sha256': checksumBase64,
        'x-amz-meta-sha256': input.expectedSha256.toLowerCase(),
      },
    });
    return {
      authorizationId: randomBytes(16).toString('hex'),
      storageBackend: 'r2',
      storageKey: input.storageKey,
      method: 'PUT',
      uploadUrl: url,
      headers,
      expiresAt,
    };
  }

  async headObject(storageKey: string): Promise<StoredObjectMetadata | null> {
    const now = new Date();
    const { url, headers } = this.signRequestHeaders({
      method: 'HEAD',
      storageKey,
      now,
      extraHeaders: { 'x-amz-checksum-mode': 'ENABLED' },
    });
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: 'HEAD', headers });
    } catch {
      throw new StorageProviderError(
        'r2_network_error',
        'R2 HEAD request failed due to a network transport error.',
        true,
      );
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new StorageProviderError(
        'r2_head_failed',
        `R2 HEAD failed with HTTP ${response.status}.`,
        response.status >= 500 || response.status === 429,
      );
    }

    const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    const checksumHeaderBase64 = response.headers.get('x-amz-checksum-sha256');
    const metaSha256 = response.headers.get('x-amz-meta-sha256');
    const providerSha256 = checksumHeaderBase64 ? sha256Base64ToHex(checksumHeaderBase64) : null;
    const resolvedSha256 =
      providerSha256 ??
      (metaSha256 && /^[0-9a-f]{64}$/i.test(metaSha256) ? metaSha256.toLowerCase() : null);

    return {
      storageBackend: 'r2',
      storageKey,
      byteSize: Number.isFinite(contentLength) ? contentLength : 0,
      sha256: resolvedSha256,
      eTag: response.headers.get('etag'),
      contentType: response.headers.get('content-type'),
      uploadedAt: response.headers.get('last-modified') ?? now.toISOString(),
      verificationMethod: providerSha256 ? 'provider_checksum_sha256' : 'signed_metadata_sha256',
    };
  }

  async getObjectMetadata(storageKey: string): Promise<StoredObjectMetadata | null> {
    return this.headObject(storageKey);
  }

  async verifyObject(input: VerifyObjectInput): Promise<ObjectVerificationResult> {
    return verifyStoredObjectWithProvider(this, input);
  }

  async deleteObject(storageKey: string): Promise<DeleteObjectResult> {
    const now = new Date();
    const { url, headers } = this.signRequestHeaders({
      method: 'DELETE',
      storageKey,
      now,
    });
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: 'DELETE', headers });
    } catch {
      throw new StorageProviderError(
        'r2_network_error',
        'R2 DELETE request failed due to a network transport error.',
        true,
      );
    }
    if (response.status === 404) {
      return { deleted: false, alreadyAbsent: true };
    }
    if (!response.ok) {
      throw new StorageProviderError(
        'r2_delete_failed',
        `R2 DELETE failed with HTTP ${response.status}.`,
        response.status >= 500 || response.status === 429,
      );
    }
    return { deleted: true, alreadyAbsent: false };
  }

  async createReadAuthorization(input: CreateReadAuthorizationInput): Promise<ReadAuthorization> {
    if (!isCanonicalPrivateStorageKey(input.storageKey)) {
      throw new StorageProviderError(
        'invalid_storage_key',
        'Refusing to authorize read for a non-canonical storage key.',
        false,
      );
    }
    const now = input.now ?? new Date();
    const { url, expiresAt } = this.buildPresignedUrl({
      method: 'GET',
      storageKey: input.storageKey,
      expiresInSeconds: input.expiresInSeconds ?? 120,
      now,
    });
    return {
      storageBackend: 'r2',
      storageKey: input.storageKey,
      method: 'GET',
      readUrl: url,
      expiresAt,
    };
  }

  async getObjectBytes(storageKey: string): Promise<Uint8Array | null> {
    const auth = await this.createReadAuthorization({ storageKey, expiresInSeconds: 120 });
    let response: Response;
    try {
      response = await this.fetchImpl(auth.readUrl, { method: 'GET' });
    } catch {
      throw new StorageProviderError(
        'r2_network_error',
        'R2 GET request failed due to a network transport error.',
        true,
      );
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new StorageProviderError(
        'r2_get_failed',
        `R2 GET failed with HTTP ${response.status}.`,
        response.status >= 500 || response.status === 429,
      );
    }
    const buf = await response.arrayBuffer();
    return new Uint8Array(buf);
  }

  async putObjectBytes(
    storageKey: string,
    bytes: Uint8Array,
    options: { contentType?: string; now?: Date } = {},
  ): Promise<StoredObjectMetadata> {
    const sha256 = computeSha256Hex(bytes);
    const auth = await this.createUploadAuthorization({
      storageKey,
      expectedByteSize: bytes.byteLength,
      expectedSha256: sha256,
      contentType: options.contentType ?? 'audio/wav',
      now: options.now,
    });
    let response: Response;
    try {
      response = await this.fetchImpl(auth.uploadUrl, {
        method: 'PUT',
        headers: auth.headers,
        body: bytes as unknown as BodyInit,
      });
    } catch {
      throw new StorageProviderError(
        'r2_network_error',
        'R2 PUT request failed due to a network transport error.',
        true,
      );
    }
    if (!response.ok) {
      throw new StorageProviderError(
        'r2_put_failed',
        `R2 PUT failed with HTTP ${response.status}.`,
        response.status >= 500 || response.status === 429,
      );
    }
    return {
      storageBackend: 'r2',
      storageKey,
      byteSize: bytes.byteLength,
      sha256,
      eTag: response.headers.get('etag'),
      contentType: options.contentType ?? 'audio/wav',
      uploadedAt: (options.now ?? new Date()).toISOString(),
      verificationMethod: 'digest_computed_from_bytes',
    };
  }
}

export function createStorageProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): StorageProvider {
  const providerName = (env.STORAGE_PROVIDER ?? 'local').trim().toLowerCase();
  const isProd = env.NODE_ENV === 'production';

  if (providerName === 'r2') {
    return new R2StorageProvider({
      accountId: env.R2_ACCOUNT_ID ?? '',
      bucket: env.R2_BUCKET ?? '',
      endpoint: env.R2_ENDPOINT,
      accessKeyId: env.R2_ACCESS_KEY_ID ?? '',
      secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? '',
      region: env.R2_REGION ?? 'auto',
    });
  }

  if (isProd) {
    throw new StorageProviderError(
      'storage_provider_production_required',
      'Production environment requires STORAGE_PROVIDER=r2 with valid private R2 credentials; development/memory storage is not permitted in production.',
      false,
    );
  }

  if (providerName === 'local' || providerName === 'memory') {
    return new MemoryStorageProvider({
      backend: providerName === 'memory' ? 'memory' : 'local',
    });
  }

  throw new StorageProviderError(
    'unknown_storage_provider',
    `Unsupported STORAGE_PROVIDER "${providerName}".`,
    false,
  );
}
