//! Local durable layout and the atomic write protocol (docs/recording.md §4).
//!
//! Layout under the OS application-support root (never a path supplied by the renderer):
//!
//! ```text
//! <root>/sessions/<sessionId>/manifest.json
//! <root>/sessions/<sessionId>/manifest.json.tmp-<revision>   (transient)
//! <root>/sessions/<sessionId>/microphone/000000.wav
//! <root>/sessions/<sessionId>/microphone/000000.wav.partial  (transient)
//! <root>/sessions/<sessionId>/system-audio/000000.wav
//! ```
//!
//! Durability rules implemented here:
//! * a finished chunk is written to `*.partial`, flushed, `fsync`ed, checksummed, then atomically
//!   renamed; the checksum is never computed on a still-mutating file;
//! * every manifest revision is written to a sibling temp file, flushed, `fsync`ed, renamed, and the
//!   directory is synced, so a reader never sees a truncated manifest;
//! * session directories are created with owner-only permissions (0700) and files with 0600;
//! * every path derived from manifest data is validated to stay inside the session directory.

use crate::errors::{RecorderError, RecorderErrorCode};
use crate::manifest::{ChunkRecord, RecorderManifest};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{IoSlice, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};

/// Bytes that must remain free on the volume after a session's projected files, so recording never
/// fills the disk and never leaves the OS without scratch space.
pub const DISK_RESERVE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Fallback safety margin applied to the projection of the planned session length.
pub const DISK_SAFETY_FACTOR_NUMERATOR: u64 = 3;
pub const DISK_SAFETY_FACTOR_DENOMINATOR: u64 = 2;

/// `sample_rate_hz * channels * bytes_per_sample`, the steady-state byte rate of one source.
#[must_use]
pub const fn bytes_per_second(sample_rate_hz: u32, channels: u16, bytes_per_sample: u64) -> u64 {
    u64::from(sample_rate_hz) * u64::from(channels) * bytes_per_sample
}

/// Projected bytes for `duration_seconds` of capture across the given sources, with the safety margin.
#[must_use]
pub fn projected_bytes(sources_bytes_per_second: u64, duration_seconds: u64) -> u64 {
    let raw = sources_bytes_per_second.saturating_mul(duration_seconds);
    raw.saturating_mul(DISK_SAFETY_FACTOR_NUMERATOR) / DISK_SAFETY_FACTOR_DENOMINATOR
}

/// Result of the pre-start capacity check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiskPreflightResult {
    pub available_bytes: u64,
    pub required_bytes: u64,
    pub projected_bytes_per_hour: u64,
    pub sufficient: bool,
}

impl DiskPreflightResult {
    fn error(&self) -> RecorderError {
        RecorderError::new(
            RecorderErrorCode::DiskSpaceInsufficient,
            format!(
                "need at least {} free bytes for this session ({} available); free space or shorten the planned duration",
                self.required_bytes, self.available_bytes
            ),
            true,
        )
    }
}

/// Reject any relative path that could escape the session directory. Manifest file references are
/// only ever `"<source-dir>/<digits>.wav"`, so the check is exact rather than heuristic.
pub fn validate_relative_path(path: &str) -> Result<PathBuf, RecorderError> {
    let candidate = Path::new(path);
    let mut parts = Vec::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => {
                let text = part.to_str().ok_or_else(|| unsafe_relative())?;
                if text.contains('\0') {
                    return Err(unsafe_relative());
                }
                parts.push(text.to_string());
            }
            _ => return Err(unsafe_relative()),
        }
    }
    if parts.len() != 2 || parts[0] != "microphone" && parts[0] != "system-audio" || !is_chunk_file_name(&parts[1]) {
        return Err(unsafe_relative());
    }
    Ok(parts.iter().collect())
}

fn is_chunk_file_name(name: &str) -> bool {
    let Some((stem, extension)) = name.split_once('.') else {
        return false;
    };
    extension == "wav"
        && !stem.is_empty()
        && stem.len() <= 12
        && stem.bytes().all(|byte| byte.is_ascii_digit())
}

fn unsafe_relative() -> RecorderError {
    RecorderError::new(
        RecorderErrorCode::ManifestConflict,
        "chunk localFile must be a session-relative microphone/system-audio WAV path",
        false,
    )
}

