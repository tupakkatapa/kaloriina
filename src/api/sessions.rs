//! Sessions: workouts done, per profile, set by set; and workouts planned.

use axum::routing::delete as delete_route;

use super::prelude::*;
use crate::model::PlanInput;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/profiles/{pid}/sessions", get(list).post(create))
        .route(
            "/api/profiles/{pid}/sessions/{id}",
            get(read).put(update).delete(delete),
        )
        .route(
            "/api/profiles/{pid}/plans",
            get(plan_list).post(plan_create),
        )
        .route("/api/profiles/{pid}/plans/{id}", delete_route(plan_delete))
}

/// Sessions in a range of days (either end open); with `exercise_id`,
/// only those that did it.
#[derive(Deserialize)]
struct SessionQuery {
    #[serde(flatten)]
    range: Range,
    exercise_id: Option<i64>,
}

async fn list(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Query(q): Query<SessionQuery>,
) -> Res<Vec<model::Session>> {
    q.range.checked()?;
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::session_list(
                conn,
                pid,
                q.range.from.as_deref(),
                q.range.to.as_deref(),
                q.exercise_id,
            )
        })
        .await?,
    ))
}

async fn create(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Json(input): Json<SessionInput>,
) -> Created<model::Session> {
    let input = input.checked()?;
    let session = on_profile(&s, pid, move |conn| {
        db::session_save(conn, pid, None, &input)
    })
    .await?;
    Ok(created(session))
}

async fn read(
    State(s): State<AppState>,
    Path((pid, id)): Path<(ProfileId, i64)>,
) -> Res<model::Session> {
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::session_get(conn, pid, id)?.ok_or_else(|| Error::not_found("session", id))
        })
        .await?,
    ))
}

async fn update(
    State(s): State<AppState>,
    Path((pid, id)): Path<(ProfileId, i64)>,
    Json(input): Json<SessionInput>,
) -> Res<model::Session> {
    let input = input.checked()?;
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::session_save(conn, pid, Some(id), &input)
        })
        .await?,
    ))
}

async fn delete(
    State(s): State<AppState>,
    Path((pid, id)): Path<(ProfileId, i64)>,
) -> Result<StatusCode, Error> {
    on_profile(&s, pid, move |conn| db::session_delete(conn, pid, id)).await?;
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
