//! Reports over the diary: where a nutrient came from, and All time.

use super::GROUP_ROWS;
use super::prelude::*;
use crate::model::{Contributor, NutrientSources, PLANNED, RichFood, Stats, TypeTotal};

/// Contributors listed by [`nutrient_sources`].
pub const SOURCES_MAX: usize = 20;

/// Which eaten foods (every group but Planned) supplied `nutrient` (a
/// registry key) in `[from, to]`. Entries of one food add up under the
/// food's current name.
pub fn nutrient_sources(
    conn: &Connection,
    profile: ProfileId,
    from: &str,
    to: &str,
    nutrient: &str,
) -> Result<NutrientSources, Error> {
    // The one nutrient summed in SQL: parsing every stored total for it
    // took as long as the whole range's Summary, holding the connection.
    let total: f64 = conn
        .prepare_cached(&format!(
            "SELECT coalesce(sum(json_extract(nutrients, '$.' || ?4)), 0)
             FROM ({GROUP_ROWS}) WHERE grp != ?5"
        ))?
        .query_row(params![from, to, profile, nutrient, PLANNED], |r| r.get(0))?;
    let mut stmt = conn.prepare_cached(
        "SELECT e.food_id, f.name,
             sum(json_extract(e.nutrients, '$.' || ?5)) AS part
         FROM entry e JOIN food f ON f.id = e.food_id
         WHERE e.profile_id = ?1 AND e.day BETWEEN ?2 AND ?3 AND e.grp != ?4
             AND e.nutrients IS NOT NULL
         GROUP BY e.food_id
         HAVING part > 0
         ORDER BY part DESC, fold(f.name)",
    )?;
    let all = stmt
        .query_map(params![profile, from, to, PLANNED, nutrient], |r| {
            Ok(Contributor {
                food_id: r.get(0)?,
                name: r.get(1)?,
                amount: r.get(2)?,
                share: 0.0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let attributed: f64 = all.iter().map(|c| c.amount).sum();
    let foods = all
        .into_iter()
        .take(SOURCES_MAX)
        .map(|c| Contributor {
            share: if total > 0.0 {
                (c.amount / total).min(1.0)
            } else {
                0.0
            },
            ..c
        })
        .collect();
    Ok(NutrientSources {
        nutrient: nutrient.to_owned(),
        total,
        // Float sums in two orders can differ in the last bits.
        unattributed: (total - attributed).max(0.0),
        foods,
    })
}

/// Foods listed by [`rich_foods`].
pub const RICH_MAX: usize = 5;
/// The least energy (kcal per 100 g) a food needs to be weighed per 100
/// kcal: below it (coffee, tea, broth, supplements) the ratio runs away.
// ponytail: a flat floor; rank per serving if leafy greens get lost.
const RICH_MIN_KCAL: f64 = 20.0;

/// Foods with at least `min` of `nutrient` (a registry key) per 100 kcal,
/// the ones `profile` has eaten first, then the library's (archived
/// aside), each richest first: at most [`RICH_MAX`].
pub fn rich_foods(
    conn: &Connection,
    profile: ProfileId,
    nutrient: &str,
    min: f64,
) -> Result<Vec<RichFood>, Error> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT id, name, per_100kcal,
             EXISTS (SELECT 1 FROM entry e WHERE e.food_id = f.id
                 AND e.profile_id = ?1 AND e.grp != ?2) AS eaten
         FROM (SELECT id, name, archived,
                   json_extract(per100, '$.' || ?3) * 100
                       / json_extract(per100, '$.energy') AS per_100kcal
               FROM food
               WHERE json_extract(per100, '$.energy') >= ?4) f
         WHERE NOT archived AND per_100kcal >= ?5
         ORDER BY eaten DESC, per_100kcal DESC, fold(name)
         LIMIT {RICH_MAX}"
    ))?;
    Ok(stmt
        .query_map(
            params![profile, PLANNED, nutrient, RICH_MIN_KCAL, min],
            |r| {
                Ok(RichFood {
                    food_id: r.get(0)?,
                    name: r.get(1)?,
                    per_100kcal: r.get(2)?,
                    eaten: r.get(3)?,
                })
            },
        )?
        .collect::<rusqlite::Result<_>>()?)
}

// ------------------------------------------------------------ all time

/// Name parts that make a food of your own or from Open Food Facts beef or
/// potato (lowercase: matched against `fold(name)`), and those that make it
/// not (mixed with pork, which it can't be told the share of; a dried or
/// fried product weighed unlike potato).
const BEEF_NAMES: [&str; 4] = ["beef", "naudan", "nauta", "härkä"];
const NOT_BEEF: [&str; 3] = ["pork", "sika", "sian"];
const POTATO_NAMES: [&str; 2] = ["potato", "peruna"];
const NOT_POTATO: [&str; 5] = ["chips", "crisps", "lastu", "jauhe", "powder"];

/// The foods migrations seed as `custom` (25: Water, 36: Creatine
/// monohydrate): the instance's, not "foods of your own".
const SEEDED: [&str; 2] = ["Water", "Creatine monohydrate"];

/// Grams eaten of foods in Fineli `classes`, or (your own or Open Food
/// Facts) named with one of `names` and none of `not`, as an SQL sum over
/// `part p JOIN food f` (see [`stats_read`]).
fn grams_of(classes: &[&str], names: &[&str], not: &[&str]) -> String {
    let in_classes = classes
        .iter()
        .map(|c| format!("'{c}'"))
        .collect::<Vec<_>>()
        .join(", ");
    let like = |list: &[&str]| {
        list.iter()
            .map(|n| format!("fold(f.name) LIKE '%{n}%'"))
            .collect::<Vec<_>>()
            .join(" OR ")
    };
    format!(
        "coalesce(sum(CASE WHEN f.fineli_class IN ({in_classes})
             OR (f.source IN ('custom', 'off') AND ({}) AND NOT ({}))
             THEN p.grams END), 0)",
        like(names),
        like(not)
    )
}

