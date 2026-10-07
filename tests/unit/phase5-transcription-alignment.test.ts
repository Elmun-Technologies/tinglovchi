import { describe, expect, it } from 'vitest';
import type {
  ProviderTranscriptSegment,
  RecordingChunkDto,
  RecordingDto,
  RecordingSourceDto,
} from '@suhbat/contracts';
import {
  alignProviderTranscriptToCanonicalTimeline,
  mapAssetIntervalToCanonicalTimeline,
  prepareCanonicalTranscriptionAssetPlan,
} from '@suhbat/database/transcription-alignment';
import {
  AssemblyAITranscriptionProvider,
  FakeTranscriptionProvider,
  TranscriptionProviderError,
  createTranscriptionProviderFromEnv,
  normalizeAssemblyAITranscriptResponse,
} from '@suhbat/database/transcription-provider';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const meetingId = '22222222-2222-4222-8222-222222222222';
const recordingId = '33333333-3333-4333-8333-333333333333';
const micSourceId = '44444444-4444-4444-8444-444444444444';
const sysSourceId = '55555555-5555-4555-8555-555555555555';
const chunk0Id = '66666666-6666-4666-8666-666666666660';
const chunk1Id = '66666666-6666-4666-8666-666666666661';
const chunk2Id = '66666666-6666-4666-8666-666666666662';
const sysChunk0Id = '77777777-7777-4777-8777-777777777770';

function makeRecording(overrides: Partial<RecordingDto> = {}): RecordingDto {
  return {
    id: recordingId,
    workspaceId,
    meetingId,
    sessionId: '88888888-8888-4888-8888-888888888888',
    status: 'finalized',
    timeline: {
      clock: 'platform_monotonic_continuous',
      clockEpochId: 'epoch-mac-1',
      originTicks: '1000000000',
      originWallClockUtc: '2026-10-07T09:00:00.000Z',
      tickFrequencyHz: 1_000_000_000,
    },
    consent: {
      acknowledgedAt: '2026-10-07T09:00:00.000Z',
      policyVersion: 'v1',
    },
    canonicalDurationMs: 55_000,
    activeCaptureMs: 40_000,
    startedAt: '2026-10-07T09:00:00.000Z',
    stoppedAt: '2026-10-07T09:00:55.000Z',
    finalizedAt: '2026-10-07T09:00:56.000Z',
    manifestRevision: 2,
    createdBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    createdAt: '2026-10-07T09:00:00.000Z',
    updatedAt: '2026-10-07T09:00:56.000Z',
    ...overrides,
  };
}

function makeSource(overrides: Partial<RecordingSourceDto> = {}): RecordingSourceDto {
  return {
    id: micSourceId,
    workspaceId,
    meetingId,
    recordingId,
    sourceKind: 'microphone',
    sourceRole: 'original',
    isRequired: true,
    codec: 'pcm_s16le',
    container: 'wav',
    sampleRateHz: 48_000,
    channels: 1,
    deviceUid: 'built-in-mic',
    deviceName: 'MacBook Pro Microphone',
    startedAtTicks: '1000000000',
    endedAtTicks: '56000000000',
    firstSampleIndex: 0,
    lastSampleIndexExclusive: 1_920_000,
    firstSampleMeetingMs: 0,
    lastSampleMeetingMs: 55_000,
    droppedSampleCount: 0,
    expectedChunkCount: 2,
    createdAt: '2026-10-07T09:00:00.000Z',
    updatedAt: '2026-10-07T09:00:56.000Z',
    ...overrides,
  };
}

