import {
  type AudioContainerExt,
  type DiscontinuityReason,
  type ProviderTranscriptSegment,
  type ProviderTranscriptWord,
  type RecordingChunkDto,
  type RecordingDto,
  type RecordingSourceDto,
  type TranscriptionAssetPiece,
  type TranscriptionAssetSourceLineage,
  transcriptionAssetPieceSchema,
  transcriptionAssetSourceLineageSchema,
} from '@suhbat/contracts';
import {
  meetingTimeMsFromSourceSamples,
  sourceSamplesToDurationMs,
  validateChunkContinuity,
  type ChunkContinuityDiagnostic,
} from '@suhbat/shared';
import { buildTranscriptionAssetStorageKey, computeSha256Hex } from './storage';

const SOURCE_KIND_PRIORITY: Record<RecordingSourceDto['sourceKind'], number> = {
  mixed_rendered: 0,
  microphone: 1,
  system_audio: 2,
};

export const WAV_MEDIA_ENGINE_VERSION = 'suhbat-wav-assembler/1.0.0' as const;

export type ParsedWavHeader = {
  audioFormat: number;
  channels: number;
  sampleRateHz: number;
  bitsPerSample: number;
  blockAlign: number;
  byteRate: number;
  dataOffset: number;
  dataByteLength: number;
  frameCount: number;
  durationMs: number;
};

/**
 * Deterministically parses and validates a RIFF/WAVE PCM16le audio buffer.
 */