/// Where the recorder keeps its sessions. The root is derived by the host application from the OS
/// application-support directory, so a web page can never choose it.
#[derive(Debug, Clone)]
pub struct RecorderRoot {
    root: PathBuf,
}

impl RecorderRoot {
    /// # Errors
    /// Returns [`RecorderError`] if the directory cannot be created.
    pub fn new(root: impl Into<PathBuf>) -> Result<Self, RecorderError> {
        let root = root.into();
        std::fs::create_dir_all(&root)?;
        set_private_dir(&root)?;
        Ok(Self { root })
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    #[must_use]
    pub fn sessions_dir(&self) -> PathBuf {
        self.root.join("sessions")
    }

    /// Session directory path for a session id. The name is the UUID itself (validated), so no
    /// renderer-supplied text reaches the filesystem.
    ///
    /// # Errors
    /// Returns [`RecorderError`] if the id is not a canonical UUID.
    pub fn session_dir(&self, session_id: &str) -> Result<PathBuf, RecorderError> {
        let uuid = uuid::Uuid::parse_str(session_id)
            .map_err(|_| RecorderError::new(RecorderErrorCode::ManifestConflict, "session id must be a UUID", false))?;
        if uuid.to_string() != session_id {
            return Err(RecorderError::new(
                RecorderErrorCode::ManifestConflict,
                "session id must be a canonical lowercase UUID",
                false,
            ));
        }
        Ok(self.sessions_dir().join(uuid.to_string()))
    }

    /// Create the session layout with owner-only permissions.
    ///
    /// # Errors
    /// Returns [`RecorderError`] if any directory cannot be created.
    pub fn prepare_session_dir(&self, session_dir: &Path) -> Result<(), RecorderError> {
        if !session_dir.starts_with(&self.root) {
            return Err(RecorderError::new(
                RecorderErrorCode::ManifestConflict,
                "session directory is outside the recorder root",
                false,
            ));
        }
        std::fs::create_dir_all(session_dir)?;
        set_private_dir(session_dir)?;
        for name in ["microphone", "system-audio"] {
            let dir = session_dir.join(name);
            std::fs::create_dir_all(&dir)?;
            set_private_dir(&dir)?;
        }
        Ok(())
    }

    /// List candidate session directories for recovery, newest first. Only UUID-shaped directories are
    /// returned; anything else is reported separately so a stray folder is never deleted implicitly.
    ///
    /// # Errors
    /// Returns [`RecorderError`] if the sessions directory cannot be read.
    pub fn candidate_session_dirs(&self) -> Result<(Vec<PathBuf>, Vec<String>), RecorderError> {
        let mut valid = Vec::new();
        let mut rejected = Vec::new();
        let sessions = self.sessions_dir();
        if !sessions.exists() {
            return Ok((valid, rejected));
        }
        for entry in std::fs::read_dir(&sessions)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
            let looks_like_uuid = uuid::Uuid::parse_str(&name).is_ok();
            if is_dir && looks_like_uuid {
                valid.push(entry.path());
            } else {
                rejected.push(name);
            }
        }
        valid.sort_by(|left, right| right.cmp(left));
        Ok((valid, rejected))
    }
}

/// Set owner-only permissions on a directory (best effort; POSIX only).
pub fn set_private_dir(path: &Path) -> Result<(), RecorderError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

/// Set owner-only permissions on a file (best effort; POSIX only).
pub fn set_private_file(path: &Path) -> Result<(), RecorderError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

/// Flush and `fsync` a file handle. Windows `FlushFileBuffers` is handled by the same std call.
pub fn sync_file(file: &File) -> Result<(), RecorderError> {
    file.flush()?;
    file.sync_all()?;
    Ok(())
}

/// Sync a directory so a rename is durable. On platforms where directory `fsync` is unsupported the
/// error is ignored deliberately: the rename itself already happened.
pub fn sync_dir(path: &Path) {
    if let Ok(file) = File::open(path) {
        let _ = file.sync_all();
    }
}