function makeChunk(overrides: Partial<RecordingChunkDto>): RecordingChunkDto {
  const seq = overrides.sequenceNo ?? 0;
  const srcId = overrides.recordingSourceId ?? micSourceId;
  return {
    id: chunk0Id,
    workspaceId,
    meetingId,
    recordingId,
    recordingSourceId: srcId,
    clientChunkId: chunk0Id,
    idempotencyKey: `${recordingId}:${srcId}:${seq}`,
    sequenceNo: seq,
    meetingStartMs: 0,
    meetingEndMs: 20_000,
    durationMs: 20_000,
    sampleStart: 0,
    sampleEnd: 960_000,
    firstSampleMonotonicTicks: '1000000000',
    byteSize: 4096,
    checksum: {
      algorithm: 'sha256',
      value: 'a'.repeat(64),
    },
    storageBackend: 'memory',
    storageKey: `workspace/${workspaceId}/meetings/${meetingId}/recordings/${recordingId}/sources/${srcId}/chunks/${String(seq).padStart(6, '0')}.wav`,
    uploadState: 'verified',
    verificationState: 'verified',
    codec: 'pcm_s16le',
    container: 'wav',
    sampleRateHz: 48_000,
    channels: 1,
    encoderDelaySamples: 0,
    encoderPaddingSamples: 0,
    verifiedByteSize: 4096,
    verifiedSha256: 'a'.repeat(64),
    verificationMethod: 'digest_computed_from_bytes',
    verificationErrorCode: null,
    createdAt: '2026-10-07T09:00:10.000Z',
    updatedAt: '2026-10-07T09:00:11.000Z',
    uploadedAt: '2026-10-07T09:00:10.500Z',
    verifiedAt: '2026-10-07T09:00:11.000Z',
    ...overrides,
  };
}

