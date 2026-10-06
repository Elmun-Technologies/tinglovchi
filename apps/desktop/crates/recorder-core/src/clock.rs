//! Host clock access, kept behind a trait so timeline logic is testable without hardware.
//!
//! Two clocks are used and never confused (docs/recording.md §3):
//! * a **monotonic continuous** clock that defines the canonical meeting timeline (`t = 0` and every
//!   sample offset). Raw tick readings are only comparable inside one clock epoch, so the epoch id is
//!   persisted alongside them;
//! * a **UTC wall clock**, persisted as metadata only (start/stop/consent/audit timestamps). It never
//!   computes meeting offsets, so NTP steps, DST changes, or a user editing the date cannot reorder
//!   evidence or shift the timeline.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU128, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Nanosecond-resolution monotonic clock used by the recorder.
pub const TICK_FREQUENCY_HZ: u128 = 1_000_000_000;

/// Reads the host clocks.
pub trait Clock: Send + Sync {
    /// Monotonic ticks. Only comparable with readings that share `epoch_id`.
    fn monotonic_ticks(&self) -> u128;
    /// Identifier of the current monotonic epoch; changes across a boot, so stale ticks are detected.
    fn epoch_id(&self) -> String;
    /// Milliseconds since the Unix epoch, for persisted metadata only.
    fn wall_clock_ms(&self) -> u64;

    /// RFC 3339 UTC timestamp of the wall clock at `millis`.
    fn wall_clock_rfc3339(&self, millis: u64) -> String {
        rfc3339_from_unix_millis(millis)
    }
}

/// Real host clock: `clock_gettime(CLOCK_MONOTONIC_RAW/…)` for ticks and the system clock for UTC.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl SystemClock {
    #[must_use]
    pub const fn new() -> Self {
        Self
    }
}

impl Clock for SystemClock {
    fn monotonic_ticks(&self) -> u128 {
        monotonic_ns()
    }

    fn epoch_id(&self) -> String {
        // Boot instant derived from the difference between UTC and the monotonic clock: stable for the
        // whole boot, different after a reboot, and requiring no extra privileges.
        let wall = wall_clock_ns();
        let monotonic = monotonic_ns();
        let boot_seconds = wall.saturating_sub(monotonic) / 1_000_000_000;
        format!("boot-{}", i128::try_from(boot_seconds).unwrap_or(0))
    }

    fn wall_clock_ms(&self) -> u64 {
        (wall_clock_ns() / 1_000_000) as u64
    }
}

#[cfg(unix)]
fn monotonic_ns() -> u128 {
    let (secs, nsecs) = posix_clock(CLOCK_ID_MONOTONIC);
    u128::from(secs) * 1_000_000_000 + u128::from(nsecs)
}

/// Unsupported platforms (Windows in this phase) have no capture at all, so this fallback only needs
/// to compile; it is process-relative and is never persisted as session audio time.
#[cfg(not(unix))]
fn monotonic_ns() -> u128 {
    u128::try_from(std::time::UNIX_EPOCH.elapsed().map(|since| since.as_nanos()).unwrap_or(0)).unwrap_or(0)
}

#[cfg(unix)]
fn wall_clock_ns() -> u128 {
    let (secs, nsecs) = posix_clock(CLOCK_ID_REALTIME);
    u128::from(secs) * 1_000_000_000 + u128::from(nsecs)
}

#[cfg(not(unix))]
fn wall_clock_ns() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_nanos())
        .unwrap_or(0)
}

#[cfg(target_os = "macos")]
const CLOCK_ID_MONOTONIC: libc::clockid_t = libc::CLOCK_MONOTONIC_RAW;
#[cfg(all(unix, not(target_os = "macos")))]
const CLOCK_ID_MONOTONIC: libc::clockid_t = libc::CLOCK_MONOTONIC;
#[cfg(unix)]
const CLOCK_ID_REALTIME: libc::clockid_t = libc::CLOCK_REALTIME;

#[cfg(unix)]
fn posix_clock(clock_id: libc::clockid_t) -> (u64, u32) {
    let mut time = std::mem::MaybeUninit::<libc::timespec>::uninit();
    // SAFETY: `time` is a writable timespec and `clock_gettime` fills it on success.
    let result = unsafe { libc::clock_gettime(clock_id, time.as_mut_ptr()) };
    if result != 0 {
        return (0, 0);
    }
    // SAFETY: `clock_gettime` succeeded, so the struct is initialised.
    let time = unsafe { time.assume_init() };
    let secs = u64::try_from(time.tv_sec).unwrap_or(0);
    let nsecs = u32::try_from(time.tv_nsec).unwrap_or(0);
    (secs, nsecs)
}

/// Clock the tests drive by hand: no sleeping, no floating point, exact expected numbers.
#[derive(Debug, Default)]
pub struct MockClock {
    ticks: AtomicU128,
    wall_ms: AtomicU128,
    epoch: String,
}

impl MockClock {
    #[must_use]
    pub fn new(start_ticks: u128, start_wall_ms: u64) -> Self {
        Self {
            ticks: AtomicU128::new(start_ticks),
            wall_ms: AtomicU128::new(u128::from(start_wall_ms)),
            epoch: "boot-mock".into(),
        }
    }

    /// Advance the monotonic clock by `nanos` (and wall time with it, as a real clock would).
    pub fn advance_ns(&self, nanos: u128) {
        self.ticks.fetch_add(nanos, Ordering::Relaxed);
        self.wall_ms.fetch_add(nanos / 1_000_000, Ordering::Relaxed);
    }

