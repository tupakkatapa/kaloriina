//! The diary: a day (food by group, what was eaten, targets, workouts and
//! weight), its entries, and the summary over a range of days.

use super::prelude::*;
use crate::model::{BodyPart, CheckInInput, Logs, MeasurementInput, NoteInput};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/profiles/{pid}/day/{date}", get(day))
        .route("/api/profiles/{pid}/entries", post(entry_create))
        .route(
            "/api/profiles/{pid}/entries/{id}",
            get(entry_read).patch(entry_update).delete(entry_delete),
        )
        .route("/api/profiles/{pid}/summary", get(summary))
        .route("/api/profiles/{pid}/notes", get(notes))
        .route(
            "/api/profiles/{pid}/notes/{day}",
            axum::routing::put(note_set).delete(note_delete),
        )
        .route("/api/profiles/{pid}/check-ins", get(check_ins))
        .route(
            "/api/profiles/{pid}/check-ins/{day}",
            axum::routing::put(check_in_set).delete(check_in_delete),
        )
        .route("/api/profiles/{pid}/measurements", get(measurements))
        .route(
            "/api/profiles/{pid}/measurements/{day}/{kind}",
            axum::routing::put(measurement_set).delete(measurement_delete),
        )
}

#[derive(Serialize)]
struct Group {
    name: String,
    entries: Vec<model::Entry>,
    totals: Nutrients,
}

#[derive(Serialize)]
struct DayView {
    day: String,
    groups: Vec<Group>,
    /// Every group, planned included.
    total: Nutrients,
    /// What was eaten: every group but Planned.
    consumed: Nutrients,
    targets: Vec<Target>,
    sessions: Vec<model::Session>,
    /// Workouts planned that day, not done yet.
    plans: Vec<model::Plan>,
    /// The day's logged weight, if any.
    weight: Option<f64>,
    /// Where it came from: `manual` or `scale`.
    weight_source: Option<model::WeightSource>,
    /// Body composition from the day's chosen reading (its earliest).
    composition: Option<Composition>,
    /// The day's note, if any.
    note: Option<String>,
    /// The day's check-in, if any.
    check_in: Option<model::CheckIn>,
    /// The day's body measurements, in [`BodyPart`] order.
    measurements: Vec<BodyValue>,
    /// The built-ins the day's food held (above 0), stored units (see
    /// `meta.habits`), in registry order.
    builtins: Vec<BuiltinValue>,
    /// Each tracker's total that day, archived ones included.
    habits: Vec<HabitValue>,
    /// Health Connect's day (energy, steps, the night that ended it,
    /// heart), if synced.
    activity: Option<model::ActivityDay>,
    /// Watch workouts waiting for Add or Dismiss.
    pending_sessions: Vec<model::PendingSession>,
    /// The food "+ Water" logs, if any: its entries read as ml or L.
    water_food_id: Option<i64>,
}

/// Body fat, water and muscle in %, each `null` when the scale gave none.
#[derive(Serialize)]
struct Composition {
    body_fat: Option<f64>,
    water: Option<f64>,
    muscle: Option<f64>,
}

/// One built-in habit's amount on the day.
#[derive(Serialize)]
struct BuiltinValue {
    habit: String,
    amount: f64,
}

/// One habit tracker's total on the day.
#[derive(Serialize)]
struct HabitValue {
    habit_id: i64,
    amount: f64,
}

/// One body part's measurement on the day, in cm.
#[derive(Serialize)]
struct BodyValue {
    kind: BodyPart,
    value: f64,
}

/// What a day or summary counts as eaten: every group but Planned.
fn eaten(group: &str) -> bool {
    group != model::PLANNED
}

