//! Backup visibility: when the newest copy in `--backup-dir` was taken,
//! never where it lies.

use std::path::Path as FsPath;
use std::time::UNIX_EPOCH;

use super::prelude::*;

pub(super) fn routes() -> Router<AppState> {
    Router::new().route("/api/backups", get(backups))
}

#[derive(Serialize)]
struct Backups {
    /// Epoch ms of the newest copy; `null` without any (or without
    /// `--backup-dir`).
    newest: Option<i64>,
}

async fn backups(State(s): State<AppState>) -> Res<Backups> {
    let dir = s.backup_dir.clone();
    let newest = tokio::task::spawn_blocking(move || {
        dir.as_deref().and_then(|d| {
            newest_backup(d)
                .inspect_err(|e| tracing::warn!(error = %e, "backup dir unreadable"))
                .ok()
                .flatten()
        })
    })
    .await
    .map_err(|e| Error::Internal(format!("backup check failed: {e}")))?;
    Ok(Json(Backups { newest }))
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
