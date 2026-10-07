//! Chunk writer thread: the only place that writes audio files.
//!
//! Responsibilities (docs/recording.md §4 safe write/finalize protocol):
//! 1. consume blocks from a bounded queue (the capture callback never blocks on this thread);
//! 2. append interleaved s16le PCM to one `.partial` file per chunk;
//! 3. close a chunk when its samples would cross the next canonical `chunk_interval_ms` boundary, when
//!    a pause/stop requests a flush, or when a discontinuity begins a new segment;
//! 4. patch the container sizes, `fsync`, compute SHA-256 over the frozen bytes, atomically rename;
//! 5. report progress, drops, and faults to the coordinator.
//!
//! Deliberate limits: no JSON, no manifest mutation, no hashing while the file is open, and no
//! unbounded buffering. A queue overflow becomes an explicit `Overflow` outcome plus a new segment, so
//! lost audio is recorded as a gap instead of being papered over.

use crate::capture::{AudioBlock, BoundedBlockQueue};
use crate::errors::{RecorderError, RecorderErrorCode, SourceKind};
use crate::levels::{measure_i16, LevelSnapshot};
use crate::manifest::{
    chunk_file_name, idempotency_key, partial_file_name, Checksum, ChecksumAlgorithm, ChunkRecord, ChunkState, CaptureFormat,
    Codec, Container, UploadState, VerificationState,
};
use crate::storage::{sync_dir, PartialChunkFile};
use crate::timeline::{meeting_ms_from_ticks, sample_ticks, TimelineOrigin};
use crate::wav::{self, WavFormat};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::Arc;
use std::time::Duration;

/// Why a source started a new, uninterrupted run of samples.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegmentReason {
    Started,
    Resumed,
    AfterDropout,
    DeviceChanged,
}

/// Commands from the coordinator to a writer thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriterCommand {
    /// Close the open chunk durably and acknowledge (pause and stop both need this).
    Flush,
    /// Stop the thread without further writes.
    Abort,
}

/// One message from a writer thread to the coordinator. Every variant names its source, because two
/// sources must never be confused with each other.
#[derive(Debug, Clone, PartialEq)]
pub enum WriterOutcome {
    ChunkFinalized {
        kind: SourceKind,
        chunk: Box<ChunkRecord>,
    },
    Progress {
        kind: SourceKind,
        last_sample_index_exclusive: u64,
        last_tick: u128,
        meeting_ms: u64,
        level: LevelSnapshot,
    },
    SegmentStarted {
        kind: SourceKind,
        segment_index: u32,
        first_sample_index: u64,
        first_tick: u128,
        meeting_ms: u64,
        reason: SegmentReason,
    },
    Overflow {
        kind: SourceKind,
        dropped_samples: u64,
    },
    Flushed {
        kind: SourceKind,
    },
    Fault {
        kind: SourceKind,
        error: RecorderError,
    },
}

/// Poll interval for the writer loop: long enough to stay cheap, short enough that a `Flush` command is
/// answered well inside [`crate::session::FLUSH_TIMEOUT`].
pub const POLL_INTERVAL: Duration = Duration::from_millis(25);
const _: () = assert!(POLL_INTERVAL.as_millis() < 1000);

/// Static configuration of one writer thread.
#[derive(Debug, Clone)]
pub struct WriterSpec {
    pub kind: SourceKind,
    pub recording_id: String,
    pub recording_source_id: String,
    pub session_dir: PathBuf,
    pub origin: TimelineOrigin,
    pub chunk_interval_ms: u64,
    pub wav: WavFormat,
}

/// The chunk file currently being appended.
struct OpenChunk {
    partial: PartialChunkFile,
    segment_index: u32,
    first_sample_index: u64,
    first_tick: u128,
    /// Samples appended so far, in samples per channel (frames).
    sample_count: u64,
    /// Canonical end of this chunk's current boundary window.
    boundary_end_ms: u64,
}