async fn day(State(s): State<AppState>, Path((pid, d)): Path<(ProfileId, String)>) -> Res<DayView> {
    let d = checked_date(&d)?.to_owned();
    on_profile(&s, pid, move |conn| {
        let entries = db::entry_list_for_day(conn, pid, &d)?;
        let totals = db::group_totals(conn, pid, &d, &d)?;
        let mut names: Vec<String> = GROUPS.iter().map(|&g| g.to_owned()).collect();
        for g in entries
            .iter()
            .map(|e| e.group.as_str())
            .chain(totals.keys().map(|(_, g)| g.as_str()))
        {
            if !names.iter().any(|n| n == g) {
                names.push(g.to_owned());
            }
        }
        names[GROUPS.len()..].sort();
        let groups: Vec<Group> = names
            .into_iter()
            .map(|name| Group {
                entries: entries
                    .iter()
                    .filter(|e| e.group == name)
                    .cloned()
                    .collect(),
                totals: totals
                    .get(&(d.clone(), name.clone()))
                    .cloned()
                    .unwrap_or_default(),
                name,
            })
            .collect();
        let total = Nutrients::sum(groups.iter().map(|g| &g.totals));
        let consumed = Nutrients::sum(groups.iter().filter(|g| eaten(&g.name)).map(|g| &g.totals));
        let mut activity = db::activity_list(conn, pid, Some(&d), Some(&d))?.days;
        Ok(DayView {
            activity: activity.pop(),
            pending_sessions: db::pending_session_list(conn, pid, Some(&d))?,
            water_food_id: db::water_food_get(conn, pid)?.map(|f| f.id),
            targets: db::target_list(conn, pid)?,
            sessions: db::session_list(conn, pid, Some(&d), Some(&d), None)?,
            plans: db::plan_list(conn, pid, Some(&d), Some(&d))?,
            weight: db::weight_list(conn, pid, Some(&d), Some(&d))?
                .first()
                .map(|w| w.kg),
            weight_source: db::weight_source(conn, pid, &d)?,
            composition: db::scale_chosen(conn, pid, &d)?
                .filter(|r| r.body_fat.is_some() || r.water.is_some() || r.muscle.is_some())
                .map(|r| Composition {
                    body_fat: r.body_fat,
                    water: r.water,
                    muscle: r.muscle,
                }),
            note: db::note_list(conn, pid, Some(&d), Some(&d))?
                .pop()
                .map(|n| n.text),
            check_in: db::check_in_list(conn, pid, Some(&d), Some(&d))?.pop(),
            measurements: db::measurement_list(conn, pid, Some(&d), Some(&d))?
                .into_iter()
                .map(|m| BodyValue {
                    kind: m.kind,
                    value: m.value,
                })
                .collect(),
            builtins: db::builtin_days(conn, pid, Some(&d), Some(&d))?
                .into_iter()
                .filter(|b| b.amount > 0.0)
                .map(|b| BuiltinValue {
                    habit: b.habit,
                    amount: b.amount,
                })
                .collect(),
            habits: db::habit_days(conn, pid, Some(&d), Some(&d))?
                .into_iter()
                .map(|h| HabitValue {
                    habit_id: h.habit_id,
                    amount: h.amount,
                })
                .collect(),
            day: d,
            groups,
            total,
            consumed,
        })
    })
    .await
    .map(Json)
}

#[derive(Serialize)]
struct Logged {
    entries: Vec<model::Entry>,
}

/// Log on a day: a food (an amount of it), a meal (all its items), copies
/// of earlier entries.
async fn entry_create(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Json(e): Json<EntryInput>,
) -> Created<Logged> {
    let e = e.checked()?;
    let entries = on_profile(&s, pid, move |conn| {
        let at = db::Slot {
            profile: pid,
            day: &e.day,
            group: e.group,
            uid: e.uid.as_deref(),
            time: e.time.as_deref(),
        };
        match &e.what {
            Logs::Food { food_id, amount } => {
                let food = db::food_get(conn, *food_id)?.ok_or_else(|| {
                    Error::invalid_field("food_id", format!("unknown food {food_id}"))
                })?;
                let m = amount.of(&food)?;
                Ok(vec![db::entry_log(conn, &at, &food, &m)?])
            }
            Logs::Meal { meal_id, portions } => db::entry_log_meal(conn, &at, *meal_id, *portions),
            Logs::Copy { entry_ids } => db::entry_copy(conn, &at, entry_ids),
        }
    })
    .await?;
    Ok(created(Logged { entries }))
}

async fn entry_read(
    State(s): State<AppState>,
    Path((pid, id)): Path<(ProfileId, i64)>,
) -> Res<model::Entry> {
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::entry_get(conn, pid, id)?.ok_or_else(|| Error::not_found("entry", id))
        })
        .await?,
    ))
}

async fn entry_update(
    State(s): State<AppState>,
    Path((pid, id)): Path<(ProfileId, i64)>,
    Json(p): Json<EntryPatch>,
) -> Res<model::Entry> {
    let p = p.checked()?;
    Ok(Json(
        on_profile(&s, pid, move |conn| db::entry_update(conn, pid, id, &p)).await?,
    ))
}

async fn entry_delete(
    State(s): State<AppState>,
    Path((pid, id)): Path<(ProfileId, i64)>,
) -> Result<StatusCode, Error> {
    on_profile(&s, pid, move |conn| db::entry_delete(conn, pid, id)).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// A day in a note's or measurement's address: a date up to tomorrow
/// (UTC), like a weight's. The address is to blame, not a body field.
pub(super) fn path_day(day: &str) -> Result<&str, Error> {
    model::checked_day_so_far(day).map_err(|e| Error::invalid(e.to_string()))
}

/// A body part in a measurement's address.
fn path_kind(kind: &str) -> Result<BodyPart, Error> {
    BodyPart::parse(kind)
        .ok_or_else(|| Error::invalid(format!("measurement must be {}", BodyPart::choices())))
}

async fn notes(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Query(r): Query<Range>,
) -> Res<Vec<model::DayNote>> {
    r.checked()?;
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::note_list(conn, pid, r.from.as_deref(), r.to.as_deref())
        })
        .await?,
    ))
}

