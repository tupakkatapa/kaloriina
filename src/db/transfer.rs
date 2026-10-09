//! A profile out to one file and back in: the export read and
//! the import, all of it in one transaction or nothing.

use super::prelude::*;
use super::workouts::check_exercises;
use super::{
    ENTRY_COLS, activity_insert, activity_list, check_in_list, entry_row, food_by_barcode,
    habit_list, measurement_list, name_free, named_sets, note_list, profile_get, recompute,
    session_list, sync_portion, sync_status, target_list, tombstone, tombstone_list, workout_get,
    write_servings, write_targets,
};
use crate::model::{
    CheckedImport, EXPORT_FORMAT, EXPORT_VERSION, ExportedBinding, ExportedDayTotal, ExportedEntry,
    ExportedExercise, ExportedFood, ExportedHabit, ExportedHabitDay, ExportedItem,
    ExportedMeasurement, ExportedNote, ExportedPlan, ExportedProfile, ExportedScaleReading,
    ExportedSession, ExportedSet, ExportedStep, ExportedTarget, ExportedWeight, ExportedWorkout,
    GoalDir, OPENSCALE, ProfileExport,
};

/// The tables an export reaches by ref besides those a profile owns (the
/// coverage test walks foreign keys from `profile` for the rest).
#[cfg(test)]
pub const REF_TABLES: &[&str] = &["food", "serving", "recipe_item", "workout", "exercise"];

/// Every column the file carries, by table. A new profile-owned
/// column fails `db::tests::every_profile_column_is_exported_or_excluded`
/// until it is listed here or in [`EXCLUDED`].
#[cfg(test)]
pub const EXPORTED: &[(&str, &[&str])] = &[
    (
        "profile",
        &[
            "id",
            "name",
            "sex",
            "birth_date",
            "height_cm",
            "activity",
            "goal_kg_per_week",
            "water_food_id",
            "synced_workouts",
        ],
    ),
    ("target", &["metric", "value"]),
    ("weight", &["day", "kg", "source", "set_at"]),
    (
        "entry",
        &[
            "uid",
            "day",
            "grp",
            "src_grp",
            "food_id",
            "name",
            "grams",
            "amount",
            "nutrients",
            "imported",
            "created_at",
            "serving",
            "quantity",
            "time",
        ],
    ),
    ("day_total", &["day", "grp", "nutrients"]),
    ("favorite", &["food_id"]),
    (
        "workout_session",
        &[
            "uid",
            "day",
            "name",
            "minutes",
            "kcal",
            "sets",
            "type",
            "distance_m",
            "start_at",
            "source",
            "source_key",
            "workout_id",
            "created_at",
        ],
    ),
    ("day_note", &["day", "text"]),
    ("measurement", &["day", "kind", "value"]),
    ("check_in", &["day", "mood", "energy", "stress", "tags"]),
    (
        "habit",
        &[
            "name",
            "unit",
            "goal_value",
            "goal_dir",
            "archived",
            "created_at",
        ],
    ),
    ("habit_day", &["day", "amount"]),
    (
        "scale_reading",
        &[
            "source",
            "source_user",
            "taken_at",
            "source_id",
            "day",
            "weight",
            "body_fat",
            "water",
            "muscle",
        ],
    ),
    (
        "activity_day",
        &[
            "day",
            "active_kcal",
            "steps",
            "resting_hr",
            "hrv_ms",
            "asleep_min",
            "in_bed_min",
            "bedtime",
            "wake_time",
            "deep_min",
            "rem_min",
            "light_min",
        ],
    ),
    (
        "activity_session",
        &[
            "source_key",
            "day",
            "start_at",
            "end_at",
            "type",
            "name",
            "kcal",
            "distance_m",
            "recording_method",
        ],
    ),
    ("workout_tombstone", &["source_key", "type", "start_at"]),
    (
        "food",
        &[
            "name",
            "brand",
            "barcode",
            "source",
            "per100",
            "cooked_g",
            "archived",
            "fineli_id",
            "makes",
            "instructions",
            "category",
        ],
    ),
    ("serving", &["label", "grams"]),
    ("recipe_item", &["food_id", "grams"]),
    ("exercise", &["name", "measure", "traits", "variant_of"]),
    ("workout", &["name", "steps", "minutes", "kcal"]),
    (
        "planned_workout",
        &["day", "workout_id", "uid", "created_at"],
    ),
    ("sync_state", &["source", "bound_user", "bound_username"]),
];