/// Writer thread body. Created by the coordinator and moved into a `std::thread`.
pub struct ChunkWriter {
    spec: WriterSpec,
    queue: Arc<BoundedBlockQueue>,
    control: Receiver<WriterCommand>,
    flush_ack: Arc<AtomicBool>,
    new_segment_pending: Arc<AtomicBool>,
    device_changed_pending: Arc<AtomicBool>,
    outcomes: Sender<WriterOutcome>,
    open: Option<OpenChunk>,
    sequence_no: u64,
    segment_index: u32,
    last_sample_index_exclusive: u64,
    dropped_total: u64,
    aborted: bool,
    scratch: Vec<u8>,
}

impl ChunkWriter {
    #[must_use]
    pub fn new(
        spec: WriterSpec,
        queue: Arc<BoundedBlockQueue>,
        control: Receiver<WriterCommand>,
        flush_ack: Arc<AtomicBool>,
        new_segment_pending: Arc<AtomicBool>,
        device_changed_pending: Arc<AtomicBool>,
        outcomes: Sender<WriterOutcome>,
    ) -> Self {
        Self {
            spec,
            queue,
            control,
            flush_ack,
            new_segment_pending,
            device_changed_pending,
            outcomes,
            open: None,
            sequence_no: 0,
            segment_index: 0,
            last_sample_index_exclusive: 0,
            dropped_total: 0,
            aborted: false,
            scratch: Vec::with_capacity(64 * 1024),
        }
    }

    /// Consume blocks until the queue is closed (or the coordinator aborts us), then finalize.
    pub fn run(mut self) {
        let mut batch: Vec<AudioBlock> = Vec::with_capacity(16);
        while !self.aborted {
            batch.clear();
            let received = self.queue.pop_batch_timeout(32, &mut batch, POLL_INTERVAL);
            self.poll_control();
            self.poll_overflow();
            for block in batch.drain(..) {
                if self.aborted {
                    break;
                }
                self.handle_block(block);
            }
            if !received && self.queue.is_closed() && self.queue.pending_blocks() == 0 {
                break;
            }
        }
        if !self.aborted {
            self.finalize_open();
        } else if let Some(chunk) = self.open.take() {
            // An abort (fault already reported) leaves the partial file in place for recovery to judge.
            drop(chunk);
        }
        self.flush_ack.store(true, Ordering::Release);
    }

    fn poll_control(&mut self) {
        while let Ok(command) = self.control.try_recv() {
            match command {
                WriterCommand::Flush => {
                    self.finalize_open();
                    let _ = self.outcomes.send(WriterOutcome::Flushed { kind: self.spec.kind });
                    self.flush_ack.store(true, Ordering::Release);
                }
                WriterCommand::Abort => {
                    self.aborted = true;
                    self.queue.close();
                }
            }
        }
    }

    fn poll_overflow(&mut self) {
        let dropped = self.queue.dropped_samples();
        if dropped == 0 {
            return;
        }
        self.dropped_total += dropped;
        // Refused blocks mean missing samples: close the chunk so the gap is explicit, and start a new
        // segment so nothing is interpolated across the hole.
        self.new_segment_pending.store(true, Ordering::Release);
        self.finalize_open();
        let _ = self.outcomes.send(WriterOutcome::Overflow {
            kind: self.spec.kind,
            dropped_samples: dropped,
        });
    }

