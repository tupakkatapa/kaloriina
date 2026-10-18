//! Photos (ADR 0022): their bytes in the row, read back one at a time.

use super::prelude::*;
use crate::model::{Photo, PhotoInput, PhotoMime, now_ms};

const PHOTO_COLS: &str = "id, uid, day, grp, taken_at, mime, length(bytes)";

fn photo_row(r: &Row) -> rusqlite::Result<Photo> {
    Ok(Photo {
        id: r.get(0)?,
        uid: r.get(1)?,
        day: r.get(2)?,
        group: r.get(3)?,
        taken_at: r.get(4)?,
        mime: r.get(5)?,
        size: r.get(6)?,
    })
}

fn photo_get(conn: &Connection, pid: ProfileId, id: i64) -> Result<Option<Photo>, Error> {
    Ok(conn
        .query_row(
            &format!("SELECT {PHOTO_COLS} FROM photo WHERE profile_id = ? AND id = ?"),
            params![pid, id],
            photo_row,
        )
        .optional()?)
}

/// Store a photo whose bytes were checked; a `uid` stored before returns that
/// photo. The profile's photos stay within `total_max` bytes (409
/// `photo_storage_full`).
pub fn photo_insert(
    conn: &mut Connection,
    pid: ProfileId,
    input: &PhotoInput,
    mime: PhotoMime,
    bytes: &[u8],
    total_max: usize,
) -> Result<Photo, Error> {
    let tx = write(conn)?;
    if let Some(uid) = &input.uid {
        let earlier: Option<i64> = tx
            .query_row(
                "SELECT id FROM photo WHERE profile_id = ? AND uid = ?",
                params![pid, uid],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = earlier {
            return Ok(written(photo_get(&tx, pid, id)?));
        }
    }
    let used: i64 = tx.query_row(
        "SELECT coalesce(sum(length(bytes)), 0) FROM photo WHERE profile_id = ?",
        [pid],
        |r| r.get(0),
    )?;
    if usize::try_from(used)
        .unwrap_or(usize::MAX)
        .saturating_add(bytes.len())
        > total_max
    {
        return Err(Error::conflict(
            Conflict::PhotoStorageFull,
            format!(
                "photos are kept up to {} MiB a profile: delete some first",
                total_max / (1024 * 1024)
            ),
        ));
    }
    let id: i64 = tx.query_row(
        "INSERT INTO photo (profile_id, uid, day, grp, taken_at, mime, bytes)
         VALUES (?1, coalesce(?2, lower(hex(randomblob(16)))), ?3, ?4, ?5, ?6, ?7)
         RETURNING id",
        params![
            pid,
            input.uid,
            input.day,
            input.group,
            now_ms(),
            mime,
            bytes
        ],
        |r| r.get(0),
    )?;
    let photo = written(photo_get(&tx, pid, id)?);
    tx.commit()?;
    Ok(photo)
}

/// `pid`'s photos on `day`, oldest first.
pub fn photo_list(conn: &Connection, pid: ProfileId, day: &str) -> Result<Vec<Photo>, Error> {
    Ok(conn
        .prepare_cached(&format!(
            "SELECT {PHOTO_COLS} FROM photo WHERE profile_id = ? AND day = ? ORDER BY id"
        ))?
        .query_map(params![pid, day], photo_row)?
        .collect::<rusqlite::Result<_>>()?)
}

/// A photo's type and bytes by its `uid`, if it is `pid`'s.
pub fn photo_bytes(
    conn: &Connection,
    pid: ProfileId,
    uid: &str,
) -> Result<Option<(PhotoMime, Vec<u8>)>, Error> {
    Ok(conn
        .query_row(
            "SELECT mime, bytes FROM photo WHERE profile_id = ? AND uid = ?",
            params![pid, uid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
}

pub fn photo_delete(conn: &Connection, pid: ProfileId, uid: &str) -> Result<(), Error> {
    match conn.execute(
        "DELETE FROM photo WHERE profile_id = ? AND uid = ?",
        params![pid, uid],
    )? {
        0 => Err(Error::not_found("photo", uid)),
        _ => Ok(()),
    }
}
