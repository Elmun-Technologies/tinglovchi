//! Minimal RIFF/WAVE (signed 16-bit little-endian PCM) container helpers.
//!
//! Only the parts the recorder needs: a deterministic 44-byte header, a strict parser for recovery,
//! and frame/byte arithmetic. Container metadata is used for *consistency checks only*: the chunk's
//! meeting interval and duration come from sample counts and the clock map (see `timeline`).

use crate::errors::{RecorderError, RecorderErrorCode};

/// Header size of the canonical PCM WAV layout this implementation writes.
pub const HEADER_BYTES: usize = 44;
/// PCM format tag.
const FORMAT_PCM: u16 = 1;
const BITS_PER_SAMPLE: u16 = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WavFormat {
    pub sample_rate_hz: u32,
    pub channels: u16,
}

impl WavFormat {
    #[must_use]
    pub const fn bytes_per_frame(self) -> u64 {
        u64::from(self.channels) * u64::from(BITS_PER_SAMPLE / 8)
    }

    #[must_use]
    pub const fn bytes_per_second(self) -> u64 {
        u64::from(self.sample_rate_hz) * self.bytes_per_frame()
    }
}

/// Build the 44-byte header for `data_bytes` of PCM payload.
#[must_use]
pub fn header(format: WavFormat, data_bytes: u64) -> [u8; HEADER_BYTES] {
    let byte_rate = u32::try_from(format.bytes_per_second()).unwrap_or(u32::MAX);
    let block_align = u16::try_from(format.bytes_per_frame()).unwrap_or(u16::MAX);
    let mut out = [0u8; HEADER_BYTES];
    out[0..4].copy_from_slice(b"RIFF");
    out[4..8].copy_from_slice(&u32::try_from(36 + data_bytes).unwrap_or(u32::MAX).to_le_bytes());
    out[8..12].copy_from_slice(b"WAVE");
    out[12..16].copy_from_slice(b"fmt ");
    out[16..20].copy_from_slice(&16u32.to_le_bytes());
    out[20..22].copy_from_slice(&FORMAT_PCM.to_le_bytes());
    out[22..24].copy_from_slice(&format.channels.to_le_bytes());
    out[24..28].copy_from_slice(&format.sample_rate_hz.to_le_bytes());
    out[28..32].copy_from_slice(&byte_rate.to_le_bytes());
    out[32..34].copy_from_slice(&block_align.to_le_bytes());
    out[34..36].copy_from_slice(&BITS_PER_SAMPLE.to_le_bytes());
    out[36..40].copy_from_slice(b"data");
    out[40..44].copy_from_slice(&u32::try_from(data_bytes).unwrap_or(u32::MAX).to_le_bytes());
    out
}