    fn handle_block(&mut self, block: AudioBlock) {
        let channels = u64::from(self.spec.wav.channels.max(1));
        let frames = u64::try_from(block.samples.len()).unwrap_or(0) / channels;
        if frames == 0 {
            return;
        }
        let crossing = self
            .open
            .as_ref()
            .is_some_and(|chunk| self.meeting_ms(self.next_tick(chunk)) >= chunk.boundary_end_ms);
        if crossing {
            self.finalize_open();
        }
        let forced_new_segment = block.discontinuity || self.new_segment_pending.swap(false, Ordering::AcqRel);
        if block.discontinuity {
            self.device_changed_pending.store(true, Ordering::Release);
        }
        if forced_new_segment {
            self.finalize_open();
            if self.last_sample_index_exclusive > 0 {
                self.segment_index += 1;
            }
            let reason = if self.last_sample_index_exclusive == 0 {
                SegmentReason::Started
            } else if self.device_changed_pending.swap(false, Ordering::AcqRel) {
                SegmentReason::DeviceChanged
            } else if self.dropped_total > 0 {
                SegmentReason::AfterDropout
            } else {
                SegmentReason::Resumed
            };
            let _ = self.outcomes.send(WriterOutcome::SegmentStarted {
                kind: self.spec.kind,
                segment_index: self.segment_index,
                first_sample_index: block.first_sample_index,
                first_tick: block.first_tick,
                meeting_ms: self.meeting_ms(block.first_tick),
                reason,
            });
        }
        if self.open.is_none() {
            match self.begin_chunk(block.first_sample_index, block.first_tick, self.segment_index) {
                Ok(chunk) => self.open = Some(chunk),
                Err(error) => {
                    self.report_fault(error);
                    return;
                }
            }
        }
        let Some(chunk) = self.open.as_mut() else {
            return;
        };
        // Conversion happens here, on the writer thread, never in a capture callback.
        self.scratch.clear();
        self.scratch.reserve(block.samples.len() * 2);
        for sample in &block.samples {
            self.scratch.extend_from_slice(&sample.to_le_bytes());
        }
        if let Err(error) = chunk.partial.append(&[&self.scratch]) {
            self.report_fault(error);
            return;
        }
        chunk.sample_count += frames;
        let chunk_first_sample_index = chunk.first_sample_index;
        let chunk_first_tick = chunk.first_tick;
        let chunk_sample_count = chunk.sample_count;
        self.last_sample_index_exclusive = block.first_sample_index + frames;
        let last_tick = self.tick_at(
            chunk_first_sample_index,
            chunk_first_tick,
            chunk_sample_count,
            frames,
        );
        let level = measure_i16(&block.samples);
        let _ = self.outcomes.send(WriterOutcome::Progress {
            kind: self.spec.kind,
            last_sample_index_exclusive: self.last_sample_index_exclusive,
            last_tick,
            meeting_ms: self.meeting_ms(last_tick),
            level,
        });
    }

    /// Monotonic tick of `first_sample_index + sample_count - 1` for a run that began at `first_tick`.
    fn tick_at(&self, first_sample_index: u64, first_tick: u128, sample_count: u64, frames: u64) -> u128 {
        let _ = frames;
        let segment = crate::timeline::SourceSegment {
            first_sample_index,
            first_sample_ticks: first_tick,
            sample_count: sample_count.max(1),
        };
        let index = i128::try_from(first_sample_index + sample_count.saturating_sub(1)).unwrap_or(0);
        let ticks = sample_ticks(&self.spec.origin, self.spec.wav.sample_rate_hz, &segment, index);
        u128::try_from(ticks).unwrap_or(0)
    }

    fn begin_chunk(&self, first_sample_index: u64, first_tick: u128, segment_index: u32) -> Result<OpenChunk, RecorderError> {
        let relative = PathBuf::from(partial_file_name(self.spec.kind, self.sequence_no, CaptureFormat::WavPcmS16Le));
        let header = wav::placeholder_header(self.spec.wav);
        let partial = PartialChunkFile::create(&self.spec.session_dir, &relative, &header)?;
        let start_ms = self.meeting_ms(first_tick);
        Ok(OpenChunk {
            partial,
            segment_index,
            first_sample_index,
            first_tick,
            sample_count: 0,
            boundary_end_ms: start_ms / self.spec.chunk_interval_ms * self.spec.chunk_interval_ms + self.spec.chunk_interval_ms,
        })
    }

    /// Monotonic tick at which the *next* frame would be sampled.
    fn next_tick(&self, chunk: &OpenChunk) -> u128 {
        let segment = crate::timeline::SourceSegment {
            first_sample_index: chunk.first_sample_index,
            first_sample_ticks: chunk.first_tick,
            sample_count: chunk.sample_count,
        };
        let ticks = sample_ticks(
            &self.spec.origin,
            self.spec.wav.sample_rate_hz,
            &segment,
            i128::try_from(chunk.first_sample_index + chunk.sample_count).unwrap_or(0),
        );
        u128::try_from(ticks).unwrap_or(0)
    }

    fn meeting_ms(&self, ticks: u128) -> u64 {
        meeting_ms_from_ticks(&self.spec.origin, ticks)
    }

