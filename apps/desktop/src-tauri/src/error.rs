//! IPC error mapping.
//!
//! Every command returns `Result<T, Failure>` where `Failure` is a transparent wrapper around
//! `recorder_core::RecorderError`. That means the renderer receives exactly the shape
//! `recorderErrorSchema` in `packages/contracts/src/recorder.ts` describes — including `retryable`,
//! `sourceKind` and `openSettingsUrl`, which are what let the UI offer a fix instead of a shrug.

use recorder_core::errors::{RecorderError, RecorderErrorCode};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(transparent)]
pub struct Failure(RecorderError);

impl Failure {
    #[must_use]
    pub fn new(code: RecorderErrorCode, message: impl Into<String>, retryable: bool) -> Self {
        Self(RecorderError::new(code, message, retryable))
    }

    #[must_use]
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(RecorderErrorCode::InternalError, message, false)
    }
}

impl From<RecorderError> for Failure {
    fn from(value: RecorderError) -> Self {
        Self(value)
    }
}

impl From<std::io::Error> for Failure {
    fn from(value: std::io::Error) -> Self {
        Self(RecorderError::from(value))
    }
}

impl From<String> for Failure {
    fn from(value: String) -> Self {
        Self::internal(value)
    }
}

impl From<&str> for Failure {
    fn from(value: &str) -> Self {
        Self::internal(value.to_string())
    }
}

/// Turns a poisoned mutex into a usable guard instead of failing every later command.
///
/// Locks here only ever protect in-memory coordinator state; durability comes from atomic manifest
/// writes, so a panic in one command cannot leave a half-written session for the next one to inherit.
#[must_use]
pub fn lock<'a, T>(mutex: &'a std::sync::Mutex<T>) -> std::sync::MutexGuard<'a, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}
