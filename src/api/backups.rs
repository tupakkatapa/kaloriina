//! Backup visibility: when the newest copy in `--backup-dir` was taken,
//! never where it lies, and how full the database's disk is.

use super::prelude::*;
use crate::backups::{newest_backup, stale_backup};

pub(super) fn routes() -> Router<AppState> {
    Router::new().route("/api/backups", get(backups))
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
