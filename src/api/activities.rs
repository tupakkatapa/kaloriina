//! Activities done, per profile, set by set; workouts planned; and what
//! the sets answer: each workout's last done, an exercise's history and
//! the records.

use axum::routing::delete as delete_route;

use super::prelude::*;
use crate::model::PlanInput;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/profiles/{pid}/activities", get(list).post(create))
        .route(
            "/api/profiles/{pid}/activities/{id}",
            get(read).put(update).delete(delete),
        )
        .route(
            "/api/profiles/{pid}/plans",
            get(plan_list).post(plan_create),
        )
        .route("/api/profiles/{pid}/plans/{id}", delete_route(plan_delete))
        .route("/api/profiles/{pid}/workouts", get(workouts_done))
        .route(
            "/api/profiles/{pid}/exercises/{id}/history",
            get(exercise_history),
        )
        .route("/api/profiles/{pid}/records", get(records))
}

/// Activities in a range of days (either end open); with `exercise_id`,
/// only those that did it; with `workout_id`, those done from that workout
/// (the workout view's History); with `limit`, the latest that many.
#[derive(Deserialize)]
struct ActivityQuery {
    #[serde(flatten)]
    range: Range,
    exercise_id: Option<i64>,
    workout_id: Option<i64>,
    limit: Option<u32>,
}

async fn list(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Query(q): Query<ActivityQuery>,
) -> Res<Vec<model::Activity>> {
    q.range.checked()?;
    if q.limit == Some(0) {
        return Err(Error::invalid_field("limit", "limit must be 1 or more"));
    }
    let filter = db::ActivityFilter {
        exercise: q.exercise_id,
        workout: q.workout_id,
        limit: q.limit,
    };
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::activity_find(
                conn,
                pid,
                (q.range.from.as_deref(), q.range.to.as_deref()),
                &filter,
            )
        })
        .await?,
    ))
}

async fn create(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Json(input): Json<ActivityInput>,
) -> Created<model::Activity> {
    let input = input.checked()?;
    let session = on_profile(&s, pid, move |conn| {
        db::activity_save(conn, pid, None, &input)
    })
    .await?;
    Ok(created(session))
}

async fn read(
    State(s): State<AppState>,
    Path((pid, id)): Path<(ProfileId, i64)>,
) -> Res<model::Activity> {
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::activity_get(conn, pid, id)?.ok_or_else(|| Error::not_found("activity", id))
        })
        .await?,
    ))
}

async fn update(
    State(s): State<AppState>,
    Path((pid, id)): Path<(ProfileId, i64)>,
    Replace(input): Replace<ActivityInput>,
) -> Res<model::Activity> {
    let input = input.checked()?;
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::activity_save(conn, pid, Some(id), &input)
        })
        .await?,
    ))
}

async fn delete(
    State(s): State<AppState>,
    Path((pid, id)): Path<(ProfileId, i64)>,
) -> Result<StatusCode, Error> {
    on_profile(&s, pid, move |conn| db::activity_delete(conn, pid, id)).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Workouts planned in a range of days (either end open).
async fn plan_list(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Query(r): Query<Range>,
) -> Res<Vec<model::Plan>> {
    r.checked()?;
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::plan_list(conn, pid, r.from.as_deref(), r.to.as_deref())
        })
        .await?,
    ))
}

async fn plan_create(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Json(input): Json<PlanInput>,
) -> Created<model::Plan> {
    let input = input.checked()?;
    let plan = on_profile(&s, pid, move |conn| db::plan_insert(conn, pid, &input)).await?;
    Ok(created(plan))
}

async fn plan_delete(
    State(s): State<AppState>,
    Path((pid, id)): Path<(ProfileId, i64)>,
) -> Result<StatusCode, Error> {
    on_profile(&s, pid, move |conn| db::plan_delete(conn, pid, id)).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The workouts, each with the day this profile last did it.
async fn workouts_done(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
) -> Res<Vec<model::WorkoutDone>> {
    Ok(Json(
        on_profile(&s, pid, move |conn| db::workouts_done(conn, pid)).await?,
    ))
}

async fn exercise_history(
    State(s): State<AppState>,
    Path((pid, id)): Path<(ProfileId, i64)>,
) -> Res<model::ExerciseHistory> {
    Ok(Json(
        on_profile(&s, pid, move |conn| db::exercise_history(conn, pid, id)).await?,
    ))
}

async fn records(State(s): State<AppState>, Path(pid): Path<ProfileId>) -> Res<model::Records> {
    Ok(Json(
        on_profile(&s, pid, move |conn| db::records(conn, pid)).await?,
    ))
}