/// Every column the file leaves out, with why. `*` is any table.
#[cfg(test)]
pub const EXCLUDED: &[(&str, &[&str], &str)] = &[
    ("*", &["id", "rev"], "local row identity"),
    ("*", &["profile_id"], "the owner: a file is one profile"),
    ("habit_day", &["habit_id"], "travels inside its habit"),
    ("serving", &["food_id"], "travels inside its food"),
    ("recipe_item", &["recipe_id"], "travels inside its recipe"),
    (
        "exercise",
        &["source"],
        "matched by name; one the instance lacks is created as your own",
    ),
    ("food", &["category_auto"], "importer bookkeeping"),
    (
        "sync_state",
        &["seen_users", "last_seen", "last_result"],
        "device status, re-learned on the next sync (the health_connect row is only that)",
    ),
];

/// Refs in an export are the ids on this instance, as text.
fn reference(id: i64) -> String {
    id.to_string()
}

/// Everything profile `pid` owns, with the foods its entries and favourites
/// use (recipes with their ingredients, recursively) and the exercises its
/// sets use (with their root moves).
pub fn profile_export(conn: &Connection, pid: ProfileId) -> Result<ProfileExport, Error> {
    let (profile, exported_at, synced_workouts, water_food) = conn.query_row(
        "SELECT name, sex, birth_date, height_cm, activity, goal_kg_per_week,
             strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), synced_workouts, water_food_id
         FROM profile WHERE id = ?",
        [pid],
        |r| {
            Ok((
                ExportedProfile {
                    id: Some(pid.0),
                    name: r.get(0)?,
                    body: Body {
                        sex: r.get(1)?,
                        birth_date: r.get(2)?,
                        height_cm: r.get(3)?,
                        activity: r.get(4)?,
                        goal_kg_per_week: r.get(5)?,
                    },
                    workouts_per_week: None,
                    goal_weight_kg: None,
                    weight_kg: None,
                },
                r.get(6)?,
                r.get(7)?,
                r.get::<_, Option<i64>>(8)?.map(reference),
            ))
        },
    )?;
    let sessions = session_list(conn, pid, None, None, None)?;
    let activity = activity_list(conn, pid, None, None)?;
    let plans = exported_plans(conn, pid)?;
    let workouts = exported_workouts(conn, &sessions, &plans)?;
    let binding = sync_status(conn, pid)?.bound_user.map(|b| ExportedBinding {
        bound_user: b.id,
        bound_username: Some(b.username).filter(|n| !n.is_empty()),
    });
    Ok(ProfileExport {
        format: EXPORT_FORMAT.to_owned(),
        version: EXPORT_VERSION,
        exported_at,
        profile,
        synced_workouts,
        water_food,
        openscale: binding,
        exercises: exported_exercises(conn, &sessions, &workouts)?,
        workouts: workouts
            .into_iter()
            .map(|w| ExportedWorkout {
                reference: reference(w.id),
                name: w.name,
                steps: ExportedStep::from_steps(&w.steps, &reference),
                minutes: w.minutes,
                kcal: w.kcal,
            })
            .collect(),
        plans,
        sessions: exported_sessions(conn, pid, sessions)?,
        targets: target_list(conn, pid)?
            .into_iter()
            // A default isn't the profile's: it applies wherever it lands.
            .filter(|t| !t.default)
            .map(|t| ExportedTarget {
                metric: t.metric,
                value: t.value,
            })
            .collect(),
        weights: exported_weights(conn, pid)?,
        scale_readings: exported_readings(conn, pid)?,
        activity_days: activity.days,
        activity_sessions: activity.sessions,
        workout_tombstones: tombstone_list(conn, pid)?,
        measurements: measurement_list(conn, pid, None, None)?
            .into_iter()
            .map(|m| ExportedMeasurement {
                day: m.day,
                kind: m.kind,
                value: m.value,
            })
            .collect(),
        notes: note_list(conn, pid, None, None)?
            .into_iter()
            .map(|n| ExportedNote {
                day: n.day,
                text: n.text,
            })
            .collect(),
        check_ins: check_in_list(conn, pid, None, None)?,
        entries: exported_entries(conn, pid)?,
        day_totals: exported_day_totals(conn, pid)?,
        favorites: conn
            .prepare("SELECT food_id FROM favorite WHERE profile_id = ? ORDER BY food_id")?
            .query_map([pid], |r| Ok(reference(r.get(0)?)))?
            .collect::<rusqlite::Result<_>>()?,
        foods: exported_foods(conn, pid)?,
        habits: exported_habits(conn, pid)?,
    })
}

