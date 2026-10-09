//! Health Connect sync: the Android companion's POST, its
//! status for Profile → Connections, the activity it stored, and what happens
//! to watch workouts (the mode, what waits, Add and Dismiss).

use super::prelude::*;
use axum::extract::DefaultBodyLimit;
use model::{
    Activity, HealthCounts, HealthPost, HealthStatus, PendingSession, WorkoutsMode, is_key,
    latest_day, now_ms,
};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/profiles/{pid}/sync/health",
            post(sync)
                .layer(DefaultBodyLimit::max(model::HEALTH_BYTES_MAX))
                .get(status)
                .delete(remove),
        )
        .route(
            "/api/profiles/{pid}/sync/health/workouts",
            get(pending).put(set_mode),
        )
        .route(
            "/api/profiles/{pid}/sync/health/workouts/{key}",
            post(add).delete(dismiss),
        )
        .route("/api/profiles/{pid}/activity", get(list))
}

/// Replace the posted window. Only a broken envelope is refused; a bad item
/// is skipped and counted. The answer is counts, never data.
async fn sync(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Json(body): Json<Value>,
) -> Res<HealthCounts> {
    let post = HealthPost::read(&body, latest_day(&s.tz))?;
    drop(body);
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::activity_replace(conn, pid, &post, now_ms())
        })
        .await?,
    ))
}

async fn status(State(s): State<AppState>, Path(pid): Path<ProfileId>) -> Res<HealthStatus> {
    Ok(Json(
        on_profile(&s, pid, move |conn| db::health_status(conn, pid)).await?,
    ))
}

async fn remove(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
) -> Result<StatusCode, Error> {
    on_profile(&s, pid, move |conn| db::activity_delete(conn, pid)).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Add automatically or ask; switching to auto adds what waits.
async fn set_mode(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Json(input): Json<WorkoutsMode>,
) -> Res<HealthStatus> {
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::synced_workouts_set(conn, pid, input.mode)?;
            db::health_status(conn, pid)
        })
        .await?,
    ))
}

/// Every watch workout waiting for Add or Dismiss, on any day.
async fn pending(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
) -> Res<Vec<PendingSession>> {
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::pending_session_list(conn, pid, None)
        })
        .await?,
    ))
}

/// A watch workout key from the path: never queried unless well formed.
fn checked_key(key: &str) -> Result<(), Error> {
    if is_key(key) {
        Ok(())
    } else {
        Err(Error::not_found("watch_workout", ""))
    }
}

async fn add(
    State(s): State<AppState>,
    Path((pid, key)): Path<(ProfileId, String)>,
) -> Created<model::Session> {
    checked_key(&key)?;
    let session = on_profile(&s, pid, move |conn| db::synced_workout_add(conn, pid, &key)).await?;
    Ok(created(session))
}

async fn dismiss(
    State(s): State<AppState>,
    Path((pid, key)): Path<(ProfileId, String)>,
) -> Result<StatusCode, Error> {
    checked_key(&key)?;
    on_profile(&s, pid, move |conn| {
        db::synced_workout_dismiss(conn, pid, &key)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Query(r): Query<Range>,
) -> Res<Activity> {
    r.checked()?;
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::activity_list(conn, pid, r.from.as_deref(), r.to.as_deref())
        })
        .await?,
    ))
}
