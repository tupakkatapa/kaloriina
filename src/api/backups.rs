//! Backup visibility: when the newest copy in `--backup-dir` was taken,
//! never where it lies, and how full the database's disk is.

use std::path::Path as FsPath;
use std::time::UNIX_EPOCH;

use super::prelude::*;

pub(super) fn routes() -> Router<AppState> {
    Router::new().route("/api/backups", get(backups))
}

/// A copy older than this means the backup job is failing.
const STALE_MS: i64 = 48 * 60 * 60 * 1000;

/// Whether the backups need looking at, `now` epoch ms: no copy yet, or
/// the newest older than 48 hours.
#[must_use]
pub fn stale_backup(newest: Option<i64>, now: i64) -> bool {
    newest.is_none_or(|at| now - at > STALE_MS)
}

#[derive(Serialize)]
struct Backups {
    /// Whether the server knows a backup dir (`--backup-dir`).
    configured: bool,
    /// Epoch ms of the newest copy; `null` without any.
    newest: Option<i64>,
    /// Backing up, and no copy or none in 48 hours; judged now.
    stale: bool,
    /// The database disk's space for us and in all; `null` when unknown.
    free_bytes: Option<u64>,
    total_bytes: Option<u64>,
}

async fn backups(State(s): State<AppState>) -> Res<Backups> {
    let (dir, data) = (s.backup_dir.clone(), s.data_dir.clone());
    tokio::task::spawn_blocking(move || {
        let newest = dir.as_deref().and_then(|d| {
            newest_backup(d)
                .inspect_err(|e| tracing::warn!(error = %e, "backup dir unreadable"))
                .ok()
                .flatten()
        });
        let space = data
            .as_deref()
            .and_then(|d| {
                rustix::fs::statvfs(d)
                    .inspect_err(|e| tracing::warn!(error = %e, "disk space unreadable"))
                    .ok()
            })
            .map(|v| (v.f_bavail * v.f_frsize, v.f_blocks * v.f_frsize));
        Json(Backups {
            configured: dir.is_some(),
            newest,
            stale: dir.is_some() && stale_backup(newest, model::now_ms()),
            free_bytes: space.map(|(free, _)| free),
            total_bytes: space.map(|(_, total)| total),
        })
    })
    .await
    .map_err(|e| Error::Internal(format!("backup check failed: {e}")))
}

/// When the newest `kaloriina-*.db` copy in `dir` was written, epoch ms
/// (the backup job's names; its `.tmp` files are not copies).
///
/// # Errors
/// `dir` can't be listed (a missing one has no copies).
pub fn newest_backup(dir: &FsPath) -> std::io::Result<Option<i64>> {
    let entries = match std::fs::read_dir(dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        other => other?,
    };
    let mut newest = None;
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with("kaloriina-") && name.ends_with(".db")) {
            continue;
        }
        let at = entry.metadata()?.modified()?;
        let ms = at
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
        newest = newest.max(Some(ms));
    }
    Ok(newest)
}
