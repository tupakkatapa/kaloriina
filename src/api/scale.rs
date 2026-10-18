//! Scale sync: openScale sync's webhook, the connection Profile →
//! Connections manages, and the readings.

use super::prelude::*;
use axum::extract::DefaultBodyLimit;
use model::{BindInput, ScaleCounts, ScalePost, ShownReading, SyncStatus, latest_day, now_ms};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/profiles/{pid}/sync/openscale",
            post(webhook)
                .layer(DefaultBodyLimit::max(model::SCALE_BYTES_MAX))
                .get(status)
                .put(bind)
                .delete(disconnect),
        )
        .route("/api/profiles/{pid}/scale", get(readings))
}

/// openScale sync's POST. Only a body that isn't a JSON object is refused:
/// openScale retries anything but 2xx, so a bad item is skipped and counted
/// instead. The answer is counts, never data.
async fn webhook(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    JsonBytes(body): JsonBytes,
) -> Res<ScaleCounts> {
    let post = ScalePost::read(&body, &s.tz, latest_day(&s.tz))?;
    drop(body);
    let tz = s.tz.clone();
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::scale_apply(conn, pid, &post, now_ms(), &tz)
        })
        .await?,
    ))
}

async fn status(State(s): State<AppState>, Path(pid): Path<ProfileId>) -> Res<SyncStatus> {
    Ok(Json(
        on_profile(&s, pid, move |conn| db::sync_status(conn, pid)).await?,
    ))
}

/// Bind (or rebind) one of the openScale users seen.
async fn bind(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Json(b): Json<BindInput>,
) -> Res<SyncStatus> {
    let tz = s.tz.clone();
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::sync_bind(conn, pid, b.user_id, now_ms(), &tz)
        })
        .await?,
    ))
}

async fn disconnect(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
) -> Result<StatusCode, Error> {
    on_profile(&s, pid, move |conn| db::sync_disconnect(conn, pid)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn readings(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Query(r): Query<Range>,
) -> Res<Vec<ShownReading>> {
    r.checked()?;
    let tz = s.tz.clone();
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::scale_shown(conn, pid, r.from.as_deref(), r.to.as_deref(), &tz)
        })
        .await?,
    ))
}