describe('Phase 5 — Canonical Transcription Asset Preparation & Timeline Alignment', () => {
  it('maps provider timestamps across contiguous chunk boundaries accurately', () => {
    const recording = makeRecording({ canonicalDurationMs: 40_000, activeCaptureMs: 40_000 });
    const source = makeSource();
    const chunks = [
      makeChunk({
        id: chunk0Id,
        sequenceNo: 0,
        meetingStartMs: 0,
        meetingEndMs: 20_000,
        durationMs: 20_000,
        sampleStart: 0,
        sampleEnd: 960_000,
      }),
      makeChunk({
        id: chunk1Id,
        sequenceNo: 1,
        meetingStartMs: 20_000,
        meetingEndMs: 40_000,
        durationMs: 20_000,
        sampleStart: 960_000,
        sampleEnd: 1_920_000,
      }),
    ];

    const plan = prepareCanonicalTranscriptionAssetPlan({
      recording,
      sources: [source],
      chunks,
      assetVersion: 1,
    });

    expect(plan.assetDurationMs).toBe(40_000);
    expect(plan.timelineMap).toHaveLength(2);
    expect(plan.timelineMap[0]?.discontinuityReason).toBe('none');
    expect(plan.timelineMap[1]?.discontinuityReason).toBe('none');

    // A segment spanning [18_500, 22_500] crosses the contiguous boundary at 20_000ms
    const segments: ProviderTranscriptSegment[] = [
      {
        providerSegmentKey: 'seg_boundary',
        speakerLabel: 'speaker_0',
        startMs: 18_500,
        endMs: 22_500,
        text: "Chunk chegarasidan o'tgan gapimiz aniq vaqtga tushishi kerak.",
        confidence: 0.95,
        detectedLanguage: 'uz',
        words: [
          {
            text: 'Chunk',
            startMs: 18_500,
            endMs: 19_800,
            confidence: 0.95,
            speakerLabel: 'speaker_0',
          },
          {
            text: 'chegarasidan',
            startMs: 19_800,
            endMs: 20_600,
            confidence: 0.95,
            speakerLabel: 'speaker_0',
          },
          {
            text: 'aniq',
            startMs: 20_600,
            endMs: 22_500,
            confidence: 0.95,
            speakerLabel: 'speaker_0',
          },
        ],
        providerMetadata: {},
      },
    ];

    const outcome = alignProviderTranscriptToCanonicalTimeline({
      segments,
      assetDurationMs: plan.assetDurationMs,
      timelineMap: plan.timelineMap,
    });

    expect(outcome.quarantinedSegments).toHaveLength(0);
    expect(outcome.canonicalSegments).toHaveLength(1);
    const aligned = outcome.canonicalSegments[0]!;
    expect(aligned.startMs).toBe(18_500);
    expect(aligned.endMs).toBe(22_500);
    expect(aligned.sourceSampleStart).toBe(888_000);
    expect(aligned.sourceSampleEnd).toBe(1_080_000);
    expect(aligned.alignmentMetadata.crossed_chunk_ids).toEqual([chunk0Id, chunk1Id]);
  });

  it('maps provider timestamps across pause gaps without fabricating coverage across the pause', () => {
    // Chunk 0: meeting [0..20_000], Chunk 1 after 15s pause: meeting [35_000..55_000]
    const recording = makeRecording({ canonicalDurationMs: 55_000, activeCaptureMs: 40_000 });
    const source = makeSource();
    const chunks = [
      makeChunk({
        id: chunk0Id,
        sequenceNo: 0,
        meetingStartMs: 0,
        meetingEndMs: 20_000,
        durationMs: 20_000,
        sampleStart: 0,
        sampleEnd: 960_000,
      }),
      makeChunk({
        id: chunk1Id,
        sequenceNo: 1,
        meetingStartMs: 35_000,
        meetingEndMs: 55_000,
        durationMs: 20_000,
        sampleStart: 960_000,
        sampleEnd: 1_920_000,
      }),
    ];

    const plan = prepareCanonicalTranscriptionAssetPlan({
      recording,
      sources: [source],
      chunks,
    });

    // Asset duration is 40_000ms (20_000 + 20_000), while canonical meeting duration is 55_000ms!
    expect(plan.assetDurationMs).toBe(40_000);
    expect(plan.canonicalDurationMs).toBe(55_000);
    expect(plan.preparationMetadata.pause_gap_count).toBe(1);
    expect(plan.preparationMetadata.total_pause_gap_ms).toBe(15_000);
    expect(plan.timelineMap[1]?.discontinuityReason).toBe('pause_gap');
    expect(plan.timelineMap[1]?.gapBeforeMeetingMs).toBe(15_000);

    // Provider segment 1 in Piece 0: asset [5_000..10_000] -> meeting [5_000..10_000]
    // Provider segment 2 in Piece 1: asset [22_000..27_000] -> meeting [37_000..42_000] (+15_000ms pause offset!)
    // Provider segment 3 illegally spanning across the pause boundary [19_000..21_000] -> quarantined!
    const outcome = alignProviderTranscriptToCanonicalTimeline({
      segments: [
        {
          providerSegmentKey: 'seg_before_pause',
          speakerLabel: 'speaker_0',
          startMs: 5_000,
          endMs: 10_000,
          text: 'Tanaffusdan oldingi muhokama.',
          confidence: 0.96,
          detectedLanguage: 'uz',
          words: [],
          providerMetadata: {},
        },
        {
          providerSegmentKey: 'seg_after_pause',
          speakerLabel: 'speaker_1',
          startMs: 22_000,
          endMs: 27_000,
          text: 'Продолжаем после паузы по плану поставок.',
          confidence: 0.94,
          detectedLanguage: 'ru',
          words: [],
          providerMetadata: {},
        },
        {
          providerSegmentKey: 'seg_crossing_pause',
          speakerLabel: 'speaker_0',
          startMs: 19_000,
          endMs: 21_000,
          text: 'This segment spans across a 15-second pause gap and must be quarantined.',
          confidence: 0.8,
          detectedLanguage: 'en',
          words: [],
          providerMetadata: {},
        },
      ],
      assetDurationMs: plan.assetDurationMs,
      timelineMap: plan.timelineMap,
    });

    expect(outcome.canonicalSegments).toHaveLength(2);
    expect(outcome.canonicalSegments[0]?.startMs).toBe(5_000);
    expect(outcome.canonicalSegments[0]?.endMs).toBe(10_000);
    expect(outcome.canonicalSegments[1]?.startMs).toBe(37_000);
    expect(outcome.canonicalSegments[1]?.endMs).toBe(42_000);
    expect(outcome.canonicalSegments[1]?.sourceRecordingChunkId).toBe(chunk1Id);

    // Segment spanning the pause gap is quarantined, never fabricating coverage across [20_000..35_000]
    expect(outcome.quarantinedSegments).toHaveLength(1);
    expect(outcome.quarantinedSegments[0]?.providerSegmentKey).toBe('seg_crossing_pause');
    expect(outcome.quarantinedSegments[0]?.reason).toBe('segment_spans_timeline_discontinuity');
  });

  it('maps provider timestamps with late source start offset and multi-source concatenation', () => {
    // Mic starts at meeting t=3_000ms..13_000ms (10s)
    // System audio starts at meeting t=5_000ms..15_000ms (10s)
    const recording = makeRecording({ canonicalDurationMs: 15_000, activeCaptureMs: 10_000 });
    const micSource = makeSource({
      id: micSourceId,
      sourceKind: 'microphone',
      firstSampleMeetingMs: 3_000,
      lastSampleMeetingMs: 13_000,
    });
    const sysSource = makeSource({
      id: sysSourceId,
      sourceKind: 'system_audio',
      isRequired: false,
      firstSampleMeetingMs: 5_000,
      lastSampleMeetingMs: 15_000,
      droppedSampleCount: 480,
    });
    const chunks = [
      makeChunk({
        id: chunk2Id,
        recordingSourceId: micSourceId,
        sequenceNo: 0,
        meetingStartMs: 3_000,
        meetingEndMs: 13_000,
        durationMs: 10_000,
        sampleStart: 0,
        sampleEnd: 480_000,
      }),
      makeChunk({
        id: sysChunk0Id,
        recordingSourceId: sysSourceId,
        sequenceNo: 0,
        meetingStartMs: 5_000,
        meetingEndMs: 15_000,
        durationMs: 10_000,
        sampleStart: 0,
        sampleEnd: 480_000,
      }),
    ];

    const plan = prepareCanonicalTranscriptionAssetPlan({
      recording,
      sources: [micSource, sysSource],
      chunks,
    });

    // Piece 0 (mic): asset [0..10_000] -> meeting [3_000..13_000] (late_source_join)
    // Piece 1 (system_audio): asset [10_000..20_000] -> meeting [5_000..15_000] (source_concatenation)
    expect(plan.assetDurationMs).toBe(20_000);
    expect(plan.timelineMap).toHaveLength(2);
    expect(plan.timelineMap[0]?.discontinuityReason).toBe('late_source_join');
    expect(plan.timelineMap[1]?.discontinuityReason).toBe('source_concatenation');
    expect(plan.preparationMetadata.total_dropped_samples).toBe(480);

    // Provider segment in mic piece [1_000..4_000] -> meeting [4_000..7_000]
    // Provider segment in system_audio piece [11_000..14_000] -> meeting [6_000..9_000]
    const outcome = alignProviderTranscriptToCanonicalTimeline({
      segments: [
        {
          providerSegmentKey: 'seg_mic',
          speakerLabel: 'speaker_0',
          startMs: 1_000,
          endMs: 4_000,
          text: 'Local microphone utterance after 3-second offset.',
          confidence: 0.95,
          detectedLanguage: 'en',
          words: [],
          providerMetadata: {},
        },
        {
          providerSegmentKey: 'seg_sys',
          speakerLabel: 'speaker_1',
          startMs: 11_000,
          endMs: 14_000,
          text: 'Remote participant on system audio channel.',
          confidence: 0.92,
          detectedLanguage: 'en',
          words: [],
          providerMetadata: {},
        },
      ],
      assetDurationMs: plan.assetDurationMs,
      timelineMap: plan.timelineMap,
    });

    expect(outcome.quarantinedSegments).toHaveLength(0);
    expect(outcome.canonicalSegments).toHaveLength(2);
    // Ordered deterministically by canonical meeting startMs: [4_000..7_000], then [6_000..9_000]
    expect(outcome.canonicalSegments[0]?.startMs).toBe(4_000);
    expect(outcome.canonicalSegments[0]?.endMs).toBe(7_000);
    expect(outcome.canonicalSegments[0]?.sourceRecordingSourceId).toBe(micSourceId);
    expect(outcome.canonicalSegments[1]?.startMs).toBe(6_000);
    expect(outcome.canonicalSegments[1]?.endMs).toBe(9_000);
    expect(outcome.canonicalSegments[1]?.sourceRecordingSourceId).toBe(sysSourceId);
  });

  it('rejects and quarantines negative, zero-length, and out-of-range timestamps without silent clamping', () => {
    const recording = makeRecording({ canonicalDurationMs: 20_000, activeCaptureMs: 20_000 });
    const source = makeSource();
    const chunks = [
      makeChunk({
        id: chunk0Id,
        sequenceNo: 0,
        meetingStartMs: 0,
        meetingEndMs: 20_000,
        durationMs: 20_000,
        sampleStart: 0,
        sampleEnd: 960_000,
      }),
    ];
    const plan = prepareCanonicalTranscriptionAssetPlan({
      recording,
      sources: [source],
      chunks,
    });

    const negCheck = mapAssetIntervalToCanonicalTimeline({
      assetStartMs: -250,
      assetEndMs: 3_000,
      assetDurationMs: plan.assetDurationMs,
      timelineMap: plan.timelineMap,
    });
    expect(negCheck.ok).toBe(false);
    if (!negCheck.ok) {
      expect(negCheck.reason).toBe('negative_or_non_integer_timestamp');
    }

    const zeroLenCheck = mapAssetIntervalToCanonicalTimeline({
      assetStartMs: 5_000,
      assetEndMs: 5_000,
      assetDurationMs: plan.assetDurationMs,
      timelineMap: plan.timelineMap,
    });
    expect(zeroLenCheck.ok).toBe(false);
    if (!zeroLenCheck.ok) {
      expect(zeroLenCheck.reason).toBe('non_positive_segment_duration');
    }

    const overflowCheck = mapAssetIntervalToCanonicalTimeline({
      assetStartMs: 18_000,
      assetEndMs: 20_500,
      assetDurationMs: plan.assetDurationMs,
      timelineMap: plan.timelineMap,
    });
    expect(overflowCheck.ok).toBe(false);
    if (!overflowCheck.ok) {
      expect(overflowCheck.reason).toBe('timestamp_exceeds_asset_duration');
    }
  });
});