    /// Simulate a wall-clock-only jump (sleep, NTP step): the monotonic clock does not move.
    pub fn advance_wall_only_ms(&self, millis: u64) {
        self.wall_ms.fetch_add(u128::from(millis), Ordering::Relaxed);
    }

    /// Pretend the process was started in a different monotonic epoch (simulates a reboot).
    #[must_use]
    pub fn with_epoch(mut self, epoch: &str) -> Self {
        self.epoch = epoch.to_string();
        self
    }
}

impl Clock for MockClock {
    fn monotonic_ticks(&self) -> u128 {
        self.ticks.load(Ordering::Relaxed)
    }

    fn epoch_id(&self) -> String {
        self.epoch.clone()
    }

    fn wall_clock_ms(&self) -> u64 {
        u64::try_from(self.wall_ms.load(Ordering::Relaxed)).unwrap_or(0)
    }
}

/// Current UTC timestamp, RFC 3339 with second precision.
#[must_use]
pub fn now_utc_rfc3339() -> String {
    rfc3339_from_unix_millis(SystemTime::now().duration_since(UNIX_EPOCH).map(|since| since.as_millis() as u64).unwrap_or(0))
}

#[must_use]
pub fn rfc3339_from_unix_millis(millis: u64) -> String {
    let seconds = (millis / 1_000) as i64;
    let millis_of_second = millis % 1_000;
    let days = seconds.div_euclid(86_400);
    let seconds = seconds.rem_euclid(86_400);
    let hour = seconds / 3_600;
    let minute = (seconds % 3_600) / 60;
    let second = seconds % 60;
    let (year, month, day) = civil_from_days(days);
    if millis_of_second == 0 {
        format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
    } else {
        format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis_of_second:03}Z")
    }
}

/// Howard Hinnant's `civil_from_days`: days since 1970-01-01 to a proleptic Gregorian date.
/// Kept here (rather than pulled from a date crate) because the recorder must format durable
/// timestamps with no dependency that could change calendar behaviour between releases.
#[must_use]
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 { shifted } else { shifted - 146_096 } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = if month <= 2 { year + 1 } else { year };
    (
        year,
        u32::try_from(month).unwrap_or(1),
        u32::try_from(day).unwrap_or(1),
    )
}

const fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// Elapsed milliseconds between two ticks of the same epoch.
#[must_use]
pub fn elapsed_ms_between(origin_ticks: u128, now_ticks: u128) -> u64 {
    if now_ticks <= origin_ticks {
        return 0;
    }
    u64::try_from((now_ticks - origin_ticks) / (TICK_FREQUENCY_HZ / 1_000)).unwrap_or(u64::MAX)
}

/// A timestamped record for JSON payloads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Timestamped {
    pub rfc3339: String,
    pub unix_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_matches_known_utc_instants_including_leap_days() {
        assert_eq!(rfc3339_from_unix_millis(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_from_unix_millis(1_791_280_800_000), "2026-10-06T10:00:00Z");
        assert_eq!(rfc3339_from_unix_millis(951_825_600_000), "2000-02-29T12:00:00Z");
        assert_eq!(rfc3339_from_unix_millis(1_709_251_199_000), "2024-02-29T23:59:59Z");
        assert_eq!(rfc3339_from_unix_millis(1_767_225_599_000), "2025-12-31T23:59:59Z");
        assert_eq!(rfc3339_from_unix_millis(1_767_225_600_000), "2026-01-01T00:00:00Z");
        assert_eq!(rfc3339_from_unix_millis(1_791_280_800_123), "2026-10-06T10:00:00.123Z");
    }

    #[test]
    fn system_clock_is_monotonic_and_reports_an_epoch_identity() {
        let clock = SystemClock::new();
        let first = clock.monotonic_ticks();
        for _ in 0..1_000 {
            assert!(clock.monotonic_ticks() >= first, "monotonic clock must not go backwards");
        }
        let epoch = clock.epoch_id();
        assert!(epoch.starts_with("boot-"), "{epoch}");
        assert_eq!(epoch, clock.epoch_id(), "epoch id is stable within a boot");
        assert!(clock.wall_clock_ms() > 1_700_000_000_000, "UTC wall clock is sane");
        let stamp = clock.wall_clock_rfc3339(clock.wall_clock_ms());
        assert_eq!(stamp.len(), 20, "{stamp}");
        assert!(stamp.ends_with('Z'));
    }

    #[test]
    fn mock_clock_can_move_monotonic_and_wall_time_independently() {
        let clock = MockClock::new(1_000_000_000_000, 1_791_280_800_000);
        assert_eq!(clock.monotonic_ticks(), 1_000_000_000_000);
        clock.advance_ns(5_000_000_000);
        assert_eq!(clock.monotonic_ticks(), 1_005_000_000_000);
        assert_eq!(clock.wall_clock_ms(), 1_791_280_805_000);
        clock.advance_wall_only_ms(60_000);
        assert_eq!(clock.monotonic_ticks(), 1_005_000_000_000, "sleep must not move the meeting clock");
        assert_eq!(clock.wall_clock_ms(), 1_791_280_865_000);
        assert_eq!(elapsed_ms_between(1_000_000_000_000, clock.monotonic_ticks()), 5_000);
        assert_eq!(elapsed_ms_between(clock.monotonic_ticks(), 1_000_000_000_000), 0);
    }

    #[test]
    fn elapsed_conversion_uses_the_declared_tick_frequency() {
        assert_eq!(elapsed_ms_between(0, TICK_FREQUENCY_HZ), 1_000);
        assert_eq!(elapsed_ms_between(0, TICK_FREQUENCY_HZ * 3_600), 3_600_000);
    }
}