    /// Close the open chunk: patch sizes, `fsync`, checksum, atomic rename, then report the record.
    fn finalize_open(&mut self) {
        let Some(chunk) = self.open.take() else { return };
        let data_bytes = chunk.partial.data_bytes();
        if chunk.sample_count == 0 || data_bytes == 0 {
            // Nothing was ever written: no artifact worth recovering, so remove the empty shell.
            let path = chunk.partial.path().to_path_buf();
            drop(chunk);
            let _ = std::fs::remove_file(&path);
            return;
        }
        let header = wav::header(self.spec.wav, data_bytes);
        let frames = chunk.sample_count;
        let first_sample_index = chunk.first_sample_index;
        let first_tick = chunk.first_tick;
        let segment_index = chunk.segment_index;
        let partial_relative = chunk
            .partial
            .path()
            .strip_prefix(&self.spec.session_dir)
            .unwrap_or(Path::new("chunk.wav.partial"))
            .to_path_buf();
        let finalized = match chunk.partial.finalize_with_header(&header) {
            Ok(finalized) => finalized,
            Err(error) => {
                self.report_fault(error);
                return;
            }
        };
        let digest = match finalized.sha256() {
            Ok(digest) => digest,
            Err(error) => {
                self.report_fault(error);
                return;
            }
        };
        let final_relative = PathBuf::from(chunk_file_name(self.spec.kind, self.sequence_no, CaptureFormat::WavPcmS16Le));
        let renamed = finalized.rename_to(&self.spec.session_dir, &final_relative);
        if let Err(error) = renamed {
            self.report_fault(error);
            return;
        }
        // Container header plus PCM payload; recorded for the size consistency check only.
        let byte_size = finalized.byte_size();
        let record = ChunkRecord {
            chunk_id: uuid::Uuid::new_v4().to_string(),
            recording_id: self.spec.recording_id.clone(),
            recording_source_id: self.spec.recording_source_id.clone(),
            source_kind: self.spec.kind,
            sequence_no: self.sequence_no,
            idempotency_key: idempotency_key(
                &self.spec.recording_id,
                &self.spec.recording_source_id,
                self.sequence_no,
            ),
            local_file: final_relative.to_string_lossy().to_string(),
            state: ChunkState::Finalized,
            meeting_start_ms: self.meeting_ms(first_tick),
            meeting_end_ms: self.end_ms(first_sample_index, first_tick, frames),
            duration_ms: frames * 1_000 / u64::from(self.spec.wav.sample_rate_hz),
            source_first_sample_index: first_sample_index,
            first_sample_monotonic_ticks: crate::manifest::DecimalU128(first_tick),
            sample_count: frames,
            byte_size,
            checksum: Some(Checksum {
                algorithm: ChecksumAlgorithm::Sha256,
                value: digest,
            }),
            codec: Codec::PcmS16Le,
            container: Container::Wav,
            sample_rate_hz: self.spec.wav.sample_rate_hz,
            channels: self.spec.wav.channels,
            encoder_delay_samples: 0,
            encoder_padding_samples: 0,
            segment_index,
            finalized_at: Some(crate::clock::now_utc_rfc3339()),
            upload_state: UploadState::Pending,
            verification_state: VerificationState::Pending,
            verified_at: None,
            storage_key: None,
        };
        let _ = partial_relative;
        sync_dir(&self.spec.session_dir);
        self.sequence_no += 1;
        let _ = self.outcomes.send(WriterOutcome::ChunkFinalized {
            kind: self.spec.kind,
            chunk: Box::new(record),
        });
    }

    fn end_ms(&self, first_sample_index: u64, first_tick: u128, frames: u64) -> u64 {
        let segment = crate::timeline::SourceSegment {
            first_sample_index,
            first_sample_ticks: first_tick,
            sample_count: frames,
        };
        let ticks = sample_ticks(
            &self.spec.origin,
            self.spec.wav.sample_rate_hz,
            &segment,
            i128::try_from(first_sample_index + frames).unwrap_or(0),
        );
        self.meeting_ms(u128::try_from(ticks).unwrap_or(0))
    }

    fn report_fault(&mut self, error: RecorderError) {
        self.aborted = true;
        self.queue.close();
        let _ = self.outcomes.send(WriterOutcome::Fault {
            kind: self.spec.kind,
            error: error.with_source(self.spec.kind),
        });
    }
}

