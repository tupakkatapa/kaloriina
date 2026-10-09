//! Targets per profile: nutrients and goals (`METRICS`), one row per
//! metric; registry defaults stand in for a goal without a row.

use super::prelude::*;
use crate::model::target_key;

/// The profile's targets, bounds derived from each metric's direction;
/// then the registry defaults the profile has no row for.
pub fn target_list(conn: &Connection, profile: ProfileId) -> Result<Vec<Target>, Error> {
    let mut stmt = conn.prepare_cached("SELECT metric, value FROM target WHERE profile_id = ?")?;
    let rows = stmt
        .query_map([profile], |r| Ok((r.get::<_, String>(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut list: Vec<Target> = rows
        .into_iter()
        // Keys are validated on write; skip any the registry no longer has.
        .filter(|(key, _)| target_key(key).is_some())
        .map(|(key, value)| Target::single(&key, value))
        .collect();
    let defaults: Vec<Target> = Target::defaults()
        .filter(|d| !list.iter().any(|t| t.metric == d.metric))
        .collect();
    list.extend(defaults);
    Ok(list)
}

/// Replace the profile's targets with `list`.
pub(super) fn write_targets(
    tx: &Connection,
    profile: ProfileId,
    list: &[Target],
) -> rusqlite::Result<()> {
    tx.execute("DELETE FROM target WHERE profile_id = ?", [profile])?;
    for t in list {
        tx.execute(
            "INSERT INTO target (profile_id, metric, value) VALUES (?1, ?2, ?3)
             ON CONFLICT (profile_id, metric) DO UPDATE SET value = ?3",
            params![profile, t.metric, t.value],
        )?;
    }
    Ok(())
}

/// Replace the profile's targets (see [`write_targets`]). They're part of
/// the profile: an update names the profile `rev` it was made from, and
/// moves it on.
pub fn target_replace(
    conn: &mut Connection,
    profile: ProfileId,
    rev: Option<i64>,
    list: &[Target],
) -> Result<(), Error> {
    let tx = write(conn)?;
    bump_rev(&tx, "profile", "profile", profile.0, rev)?;
    write_targets(&tx, profile, list)?;
    tx.commit()?;
    Ok(())
}