/// The most days in a row among `days` (sorted, distinct `YYYY-MM-DD`).
fn longest_run(days: &[String]) -> usize {
    let mut best = 0;
    let mut run = 0;
    let mut last: Option<jiff::civil::Date> = None;
    for day in days {
        let Ok(d) = day.parse::<jiff::civil::Date>() else {
            continue;
        };
        run = match last {
            Some(l) if l.tomorrow().ok() == Some(d) => run + 1,
            _ => 1,
        };
        best = best.max(run);
        last = Some(d);
    }
    best
}

/// `pid`'s All time totals. Sums per-day rows: entries' snapshots,
/// imported day totals, sessions, synced days and naps. (The API reads
/// it in parts and sums it apart: [`stats_read`], [`stats_part`],
/// [`stats_of`].)
#[cfg(test)]
pub fn stats(conn: &Connection, pid: ProfileId) -> Result<Stats, Error> {
    let (s, parts) = stats_read(conn, pid)?;
    let parts = parts
        .iter()
        .map(|(from, to)| stats_part(conn, pid, from, to))
        .collect::<Result<_, _>>()?;
    stats_of(s, parts)
}

/// One part of the history read for [`stats_of`]: its eaten rows, whether
/// a day of it ate food without energy, and its beef and potato grams.
pub struct StatsPart {
    rows: Vec<super::EatenRow>,
    unknown_energy: bool,
    beef_g: f64,
    potato_g: f64,
}

