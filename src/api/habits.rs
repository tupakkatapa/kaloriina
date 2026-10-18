//! Habit trackers of your own and their daily totals, and every habit's
//! daily amounts (the built-ins' read from what was eaten).

use super::diary::path_day;
use super::prelude::*;
use crate::model::{HabitAmountInput, HabitInput};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/profiles/{pid}/habits", get(list).post(create))
        .route("/api/profiles/{pid}/habits/days", get(days))
        .route(
            "/api/profiles/{pid}/habits/{id}",
            axum::routing::put(update).delete(delete),
        )
        .route(
            "/api/profiles/{pid}/habits/{id}/days/{day}",
            axum::routing::put(day_set).delete(day_delete),
        )
}

async fn list(State(s): State<AppState>, Path(pid): Path<ProfileId>) -> Res<Vec<model::Habit>> {
    Ok(Json(
        on_profile(&s, pid, move |conn| db::habit_list(conn, pid)).await?,
    ))
}

async fn create(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Json(h): Json<HabitInput>,
) -> Created<model::Habit> {
    let h = h.checked()?;
    let habit = on_profile(&s, pid, move |conn| db::habit_save(conn, pid, None, &h)).await?;
    Ok(created(habit))
}

async fn update(
    State(s): State<AppState>,
    Path((pid, id)): Path<(ProfileId, i64)>,
    Replace(h): Replace<HabitInput>,
) -> Res<model::Habit> {
    let h = h.checked()?;
    Ok(Json(
        on_profile(&s, pid, move |conn| db::habit_save(conn, pid, Some(id), &h)).await?,
    ))
}

async fn delete(
    State(s): State<AppState>,
    Path((pid, id)): Path<(ProfileId, i64)>,
) -> Result<StatusCode, Error> {
    on_profile(&s, pid, move |conn| db::habit_delete(conn, pid, id)).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Every habit's amounts in the range: the built-ins' (stored units, see
/// `meta.habits`) and the trackers', by day, built-ins first. The rows are
/// read under the lock and the built-ins computed after it.
async fn days(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Query(r): Query<Range>,
) -> Res<Vec<model::HabitDayRow>> {
    r.checked()?;
    let (inputs, trackers) = on_profile(&s, pid, move |conn| {
        let (from, to) = (r.from.as_deref(), r.to.as_deref());
        Ok((
            db::builtin_inputs(conn, pid, from, to)?,
            db::habit_days(conn, pid, from, to)?,
        ))
    })
    .await?;
    let mut rows = tokio::task::spawn_blocking(move || db::builtin_days_of(inputs))
        .await
        .map_err(|e| Error::Internal(format!("habit days task failed: {e}")))??;
    rows.extend(trackers.into_iter().map(|d| model::HabitDayRow {
        habit: d.habit_id.to_string(),
        day: d.day,
        amount: d.amount,
        known: true,
    }));
    // Stable: within a day, built-ins (registry order) then trackers.
    rows.sort_by(|a, b| a.day.cmp(&b.day));
    Ok(Json(rows))
}

/// Set a tracker's total on a day, up to tomorrow (UTC). Repeating it
/// changes nothing, so a client may queue it offline.
async fn day_set(
    State(s): State<AppState>,
    Path((pid, id, day)): Path<(ProfileId, i64, String)>,
    Json(a): Json<HabitAmountInput>,
) -> Res<model::HabitDay> {
    path_day(&day)?;
    let a = a.checked()?;
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::habit_day_set(conn, pid, id, &day, a.amount)
        })
        .await?,
    ))
}

async fn day_delete(
    State(s): State<AppState>,
    Path((pid, id, day)): Path<(ProfileId, i64, String)>,
) -> Result<StatusCode, Error> {
    checked_date(&day)?;
    on_profile(&s, pid, move |conn| {
        db::habit_day_delete(conn, pid, id, &day)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