fn exported_sessions(
    conn: &Connection,
    pid: ProfileId,
    sessions: Vec<Session>,
) -> Result<Vec<ExportedSession>, Error> {
    let created: BTreeMap<i64, String> = conn
        .prepare("SELECT id, created_at FROM workout_session WHERE profile_id = ?")?
        .query_map([pid], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(sessions
        .into_iter()
        .map(|s| ExportedSession {
            created_at: created.get(&s.id).cloned(),
            workout: s.workout_id.map(reference),
            uid: s.uid,
            day: s.day,
            name: s.name,
            minutes: s.minutes,
            kcal: s.kcal,
            kind: s.kind,
            distance_m: s.distance_m,
            start_at: s.start_at,
            source: s.source,
            source_key: s.source_key,
            sets: s
                .sets
                .into_iter()
                .map(|set| ExportedSet {
                    exercise: reference(set.exercise_id),
                    name: set.name,
                    reps: set.reps,
                    seconds: set.seconds,
                    kg: set.kg,
                    side: set.side,
                })
                .collect(),
        })
        .collect())
}

/// The profile's plans, by day.
fn exported_plans(conn: &Connection, pid: ProfileId) -> Result<Vec<ExportedPlan>, Error> {
    Ok(conn
        .prepare(
            "SELECT uid, day, workout_id, created_at FROM planned_workout
             WHERE profile_id = ? ORDER BY day, id",
        )?
        .query_map([pid], |r| {
            Ok(ExportedPlan {
                uid: r.get(0)?,
                day: r.get(1)?,
                workout: reference(r.get(2)?),
                created_at: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// The workouts the sessions were done from and the plans name, by id.
fn exported_workouts(
    conn: &Connection,
    sessions: &[Session],
    plans: &[ExportedPlan],
) -> Result<Vec<Workout>, Error> {
    let ids: BTreeSet<i64> = sessions
        .iter()
        .filter_map(|s| s.workout_id)
        .chain(plans.iter().filter_map(|p| p.workout.parse().ok()))
        .collect();
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        out.extend(workout_get(conn, id)?);
    }
    Ok(out)
}

fn exported_readings(
    conn: &Connection,
    pid: ProfileId,
) -> Result<Vec<ExportedScaleReading>, Error> {
    Ok(conn
        .prepare(
            "SELECT source, source_user, source_id, taken_at, day, weight, body_fat, water, muscle
             FROM scale_reading WHERE profile_id = ? ORDER BY taken_at, source, source_user",
        )?
        .query_map([pid], |r| {
            Ok(ExportedScaleReading {
                source: r.get(0)?,
                source_user: r.get(1)?,
                source_id: r.get(2)?,
                taken_at: r.get(3)?,
                day: r.get(4)?,
                weight: r.get(5)?,
                body_fat: r.get(6)?,
                water: r.get(7)?,
                muscle: r.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

fn exported_day_totals(conn: &Connection, pid: ProfileId) -> Result<Vec<ExportedDayTotal>, Error> {
    Ok(conn
        .prepare(
            "SELECT day, grp, nutrients FROM day_total WHERE profile_id = ? ORDER BY day, grp",
        )?
        .query_map([pid], |r| {
            Ok(ExportedDayTotal {
                day: r.get(0)?,
                group: r.get(1)?,
                nutrients: from_json(&r.get::<_, String>(2)?)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

fn exported_entries(conn: &Connection, pid: ProfileId) -> Result<Vec<ExportedEntry>, Error> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ENTRY_COLS}, src_grp FROM entry WHERE profile_id = ? ORDER BY day, id"
    ))?;
    Ok(stmt
        .query_map([pid], |r| {
            let e = entry_row(r)?;
            Ok(ExportedEntry {
                uid: e.uid,
                day: e.day,
                group: e.group,
                food: e.food_id.map(reference),
                name: e.name,
                grams: e.grams,
                serving: e.serving,
                quantity: e.quantity,
                amount: e.amount,
                nutrients: e.nutrients,
                imported: e.imported,
                src_group: r.get(15)?,
                time: e.time,
                created_at: e.created_at,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

fn exported_foods(conn: &Connection, pid: ProfileId) -> Result<Vec<ExportedFood>, Error> {
    let ids: Vec<i64> = conn
        .prepare(
            "WITH RECURSIVE used(id) AS (
                 SELECT food_id FROM entry WHERE profile_id = ?1 AND food_id IS NOT NULL
                 UNION SELECT food_id FROM favorite WHERE profile_id = ?1
                 UNION SELECT water_food_id FROM profile
                     WHERE id = ?1 AND water_food_id IS NOT NULL
                 UNION SELECT i.food_id FROM recipe_item i JOIN used ON i.recipe_id = used.id
             ) SELECT id FROM used ORDER BY id",
        )?
        .query_map([pid], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut items =
        conn.prepare("SELECT food_id, grams FROM recipe_item WHERE recipe_id = ? ORDER BY rowid")?;
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let food = written(food_get(conn, id)?);
        let fineli_id: Option<i64> =
            conn.query_row("SELECT fineli_id FROM food WHERE id = ?", [id], |r| {
                r.get(0)
            })?;
        out.push(ExportedFood {
            reference: reference(id),
            name: food.name,
            brand: food.brand,
            barcode: food.barcode,
            source: food.source,
            fineli_id,
            per100: food.per100,
            cooked_g: food.cooked_g,
            makes: food.makes,
            instructions: food.instructions,
            archived: food.archived,
            category: food.category,
            servings: food.servings,
            items: items
                .query_map([id], |r| {
                    Ok(ExportedItem {
                        food: reference(r.get(0)?),
                        grams: r.get(1)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?,
        });
    }
    Ok(out)
}

fn exported_exercises(
    conn: &Connection,
    sessions: &[Session],
    workouts: &[Workout],
) -> Result<Vec<ExportedExercise>, Error> {
    let sets: BTreeMap<i64, &SessionSet> = sessions
        .iter()
        .flat_map(|s| s.sets.iter().map(|set| (set.exercise_id, set)))
        .collect();
    let mut ids: BTreeSet<i64> = sets.keys().copied().collect();
    for w in workouts {
        ids.extend(exercise_steps(&w.steps).iter().map(|s| s.exercise_id));
    }
    let mut found = BTreeMap::new();
    while let Some(id) = ids.pop_first() {
        if found.contains_key(&id) {
            continue;
        }
        let x = if let Some(x) = exercise_get(conn, id)? {
            ids.extend(x.variant_of);
            ExportedExercise {
                reference: reference(x.id),
                name: x.name,
                measure: x.measure,
                variant_of: x.variant_of.map(reference),
                traits: x.traits,
            }
        } else {
            // Deleted since: the sets kept its name, which is what an
            // import matches by.
            // (A workout's exercises can't be deleted.)
            let set = sets
                .get(&id)
                .ok_or_else(|| Error::Internal(format!("exercise {id} of a workout is gone")))?;
            ExportedExercise {
                reference: reference(id),
                name: set.name.clone(),
                measure: if set.reps.is_some() {
                    Measure::Reps
                } else {
                    Measure::Time
                },
                variant_of: None,
                traits: ExerciseTraits::default(),
            }
        };
        found.insert(id, x);
    }
    Ok(found.into_values().collect())
}

/// Bad input found while writing: blamed on the list it came from.
fn blamed(field: &'static str, what: String) -> impl Fn(Error) -> Error {
    move |e| match e {
        Error::Invalid { message, .. } => Error::invalid_field(field, format!("{what}: {message}")),
        other => other,
    }
}

/// Create a profile from a checked export, all of it or nothing. Foods,
/// exercises and workouts match ones here or are created as
/// your own. A `restore` keeps the file's profile id when no profile has
/// it, and binds its openScale user again; a plain import does
/// neither.
///
/// `ponytail:` the import holds the one database lock for its whole run
/// (seconds for years of data); chunk it if other requests visibly stall.
pub fn profile_import(
    conn: &mut Connection,
    import: &CheckedImport,
    restore: bool,
) -> Result<Profile, Error> {
    let tx = write(conn)?;
    let file = &import.file;
    name_free(&tx, &import.profile.name, None)?;
    let pid = insert_profile(&tx, import, restore)?;
    write_targets(&tx, pid, &import.targets)?;
    write_days(&tx, pid, file)?;
    let mut foods: BTreeMap<&str, i64> = BTreeMap::new();
    for f in &file.foods {
        let id = match match_food(&tx, f)? {
            Some(id) => id,
            None => create_food(&tx, f, &foods)?,
        };
        foods.insert(&f.reference, id);
    }
    let mut exercises: BTreeMap<&str, i64> = BTreeMap::new();
    for x in &file.exercises {
        let id = import_exercise(&tx, x, &exercises)?;
        exercises.insert(&x.reference, id);
    }
    let mut workouts: BTreeMap<&str, i64> = BTreeMap::new();
    for w in &file.workouts {
        let id = import_workout(&tx, w, &exercises)
            .map_err(blamed("workouts", format!("workout “{}”", w.reference)))?;
        workouts.insert(&w.reference, id);
    }
    for e in &file.entries {
        tx.execute(
            "INSERT INTO entry (profile_id, day, grp, src_grp, food_id, name, grams, amount,
                 nutrients, imported, created_at, uid, serving, quantity, time)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                pid,
                e.day,
                e.group,
                e.src_group,
                e.food.as_deref().map(|r| foods[r]),
                e.name,
                e.grams,
                e.amount,
                e.nutrients.as_ref().map(json),
                e.imported,
                e.created_at,
                e.uid,
                e.serving,
                e.quantity,
                e.time
            ],
        )?;
    }
    write_sessions(&tx, pid, file, &exercises, &workouts)?;
    for p in &file.plans {
        tx.execute(
            "INSERT INTO planned_workout (profile_id, day, workout_id, uid, created_at)
             VALUES (?, ?, ?, ?, coalesce(?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))",
            params![
                pid,
                p.day,
                workouts[p.workout.as_str()],
                p.uid,
                p.created_at
            ],
        )?;
    }
    write_habits(&tx, pid, file)?;
    for r in &file.favorites {
        tx.execute(
            "INSERT OR IGNORE INTO favorite (profile_id, food_id) VALUES (?, ?)",
            params![pid, foods[r.as_str()]],
        )?;
    }
    if let Some(r) = &file.water_food {
        tx.execute(
            "UPDATE profile SET water_food_id = ? WHERE id = ?",
            params![foods[r.as_str()], pid],
        )?;
    }
    if restore && let Some(b) = &file.openscale {
        tx.execute(
            "INSERT INTO sync_state (profile_id, source, bound_user, bound_username)
             VALUES (?, ?, ?, ?)",
            params![pid, OPENSCALE, b.bound_user, b.bound_username],
        )?;
    }
    let profile = written(profile_get(&tx, pid)?);
    tx.commit()?;
    Ok(profile)
}

/// The profile's weights, measurements, notes, check-ins and imported
/// totals.
fn write_days(tx: &Transaction, pid: ProfileId, file: &ProfileExport) -> Result<(), Error> {
    for w in &file.weights {
        tx.execute(
            "INSERT INTO weight (profile_id, day, kg, source, set_at) VALUES (?, ?, ?, ?, ?)",
            params![pid, w.day, w.kg, w.source, w.set_at],
        )?;
    }
    for r in &file.scale_readings {
        tx.execute(
            "INSERT INTO scale_reading (profile_id, source, source_user, taken_at, source_id,
                 day, weight, body_fat, water, muscle)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                pid,
                r.source,
                r.source_user,
                r.taken_at,
                r.source_id,
                r.day,
                r.weight,
                r.body_fat,
                r.water,
                r.muscle
            ],
        )?;
    }
    activity_insert(tx, pid, &file.activity_days, &file.activity_sessions)?;
    for t in &file.workout_tombstones {
        tombstone(tx, pid, &t.key, t.kind, t.start_at.as_deref())?;
    }
    for m in &file.measurements {
        tx.execute(
            "INSERT INTO measurement (profile_id, day, kind, value) VALUES (?, ?, ?, ?)",
            params![pid, m.day, m.kind.as_str(), m.value],
        )?;
    }
    for n in &file.notes {
        tx.execute(
            "INSERT INTO day_note (profile_id, day, text) VALUES (?, ?, ?)",
            params![pid, n.day, n.text],
        )?;
    }
    for c in &file.check_ins {
        tx.execute(
            "INSERT INTO check_in (profile_id, day, mood, energy, stress, tags)
             VALUES (?, ?, ?, ?, ?, ?)",
            params![pid, c.day, c.mood, c.energy, c.stress, json(&c.tags)],
        )?;
    }
    for t in &file.day_totals {
        tx.execute(
            "INSERT INTO day_total (profile_id, day, grp, nutrients) VALUES (?, ?, ?, ?)",
            params![pid, t.day, t.group, json(&t.nutrients)],
        )?;
    }
    Ok(())
}

/// The sessions, their sets named after the exercises here.
fn write_sessions(
    tx: &Transaction,
    pid: ProfileId,
    file: &ProfileExport,
    exercises: &BTreeMap<&str, i64>,
    workouts: &BTreeMap<&str, i64>,
) -> Result<(), Error> {
    for s in &file.sessions {
        let workout_id = s.workout.as_deref().map(|r| workouts[r]);
        let input = SessionInput {
            day: s.day.clone(),
            workout_id,
            name: s.name.clone(),
            minutes: s.minutes,
            kcal: s.kcal,
            sets: s
                .sets
                .iter()
                .map(|set| SessionSet {
                    exercise_id: exercises[set.exercise.as_str()],
                    name: set.name.clone(),
                    reps: set.reps,
                    seconds: set.seconds,
                    kg: set.kg,
                    side: set.side,
                })
                .collect(),
            uid: Some(s.uid.clone()),
            kind: s.kind,
            distance_m: s.distance_m,
            start_at: s.start_at.clone(),
            rev: None,
        };
        let sets = named_sets(tx, &input, None)
            .map_err(blamed("sessions", format!("session “{}”", s.uid)))?;
        tx.execute(
            "INSERT INTO workout_session (profile_id, day, name, minutes, kcal, sets, uid, type,
                 distance_m, start_at, source, source_key, workout_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 coalesce(?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))",
            params![
                pid,
                s.day,
                s.name,
                s.minutes,
                s.kcal,
                json(&sets),
                s.uid,
                s.kind,
                s.distance_m,
                s.start_at,
                s.source,
                s.source_key,
                workout_id,
                s.created_at
            ],
        )?;
    }
    Ok(())
}

/// The profile's trackers, oldest first, each with its days.
fn exported_habits(conn: &Connection, pid: ProfileId) -> Result<Vec<ExportedHabit>, Error> {
    let mut days: BTreeMap<i64, Vec<ExportedHabitDay>> = BTreeMap::new();
    let mut stmt = conn.prepare(
        "SELECT d.habit_id, d.day, d.amount FROM habit_day d JOIN habit h ON h.id = d.habit_id
         WHERE h.profile_id = ? ORDER BY d.day",
    )?;
    for row in stmt.query_map([pid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))? {
        let (habit, day, amount) = row?;
        days.entry(habit)
            .or_default()
            .push(ExportedHabitDay { day, amount });
    }
    let created: BTreeMap<i64, String> = conn
        .prepare("SELECT id, created_at FROM habit WHERE profile_id = ?")?
        .query_map([pid], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(habit_list(conn, pid)?
        .into_iter()
        .map(|h| ExportedHabit {
            days: days.remove(&h.id).unwrap_or_default(),
            created_at: created.get(&h.id).cloned(),
            name: h.name,
            unit: h.unit,
            goal_value: h.goal_value,
            goal_dir: Some(h.goal_dir),
            day_limit: None,
            archived: h.archived,
        })
        .collect())
}

/// The trackers, new to this profile (habits are per profile: nothing to
/// match), with their days.
fn write_habits(tx: &Transaction, pid: ProfileId, file: &ProfileExport) -> Result<(), Error> {
    for h in &file.habits {
        tx.execute(
            "INSERT INTO habit (profile_id, name, unit, goal_value, goal_dir, archived, created_at)
             VALUES (?, ?, ?, ?, ?, ?, coalesce(?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))",
            params![
                pid,
                h.name,
                h.unit,
                h.goal_value,
                h.goal_dir.unwrap_or(GoalDir::AtMost),
                h.archived,
                h.created_at
            ],
        )?;
        let id = tx.last_insert_rowid();
        for d in &h.days {
            tx.execute(
                "INSERT INTO habit_day (habit_id, day, amount) VALUES (?, ?, ?)",
                params![id, d.day, d.amount],
            )?;
        }
    }
    Ok(())
}

/// The food here that is the file's: the same Fineli id, else the same
/// barcode, else the same source, name, brand and values.
fn match_food(tx: &Transaction, f: &ExportedFood) -> Result<Option<i64>, Error> {
    if let Some(fineli_id) = f.fineli_id {
        let id = tx
            .query_row(
                "SELECT id FROM food WHERE fineli_id = ?",
                [fineli_id],
                |r| r.get(0),
            )
            .optional()?;
        if id.is_some() {
            return Ok(id);
        }
    }
    if let Some(code) = &f.barcode
        && let Some(food) = food_by_barcode(tx, code)?
    {
        return Ok(Some(food.id));
    }
    let wanted = json(&f.per100);
    let mut stmt = tx.prepare_cached(
        "SELECT id, per100 FROM food WHERE source = ? AND name = ? AND brand IS ? ORDER BY id",
    )?;
    for row in stmt.query_map(params![f.source, f.name, f.brand], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
    })? {
        let (id, per100) = row?;
        // Compared as values, so older stored spellings of a number match.
        if json(&from_json::<Nutrients>(&per100)?) == wanted {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

/// A food the file has and this instance doesn't, as your own: a recipe
/// stays a recipe (its values computed from the ingredients here); any
/// other is custom, without its Fineli id, keeping its barcode if unused.
fn create_food(
    tx: &Transaction,
    f: &ExportedFood,
    foods: &BTreeMap<&str, i64>,
) -> Result<i64, Error> {
    if f.source != Source::Recipe {
        let barcode = match &f.barcode {
            Some(code) if food_by_barcode(tx, code)?.is_none() => Some(code),
            _ => None,
        };
        tx.execute(
            "INSERT INTO food (name, brand, barcode, source, per100, archived, category)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                f.name,
                f.brand,
                barcode,
                Source::Custom,
                json(&f.per100),
                f.archived,
                f.category
            ],
        )?;
        let id = tx.last_insert_rowid();
        write_servings(tx, id, &f.servings)?;
        return Ok(id);
    }
    tx.execute(
        "INSERT INTO food (name, source, cooked_g, archived, makes, instructions, category)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        params![
            f.name,
            Source::Recipe,
            f.cooked_g,
            f.archived,
            f.makes,
            f.instructions,
            f.category
        ],
    )?;
    let id = tx.last_insert_rowid();
    // Ingredients come first in a checked file, so each is mapped already.
    for item in &f.items {
        tx.execute(
            "INSERT INTO recipe_item (recipe_id, food_id, grams) VALUES (?, ?, ?)",
            params![id, foods[item.food.as_str()], item.grams],
        )?;
    }
    let mut servings = f.servings.clone();
    if !servings.iter().any(|s| s.label == WHOLE_RECIPE) {
        servings.insert(
            0,
            Serving {
                label: WHOLE_RECIPE.to_owned(),
                grams: 1.0,
            },
        );
    }
    write_servings(tx, id, &servings)?;
    recompute(tx, id)?;
    sync_portion(tx, id)?;
    Ok(id)
}

/// The exercise here with the file's name (ignoring case), else a new one
/// of your own: a variant of its root when that root is one here.
fn import_exercise(
    tx: &Transaction,
    x: &ExportedExercise,
    exercises: &BTreeMap<&str, i64>,
) -> Result<i64, Error> {
    // `exercise.name` compares without case (its column's collation).
    let found: Option<i64> = tx
        .query_row("SELECT id FROM exercise WHERE name = ?", [&x.name], |r| {
            r.get(0)
        })
        .optional()?;
    if let Some(id) = found {
        return Ok(id);
    }
    let parent = match x.variant_of.as_deref().and_then(|r| exercises.get(r)) {
        Some(&p) => exercise_get(tx, p)?
            .filter(|root| root.variant_of.is_none())
            .map(|root| root.id),
        None => None,
    };
    tx.execute(
        "INSERT INTO exercise (name, measure, variant_of, traits) VALUES (?, ?, ?, ?)",
        params![x.name, x.measure, parent, json(&x.traits)],
    )?;
    Ok(tx.last_insert_rowid())
}

/// The workout here with the file's name and the same steps, else a new
/// one.
fn import_workout(
    tx: &Transaction,
    w: &ExportedWorkout,
    exercises: &BTreeMap<&str, i64>,
) -> Result<i64, Error> {
    let steps = ExportedStep::to_steps(&w.steps, exercises)?;
    check_exercises(tx, &steps)?;
    let mut same = tx.prepare_cached("SELECT id, steps FROM workout WHERE name = ? ORDER BY id")?;
    for row in same.query_map([&w.name], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
    })? {
        let (id, stored) = row?;
        if from_json::<Vec<Step>>(&stored)? == steps {
            return Ok(id);
        }
    }
    tx.execute(
        "INSERT INTO workout (name, steps, minutes, kcal) VALUES (?, ?, ?, ?)",
        params![w.name, json(&steps), w.minutes, w.kcal],
    )?;
    Ok(tx.last_insert_rowid())
}

/// The profile row: the file's id when restoring and free, else a new one.
fn insert_profile(
    tx: &Transaction,
    import: &CheckedImport,
    restore: bool,
) -> Result<ProfileId, Error> {
    let (p, file) = (&import.profile, &import.file);
    let id = match file.profile.id {
        Some(id) if restore => {
            let taken: bool = tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM profile WHERE id = ?)",
                [id],
                |r| r.get(0),
            )?;
            (!taken).then_some(id)
        }
        _ => None,
    };
    let b = &p.body;
    tx.execute(
        "INSERT INTO profile (id, name, sex, birth_date, height_cm, activity, goal_kg_per_week,
             synced_workouts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            id,
            p.name,
            b.sex,
            b.birth_date,
            b.height_cm,
            b.activity,
            b.goal_kg_per_week,
            file.synced_workouts
        ],
    )?;
    Ok(ProfileId(tx.last_insert_rowid()))
}

fn exported_weights(conn: &Connection, pid: ProfileId) -> Result<Vec<ExportedWeight>, Error> {
    Ok(conn
        .prepare("SELECT day, kg, source, set_at FROM weight WHERE profile_id = ? ORDER BY day")?
        .query_map([pid], |r| {
            Ok(ExportedWeight {
                day: r.get(0)?,
                kg: r.get(1)?,
                source: r.get(2)?,
                set_at: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}