/// Placeholder header written when a chunk file is created: sizes are patched at finalize.
#[must_use]
pub fn placeholder_header(format: WavFormat) -> [u8; HEADER_BYTES] {
    header(format, 0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParsedWav {
    pub format: WavFormat,
    pub data_offset: u64,
    pub data_bytes: u64,
    /// Frames declared by the header, which can disagree with the file length after a crash.
    pub declared_frames: u64,
    /// Frames actually present in the file, computed from `file_bytes - data_offset`.
    pub present_frames: u64,
    pub truncated: bool,
}

/// Parse and validate a header plus the trailing byte count.
///
/// # Errors
/// Returns [`RecorderError`] when the bytes are not a PCM WAV this recorder could have written.
pub fn parse(header_bytes: &[u8], file_bytes: u64) -> Result<ParsedWav, RecorderError> {
    if header_bytes.len() < HEADER_BYTES {
        return Err(invalid("file is shorter than a WAV header"));
    }
    if &header_bytes[0..4] != b"RIFF" || &header_bytes[8..12] != b"WAVE" {
        return Err(invalid("not a RIFF/WAVE file"));
    }
    if &header_bytes[12..16] != b"fmt " {
        return Err(invalid("missing fmt chunk"));
    }
    let read_u16 = |offset: usize| u16::from_le_bytes([header_bytes[offset], header_bytes[offset + 1]]);
    let read_u32 = |offset: usize| {
        u32::from_le_bytes([
            header_bytes[offset],
            header_bytes[offset + 1],
            header_bytes[offset + 2],
            header_bytes[offset + 3],
        ])
    };
    if read_u16(20) != FORMAT_PCM {
        return Err(invalid("only PCM format is supported by this recorder"));
    }
    let channels = read_u16(22);
    let sample_rate = read_u32(24);
    let bits = read_u16(34);
    if bits != BITS_PER_SAMPLE {
        return Err(invalid("only signed 16-bit PCM is supported by this recorder"));
    }
    if channels == 0 || channels > 32 || sample_rate == 0 {
        return Err(invalid("implausible WAV channel count or sample rate"));
    }
    if &header_bytes[36..40] != b"data" {
        return Err(invalid("missing data chunk"));
    }
    let data_bytes = u64::from(read_u32(40));
    let bytes_per_frame = u64::from(channels) * u64::from(BITS_PER_SAMPLE / 8);
    let present = file_bytes.saturating_sub(u64::try_from(HEADER_BYTES).unwrap_or(44));
    let truncated = present < data_bytes;
    Ok(ParsedWav {
        format: WavFormat {
            sample_rate_hz: sample_rate,
            channels,
        },
        data_offset: u64::try_from(HEADER_BYTES).unwrap_or(44),
        data_bytes: present.min(data_bytes),
        declared_frames: data_bytes / bytes_per_frame,
        present_frames: present / bytes_per_frame,
        truncated,
    })
}

fn invalid(message: impl Into<String>) -> RecorderError {
    RecorderError::new(RecorderErrorCode::SessionNotRecoverable, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_round_trips_the_format_metadata() {
        let format = WavFormat {
            sample_rate_hz: 48_000,
            channels: 2,
        };
        let bytes = header(format, 4_800);
        let parsed = parse(&bytes, 44 + 4_800).expect("valid header");
        assert_eq!(parsed.format, format);
        assert_eq!(parsed.data_bytes, 4_800);
        assert_eq!(parsed.declared_frames, 1_200);
        assert_eq!(parsed.present_frames, 1_200);
        assert!(!parsed.truncated);
        assert_eq!(bytes[0..4], *b"RIFF");
        assert_eq!(u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]), 4_836);
    }

    #[test]
    fn byte_rate_and_alignment_are_consistent() {
        let mono = WavFormat {
            sample_rate_hz: 48_000,
            channels: 1,
        };
        assert_eq!(mono.bytes_per_frame(), 2);
        assert_eq!(mono.bytes_per_second(), 96_000);
        assert_eq!(mono.bytes_per_second() * 30, 2_880_000, "a 30 s mono chunk is 2.75 MiB");
        let stereo = WavFormat {
            sample_rate_hz: 48_000,
            channels: 2,
        };
        assert_eq!(stereo.bytes_per_second(), 192_000);
    }

    #[test]
    fn truncation_is_detected_instead_of_trusting_the_header() {
        let format = WavFormat {
            sample_rate_hz: 48_000,
            channels: 1,
        };
        let bytes = header(format, 96_000);
        let parsed = parse(&bytes, 44 + 1_000).expect("parses");
        assert!(parsed.truncated, "a crashed chunk must be reported as truncated");
        assert_eq!(parsed.present_frames, 500);
        assert_eq!(parsed.data_bytes, 1_000);
    }

    #[test]
    fn foreign_or_corrupt_containers_are_rejected() {
        let mut bytes = header(
            WavFormat {
                sample_rate_hz: 48_000,
                channels: 1,
            },
            0,
        )
        .to_vec();
        let parsed = parse(&bytes, 44).expect("an empty chunk still parses");
        assert_eq!(parsed.present_frames, 0);
        assert!(!parsed.truncated);
        bytes[0..4].copy_from_slice(b"OggS");
        assert!(parse(&bytes, 44).is_err(), "an Ogg stream is not our container");
        let mut bytes = header(
            WavFormat {
                sample_rate_hz: 48_000,
                channels: 1,
            },
            0,
        )
        .to_vec();
        bytes[20..22].copy_from_slice(&3u16.to_le_bytes());
        assert!(parse(&bytes, 44).is_err(), "IEEE-float format tag is not written here");
        let mut bytes = header(
            WavFormat {
                sample_rate_hz: 48_000,
                channels: 1,
            },
            0,
        )
        .to_vec();
        bytes[34..36].copy_from_slice(&32u16.to_le_bytes());
        assert!(parse(&bytes, 44).is_err(), "32-bit payloads are not written here");
        assert!(parse(&[0u8; 10], 10).is_err());
    }
}
