//! The diary: a day (food by group, what was eaten, targets, workouts and
//! weight), its entries, and the summary over a range of days.

use std::collections::{BTreeMap, BTreeSet};

use super::prelude::*;
use crate::model::{
    BodyPart, CheckInInput, EntryKey, InsightPref, InsightPrefInput, Logs, MeasurementInput,
    NoteInput,
};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/profiles/{pid}/day/{day}", get(day))
        .route("/api/profiles/{pid}/entries", post(entry_create))
        .route(
            "/api/profiles/{pid}/entries/{key}",
            get(entry_read)
                .patch(entry_update)
                .delete(entry_delete)
                .put(entry_restore),
        )
        .route(
            "/api/profiles/{pid}/imported/{day}/{group}",
            axum::routing::delete(imported_group_delete),
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
        .route("/api/profiles/{pid}/insights/prefs", get(insight_prefs))
        .route(
            "/api/profiles/{pid}/insights/prefs/{id}",
            axum::routing::put(insight_pref_set).delete(insight_pref_delete),
        )
        .route("/api/profiles/{pid}/measurements", get(measurements))
        .route(
            "/api/profiles/{pid}/measurements/{day}/{kind}",
            axum::routing::put(measurement_set).delete(measurement_delete),
        )
}

async fn day(
    State(s): State<AppState>,
    Path((pid, d)): Path<(ProfileId, String)>,
) -> Res<model::DayView> {
    let d = checked_date(&d)?.to_owned();
    let tz = s.tz.clone();
    on_profile(&s, pid, move |conn| db::day_view(conn, pid, &d, &tz))
        .await
        .map(Json)
}

#[derive(Serialize)]
struct Logged {
    entries: Vec<model::Entry>,
}

/// Log on a day: a food (an amount of it), copies of earlier entries, a
/// series' tick, a text entry.
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
            Logs::Food {
                food_id,
                amount,
                repeat,
            } => {
                let food = db::food_get(conn, *food_id)?.ok_or_else(|| {
                    Error::invalid_field("food_id", format!("unknown food {food_id}"))
                })?;
                let m = amount.of(&food)?;
                Ok(vec![db::entry_log(conn, &at, &food, &m, repeat.as_ref())?])
            }
            Logs::Copy { entry_ids } => db::entry_copy(conn, &at, entry_ids),
            Logs::Daily { item } => Ok(vec![db::entry_log_daily(conn, &at, *item)?]),
            Logs::Text { name, nutrients } => {
                Ok(vec![db::entry_text(conn, &at, name, nutrients.as_ref())?])
            }
        }
    })
    .await?;
    Ok(created(Logged { entries }))
}

/// An entry by its address: an id, or a series' day (`daily-{item}-{day}`:
/// its tick, else the day while due).
async fn entry_read(
    State(s): State<AppState>,
    Path((pid, key)): Path<(ProfileId, String)>,
) -> Res<model::Entry> {
    let k = EntryKey::parse(&key)?;
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::entry_at(conn, pid, &k)?.ok_or_else(|| Error::not_found("entry", key))
        })
        .await?,
    ))
}

/// Change an entry; at a series' day, the series (its amount, or stop it).
async fn entry_update(
    State(s): State<AppState>,
    Path((pid, key)): Path<(ProfileId, String)>,
    Json(p): Json<EntryPatch>,
) -> Res<model::Entry> {
    let k = EntryKey::parse(&key)?;
    let p = p.checked()?;
    Ok(Json(
        on_profile(&s, pid, move |conn| match &k {
            EntryKey::Id(id) => db::entry_update(conn, pid, *id, &p),
            EntryKey::Due { item, day } => db::due_update(conn, pid, *item, day, &p),
        })
        .await?,
    ))
}

