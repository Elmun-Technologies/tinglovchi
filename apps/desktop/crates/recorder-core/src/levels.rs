//! Level metering computed off the writer thread (docs/recording.md §3: no work in realtime callbacks).
//!
//! Pure integer/float math over already-copied PCM blocks: the capture callback only pushes samples
//! into a bounded queue, and this module turns a block into a displayable meter value plus clipping
//! evidence. `live == false` is only ever produced by an absent source, never as a filler.

use serde::{Deserialize, Serialize};

/// Full-scale floor reported for digital silence, matching typical meter UIs.
pub const SILENCE_DBFS: f32 = -120.0;
/// Peak of a digital-silence block.
pub const SILENCE_PEAK: f32 = 0.0;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelSnapshot {
    /// Peak magnitude in `0.0..=1.0`.
    pub peak: f32,
    /// Root mean square in `0.0..=1.0`.
    pub rms: f32,
    /// Peak expressed in dBFS, clamped at [`SILENCE_DBFS`].
    pub peak_dbfs: f32,
    /// Samples that hit the rail: evidence of a bad gain stage, not a silent failure.
    pub clipping_samples: u32,
    /// Samples analysed in this block.
    pub block_sample_count: u32,
    /// False when no audio was delivered, so the UI can distinguish silence from absence.
    pub live: bool,
}

impl LevelSnapshot {
    #[must_use]
    pub const fn silent() -> Self {
        Self {
            peak: SILENCE_PEAK,
            rms: SILENCE_PEAK,
            peak_dbfs: SILENCE_DBFS,
            clipping_samples: 0,
            block_sample_count: 0,
            live: false,
        }
    }
}

/// Measure one block of interleaved signed 16-bit PCM.
#[must_use]
pub fn measure_i16(samples: &[i16]) -> LevelSnapshot {
    if samples.is_empty() {
        return LevelSnapshot::silent();
    }
    let mut peak_i: i32 = 0;
    let mut squares: f64 = 0.0;
    let mut clipping = 0u32;
    for &sample in samples {
        let magnitude = i32::from(sample).abs();
        if magnitude > peak_i {
            peak_i = magnitude;
        }
        if magnitude >= i32::from(i16::MAX) {
            clipping += 1;
        }
        let normalized = f64::from(sample) / f64::from(i16::MAX);
        squares += normalized * normalized;
    }
    let peak = f32::from(peak_i) / f32::from(i16::MAX);
    let rms = (squares / f64::from(samples.len())).sqrt() as f32;
    LevelSnapshot {
        peak,
        rms,
        peak_dbfs: dbfs_from_peak(peak),
        clipping_samples: clipping,
        block_sample_count: u32::try_from(samples.len()).unwrap_or(u32::MAX),
        live: true,
    }
}

/// Convert a linear peak to dBFS, mapping exact silence to [`SILENCE_DBFS`] instead of `-inf`.
#[must_use]
pub fn dbfs_from_peak(peak: f32) -> f32 {
    if peak <= 0.0 || !peak.is_finite() {
        return SILENCE_DBFS;
    }
    let dbfs = 20.0 * peak.log10();
    if dbfs < SILENCE_DBFS || !dbfs.is_finite() {
        SILENCE_DBFS
    } else {
        dbfs.min(0.0)
    }
}

/// Exponential smoothing for display, so a 20 Hz event stream is readable without extra work in the
/// capture path. `attack`/`release` are the coefficients for rising and falling levels.
#[must_use]
pub fn smooth(previous: f32, next: f32, attack: f32, release: f32) -> f32 {
    let coefficient = if next > previous { attack } else { release };
    previous + (next - previous) * coefficient
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digital_silence_is_zero_not_unknown() {
        let snapshot = measure_i16(&[0i16; 480]);
        assert!(snapshot.live);
        assert_eq!(snapshot.peak, 0.0);
        assert_eq!(snapshot.rms, 0.0);
        assert_eq!(snapshot.peak_dbfs, SILENCE_DBFS);
        assert_eq!(snapshot.block_sample_count, 480);
        assert_eq!(measure_i16(&[]), LevelSnapshot::silent());
        assert!(!LevelSnapshot::silent().live);
    }

    #[test]
    fn full_scale_and_clipping_are_measured() {
        let samples = [i16::MIN, -1_000, 0, 16_384, i16::MAX];
        let snapshot = measure_i16(&samples);
        assert_eq!(snapshot.peak, 1.0);
        assert_eq!(snapshot.peak_dbfs, 0.0);
        assert_eq!(snapshot.clipping_samples, 2);
        let quiet = measure_i16(&[16_384i16; 4]);
        assert!((quiet.peak_dbfs + 6.0206).abs() < 0.01, "half scale is about -6 dBFS");
        assert_eq!(quiet.clipping_samples, 0);
    }

    #[test]
    fn rms_tracks_the_waveform() {
        let sine: Vec<i16> = (0..480)
            .map(|i| (f64::from(i) / 480.0 * std::f64::consts::TAU).sin() * 16_000.0)
            .map(|value| value as i16)
            .collect();
        let snapshot = measure_i16(&sine);
        assert!(snapshot.rms > 0.3 && snapshot.rms < 0.9, "rms {}", snapshot.rms);
        assert!(snapshot.peak > snapshot.rms);
    }

    #[test]
    fn dbfs_conversion_is_bounded_and_monotonic() {
        assert_eq!(dbfs_from_peak(0.0), SILENCE_DBFS);
        assert_eq!(dbfs_from_peak(f32::NAN), SILENCE_DBFS);
        assert_eq!(dbfs_from_peak(1.0), 0.0);
        assert!(dbfs_from_peak(1.5) <= 0.0);
        assert!(dbfs_from_peak(0.5) > dbfs_from_peak(0.25));
    }

    #[test]
    fn smoothing_rises_faster_than_it_falls() {
        assert!((smooth(0.0, 1.0, 0.7, 0.1) - 0.7).abs() < 1e-6);
        assert!((smooth(1.0, 0.0, 0.7, 0.1) - 0.9).abs() < 1e-6);
    }
}