/// Write a day's note, replacing its old one. Repeating it changes nothing.
async fn note_set(
    State(s): State<AppState>,
    Path((pid, day)): Path<(ProfileId, String)>,
    Json(n): Json<NoteInput>,
) -> Res<model::DayNote> {
    path_day(&day)?;
    let n = n.checked()?;
    Ok(Json(
        on_profile(&s, pid, move |conn| db::note_set(conn, pid, &day, &n.text)).await?,
    ))
}

async fn note_delete(
    State(s): State<AppState>,
    Path((pid, day)): Path<(ProfileId, String)>,
) -> Result<StatusCode, Error> {
    checked_date(&day)?;
    on_profile(&s, pid, move |conn| db::note_delete(conn, pid, &day)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn check_ins(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Query(r): Query<Range>,
) -> Res<Vec<model::CheckIn>> {
    r.checked()?;
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::check_in_list(conn, pid, r.from.as_deref(), r.to.as_deref())
        })
        .await?,
    ))
}

/// Write a day's whole check-in (a missing field is unset). Repeating it
/// changes nothing.
async fn check_in_set(
    State(s): State<AppState>,
    Path((pid, day)): Path<(ProfileId, String)>,
    Json(c): Json<CheckInInput>,
) -> Res<model::CheckIn> {
    path_day(&day)?;
    let c = c.checked()?;
    Ok(Json(
        on_profile(&s, pid, move |conn| db::check_in_set(conn, pid, &day, &c)).await?,
    ))
}

async fn check_in_delete(
    State(s): State<AppState>,
    Path((pid, day)): Path<(ProfileId, String)>,
) -> Result<StatusCode, Error> {
    checked_date(&day)?;
    on_profile(&s, pid, move |conn| db::check_in_delete(conn, pid, &day)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn measurements(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Query(r): Query<Range>,
) -> Res<Vec<model::Measurement>> {
    r.checked()?;
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::measurement_list(conn, pid, r.from.as_deref(), r.to.as_deref())
        })
        .await?,
    ))
}

/// Write a day's measurement of one body part, replacing its old one.
/// Repeating it changes nothing.
async fn measurement_set(
    State(s): State<AppState>,
    Path((pid, day, kind)): Path<(ProfileId, String, String)>,
    Json(m): Json<MeasurementInput>,
) -> Res<model::Measurement> {
    path_day(&day)?;
    let kind = path_kind(&kind)?;
    let m = m.checked()?;
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::measurement_set(conn, pid, &day, kind, m.value)
        })
        .await?,
    ))
}

async fn measurement_delete(
    State(s): State<AppState>,
    Path((pid, day, kind)): Path<(ProfileId, String, String)>,
) -> Result<StatusCode, Error> {
    checked_date(&day)?;
    let kind = path_kind(&kind)?;
    on_profile(&s, pid, move |conn| {
        db::measurement_delete(conn, pid, &day, kind)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
struct DaySummary {
    day: String,
    total: Nutrients,
}

#[derive(Serialize)]
struct Summary {
    from: String,
    to: String,
    days_logged: usize,
    average: Nutrients,
    days: Vec<DaySummary>,
}

/// Mean over the given days.
fn average(days: &BTreeMap<String, Nutrients>) -> Nutrients {
    if days.is_empty() {
        return Nutrients::default();
    }
    let n = f64::from(u32::try_from(days.len()).unwrap_or(u32::MAX));
    Nutrients::sum(days.values()).scale(1.0 / n)
}

/// What was eaten per day over `[from, to]` and the mean over the days that
/// have any. The stored totals are read under the lock and parsed after it.
async fn summary(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Query(r): Query<Range>,
) -> Res<Summary> {
    let (Some(from), Some(to)) = r.checked()? else {
        return Err(Error::invalid("from and to are required"));
    };
    let (from, to) = (from.to_owned(), to.to_owned());
    let (f, t) = (from.clone(), to.clone());
    let rows = on_profile(&s, pid, move |conn| db::group_rows(conn, pid, &f, &t)).await?;
    let days = tokio::task::spawn_blocking(move || {
        let mut days: BTreeMap<String, Nutrients> = BTreeMap::new();
        for ((day, group), n) in db::group_sums(rows)? {
            if eaten(&group) {
                days.entry(day).or_default().add(&n);
            }
        }
        Ok::<_, Error>(days)
    })
    .await
    .map_err(|e| Error::Internal(format!("summary task failed: {e}")))??;
    Ok(Json(Summary {
        from,
        to,
        days_logged: days.len(),
        average: average(&days),
        days: days
            .into_iter()
            .map(|(day, total)| DaySummary { day, total })
            .collect(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn average_over_logged_days_only() {
        let mut days = BTreeMap::new();
        days.insert("a".into(), Nutrients::of(&[("energy", 1000.0)]));
        days.insert("b".into(), Nutrients::of(&[("energy", 2000.0)]));
        assert_close!(average(&days).get("energy").unwrap(), 1500.0);
        assert!(average(&BTreeMap::new()).is_empty());
    }
}