/// Delete an entry; at a series' day, skip that day (any date: you may
/// skip ahead). Skipping again changes nothing.
async fn entry_delete(
    State(s): State<AppState>,
    Path((pid, key)): Path<(ProfileId, String)>,
) -> Result<StatusCode, Error> {
    let k = EntryKey::parse(&key)?;
    on_profile(&s, pid, move |conn| match &k {
        EntryKey::Id(id) => db::entry_delete(conn, pid, *id),
        EntryKey::Due { item, day } => db::daily_skip(conn, pid, *item, day, true),
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Undo a series' day's skip; none to undo is 204 too. Only a series'
/// day is restored.
async fn entry_restore(
    State(s): State<AppState>,
    Path((pid, key)): Path<(ProfileId, String)>,
) -> Result<StatusCode, Error> {
    let EntryKey::Due { item, day } = EntryKey::parse(&key)? else {
        return Err(Error::invalid(
            "only a series' day (daily-{item}-{day}) is restored",
        ));
    };
    on_profile(&s, pid, move |conn| {
        db::daily_skip(conn, pid, item, &day, false)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Remove a day's imported history of one import group, rows and total.
/// Repeating it changes nothing.
async fn imported_group_delete(
    State(s): State<AppState>,
    Path((pid, day, group)): Path<(ProfileId, String, String)>,
) -> Result<StatusCode, Error> {
    checked_date(&day)?;
    on_profile(&s, pid, move |conn| {
        db::imported_group_delete(conn, pid, &day, &group)
    })
    .await?;
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

async fn insight_prefs(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
) -> Res<Vec<InsightPref>> {
    Ok(Json(
        on_profile(&s, pid, move |conn| db::insight_pref_list(conn, pid)).await?,
    ))
}

/// Hide an insight until a day, or pin it. Repeating it changes nothing.
async fn insight_pref_set(
    State(s): State<AppState>,
    Path((pid, id)): Path<(ProfileId, String)>,
    Json(p): Json<InsightPrefInput>,
) -> Res<InsightPref> {
    let pref = InsightPref::checked(&id, p.state, p.until.as_deref())?;
    Ok(Json(
        on_profile(&s, pid, move |conn| db::insight_pref_set(conn, pid, &pref)).await?,
    ))
}

async fn insight_pref_delete(
    State(s): State<AppState>,
    Path((pid, id)): Path<(ProfileId, String)>,
) -> Result<StatusCode, Error> {
    on_profile(&s, pid, move |conn| db::insight_pref_delete(conn, pid, &id)).await?;
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
    /// How far `total` is known ([`model::Known`], ADR 0030): a recipe's
    /// keys as far as its ingredients carry them, an imported total's only
    /// for energy, the macros and alcohol.
    known: model::Known,
    /// An eaten entry carries no energy: `total.energy` is a lower bound.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    energy_unknown: bool,
    /// Its food isn't the whole day's ([`model::DayView::incomplete`]).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    incomplete: bool,
    /// Its eaten energy by rating; none without energy.
    #[serde(skip_serializing_if = "Option::is_none")]
    ratings: Option<model::Ratings>,
}

/// `[from, to]` (days, `from` first) by calendar month.
fn months(from: &str, to: &str) -> Result<Vec<(String, String)>, Error> {
    let day = |d: &str| {
        d.parse::<jiff::civil::Date>()
            .map_err(|e| Error::Internal(format!("{d}: {e}")))
    };
    let (mut at, to) = (day(from)?, day(to)?);
    let mut parts = Vec::new();
    while at <= to {
        let end = at.last_of_month().min(to);
        parts.push((at.to_string(), end.to_string()));
        match end.tomorrow() {
            Ok(next) => at = next,
            Err(_) => break,
        }
    }
    Ok(parts)
}

/// The days with food logged; their mean is the client's (it knows which
/// days count: through yesterday, food days only).
#[derive(Serialize)]
struct Summary {
    from: String,
    to: String,
    days: Vec<DaySummary>,
}

#[derive(Deserialize)]
struct SummaryQuery {
    #[serde(flatten)]
    range: Range,
    /// Comma-separated nutrient keys: each day's totals narrowed to them (All
    /// time reads years for energy alone).
    keys: Option<String>,
}

/// What was eaten per day over `[from, to]`, every nutrient or `?keys`
/// only. The stored totals are read
/// under the lock and parsed after it.
async fn summary(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Query(q): Query<SummaryQuery>,
) -> Res<Summary> {
    let (Some(from), Some(to)) = q.range.checked()? else {
        return Err(Error::invalid("from and to are required"));
    };
    let keys = q
        .keys
        .as_deref()
        .map(|list| {
            list.split(',')
                .map(|k| {
                    nutrients::find(k).map(|n| n.key).ok_or_else(|| {
                        Error::invalid_field("keys", format!("unknown nutrient “{k}”"))
                    })
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?;
    let wanted = |k: &str| keys.as_ref().is_none_or(|keys| keys.contains(&k));
    let only = |n: Nutrients| match &keys {
        None => n,
        Some(keys) => {
            let mut out = Nutrients::default();
            for key in keys {
                if let Some(v) = n.get(key) {
                    out.insert(key, v);
                }
            }
            out
        }
    };
    let (from, to) = (from.to_owned(), to.to_owned());
    let mut rows = Vec::new();
    let (mut unknown, mut sizeless_days) = (BTreeSet::new(), BTreeSet::new());
    let mut ratings = BTreeMap::new();
    // A month under the lock at a time: All time's years never hold it long.
    for (f, t) in months(&from, &to)? {
        let (eaten, energy_unknown, sizeless, rated) = on_profile(&s, pid, move |conn| {
            Ok((
                db::eaten_rows(conn, pid, &f, &t)?,
                db::energy_unknown_days(conn, pid, &f, &t)?,
                db::unsized_days(conn, pid, &f, &t)?,
                db::day_ratings(conn, pid, &f, &t)?,
            ))
        })
        .await?;
        rows.extend(eaten);
        unknown.extend(energy_unknown);
        sizeless_days.extend(sizeless);
        ratings.extend(rated);
    }
    let days = tokio::task::spawn_blocking(move || db::eaten_days(&rows))
        .await
        .map_err(|e| Error::Internal(format!("summary task failed: {e}")))??;
    Ok(Json(Summary {
        from,
        to,
        days: days
            .into_iter()
            .map(|(day, (total, mut known))| {
                let sizeless = sizeless_days.contains(&day);
                if sizeless {
                    db::unvouched(&mut known, &total);
                }
                // The dry matter weighs a day among others: always kept.
                known.retain(|k, _| k == model::DRY || wanted(k));
                DaySummary {
                    energy_unknown: unknown.contains(&day),
                    incomplete: sizeless,
                    ratings: ratings.remove(&day),
                    day,
                    total: only(total),
                    known,
                }
            })
            .collect(),
    }))
}

#[cfg(test)]
mod tests {
    use super::months;

    #[test]
    fn a_range_splits_by_calendar_month() {
        let parts = |from, to| months(from, to).unwrap();
        assert_eq!(
            parts("2024-01-30", "2024-03-02"),
            [
                ("2024-01-30".into(), "2024-01-31".into()),
                ("2024-02-01".into(), "2024-02-29".into()),
                ("2024-03-01".into(), "2024-03-02".into()),
            ]
        );
        assert_eq!(
            parts("2026-10-07", "2026-10-07"),
            [("2026-10-07".into(), "2026-10-07".into())]
        );
    }
}