/// All time's totals SQL makes, and the parts of the history to read with
/// [`stats_part`]: each half year with a day logged, `(from, to)`. The
/// reads hold the connection, a part at a time, so a Diary read waits for
/// one part at most (a whole year's read was
/// 24 ms of the Diary's 30); the summing, a JSON parse of every entry, is
/// [`stats_of`]'s, done after.
pub fn stats_read(
    conn: &Connection,
    pid: ProfileId,
) -> Result<(Stats, Vec<(String, String)>), Error> {
    let days: Vec<String> = conn
        .prepare_cached(
            "SELECT day FROM entry WHERE profile_id = ?1 AND grp <> ?2
             UNION SELECT day FROM day_total WHERE profile_id = ?1 AND grp <> ?2
             ORDER BY day",
        )?
        .query_map(params![pid, PLANNED], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut s = Stats {
        first_day: days.first().cloned(),
        days_logged: days.len(),
        longest_streak: longest_run(&days),
        ..Stats::default()
    };
    training_totals(conn, pid, &mut s)?;
    activity_totals(conn, pid, &mut s)?;
    (
        s.entries,
        s.classes_known,
        s.weigh_ins,
        s.weigh_ins_from,
        s.custom_foods,
        s.recipes,
        s.meals,
    ) = conn.query_row(
        &format!(
            "SELECT (SELECT count(*) FROM entry WHERE profile_id = ?1 AND grp <> ?2),
                    EXISTS (SELECT 1 FROM food WHERE fineli_class IS NOT NULL),
                    (SELECT count(*) FROM weight WHERE profile_id = ?1),
                    (SELECT min(day) FROM weight WHERE profile_id = ?1),
                    (SELECT count(*) FROM food WHERE source = 'custom' AND kind = 'food' AND NOT archived
                         AND name NOT IN ({})),
                    (SELECT count(*) FROM food WHERE kind = 'recipe'),
                    (SELECT count(*) FROM meal)",
            SEEDED.map(|n| format!("'{n}'")).join(", ")
        ),
        params![pid, PLANNED],
        |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        },
    )?;
    let mut parts: Vec<(String, String)> = days
        .iter()
        .map(|d| match (&d[..4], &d[5..7] <= "06") {
            (y, true) => (format!("{y}-01-01"), format!("{y}-06-30")),
            (y, false) => (format!("{y}-07-01"), format!("{y}-12-31")),
        })
        .collect();
    parts.dedup();
    Ok((s, parts))
}