/// Free bytes available to the current user on the volume holding `path`.
///
/// # Errors
/// Returns [`RecorderError`] if the capacity cannot be queried.
#[cfg(target_os = "macos")]
pub fn available_bytes(path: &Path) -> Result<u64, RecorderError> {
    let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: `stat` is a valid out pointer for `statfs`, and `path` is a NUL-terminated C string we
    // own for the duration of the call.
    let result = unsafe { libc::statfs(c_path(path)?.as_ptr(), stat.as_mut_ptr()) };
    if result != 0 {
        return Err(RecorderError::new(
            RecorderErrorCode::InternalError,
            "could not read volume capacity",
            true,
        ));
    }
    // SAFETY: `statfs` returned success, so the structure is initialised.
    let stat = unsafe { stat.assume_init() };
    let block_size = u64::try_from(stat.f_bsize).map_err(|_| capacity_error())?;
    Ok(stat.f_bavail.saturating_mul(i64::try_from(block_size).map_err(|_| capacity_error())?) as u64)
}

/// Non-macOS development fallback (Linux test hosts); `statvfs` has the same fields.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn available_bytes(path: &Path) -> Result<u64, RecorderError> {
    use std::os::unix::ffi::OsStrExt;
    let mut bytes: Vec<u8> = path.as_os_str().as_bytes().to_vec();
    bytes.push(0);
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `bytes` is a valid NUL-terminated path and `stat` is a writable out pointer.
    let result = unsafe { libc::statvfs(bytes.as_ptr().cast(), stat.as_mut_ptr()) };
    if result != 0 {
        return Err(capacity_error());
    }
    // SAFETY: `statvfs` returned success.
    let stat = unsafe { stat.assume_init() };
    let block_size = u64::try_from(stat.f_frsize).map_err(|_| capacity_error())?;
    Ok(stat.f_bavail.saturating_mul(i64::try_from(block_size).map_err(|_| capacity_error())?) as u64)
}

#[cfg(windows)]
pub fn available_bytes(_path: &Path) -> Result<u64, RecorderError> {
    Err(RecorderError::new(
        RecorderErrorCode::PlatformUnsupported,
        "Windows capacity checks are not implemented in this phase",
        false,
    ))
}

fn capacity_error() -> RecorderError {
    RecorderError::new(RecorderErrorCode::InternalError, "could not read volume capacity", true)
}

#[cfg(target_os = "macos")]
fn c_path(path: &Path) -> Result<std::ffi::CString, RecorderError> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(path.as_os_str().as_bytes().to_vec()).map_err(|_| {
        RecorderError::new(
            RecorderErrorCode::ManifestConflict,
            "path contains an embedded NUL byte",
            false,
        )
    })
}

/// Capacity gate applied before capture starts and again while a session is open.
///
/// # Errors
/// Returns [`RecorderError`] when the volume cannot hold the projected session.
pub fn preflight_disk(
    root: &RecorderRoot,
    sources_bytes_per_second: u64,
    planned_seconds: u64,
) -> Result<DiskPreflightResult, RecorderError> {
    let available = available_bytes(root.root())?;
    let projected = projected_bytes(sources_bytes_per_second, planned_seconds);
    let required = projected.saturating_add(DISK_RESERVE_BYTES);
    Ok(DiskPreflightResult {
        available_bytes: available,
        required_bytes: required,
        projected_bytes_per_hour: sources_bytes_per_second.saturating_mul(3600),
        sufficient: available >= required,
    })
}

