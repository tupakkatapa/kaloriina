//! Outbound hooks (ADR 0024): one Home Assistant hook per profile, the webhook
//! id read only to call it.

use super::prelude::*;
use crate::model::{CheckedHook, Hook, HookEvent, HookResult};

/// Where a hook calls, and on what: what forwarding an event needs.
pub struct HookTarget {
    pub url: String,
    pub webhook_id: String,
    pub events: Vec<HookEvent>,
    pub profile: String,
}

/// Stored events, without any there no longer is (`workout_saved`): they
/// go for good on the hook's next save.
fn stored_events(s: &str) -> rusqlite::Result<Vec<HookEvent>> {
    Ok(from_json::<Vec<String>>(s)?
        .iter()
        .filter_map(|e| HookEvent::parse(e))
        .collect())
}

fn hook_row(r: &Row) -> rusqlite::Result<Hook> {
    Ok(Hook {
        url: r.get(0)?,
        events: stored_events(&r.get::<_, String>(1)?)?,
        // A last call of an event there no longer is reads as none.
        last_result: r
            .get::<_, Option<String>>(2)?
            .and_then(|s| serde_json::from_str(&s).ok()),
    })
}

/// `pid`'s Home Assistant hook, without its id.
pub fn hook_get(conn: &Connection, pid: ProfileId) -> Result<Option<Hook>, Error> {
    Ok(conn
        .query_row(
            "SELECT url, events, last_result FROM hook WHERE profile_id = ?",
            [pid],
            hook_row,
        )
        .optional()?)
}

/// Save `pid`'s hook. Without a webhook id the saved one stays, only for
/// the same URL: 400 `webhook_id` on a first save or a new address.
pub fn hook_set(conn: &mut Connection, pid: ProfileId, h: &CheckedHook) -> Result<Hook, Error> {
    let tx = write(conn)?;
    let saved: Option<(String, String)> = tx
        .query_row(
            "SELECT url, webhook_id FROM hook WHERE profile_id = ?",
            [pid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let webhook_id = match (&h.webhook_id, saved) {
        (Some(id), _) => id.clone(),
        (None, Some((url, id))) if url == h.url => id,
        (None, _) => {
            return Err(Error::invalid_field(
                "webhook_id",
                "webhook_id is needed for a new Home Assistant address",
            ));
        }
    };
    tx.execute(
        "INSERT INTO hook (profile_id, url, webhook_id, events) VALUES (?, ?, ?, ?)
         ON CONFLICT (profile_id) DO UPDATE SET
             url = excluded.url, webhook_id = excluded.webhook_id, events = excluded.events",
        params![pid, h.url, webhook_id, json(&h.events)],
    )?;
    let hook = written(hook_get(&tx, pid)?);
    tx.commit()?;
    Ok(hook)
}

pub fn hook_delete(conn: &Connection, pid: ProfileId) -> Result<(), Error> {
    conn.execute("DELETE FROM hook WHERE profile_id = ?", [pid])?;
    Ok(())
}

/// What calling `pid`'s hook needs, with the profile's name for the body.
pub fn hook_target(conn: &Connection, pid: ProfileId) -> Result<Option<HookTarget>, Error> {
    Ok(conn
        .query_row(
            "SELECT h.url, h.webhook_id, h.events, p.name FROM hook h
             JOIN profile p ON p.id = h.profile_id
             WHERE h.profile_id = ?",
            [pid],
            |r| {
                Ok(HookTarget {
                    url: r.get(0)?,
                    webhook_id: r.get(1)?,
                    events: stored_events(&r.get::<_, String>(2)?)?,
                    profile: r.get(3)?,
                })
            },
        )
        .optional()?)
}

/// Keep how the last call went (on a hook that may have gone meanwhile).
pub fn hook_result_set(
    conn: &Connection,
    pid: ProfileId,
    result: &HookResult,
) -> Result<(), Error> {
    conn.execute(
        "UPDATE hook SET last_result = ? WHERE profile_id = ?",
        params![json(result), pid],
    )?;
    Ok(())
}