/// [`stats_read`]'s part `[from, to]`.
pub fn stats_part(
    conn: &Connection,
    pid: ProfileId,
    from: &str,
    to: &str,
) -> Result<StatsPart, Error> {
    // A recipe's entry counts each ingredient's share, `entry g × item g /
    // (cooked g, else the items' total)`, down through recipes in recipes
    // (as the habits' category grams). Summed by food first, so each food's
    // name is matched once.
    let (beef_g, potato_g) = conn
        .prepare_cached(&format!(
            "WITH RECURSIVE
                 total (recipe_id, grams) AS (
                     SELECT recipe_id, sum(grams) FROM recipe_item GROUP BY recipe_id),
                 part (food_id, grams) AS (
                     SELECT food_id, grams FROM entry
                     WHERE {IN_RANGE} AND grp <> ?4 AND food_id IS NOT NULL AND grams > 0
                     UNION ALL
                     SELECT i.food_id, p.grams * i.grams / coalesce(r.cooked_g, t.grams)
                     FROM part p
                     JOIN food r ON r.id = p.food_id AND r.kind = 'recipe'
                     JOIN total t ON t.recipe_id = r.id
                     JOIN recipe_item i ON i.recipe_id = r.id)
             SELECT {}, {}
             FROM (SELECT food_id, sum(grams) AS grams FROM part GROUP BY food_id) p
             JOIN food f ON f.id = p.food_id",
            grams_of(&["BEEF"], &BEEF_NAMES, &NOT_BEEF),
            // POTAPROD (flakes, crisps) is weighed dry, unlike potato.
            grams_of(&["POTATO"], &POTATO_NAMES, &NOT_POTATO)
        ))?
        .query_row(params![pid, from, to, PLANNED], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;
    Ok(StatsPart {
        rows: super::eaten_rows(conn, pid, from, to)?,
        unknown_energy: !super::energy_unknown_days(conn, pid, from, to)?.is_empty(),
        beef_g,
        potato_g,
    })
}

/// All time from its reads: energy and the tracked nutrients, each a lower
/// bound where any day's food didn't all carry it (coverage, ADR 0030):
/// energy also where a food without energy was eaten. Water is
/// Hydration's: what was drunk and eaten less alcohol's debit, a
/// floor where any day's water isn't known.
pub fn stats_of(mut s: Stats, parts: Vec<StatsPart>) -> Result<Stats, Error> {
    let unknown_energy = parts.iter().any(|p| p.unknown_energy);
    let mut rows = Vec::new();
    for p in parts {
        s.beef_g += p.beef_g;
        s.potato_g += p.potato_g;
        rows.extend(p.rows);
    }
    let days = super::eaten_days(&rows)?;
    let total = |key: &str| days.values().map(|d| d.0.get(key).unwrap_or(0.0)).sum();
    let partly = |key: &str| days.values().any(|d| super::known_share(d, key) < 1.0);
    (s.kcal_eaten, s.caffeine_mg, s.alcohol_g) =
        (total("energy"), total("caffeine"), total("alcohol"));
    let hydration: Vec<_> = super::builtin_days_of(super::BuiltinInputs::of_eaten(rows))?
        .into_iter()
        .filter(|b| b.habit == "water")
        .collect();
    s.water_ml = hydration.iter().map(|b| b.amount).sum();
    for (key, partial) in [
        ("energy", unknown_energy || partly("energy")),
        ("water", hydration.iter().any(|b| !b.known)),
        ("caffeine", partly("caffeine")),
        ("alcohol", partly("alcohol")),
    ] {
        if partial {
            s.at_least.push(key);
        }
    }
    Ok(s)
}

/// [`stats_read`]' sessions by type and their totals.
fn training_totals(conn: &Connection, pid: ProfileId, s: &mut Stats) -> Result<(), Error> {
    s.by_type = conn
        .prepare_cached(&format!(
            "SELECT type, count(*), coalesce(sum(minutes), 0),
                        coalesce(sum(CASE WHEN {} THEN distance_m END), 0)
                 FROM activity WHERE profile_id = ?
                 GROUP BY type ORDER BY count(*) DESC, type",
            super::activities::REAL_DISTANCE
        ))?
        .query_map([pid], |r| {
            Ok(TypeTotal {
                kind: r.get(0)?,
                activities: r.get(1)?,
                minutes: r.get(2)?,
                distance_m: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    s.activities_from = conn.query_row(
        "SELECT min(day) FROM activity WHERE profile_id = ?",
        [pid],
        |r| r.get(0),
    )?;
    s.activities = s.by_type.iter().map(|t| t.activities).sum();
    s.minutes_trained = s.by_type.iter().map(|t| t.minutes).sum();
    s.distance_m = s.by_type.iter().map(|t| t.distance_m).sum();
    Ok(())
}

/// [`stats_read`]' steps, sleep and naps.
fn activity_totals(conn: &Connection, pid: ProfileId, s: &mut Stats) -> Result<(), Error> {
    // The days and naps as the Activity days show them (stored, imported
    // and hand values in their precedence), without its sessions.
    // Each total's first day, as its tile starts (days come in order).
    let first = |slot: &mut Option<String>, day: &str| {
        if slot.as_deref().is_none_or(|f| day < f) {
            *slot = Some(day.to_owned());
        }
    };
    for d in super::day_list(conn, pid, None, None)? {
        s.steps += d.steps.unwrap_or(0);
        s.step_days += i64::from(d.steps.is_some());
        s.asleep_min += d.asleep_min.unwrap_or(0);
        if d.steps.is_some_and(|n| n > 0) {
            first(&mut s.steps_from, &d.day);
        }
        if d.asleep_min.is_some_and(|n| n > 0) {
            first(&mut s.sleep_from, &d.day);
        }
    }
    let naps = super::nap_list(conn, pid, None, None)?;
    s.naps = i64::try_from(naps.len()).unwrap_or(i64::MAX);
    for n in &naps {
        first(&mut s.naps_from, &n.day);
    }
    // Time asleep only: a nap without stages was in bed, not known asleep.
    for n in &naps {
        if let Some(m) = n.asleep_min {
            s.asleep_min += m;
            first(&mut s.sleep_from, &n.day);
        }
    }
    Ok(())
}