/// Atomically write a manifest revision: temp file → flush → `fsync` → rename → directory sync.
///
/// # Errors
/// Returns [`RecorderError`] on any I/O failure; the caller must then surface a persistence fault
/// rather than continuing to show a healthy recording.
pub fn write_manifest_atomic(session_dir: &Path, manifest: &RecorderManifest) -> Result<(), RecorderError> {
    let text = manifest.to_json_string()?;
    let target = session_dir.join("manifest.json");
    let temp = session_dir.join(format!("manifest.json.tmp-{}", manifest.revision));
    write_bytes_and_sync(&temp, text.as_bytes())?;
    std::fs::rename(&temp, &target)?;
    sync_dir(session_dir);
    // Drop the temp file of the previous revision if a crash left one behind.
    if let Ok(entries) = std::fs::read_dir(session_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("manifest.json.tmp-") && entry.path() != temp {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

fn write_bytes_and_sync(path: &Path, bytes: &[u8]) -> Result<(), RecorderError> {
    let mut file = OpenOptions::new().create(true).truncate(true).write(true).open(path)?;
    set_private_file(path)?;
    file.write_all(bytes)?;
    sync_file(&file)?;
    Ok(())
}

/// A chunk file being appended to. Only the writer thread touches it, so no lock is needed here,
/// and no hashing or JSON work happens in a capture callback.
#[derive(Debug)]
pub struct PartialChunkFile {
    file: File,
    path: PathBuf,
    header_len: u64,
    data_bytes: u64,
}

impl PartialChunkFile {
    /// Create the `.partial` file and write a placeholder header (patched at finalize).
    ///
    /// # Errors
    /// Returns [`RecorderError`] if the file cannot be created.
    pub fn create(session_dir: &Path, relative: &Path, header: &[u8]) -> Result<Self, RecorderError> {
        let path = join_within(session_dir, relative)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
            set_private_dir(parent)?;
        }
        let mut file = OpenOptions::new().create(true).truncate(true).read(true).write(true).open(&path)?;
        set_private_file(&path)?;
        file.write_all(header)?;
        Ok(Self {
            file,
            path,
            header_len: u64::try_from(header.len()).unwrap_or(0),
            data_bytes: 0,
        })
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Total bytes written so far, header included.
    #[must_use]
    pub fn bytes_written(&self) -> u64 {
        self.header_len + self.data_bytes
    }

    #[must_use]
    pub fn data_bytes(&self) -> u64 {
        self.data_bytes
    }

    /// Append one block of audio. A short write is a persistence fault, never a silent gap.
    ///
    /// # Errors
    /// Returns [`RecorderError`] (a mapped `ENOSPC` becomes `disk_full`) on failure.
    pub fn append(&mut self, payload: &[&[u8]]) -> Result<(), RecorderError> {
        self.file.seek(SeekFrom::End(0))?;
        let mut pending: Vec<&[u8]> = payload.iter().copied().filter(|slice| !slice.is_empty()).collect();
        let expected: usize = pending.iter().map(|slice| slice.len()).sum();
        let mut written = 0usize;
        while written < expected {
            let slices: Vec<IoSlice<'_>> = pending.iter().map(|slice| IoSlice::new(slice)).collect();
            let step = self.file.write_vectored(&slices)?;
            if step == 0 {
                return Err(writer_failed("chunk write made no progress"));
            }
            written += step;
            let mut skip = step;
            let mut rest: Vec<&[u8]> = Vec::with_capacity(pending.len());
            for slice in pending.drain(..) {
                if skip >= slice.len() {
                    skip -= slice.len();
                    continue;
                }
                rest.push(&slice[skip..]);
                skip = 0;
            }
            pending = rest;
        }
        self.data_bytes += u64::try_from(expected).unwrap_or(u64::MAX);
        Ok(())
    }

    /// Flush and `fsync` so the audio is durable before the rename.
    ///
    /// # Errors
    /// Returns [`RecorderError`] on sync failure.
    pub fn sync(&mut self) -> Result<(), RecorderError> {
        sync_file(&self.file)
    }

    /// Rewrite the header in place (container sizes), sync, and freeze the file for checksumming.
    ///
    /// # Errors
    /// Returns [`RecorderError`] on I/O failure.
    pub fn finalize_with_header(mut self, header: &[u8]) -> Result<FinalizedChunk, RecorderError> {
        if u64::try_from(header.len()).map_err(|_| writer_failed("header length overflow"))? != self.header_len {
            return Err(writer_failed("header patch must keep the container header size"));
        }
        self.file.seek(SeekFrom::Start(0))?;
        self.file.write_all(header)?;
        self.file.seek(SeekFrom::End(0))?;
        sync_file(&self.file)?;
        drop(self.file);
        let on_disk = std::fs::metadata(&self.path).map(|metadata| metadata.len()).unwrap_or(0);
        let expected = self.header_len + self.data_bytes;
        if on_disk != expected {
            return Err(RecorderError::new(
                RecorderErrorCode::WriterFailed,
                format!("chunk file is {on_disk} bytes but {expected} were written"),
                false,
            ));
        }
        Ok(FinalizedChunk {
            path: self.path,
            byte_size: on_disk,
        })
    }
}

fn writer_failed(message: impl Into<String>) -> RecorderError {
    RecorderError::new(RecorderErrorCode::WriterFailed, message, false)
}

/// A closed, durable, not-yet-renamed chunk file.
#[derive(Debug)]
pub struct FinalizedChunk {
    pub path: PathBuf,
    pub byte_size: u64,
}

impl FinalizedChunk {
    /// SHA-256 over the exact final object bytes, computed after the file stopped changing.
    ///
    /// # Errors
    /// Returns [`RecorderError`] if the file cannot be read.
    pub fn sha256(&self) -> Result<String, RecorderError> {
        let mut file = File::open(&self.path)?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 1024 * 1024];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok(format!("{:x}", hasher.finalize()))
    }

    #[must_use]
    pub const fn byte_size(&self) -> u64 {
        self.byte_size
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Atomic rename into the deterministic final path, then parent-directory sync.
    ///
    /// # Errors
    /// Returns [`RecorderError`] if the rename fails or the destination already exists.
    pub fn rename_to(self, session_dir: &Path, relative: &Path) -> Result<PathBuf, RecorderError> {
        let target = join_within(session_dir, relative)?;
        if target.exists() {
            return Err(RecorderError::new(
                RecorderErrorCode::ManifestConflict,
                "final chunk path already exists; identity reuse is a conflict, never an overwrite",
                false,
            ));
        }
        std::fs::rename(&self.path, &target)?;
        if let Some(parent) = target.parent() {
            sync_dir(parent);
        }
        Ok(target)
    }
}

/// SHA-256 hex digest of a byte slice. Exposed so recovery and the acceptance harness can verify a
/// finalized chunk with the same helper the writer used.
#[must_use]
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Join a validated relative path onto a session directory, refusing anything that escapes it.
pub fn join_within(session_dir: &Path, relative: &Path) -> Result<PathBuf, RecorderError> {
    for component in relative.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(unsafe_relative());
        }
    }
    let joined = session_dir.join(relative);
    let normalized = normalize(session_dir, &joined);
    if !normalized.starts_with(session_dir) || normalized == session_dir {
        return Err(unsafe_relative());
    }
    Ok(normalized)
}

/// Lexical normalization (no symlink resolution): rejects `.`/`..` components that would climb out.
fn normalize(root: &Path, path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    let _ = root;
    out
}

/// Fill in the byte-size/checksum fields of a finalized chunk and validate the result.
///
/// # Errors
/// Returns [`RecorderError`] if the recorded size does not match the file on disk.
pub fn bind_finalized_chunk(
    chunk: &ChunkRecord,
    recorded_size: u64,
    checksum_hex: String,
) -> Result<ChunkRecord, RecorderError> {
    if recorded_size < crate::manifest::MIN_CHUNK_BYTES {
        return Err(RecorderError::new(
            RecorderErrorCode::WriterFailed,
            "finalized chunk is too small to be a valid container",
            false,
        ));
    }
    let mut updated = chunk.clone();
    updated.byte_size = recorded_size;
    updated.checksum = Some(crate::manifest::Checksum {
        algorithm: crate::manifest::ChecksumAlgorithm::Sha256,
        value: checksum_hex,
    });
    if !is_hex(&updated.checksum.as_ref().map(|value| value.value.clone()).unwrap_or_default()) {
        return Err(RecorderError::new(
            RecorderErrorCode::WriterFailed,
            "checksum digest was malformed",
            false,
        ));
    }
    Ok(updated)
}

fn is_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::fixtures::valid_manifest;

    #[test]
    fn path_validation_blocks_traversal() {
        assert!(validate_relative_path("microphone/000000.wav").is_ok());
        assert!(validate_relative_path("system-audio/000042.wav").is_ok());
        for bad in [
            "../x.wav",
            "microphone/../../secret.wav",
            "/absolute/x.wav",
            "C:\\windows\\x.wav",
            "microphone/",
            "other/000000.wav",
            "microphone/x.wav",
            "microphone/000000.wav\n",
            "microphone/000000.wav2",
            "",
        ] {
            assert!(validate_relative_path(bad).is_err(), "must reject {bad:?}");
        }
    }

    #[test]
    fn join_within_cannot_escape_the_session_dir() {
        let dir = std::env::temp_dir().join(format!("suhbat-join-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        assert!(join_within(&dir, Path::new("microphone/000000.wav")).is_ok());
        assert!(join_within(&dir, Path::new("../escape")).is_err());
        assert!(join_within(&dir, Path::new("/etc/passwd")).is_err());
        assert!(join_within(&dir, Path::new("microphone/../../escape")).is_err());
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn session_ids_must_be_canonical_uuids() {
        let root = std::env::temp_dir().join(format!("suhbat-root-{}", uuid::Uuid::new_v4()));
        let root = RecorderRoot::new(&root).expect("root");
        assert!(root.session_dir("nope").is_err());
        assert!(root.session_dir("..").is_err());
        let id = uuid::Uuid::new_v4().to_string();
        let path = root.session_dir(&id).expect("valid");
        assert!(path.ends_with(id.as_str()));
        std::fs::remove_dir_all(root.root()).ok();
    }

    #[test]
    fn manifest_writes_are_atomic_and_readable() {
        let dir = std::env::temp_dir().join(format!("suhbat-manifest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let manifest = valid_manifest();
        write_manifest_atomic(&dir, &manifest).expect("write");
        let text = std::fs::read_to_string(dir.join("manifest.json")).expect("read");
        let parsed = RecorderManifest::parse_and_validate(&text).expect("validated round trip");
        assert_eq!(parsed.revision, manifest.revision);
        assert_eq!(parsed.chunks.len(), manifest.chunks.len());
        assert!(!dir.join("manifest.json.tmp-1").exists(), "temp file is renamed away");
        // A second revision replaces the file and leaves no temp litter.
        let mut next = manifest.clone();
        next.revision = 2;
        write_manifest_atomic(&dir, &next).expect("rewrite");
        let entries: Vec<String> = std::fs::read_dir(&dir)
            .expect("entries")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(entries, vec!["manifest.json".to_string()]);
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn partial_chunk_finalize_computes_checksum_after_freeze() {
        let dir = std::env::temp_dir().join(format!("suhbat-partial-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("microphone")).expect("dir");
        let header = vec![0x52u8, 0x49, 0x46, 0x46];
        let mut partial =
            PartialChunkFile::create(&dir, Path::new("microphone/000000.wav.partial"), &header).expect("create");
        partial.append(&[&[0u8; 4], &[1u8; 4]]).expect("write");
        partial.append(&[&[2u8; 4]]).expect("write append");
        assert_eq!(partial.data_bytes(), 12);
        assert_eq!(partial.bytes_written(), 16);
        partial.sync().expect("sync");
        let bytes = std::fs::read(dir.join("microphone/000000.wav.partial")).expect("bytes");
        assert_eq!(bytes.len(), 16, "header plus 12 payload bytes");
        let finalized = partial.finalize_with_header(&[0x52, 0x49, 0x46, 0x46]).expect("finalize");
        assert_eq!(finalized.byte_size(), 16);
        let digest = finalized.sha256().expect("checksum after freeze");
        assert_eq!(digest.len(), 64);
        assert_eq!(
            finalized
                .rename_to(&dir, Path::new("microphone/000000.wav"))
                .expect("rename")
                .file_name()
                .and_then(|name| name.to_str()),
            Some("000000.wav")
        );
        assert!(!dir.join("microphone/000000.wav.partial").exists(), "partial file is renamed away");
        // Reusing the same final identity is a conflict, never an overwrite.
        let clash = FinalizedChunk {
            path: dir.join("microphone/000000.wav"),
            byte_size: 12,
        };
        let error = clash
            .rename_to(&dir, Path::new("microphone/000000.wav"))
            .expect_err("identity reuse must be refused");
        assert_eq!(error.code, RecorderErrorCode::ManifestConflict);
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn disk_projection_uses_the_real_byte_rate() {
        // 48 kHz stereo s16 = 192000 B/s; mono = 96000 B/s.
        let rate = bytes_per_second(48_000, 2, 2) + bytes_per_second(48_000, 1, 2);
        assert_eq!(rate, 288_000);
        let one_hour = projected_bytes(rate, 3600);
        assert_eq!(one_hour, 288_000 * 3600 * 3 / 2);
        let preflight = DiskPreflightResult {
            available_bytes: one_hour + DISK_RESERVE_BYTES,
            required_bytes: one_hour + DISK_RESERVE_BYTES,
            projected_bytes_per_hour: rate * 3600,
            sufficient: true,
        };
        assert!(preflight.sufficient);
        let tight = DiskPreflightResult {
            available_bytes: preflight.required_bytes - 1,
            required_bytes: preflight.required_bytes,
            projected_bytes_per_hour: preflight.projected_bytes_per_hour,
            sufficient: false,
        };
        assert!(!tight.sufficient);
        let message = tight.error().message;
        assert!(message.contains("free bytes"), "{message}");
        assert!(message.contains(&tight.available_bytes.to_string()));
    }

    #[test]
    fn capacity_query_runs_on_this_host() {
        let bytes = available_bytes(&std::env::temp_dir()).expect("capacity readable");
        assert!(bytes > 1024 * 1024, "expected a real free-byte count, got {bytes}");
        let root = RecorderRoot::new(std::env::temp_dir().join(format!("suhbat-cap-{}", uuid::Uuid::new_v4())))
            .expect("root");
        let preflight = preflight_disk(&root, 288_000, 60).expect("preflight");
        assert!(preflight.sufficient, "a 60 s projection must fit: {preflight:?}");
        let absurd = preflight_disk(&root, 288_000, 1_000_000_000).expect("preflight");
        assert!(!absurd.sufficient, "an absurd projection must be refused");
        std::fs::remove_dir_all(root.root()).ok();
    }

    #[test]
    fn bind_finalized_chunk_records_size_and_digest() {
        let manifest = valid_manifest();
        let chunk = &manifest.chunks[0];
        let bound = bind_finalized_chunk(chunk, 4_000_000, "a".repeat(64)).expect("bound");
        assert_eq!(bound.byte_size, 4_000_000);
        assert_eq!(bound.checksum.as_ref().map(|value| value.value.len()), Some(64));
        assert!(bind_finalized_chunk(chunk, 10, "a".repeat(64)).is_err(), "too small");
        assert!(bind_finalized_chunk(chunk, 4_000_000, "nothex").is_err(), "bad digest");
    }

    #[test]
    fn private_permissions_are_applied_on_unix() {
        let dir = std::env::temp_dir().join(format!("suhbat-perm-{}", uuid::Uuid::new_v4()));
        let root = RecorderRoot::new(&dir).expect("root");
        let session = root.session_dir(&uuid::Uuid::new_v4().to_string()).expect("session path");
        root.prepare_session_dir(&session).expect("prepare");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for path in [&session, &session.join("microphone"), &session.join("system-audio")] {
                let mode = std::fs::metadata(path).expect("metadata").permissions().mode();
                assert_eq!(mode & 0o777, 0o700, "{path:?} must be owner-only");
            }
            let file = session.join("microphone/000000.wav");
            std::fs::write(&file, b"hi").expect("write");
            set_private_file(&file).expect("chmod");
            let mode = std::fs::metadata(&file).expect("metadata").permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn candidate_listing_separates_stray_directories() {
        let dir = std::env::temp_dir().join(format!("suhbat-scan-{}", uuid::Uuid::new_v4()));
        let root = RecorderRoot::new(&dir).expect("root");
        let session = root.session_dir(&uuid::Uuid::new_v4().to_string()).expect("path");
        root.prepare_session_dir(&session).expect("prepare");
        std::fs::create_dir(root.sessions_dir().join("not-a-uuid")).expect("stray");
        std::fs::write(root.sessions_dir().join("loose-file"), b"x").expect("file");
        let (valid, rejected) = root.candidate_session_dirs().expect("scan");
        assert_eq!(valid.len(), 1);
        assert_eq!(rejected.len(), 2, "stray entries are reported, never deleted");
        std::fs::remove_dir_all(&dir).ok();
    }
}