describe('Phase 5 — FakeTranscriptionProvider & AssemblyAITranscriptionProvider', () => {
  it('FakeTranscriptionProvider produces multi-speaker, multilingual uz/ru/en/mixed code-switched segments suitable for windowing', async () => {
    const recording = makeRecording();
    const source = makeSource();
    const chunks = [
      makeChunk({
        id: chunk0Id,
        sequenceNo: 0,
        meetingStartMs: 0,
        meetingEndMs: 20_000,
        durationMs: 20_000,
      }),
      makeChunk({
        id: chunk1Id,
        sequenceNo: 1,
        meetingStartMs: 35_000,
        meetingEndMs: 55_000,
        durationMs: 20_000,
      }),
    ];
    const plan = prepareCanonicalTranscriptionAssetPlan({
      recording,
      sources: [source],
      chunks,
    });

    const provider = new FakeTranscriptionProvider();
    const result = await provider.transcribe({
      assetId: '99999999-9999-4999-8999-999999999999',
      workspaceId,
      meetingId,
      recordingId,
      assetVersion: 1,
      storageKey: plan.storageKey,
      assetDurationMs: plan.assetDurationMs,
      sampleRateHz: plan.sampleRateHz,
      channels: plan.channels,
      timelineMap: plan.timelineMap,
    });

    expect(result.provider).toBe('fake');
    expect(result.segments.length).toBeGreaterThanOrEqual(12);

    const speakers = new Set(result.segments.map((s) => s.speakerLabel));
    expect(speakers.has('speaker_0')).toBe(true);
    expect(speakers.has('speaker_1')).toBe(true);
    expect(speakers.has('speaker_2')).toBe(true);

    const languages = new Set(result.segments.map((s) => s.detectedLanguage));
    expect(languages.has('uz')).toBe(true);
    expect(languages.has('ru')).toBe(true);
    expect(languages.has('en')).toBe(true);
    expect(languages.has('mixed')).toBe(true);
  });

  it('AssemblyAITranscriptionProvider remains disabled without credentials, fails clearly when invoked, and normalizes AssemblyAI responses without leaking raw shapes', async () => {
    const unconfigured = new AssemblyAITranscriptionProvider({});
    expect(unconfigured.isConfigured()).toBe(false);

    await expect(
      unconfigured.transcribe({
        assetId: '99999999-9999-4999-8999-999999999999',
        workspaceId,
        meetingId,
        recordingId,
        assetVersion: 1,
        storageKey: 'workspace/w/meetings/m/recordings/r/transcription-assets/v0001.wav',
        signedAudioUrl: 'https://storage.example/audio.wav',
        assetDurationMs: 20_000,
        sampleRateHz: 48_000,
        channels: 1,
        timelineMap: [],
      }),
    ).rejects.toThrowError(TranscriptionProviderError);

    // Normalize a realistic AssemblyAI payload
    const normalized = normalizeAssemblyAITranscriptResponse(
      {
        id: 'aai_tx_987654',
        status: 'completed',
        audio_duration: 18.4,
        utterances: [
          {
            speaker: 'A',
            start: 400,
            end: 5200,
            confidence: 0.94,
            language_code: 'uz',
            text: "Assalomu alaykum, bugun Q4 eksport rejasi bo'yicha gaplashamiz.",
            words: [
              { text: 'Assalomu', start: 400, end: 1100, confidence: 0.96, speaker: 'A' },
              { text: 'alaykum,', start: 1120, end: 1900, confidence: 0.95, speaker: 'A' },
            ],
          },
          {
            speaker: 'B',
            start: 5600,
            end: 11800,
            confidence: 0.91,
            text: "По логистике SLA bo'yicha 99.5% target qo'yamiz.",
            words: [],
          },
        ],
      },
      { model: 'universal-2' },
    );

    expect(normalized.provider).toBe('assemblyai');
    expect(normalized.providerModel).toBe('universal-2');
    expect(normalized.providerJobId).toBe('aai_tx_987654');
    expect(normalized.durationMs).toBe(18_400);
    expect(normalized.segments).toHaveLength(2);
    expect(normalized.segments[0]?.speakerLabel).toBe('speaker_0');
    expect(normalized.segments[0]?.detectedLanguage).toBe('uz');
    expect(normalized.segments[1]?.speakerLabel).toBe('speaker_1');
    expect(normalized.segments[1]?.detectedLanguage).toBe('mixed');

    // Never silently fall back from assemblyai to fake in createTranscriptionProviderFromEnv
    const envProvider = createTranscriptionProviderFromEnv({
      NODE_ENV: 'development',
      TRANSCRIPTION_PROVIDER: 'assemblyai',
    });
    expect(envProvider.providerName).toBe('assemblyai');
    expect(envProvider.isConfigured()).toBe(false);

    // Reject fake provider in production
    expect(() =>
      createTranscriptionProviderFromEnv({
        NODE_ENV: 'production',
        TRANSCRIPTION_PROVIDER: 'fake',
      }),
    ).toThrowError(/not permitted in production/);
  });
});
