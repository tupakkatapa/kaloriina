//! The backup job's copies in `--backup-dir`: when the newest was taken,
//! and whether that is too long ago.

use std::path::Path;
use std::time::UNIX_EPOCH;

/// A copy older than this means the backup job is failing.
const STALE_MS: i64 = 48 * 60 * 60 * 1000;

/// Whether the backups need looking at, `now` epoch ms: no copy yet, or
/// the newest older than 48 hours.
#[must_use]
pub fn stale_backup(newest: Option<i64>, now: i64) -> bool {
    newest.is_none_or(|at| now - at > STALE_MS)
}

/// When the newest `kaloriina-*.db.zst` (or earlier `.db`) copy in `dir`
/// was written, epoch ms (the backup job's names; its `.tmp` files are not
/// copies).
///
/// # Errors
/// `dir` can't be listed (a missing one has no copies).
pub fn newest_backup(dir: &Path) -> std::io::Result<Option<i64>> {
    let entries = match std::fs::read_dir(dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        other => other?,
    };
    let mut newest = None;
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with("kaloriina-") && (name.ends_with(".db") || name.ends_with(".db.zst")))
        {
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