export function parseWavPcm16(bytes: Uint8Array): ParsedWavHeader {
  if (bytes.byteLength < 44) {
    throw new Error(
      `Invalid WAV buffer: byte length ${bytes.byteLength} is smaller than 44-byte RIFF header.`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readFourCc = (offset: number): string =>
    String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);

  if (readFourCc(0) !== 'RIFF' || readFourCc(8) !== 'WAVE') {
    throw new Error('Invalid WAV buffer: missing RIFF/WAVE magic header.');
  }

  const riffChunkSize = view.getUint32(4, true);
  if (riffChunkSize + 8 > bytes.byteLength) {
    throw new Error(
      `Invalid WAV buffer: RIFF chunk size (${riffChunkSize + 8}) exceeds buffer byte length (${bytes.byteLength}).`,
    );
  }

  let cursor = 12;
  let audioFormat: number | null = null;
  let channels: number | null = null;
  let sampleRateHz: number | null = null;
  let byteRate: number | null = null;
  let blockAlign: number | null = null;
  let bitsPerSample: number | null = null;
  let dataOffset: number | null = null;
  let dataByteLength: number | null = null;

  while (cursor + 8 <= bytes.byteLength) {
    const chunkId = readFourCc(cursor);
    const chunkSize = view.getUint32(cursor + 4, true);
    const payloadStart = cursor + 8;

    if (chunkId === 'fmt ') {
      if (chunkSize < 16 || payloadStart + chunkSize > bytes.byteLength) {
        throw new Error('Invalid WAV buffer: truncated fmt subchunk.');
      }
      audioFormat = view.getUint16(payloadStart, true);
      channels = view.getUint16(payloadStart + 2, true);
      sampleRateHz = view.getUint32(payloadStart + 4, true);
      byteRate = view.getUint32(payloadStart + 8, true);
      blockAlign = view.getUint16(payloadStart + 12, true);
      bitsPerSample = view.getUint16(payloadStart + 14, true);
    } else if (chunkId === 'data') {
      if (payloadStart + chunkSize > bytes.byteLength) {
        throw new Error('Invalid WAV buffer: data subchunk exceeds buffer bounds.');
      }
      dataOffset = payloadStart;
      dataByteLength = chunkSize;
      break;
    }

    const paddedSize = chunkSize + (chunkSize % 2);
    cursor = payloadStart + paddedSize;
  }

  if (
    audioFormat === null ||
    channels === null ||
    sampleRateHz === null ||
    byteRate === null ||
    blockAlign === null ||
    bitsPerSample === null ||
    dataOffset === null ||
    dataByteLength === null
  ) {
    throw new Error('Invalid WAV buffer: missing fmt or data subchunk.');
  }
  if (audioFormat !== 1) {
    throw new Error(`Unsupported WAV audioFormat ${audioFormat}; expected 1 (PCM).`);
  }
  if (bitsPerSample !== 16) {
    throw new Error(`Unsupported WAV bitsPerSample ${bitsPerSample}; expected 16 (PCM16le).`);
  }
  if (channels < 1 || channels > 32) {
    throw new Error(`Invalid WAV channel count ${channels}.`);
  }
  if (sampleRateHz < 8000 || sampleRateHz > 192000) {
    throw new Error(`Invalid WAV sampleRateHz ${sampleRateHz}.`);
  }
  const expectedBlockAlign = channels * 2;
  if (blockAlign !== expectedBlockAlign) {
    throw new Error(`Invalid WAV blockAlign ${blockAlign}; expected ${expectedBlockAlign}.`);
  }
  const expectedByteRate = sampleRateHz * expectedBlockAlign;
  if (byteRate !== expectedByteRate) {
    throw new Error(
      `Invalid WAV byteRate ${byteRate}; expected ${expectedByteRate} (${sampleRateHz}Hz * ${expectedBlockAlign} bytes/frame).`,
    );
  }
  if (dataByteLength % blockAlign !== 0) {
    throw new Error('Invalid WAV dataByteLength: not a multiple of blockAlign.');
  }

  const frameCount = dataByteLength / blockAlign;
  const durationMs = sourceSamplesToDurationMs(frameCount, sampleRateHz);

  return {
    audioFormat,
    channels,
    sampleRateHz,
    bitsPerSample,
    blockAlign,
    byteRate,
    dataOffset,
    dataByteLength,
    frameCount,
    durationMs,
  };
}

export function isRiffWavePcm16(bytes: Uint8Array | null | undefined): boolean {
  if (!bytes || bytes.byteLength < 44) return false;
  try {
    parseWavPcm16(bytes);
    return true;
  } catch {
    return false;
  }
}

export function hasRiffHeaderPrefix(bytes: Uint8Array | null | undefined): boolean {
  if (!bytes || bytes.byteLength < 4) return false;
  return (
    bytes[0] === 0x52 && // 'R'
    bytes[1] === 0x49 && // 'I'
    bytes[2] === 0x46 && // 'F'
    bytes[3] === 0x46 // 'F'
  );
}

/**
 * Generates a standards-compliant 44-byte header RIFF/WAVE PCM16le audio buffer.
 */
export function createPcm16WavBuffer(params: {
  sampleRateHz: number;
  channels: number;
  samples?: Int16Array | readonly number[];
  durationMs?: number;
  frequencyHz?: number;
  amplitude?: number;
  toneSegments?: ReadonlyArray<{
    durationMs: number;
    frequencyHz: number;
    amplitude?: number;
  }>;
}): Uint8Array {
  const { sampleRateHz, channels } = params;
  if (!Number.isInteger(sampleRateHz) || sampleRateHz < 8000 || sampleRateHz > 192000) {
    throw new Error(`Invalid sampleRateHz ${sampleRateHz}.`);
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > 32) {
    throw new Error(`Invalid channels ${channels}.`);
  }

  let pcmSamples: Int16Array;
  if (params.samples) {
    pcmSamples =
      params.samples instanceof Int16Array ? params.samples : Int16Array.from(params.samples);
    if (pcmSamples.length % channels !== 0) {
      throw new Error('PCM sample count must be divisible by channel count.');
    }
  } else if (params.toneSegments && params.toneSegments.length > 0) {
    const totalDurationMs = params.toneSegments.reduce((sum, s) => sum + s.durationMs, 0);
    const totalFrames = Math.max(1, Math.floor((sampleRateHz * totalDurationMs) / 1000));
    pcmSamples = new Int16Array(totalFrames * channels);
    let frameCursor = 0;
    for (let sIdx = 0; sIdx < params.toneSegments.length; sIdx++) {
      const seg = params.toneSegments[sIdx]!;
      const segFrames =
        sIdx === params.toneSegments.length - 1
          ? totalFrames - frameCursor
          : Math.floor((sampleRateHz * seg.durationMs) / 1000);
      const freq = seg.frequencyHz;
      const amp = Math.min(32767, Math.max(0, Math.round((seg.amplitude ?? 0.35) * 32767)));
      for (let f = 0; f < segFrames && frameCursor < totalFrames; f++, frameCursor++) {
        const value =
          freq > 0 ? Math.round(Math.sin((2 * Math.PI * freq * f) / sampleRateHz) * amp) : 0;
        for (let ch = 0; ch < channels; ch++) {
          pcmSamples[frameCursor * channels + ch] = value;
        }
      }
    }
  } else {
    const durationMs = params.durationMs ?? 1000;
    const frameCount = Math.max(1, Math.floor((sampleRateHz * durationMs) / 1000));
    const freq = params.frequencyHz ?? 440;
    const amp = Math.min(32767, Math.max(0, Math.round((params.amplitude ?? 0.35) * 32767)));
    pcmSamples = new Int16Array(frameCount * channels);
    for (let f = 0; f < frameCount; f++) {
      const value =
        freq > 0 ? Math.round(Math.sin((2 * Math.PI * freq * f) / sampleRateHz) * amp) : 0;
      for (let ch = 0; ch < channels; ch++) {
        pcmSamples[f * channels + ch] = value;
      }
    }
  }

  const blockAlign = channels * 2;
  const byteRate = sampleRateHz * blockAlign;
  const dataByteLength = pcmSamples.length * 2;
  const totalByteLength = 44 + dataByteLength;
  const out = new Uint8Array(totalByteLength);
  const view = new DataView(out.buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      out[offset + i] = text.charCodeAt(i);
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audioFormat = 1 (PCM)
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bitsPerSample = 16
  writeAscii(36, 'data');
  view.setUint32(40, dataByteLength, true);

  let byteCursor = 44;
  const isLittleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  if (isLittleEndian) {
    out.set(
      new Uint8Array(pcmSamples.buffer, pcmSamples.byteOffset, pcmSamples.byteLength),
      byteCursor,
    );
  } else {
    for (let i = 0; i < pcmSamples.length; i++) {
      view.setInt16(byteCursor, pcmSamples[i]!, true);
      byteCursor += 2;
    }
  }

  return out;
}

/**
 * Deterministically concatenates and normalizes verified RIFF/WAVE PCM16le chunk buffers
 * into a single canonical RIFF/WAVE PCM16le asset without mutating the input chunks.
 *
 * Strictly validates that each WAV buffer's header (`sampleRateHz`, `channels`, `frameCount`, `durationMs`)
 * agrees with the declared `TranscriptionAssetPiece` metadata — never stretches or truncates audio
 * to paper over a manifest/payload discrepancy.
 */
export function assembleCanonicalWavFromChunks(params: {
  targetSampleRateHz: number;
  targetChannels: number;
  pieces: ReadonlyArray<{
    piece: TranscriptionAssetPiece;
    chunkBytes: Uint8Array;
  }>;
}): {
  wavBytes: Uint8Array;
  header: ParsedWavHeader;
  totalFrames: number;
  dataByteLength: number;
  checksumSha256: string;
} {
  if (params.pieces.length === 0) {
    throw new Error('Cannot assemble WAV asset from zero pieces.');
  }

  const normalizedPieceFrames: Int16Array[] = [];
  let totalFrames = 0;

  for (const { piece, chunkBytes } of params.pieces) {
    const hdr = parseWavPcm16(chunkBytes);
    if (hdr.sampleRateHz !== piece.sampleRateHz) {
      throw new Error(
        `WAV header sampleRateHz (${hdr.sampleRateHz}) disagrees with chunk metadata sampleRateHz (${piece.sampleRateHz}) for chunk ${piece.recordingChunkId}.`,
      );
    }
    if (hdr.channels !== piece.channels) {
      throw new Error(
        `WAV header channels (${hdr.channels}) disagrees with chunk metadata channels (${piece.channels}) for chunk ${piece.recordingChunkId}.`,
      );
    }
    const expectedFrames = piece.sourceSampleEnd - piece.sourceSampleStart;
    if (hdr.frameCount !== expectedFrames) {
      throw new Error(
        `WAV PCM frame count (${hdr.frameCount} frames, ${hdr.durationMs}ms) disagrees with chunk sample range [${piece.sourceSampleStart}, ${piece.sourceSampleEnd}) (${expectedFrames} frames) for chunk ${piece.recordingChunkId}.`,
      );
    }
    const expectedPieceDurationMs = piece.assetEndMs - piece.assetStartMs;
    if (Math.abs(hdr.durationMs - expectedPieceDurationMs) > 2) {
      throw new Error(
        `WAV playable duration (${hdr.durationMs}ms) disagrees with piece asset duration (${expectedPieceDurationMs}ms) for chunk ${piece.recordingChunkId}.`,
      );
    }

    const view = new DataView(
      chunkBytes.buffer,
      chunkBytes.byteOffset + hdr.dataOffset,
      hdr.dataByteLength,
    );

    // Step 1: Normalize channels to targetChannels at source sample rate
    const channelNormalized = new Int16Array(hdr.frameCount * params.targetChannels);
    for (let f = 0; f < hdr.frameCount; f++) {
      if (hdr.channels === params.targetChannels) {
        for (let ch = 0; ch < params.targetChannels; ch++) {
          channelNormalized[f * params.targetChannels + ch] = view.getInt16(
            (f * hdr.channels + ch) * 2,
            true,
          );
        }
      } else if (params.targetChannels === 1) {
        let sum = 0;
        for (let ch = 0; ch < hdr.channels; ch++) {
          sum += view.getInt16((f * hdr.channels + ch) * 2, true);
        }
        channelNormalized[f] = Math.round(sum / hdr.channels);
      } else {
        const monoVal = view.getInt16(f * hdr.channels * 2, true);
        for (let ch = 0; ch < params.targetChannels; ch++) {
          channelNormalized[f * params.targetChannels + ch] = monoVal;
        }
      }
    }

    // Step 2: Resample if hdr.sampleRateHz !== targetSampleRateHz
    let finalSamples: Int16Array;
    if (hdr.sampleRateHz === params.targetSampleRateHz) {
      finalSamples = channelNormalized;
    } else {
      const resampledFrames = Math.max(
        1,
        Math.round((hdr.frameCount * params.targetSampleRateHz) / hdr.sampleRateHz),
      );
      const resampledDurationMs = sourceSamplesToDurationMs(
        resampledFrames,
        params.targetSampleRateHz,
      );
      if (Math.abs(resampledDurationMs - hdr.durationMs) > 1) {
        throw new Error(
          `Resampled frame count (${resampledFrames} frames at ${params.targetSampleRateHz}Hz = ${resampledDurationMs}ms) diverges from source duration (${hdr.durationMs}ms).`,
        );
      }
      finalSamples = new Int16Array(resampledFrames * params.targetChannels);
      for (let tf = 0; tf < resampledFrames; tf++) {
        const srcPos = (tf * hdr.sampleRateHz) / params.targetSampleRateHz;
        const idx0 = Math.min(hdr.frameCount - 1, Math.floor(srcPos));
        const idx1 = Math.min(hdr.frameCount - 1, idx0 + 1);
        const frac = srcPos - idx0;
        for (let ch = 0; ch < params.targetChannels; ch++) {
          const s0 = channelNormalized[idx0 * params.targetChannels + ch]!;
          const s1 = channelNormalized[idx1 * params.targetChannels + ch]!;
          finalSamples[tf * params.targetChannels + ch] = Math.round(s0 + (s1 - s0) * frac);
        }
      }
    }

    normalizedPieceFrames.push(finalSamples);
    totalFrames += finalSamples.length / params.targetChannels;
  }

  const combinedSamples = new Int16Array(totalFrames * params.targetChannels);
  let sampleCursor = 0;
  for (const pieceSamples of normalizedPieceFrames) {
    combinedSamples.set(pieceSamples, sampleCursor);
    sampleCursor += pieceSamples.length;
  }

  const wavBytes = createPcm16WavBuffer({
    sampleRateHz: params.targetSampleRateHz,
    channels: params.targetChannels,
    samples: combinedSamples,
  });

  // Deterministically verify the assembled output WAV header and data bounds
  const verifiedHeader = parseWavPcm16(wavBytes);
  const checksumSha256 = computeSha256Hex(wavBytes);

  return {
    wavBytes,
    header: verifiedHeader,
    totalFrames: verifiedHeader.frameCount,
    dataByteLength: verifiedHeader.dataByteLength,
    checksumSha256,
  };
}

export type PreparedTranscriptionAssetPlan = {
  assetVersion: number;
  assetRole: 'canonical_transcription_input';
  storageKey: string;
  container: AudioContainerExt;
  codec: string;
  sampleRateHz: number;
  channels: number;
  assetDurationMs: number;
  canonicalDurationMs: number;
  activeCaptureMs: number;
  timelineMap: TranscriptionAssetPiece[];
  sourceLineage: TranscriptionAssetSourceLineage[];
  manifestBytes: Uint8Array;
  byteSize: number;
  checksumSha256: string;
  preparationMetadata: {
    schema_version: 1;
    binary_mux_performed: boolean;
    binary_media_boundary_note: string;
    media_engine?: string;
    wav_frames_assembled?: number;
    wav_data_bytes?: number;
    total_verified_chunks: number;
    total_verified_bytes: number;
    pause_gap_count: number;
    total_pause_gap_ms: number;
    source_concatenation_count: number;
    total_dropped_samples: number;
    missing_optional_sources: Array<{
      source_id: string;
      source_kind: string;
      reason: string;
    }>;
    degraded_sources: Array<{
      source_id: string;
      source_kind: string;
      dropped_sample_count: number;
      continuity_diagnostics: ChunkContinuityDiagnostic[];
    }>;
  };
};

/**
 * Deterministically prepares a canonical transcription asset and its piecewise
 * `asset_time -> meeting_time -> original_source_sample` timeline map from verified chunks.
 *
 * Original recording chunks are never altered.
 * Mic and system channels are never pretended to be naturally one timeline file:
 * each verified source/chunk occupies an explicit non-overlapping interval `[assetStartMs, assetEndMs)`
 * in the prepared asset timeline, with exact mapping back to `[meetingStartMs, meetingEndMs)`
 * and `[sourceSampleStart, sourceSampleEnd)`.
 */
export function prepareCanonicalTranscriptionAssetPlan(params: {
  recording: RecordingDto;
  sources: readonly RecordingSourceDto[];
  chunks: readonly RecordingChunkDto[];
  assetVersion?: number;
  chunkBytesById?: ReadonlyMap<string, Uint8Array>;
}): PreparedTranscriptionAssetPlan {
  const { recording } = params;
  const assetVersion = params.assetVersion ?? 1;

  if (!Number.isInteger(assetVersion) || assetVersion <= 0) {
    throw new Error('assetVersion must be a positive integer.');
  }

  if (params.sources.length === 0) {
    throw new Error('Cannot prepare transcription asset: recording has no sources.');
  }
  if (params.chunks.length === 0) {
    throw new Error('Cannot prepare transcription asset: recording has no chunks.');
  }

  for (const chunk of params.chunks) {
    if (chunk.verificationState !== 'verified') {
      throw new Error(
        `Cannot prepare transcription asset: chunk ${chunk.id} (seq ${chunk.sequenceNo}) is not verified.`,
      );
    }
  }

  // Sort sources deterministically: mixed_rendered -> microphone -> system_audio, then firstSampleMeetingMs, then id
  const sortedSources = [...params.sources].sort((a, b) => {
    const prioDiff = SOURCE_KIND_PRIORITY[a.sourceKind] - SOURCE_KIND_PRIORITY[b.sourceKind];
    if (prioDiff !== 0) return prioDiff;
    if (a.firstSampleMeetingMs !== b.firstSampleMeetingMs) {
      return a.firstSampleMeetingMs - b.firstSampleMeetingMs;
    }
    return a.id.localeCompare(b.id);
  });

  // If a verified `mixed_rendered` source is present with chunks, use it as the sole transcription source;
  // otherwise include each verified source explicitly in deterministic sequence.
  const mixedSource = sortedSources.find(
    (s) =>
      s.sourceKind === 'mixed_rendered' && params.chunks.some((c) => c.recordingSourceId === s.id),
  );
  const candidateSources = mixedSource ? [mixedSource] : sortedSources;

  const timelineMap: TranscriptionAssetPiece[] = [];
  const sourceLineage: TranscriptionAssetSourceLineage[] = [];
  const missingOptionalSources: PreparedTranscriptionAssetPlan['preparationMetadata']['missing_optional_sources'] =
    [];
  const degradedSources: PreparedTranscriptionAssetPlan['preparationMetadata']['degraded_sources'] =
    [];

  let assetCursorMs = 0;
  let pieceIndex = 0;
  let pauseGapCount = 0;
  let totalPauseGapMs = 0;
  let sourceConcatenationCount = 0;
  let totalDroppedSamples = 0;
  let maxMeetingEndMs = recording.canonicalDurationMs ?? 0;
  let totalActiveCaptureMs = 0;

  for (const source of candidateSources) {
    const sourceChunks = params.chunks
      .filter((c) => c.recordingSourceId === source.id)
      .sort((a, b) => a.sequenceNo - b.sequenceNo);

    if (sourceChunks.length === 0) {
      if (!source.isRequired) {
        missingOptionalSources.push({
          source_id: source.id,
          source_kind: source.sourceKind,
          reason: 'no_verified_chunks_captured',
        });
        continue;
      }
      throw new Error(
        `Cannot prepare transcription asset: required source ${source.id} (${source.sourceKind}) has no verified chunks.`,
      );
    }

    // Validate chunk continuity using Phase 0 / Phase 2 shared timeline contracts
    const continuityDiagnostics = validateChunkContinuity(
      sourceChunks.map((chunk) => ({
        sequence: chunk.sequenceNo,
        sampleRateHz: chunk.sampleRateHz,
        sampleStart: chunk.sampleStart,
        sampleEnd: chunk.sampleEnd,
        meetingStartMs: chunk.meetingStartMs,
        meetingEndMs: chunk.meetingEndMs,
      })),
    );

    const sequenceGapDiag = continuityDiagnostics.find((d) => d.kind === 'sequence_gap');
    if (sequenceGapDiag) {
      throw new Error(
        `Cannot prepare transcription asset: source ${source.id} has chunk sequence gap at chunk index ${sequenceGapDiag.chunkIndex}.`,
      );
    }

    const negativeMeetingDiag = continuityDiagnostics.find(
      (d) => d.kind === 'meeting_time_gap' && d.delta < 0,
    );
    if (negativeMeetingDiag) {
      throw new Error(
        `Cannot prepare transcription asset: source ${source.id} has overlapping/regressing chunk meeting time at index ${negativeMeetingDiag.chunkIndex}.`,
      );
    }

    if (source.droppedSampleCount > 0 || continuityDiagnostics.length > 0) {
      degradedSources.push({
        source_id: source.id,
        source_kind: source.sourceKind,
        dropped_sample_count: source.droppedSampleCount,
        continuity_diagnostics: continuityDiagnostics,
      });
    }
    totalDroppedSamples += source.droppedSampleCount;

    const isAdditionalSource = sourceLineage.length > 0;
    if (isAdditionalSource) {
      sourceConcatenationCount += 1;
    }

    let previousChunkMeetingEndMs: number | null = null;
    let previousChunkSampleEnd: number | null = null;

    for (let i = 0; i < sourceChunks.length; i++) {
      const chunk = sourceChunks[i]!;
      const frameCount = chunk.sampleEnd - chunk.sampleStart;
      if (frameCount <= 0) {
        throw new Error(
          `Cannot prepare transcription asset: chunk ${chunk.id} (seq ${chunk.sequenceNo}) has non-positive sample count [${chunk.sampleStart}, ${chunk.sampleEnd}).`,
        );
      }
      if (chunk.sampleRateHz !== source.sampleRateHz || chunk.channels !== source.channels) {
        throw new Error(
          `Cannot prepare transcription asset: chunk ${chunk.id} format (${chunk.sampleRateHz}Hz/${chunk.channels}ch) disagrees with source ${source.id} (${source.sampleRateHz}Hz/${source.channels}ch).`,
        );
      }
      const sampleDurationMs = sourceSamplesToDurationMs(frameCount, chunk.sampleRateHz);
      const chunkMeetingSpanMs = chunk.meetingEndMs - chunk.meetingStartMs;
      if (Math.abs(chunk.durationMs - sampleDurationMs) > 1) {
        throw new Error(
          `Cannot prepare transcription asset: chunk ${chunk.id} (seq ${chunk.sequenceNo}) declares durationMs=${chunk.durationMs}ms, which disagrees with PCM sample duration (${sampleDurationMs}ms for ${frameCount} frames at ${chunk.sampleRateHz}Hz).`,
        );
      }
      if (Math.abs(chunkMeetingSpanMs - sampleDurationMs) > 2) {
        throw new Error(
          `Cannot prepare transcription asset: chunk ${chunk.id} (seq ${chunk.sequenceNo}) meeting span [${chunk.meetingStartMs}, ${chunk.meetingEndMs}) (${chunkMeetingSpanMs}ms) disagrees with PCM sample duration (${sampleDurationMs}ms for ${frameCount} frames at ${chunk.sampleRateHz}Hz).`,
        );
      }
      // Asset piece duration matches the chunk's canonical duration (derived from verified chunk bounds)
      const pieceDurationMs = chunkMeetingSpanMs > 0 ? chunkMeetingSpanMs : sampleDurationMs;

      // Cross-check sample-derived meeting time from source anchor when samples are contiguous
      const sampleDerivedStartMs = meetingTimeMsFromSourceSamples(
        source.firstSampleMeetingMs,
        chunk.sampleStart - source.firstSampleIndex,
        chunk.sampleRateHz,
      );

      let gapBeforeMeetingMs = 0;
      let discontinuityReason: DiscontinuityReason = 'none';

      if (i === 0) {
        if (isAdditionalSource) {
          discontinuityReason = 'source_concatenation';
          gapBeforeMeetingMs = chunk.meetingStartMs;
        } else if (chunk.meetingStartMs > 0) {
          discontinuityReason = 'late_source_join';
          gapBeforeMeetingMs = chunk.meetingStartMs;
        }
      } else if (previousChunkMeetingEndMs !== null) {
        const meetingGap = chunk.meetingStartMs - previousChunkMeetingEndMs;
        const sampleGap =
          previousChunkSampleEnd !== null ? chunk.sampleStart - previousChunkSampleEnd : 0;
        if (meetingGap > 0) {
          gapBeforeMeetingMs = meetingGap;
          // If sample indices are contiguous (or pause was explicit in wall/monotonic meeting time while capture paused),
          // classify whether it's a pause gap vs dropped-sample chunk gap.
          discontinuityReason =
            sampleGap === 0 || chunk.meetingStartMs > sampleDerivedStartMs
              ? 'pause_gap'
              : 'chunk_gap';
          pauseGapCount += 1;
          totalPauseGapMs += meetingGap;
        }
      }

      const assetStartMs = assetCursorMs;
      const assetEndMs = assetStartMs + pieceDurationMs;
      assetCursorMs = assetEndMs;

      const piece = transcriptionAssetPieceSchema.parse({
        pieceIndex,
        recordingSourceId: source.id,
        sourceKind: source.sourceKind,
        recordingChunkId: chunk.id,
        chunkSequenceNo: chunk.sequenceNo,
        assetStartMs,
        assetEndMs,
        meetingStartMs: chunk.meetingStartMs,
        meetingEndMs: chunk.meetingEndMs,
        sourceSampleStart: chunk.sampleStart,
        sourceSampleEnd: chunk.sampleEnd,
        sampleRateHz: chunk.sampleRateHz,
        channels: chunk.channels,
        gapBeforeAssetMs: 0,
        gapBeforeMeetingMs,
        discontinuityReason,
      });

      timelineMap.push(piece);
      pieceIndex += 1;
      previousChunkMeetingEndMs = chunk.meetingEndMs;
      previousChunkSampleEnd = chunk.sampleEnd;
      if (chunk.meetingEndMs > maxMeetingEndMs) {
        maxMeetingEndMs = chunk.meetingEndMs;
      }
      if (!isAdditionalSource) {
        totalActiveCaptureMs += pieceDurationMs;
      }
    }

    const firstChunk = sourceChunks[0]!;
    const lastChunk = sourceChunks[sourceChunks.length - 1]!;
    const lineage = transcriptionAssetSourceLineageSchema.parse({
      recordingSourceId: source.id,
      sourceKind: source.sourceKind,
      sourceRole: source.sourceRole,
      codec: source.codec,
      container: source.container,
      sampleRateHz: source.sampleRateHz,
      channels: source.channels,
      chunkIds: sourceChunks.map((c) => c.id),
      sequenceNumbers: sourceChunks.map((c) => c.sequenceNo),
      totalByteSize: sourceChunks.reduce((sum, c) => sum + c.byteSize, 0),
      firstSampleMeetingMs: firstChunk.meetingStartMs,
      lastSampleMeetingMs: lastChunk.meetingEndMs,
      droppedSampleCount: source.droppedSampleCount,
    });
    sourceLineage.push(lineage);
  }

  if (timelineMap.length === 0 || sourceLineage.length === 0) {
    throw new Error('Cannot prepare transcription asset: no verified source pieces were produced.');
  }

  const primaryLineage = sourceLineage[0]!;
  const storageKey = buildTranscriptionAssetStorageKey({
    workspaceId: recording.workspaceId,
    meetingId: recording.meetingId,
    recordingId: recording.id,
    assetVersion,
    container: primaryLineage.container,
  });

  const canonicalDurationMs = Math.max(recording.canonicalDurationMs ?? 0, maxMeetingEndMs);
  const activeCaptureMs = recording.activeCaptureMs ?? totalActiveCaptureMs;
  const totalVerifiedBytes = sourceLineage.reduce((sum, s) => sum + s.totalByteSize, 0);
  const totalVerifiedChunks = sourceLineage.reduce((sum, s) => sum + s.chunkIds.length, 0);

  let binaryMuxPerformed = false;
  let binaryBoundaryNote =
    'Canonical transcription asset manifest and deterministic piecewise timeline map built from verified chunks without altering original chunk objects.';
  let mediaEngine: string | undefined;
  let wavFramesAssembled: number | undefined;
  let wavDataBytes: number | undefined;
  let outputBytes: Uint8Array | null = null;
  let outputChecksumSha256: string | null = null;

  if (params.chunkBytesById && primaryLineage.container === 'wav') {
    const piecePayloads: Array<{ piece: TranscriptionAssetPiece; chunkBytes: Uint8Array }> = [];
    let anyRiffPayload = false;
    let allPresent = true;
    for (const piece of timelineMap) {
      const rawBytes = params.chunkBytesById.get(piece.recordingChunkId);
      if (!rawBytes) {
        allPresent = false;
        break;
      }
      if (hasRiffHeaderPrefix(rawBytes)) {
        anyRiffPayload = true;
      }
      piecePayloads.push({ piece, chunkBytes: rawBytes });
    }

    if (anyRiffPayload && allPresent && piecePayloads.length === timelineMap.length) {
      const assembled = assembleCanonicalWavFromChunks({
        targetSampleRateHz: primaryLineage.sampleRateHz,
        targetChannels: primaryLineage.channels,
        pieces: piecePayloads,
      });
      binaryMuxPerformed = true;
      mediaEngine = WAV_MEDIA_ENGINE_VERSION;
      wavFramesAssembled = assembled.totalFrames;
      wavDataBytes = assembled.dataByteLength;
      binaryBoundaryNote = `Assembled deterministic RIFF/WAVE PCM16le asset (${assembled.totalFrames} frames, ${assembled.dataByteLength} PCM bytes) via ${WAV_MEDIA_ENGINE_VERSION} without modifying original chunk objects.`;
      outputBytes = assembled.wavBytes;
      outputChecksumSha256 = assembled.checksumSha256;
    }
  }

  const preparationMetadata: PreparedTranscriptionAssetPlan['preparationMetadata'] = {
    schema_version: 1,
    binary_mux_performed: binaryMuxPerformed,
    binary_media_boundary_note: binaryBoundaryNote,
    ...(mediaEngine ? { media_engine: mediaEngine } : {}),
    ...(wavFramesAssembled !== undefined ? { wav_frames_assembled: wavFramesAssembled } : {}),
    ...(wavDataBytes !== undefined ? { wav_data_bytes: wavDataBytes } : {}),
    total_verified_chunks: totalVerifiedChunks,
    total_verified_bytes: totalVerifiedBytes,
    pause_gap_count: pauseGapCount,
    total_pause_gap_ms: totalPauseGapMs,
    source_concatenation_count: sourceConcatenationCount,
    total_dropped_samples: totalDroppedSamples,
    missing_optional_sources: missingOptionalSources,
    degraded_sources: degradedSources,
  };

  if (!outputBytes || !outputChecksumSha256) {
    // Deterministic canonical asset representation stored in private object storage when raw WAV bytes are not supplied
    const deterministicPayload = JSON.stringify({
      schema_version: 1,
      workspace_id: recording.workspaceId,
      meeting_id: recording.meetingId,
      recording_id: recording.id,
      asset_version: assetVersion,
      asset_duration_ms: assetCursorMs,
      canonical_duration_ms: canonicalDurationMs,
      active_capture_ms: activeCaptureMs,
      timeline_map: timelineMap,
      source_lineage: sourceLineage,
    });
    outputBytes = new TextEncoder().encode(deterministicPayload);
    outputChecksumSha256 = computeSha256Hex(outputBytes);
  }

  return {
    assetVersion,
    assetRole: 'canonical_transcription_input',
    storageKey,
    container: primaryLineage.container,
    codec: primaryLineage.codec,
    sampleRateHz: primaryLineage.sampleRateHz,
    channels: primaryLineage.channels,
    assetDurationMs: assetCursorMs,
    canonicalDurationMs,
    activeCaptureMs,
    timelineMap,
    sourceLineage,
    manifestBytes: outputBytes,
    byteSize: outputBytes.byteLength,
    checksumSha256: outputChecksumSha256,
    preparationMetadata,
  };
}

export type QuarantineReasonCode =
  | 'negative_or_non_integer_timestamp'
  | 'non_positive_segment_duration'
  | 'timestamp_exceeds_asset_duration'
  | 'timestamp_in_unmapped_asset_gap'
  | 'segment_spans_timeline_discontinuity'
  | 'canonical_duration_non_positive';

export type QuarantinedTranscriptSegment = {
  providerSegmentKey: string;
  speakerLabel: string;
  rawStartMs: number;
  rawEndMs: number;
  text: string;
  reason: QuarantineReasonCode;
  detail: string;
};

export type AlignedCanonicalSegment = {
  sequenceNo: number;
  providerSegmentKey: string;
  providerSpeakerLabel: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  assetStartMs: number;
  assetEndMs: number;
  sourceRecordingSourceId: string;
  sourceRecordingChunkId: string;
  sourceSampleStart: number;
  sourceSampleEnd: number;
  text: string;
  language: ProviderTranscriptSegment['detectedLanguage'];
  confidence: number | null;
  wordCount: number;
  words: ProviderTranscriptWord[];
  alignmentStatus: 'canonical';
  alignmentMetadata: {
    schema_version: 1;
    piece_indices: number[];
    source_kind: string;
    crossed_chunk_ids: string[];
    discontinuity_crossed: false;
  };
};

export type CanonicalAlignmentOutcome = {
  canonicalSegments: AlignedCanonicalSegment[];
  quarantinedSegments: QuarantinedTranscriptSegment[];
};

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function mapAssetPointInPiece(
  assetPointMs: number,
  piece: TranscriptionAssetPiece,
): { meetingMs: number; sampleIndex: number } {
  const pieceAssetDurationMs = piece.assetEndMs - piece.assetStartMs;
  const pieceMeetingDurationMs = piece.meetingEndMs - piece.meetingStartMs;
  const pieceSampleCount = piece.sourceSampleEnd - piece.sourceSampleStart;
  const offsetAssetMs = assetPointMs - piece.assetStartMs;

  const meetingOffsetMs = Math.round(
    (offsetAssetMs * pieceMeetingDurationMs) / pieceAssetDurationMs,
  );
  const sampleOffset = Math.round((offsetAssetMs * pieceSampleCount) / pieceAssetDurationMs);

  return {
    meetingMs: piece.meetingStartMs + meetingOffsetMs,
    sampleIndex: piece.sourceSampleStart + sampleOffset,
  };
}

/**
 * Maps a single `[assetStartMs, assetEndMs]` interval through `timelineMap`.
 * Never clamps out-of-range or negative timestamps; returns an explicit quarantine error if unsafe.
 */
export function mapAssetIntervalToCanonicalTimeline(params: {
  assetStartMs: number;
  assetEndMs: number;
  assetDurationMs: number;
  timelineMap: readonly TranscriptionAssetPiece[];
}):
  | {
      ok: true;
      startMs: number;
      endMs: number;
      sourceRecordingSourceId: string;
      sourceRecordingChunkId: string;
      sourceSampleStart: number;
      sourceSampleEnd: number;
      pieceIndices: number[];
      sourceKind: string;
      crossedChunkIds: string[];
    }
  | {
      ok: false;
      reason: QuarantineReasonCode;
      detail: string;
    } {
  const { assetStartMs, assetEndMs, assetDurationMs, timelineMap } = params;

  if (
    !Number.isInteger(assetStartMs) ||
    !Number.isInteger(assetEndMs) ||
    assetStartMs < 0 ||
    assetEndMs < 0
  ) {
    return {
      ok: false,
      reason: 'negative_or_non_integer_timestamp',
      detail: `Provider timestamp [${assetStartMs}, ${assetEndMs}] must be non-negative integers.`,
    };
  }

  if (assetEndMs <= assetStartMs) {
    return {
      ok: false,
      reason: 'non_positive_segment_duration',
      detail: `Provider timestamp endMs (${assetEndMs}) must be strictly greater than startMs (${assetStartMs}).`,
    };
  }

  if (assetStartMs >= assetDurationMs || assetEndMs > assetDurationMs) {
    return {
      ok: false,
      reason: 'timestamp_exceeds_asset_duration',
      detail: `Provider timestamp [${assetStartMs}, ${assetEndMs}] exceeds prepared transcription asset duration (${assetDurationMs}ms).`,
    };
  }

  // Find the piece containing `assetStartMs` (inclusive start, strictly less than end)
  const startPieceIdx = timelineMap.findIndex(
    (p) => assetStartMs >= p.assetStartMs && assetStartMs < p.assetEndMs,
  );
  // Find the piece containing `assetEndMs` (strictly greater than start, inclusive end)
  const endPieceIdx = timelineMap.findIndex(
    (p) => assetEndMs > p.assetStartMs && assetEndMs <= p.assetEndMs,
  );

  if (startPieceIdx === -1 || endPieceIdx === -1 || endPieceIdx < startPieceIdx) {
    return {
      ok: false,
      reason: 'timestamp_in_unmapped_asset_gap',
      detail: `Provider timestamp [${assetStartMs}, ${assetEndMs}] falls in an unmapped asset interval.`,
    };
  }

  const spannedPieces = timelineMap.slice(startPieceIdx, endPieceIdx + 1);
  const firstPiece = spannedPieces[0]!;
  const lastPiece = spannedPieces[spannedPieces.length - 1]!;

  // Verify contiguous coverage across spanned pieces with no pause gap, chunk gap, or source switch
  for (let i = 1; i < spannedPieces.length; i++) {
    const prev = spannedPieces[i - 1]!;
    const curr = spannedPieces[i]!;
    const assetContiguous = curr.assetStartMs === prev.assetEndMs;
    const meetingContiguous = curr.meetingStartMs === prev.meetingEndMs;
    const sameSource = curr.recordingSourceId === prev.recordingSourceId;
    const noDiscontinuity = curr.discontinuityReason === 'none' && curr.gapBeforeMeetingMs === 0;

    if (!assetContiguous || !meetingContiguous || !sameSource || !noDiscontinuity) {
      return {
        ok: false,
        reason: 'segment_spans_timeline_discontinuity',
        detail: `Provider segment [${assetStartMs}, ${assetEndMs}] spans across a timeline discontinuity (${curr.discontinuityReason}, gap=${curr.gapBeforeMeetingMs}ms) between piece ${prev.pieceIndex} and piece ${curr.pieceIndex}.`,
      };
    }
  }

  const mappedStart = mapAssetPointInPiece(assetStartMs, firstPiece);
  const mappedEnd = mapAssetPointInPiece(assetEndMs, lastPiece);

  if (mappedEnd.meetingMs <= mappedStart.meetingMs) {
    return {
      ok: false,
      reason: 'canonical_duration_non_positive',
      detail: `Mapped canonical meeting interval [${mappedStart.meetingMs}, ${mappedEnd.meetingMs}] has non-positive duration.`,
    };
  }

  return {
    ok: true,
    startMs: mappedStart.meetingMs,
    endMs: mappedEnd.meetingMs,
    sourceRecordingSourceId: firstPiece.recordingSourceId,
    sourceRecordingChunkId: firstPiece.recordingChunkId,
    sourceSampleStart: mappedStart.sampleIndex,
    sourceSampleEnd: mappedEnd.sampleIndex,
    pieceIndices: spannedPieces.map((p) => p.pieceIndex),
    sourceKind: firstPiece.sourceKind,
    crossedChunkIds: spannedPieces.map((p) => p.recordingChunkId),
  };
}

/**
 * Aligns provider-neutral transcript segments through the persisted `timelineMap` onto canonical meeting time.
 *
 * Rules:
 * - Never treats provider timestamps as meeting timestamps directly.
 * - Never silently clamps negative or out-of-range timestamps.
 * - Never fabricates coverage across pause gaps, missing audio, or source concatenation boundaries.
 * - Orders canonical segments deterministically by `(startMs, endMs, providerSegmentKey)`.
 */
export function alignProviderTranscriptToCanonicalTimeline(params: {
  segments: readonly ProviderTranscriptSegment[];
  assetDurationMs: number;
  timelineMap: readonly TranscriptionAssetPiece[];
}): CanonicalAlignmentOutcome {
  const { segments, assetDurationMs, timelineMap } = params;
  const rawAligned: Omit<AlignedCanonicalSegment, 'sequenceNo'>[] = [];
  const quarantinedSegments: QuarantinedTranscriptSegment[] = [];

  for (const segment of segments) {
    const trimmedText = segment.text.trim();
    if (!trimmedText) {
      continue;
    }

    const mapped = mapAssetIntervalToCanonicalTimeline({
      assetStartMs: segment.startMs,
      assetEndMs: segment.endMs,
      assetDurationMs,
      timelineMap,
    });

    if (!mapped.ok) {
      quarantinedSegments.push({
        providerSegmentKey: segment.providerSegmentKey,
        speakerLabel: segment.speakerLabel,
        rawStartMs: segment.startMs,
        rawEndMs: segment.endMs,
        text: trimmedText,
        reason: mapped.reason,
        detail: mapped.detail,
      });
      continue;
    }

    // Align word-level timestamps through the same piecewise timeline map
    const alignedWords: ProviderTranscriptWord[] = [];
    let wordQuarantined = false;

    for (const word of segment.words ?? []) {
      if (word.endMs === word.startMs) {
        // Zero-duration word token inside segment bounds: map point
        if (word.startMs < segment.startMs || word.startMs > segment.endMs) {
          wordQuarantined = true;
          break;
        }
        const piece = timelineMap.find(
          (p) => word.startMs >= p.assetStartMs && word.startMs <= p.assetEndMs,
        );
        if (!piece) {
          wordQuarantined = true;
          break;
        }
        const pt = mapAssetPointInPiece(word.startMs, piece);
        alignedWords.push({
          text: word.text,
          startMs: pt.meetingMs,
          endMs: pt.meetingMs,
          confidence: word.confidence ?? null,
          speakerLabel: word.speakerLabel ?? segment.speakerLabel,
        });
        continue;
      }

      const wordMapped = mapAssetIntervalToCanonicalTimeline({
        assetStartMs: word.startMs,
        assetEndMs: word.endMs,
        assetDurationMs,
        timelineMap,
      });
      if (!wordMapped.ok) {
        wordQuarantined = true;
        quarantinedSegments.push({
          providerSegmentKey: segment.providerSegmentKey,
          speakerLabel: segment.speakerLabel,
          rawStartMs: segment.startMs,
          rawEndMs: segment.endMs,
          text: trimmedText,
          reason: wordMapped.reason,
          detail: `Word "${word.text}" [${word.startMs}, ${word.endMs}] failed canonical alignment: ${wordMapped.detail}`,
        });
        break;
      }
      alignedWords.push({
        text: word.text,
        startMs: wordMapped.startMs,
        endMs: wordMapped.endMs,
        confidence: word.confidence ?? null,
        speakerLabel: word.speakerLabel ?? segment.speakerLabel,
      });
    }

    if (wordQuarantined) {
      continue;
    }

    rawAligned.push({
      providerSegmentKey: segment.providerSegmentKey,
      providerSpeakerLabel: segment.speakerLabel,
      startMs: mapped.startMs,
      endMs: mapped.endMs,
      durationMs: mapped.endMs - mapped.startMs,
      assetStartMs: segment.startMs,
      assetEndMs: segment.endMs,
      sourceRecordingSourceId: mapped.sourceRecordingSourceId,
      sourceRecordingChunkId: mapped.sourceRecordingChunkId,
      sourceSampleStart: mapped.sourceSampleStart,
      sourceSampleEnd: mapped.sourceSampleEnd,
      text: trimmedText,
      language: segment.detectedLanguage,
      confidence: segment.confidence ?? null,
      wordCount: alignedWords.length > 0 ? alignedWords.length : countWords(trimmedText),
      words: alignedWords,
      alignmentStatus: 'canonical',
      alignmentMetadata: {
        schema_version: 1,
        piece_indices: mapped.pieceIndices,
        source_kind: mapped.sourceKind,
        crossed_chunk_ids: mapped.crossedChunkIds,
        discontinuity_crossed: false,
      },
    });
  }

  // Deterministic canonical ordering: sort by canonical startMs asc, endMs asc, assetStartMs asc, providerSegmentKey asc
  rawAligned.sort((a, b) => {
    if (a.startMs !== b.startMs) return a.startMs - b.startMs;
    if (a.endMs !== b.endMs) return a.endMs - b.endMs;
    if (a.assetStartMs !== b.assetStartMs) return a.assetStartMs - b.assetStartMs;
    return a.providerSegmentKey.localeCompare(b.providerSegmentKey);
  });

  const canonicalSegments: AlignedCanonicalSegment[] = rawAligned.map((seg, idx) => ({
    ...seg,
    sequenceNo: idx,
  }));

  return {
    canonicalSegments,
    quarantinedSegments,
  };
}

/**
 * Resolves an aligned canonical transcript segment back to its exact PCM16le sample range
 * inside the original immutable `RecordingChunkDto` WAV buffer and measures signal characteristics.
 */
export function resolveCanonicalSegmentAudioSlice(params: {
  segment: Pick<
    AlignedCanonicalSegment,
    | 'sourceRecordingSourceId'
    | 'sourceRecordingChunkId'
    | 'sourceSampleStart'
    | 'sourceSampleEnd'
    | 'startMs'
    | 'endMs'
  >;
  chunk: Pick<
    RecordingChunkDto,
    'id' | 'recordingSourceId' | 'sampleStart' | 'sampleEnd' | 'sampleRateHz' | 'channels'
  >;
  chunkWavBytes: Uint8Array;
}): {
  chunkRelativeFrameStart: number;
  chunkRelativeFrameEnd: number;
  frameCount: number;
  durationMs: number;
  samples: Int16Array;
  rmsAmplitude: number;
  estimatedFrequencyHz: number;
} {
  const { segment, chunk, chunkWavBytes } = params;
  if (segment.sourceRecordingChunkId !== chunk.id) {
    throw new Error(
      `Segment sourceRecordingChunkId (${segment.sourceRecordingChunkId}) does not match chunk id (${chunk.id}).`,
    );
  }
  if (segment.sourceRecordingSourceId !== chunk.recordingSourceId) {
    throw new Error(
      `Segment sourceRecordingSourceId (${segment.sourceRecordingSourceId}) does not match chunk recordingSourceId (${chunk.recordingSourceId}).`,
    );
  }
  if (segment.sourceSampleStart < chunk.sampleStart || segment.sourceSampleEnd > chunk.sampleEnd) {
    throw new Error(
      `Segment sample range [${segment.sourceSampleStart}, ${segment.sourceSampleEnd}) falls outside chunk sample range [${chunk.sampleStart}, ${chunk.sampleEnd}).`,
    );
  }

  const hdr = parseWavPcm16(chunkWavBytes);
  const expectedChunkFrames = chunk.sampleEnd - chunk.sampleStart;
  if (hdr.frameCount !== expectedChunkFrames) {
    throw new Error(
      `Chunk WAV frame count (${hdr.frameCount}) disagrees with chunk sample range (${expectedChunkFrames}).`,
    );
  }

  const chunkRelativeFrameStart = segment.sourceSampleStart - chunk.sampleStart;
  const chunkRelativeFrameEnd = segment.sourceSampleEnd - chunk.sampleStart;
  const frameCount = chunkRelativeFrameEnd - chunkRelativeFrameStart;
  if (frameCount <= 0) {
    throw new Error('Resolved audio slice has non-positive frame count.');
  }

  const view = new DataView(
    chunkWavBytes.buffer,
    chunkWavBytes.byteOffset + hdr.dataOffset,
    hdr.dataByteLength,
  );
  const samples = new Int16Array(frameCount * hdr.channels);
  let sumSq = 0;
  let zeroCrossings = 0;
  let prevMono = 0;

  for (let f = 0; f < frameCount; f++) {
    const absFrame = chunkRelativeFrameStart + f;
    let monoSum = 0;
    for (let ch = 0; ch < hdr.channels; ch++) {
      const s = view.getInt16((absFrame * hdr.channels + ch) * 2, true);
      samples[f * hdr.channels + ch] = s;
      monoSum += s;
    }
    const mono = monoSum / hdr.channels;
    sumSq += (mono / 32768) * (mono / 32768);
    if (f > 0 && ((prevMono < 0 && mono >= 0) || (prevMono > 0 && mono <= 0))) {
      zeroCrossings += 1;
    }
    prevMono = mono;
  }

  const rmsAmplitude = Math.sqrt(sumSq / frameCount);
  const durationSeconds = frameCount / hdr.sampleRateHz;
  const estimatedFrequencyHz =
    durationSeconds > 0 ? Math.round(zeroCrossings / (2 * durationSeconds)) : 0;

  return {
    chunkRelativeFrameStart,
    chunkRelativeFrameEnd,
    frameCount,
    durationMs: sourceSamplesToDurationMs(frameCount, hdr.sampleRateHz),
    samples,
    rmsAmplitude,
    estimatedFrequencyHz,
  };
}
