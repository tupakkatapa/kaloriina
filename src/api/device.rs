//! Health Connect sync: the Android companion's POST, its status for Profile →
//! Connections, the device days it stored, and what happens to device workouts
//! (the mode, what waits, Add and Dismiss); its raw records (an archive,
//! ADR 0019); naps logged by hand; a Google Health import, and its removal.

use super::prelude::*;
use crate::google_health;
use axum::extract::DefaultBodyLimit;
use model::{
    DeviceDays, HealthCounts, HealthPost, HealthStatus, ImportCounts, PendingActivity, RawCounts,
    RecordsPost, WorkoutsMode, is_key, latest_day, now_ms,
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
            "/api/profiles/{pid}/sync/health/records",
            post(records).layer(DefaultBodyLimit::max(model::HEALTH_BYTES_MAX)),
        )
        .route(
            "/api/profiles/{pid}/sync/health/workouts",
            get(pending).put(set_mode),
        )
        .route(
            "/api/profiles/{pid}/sync/health/workouts/{key}",
            post(add).delete(dismiss),
        )
        .route("/api/profiles/{pid}/device-days", get(list))
        .route("/api/profiles/{pid}/naps", post(nap_create))
        .route(
            "/api/profiles/{pid}/naps/{uid}",
            axum::routing::delete(nap_delete),
        )
        .route(
            "/api/profiles/{pid}/import/google-health",
            post(import_google_health)
                .layer(DefaultBodyLimit::max(model::IMPORT_BYTES_MAX))
                .delete(remove_google_health),
        )
}

/// Log a nap by hand (+ Log → Nap); a repeated `uid` returns the nap.
async fn nap_create(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Json(input): Json<model::NapInput>,
) -> Created<model::Nap> {
    let input = input.checked()?;
    let nap = on_profile(&s, pid, move |conn| db::nap_insert(conn, pid, &input)).await?;
    Ok(created(nap))
}

async fn nap_delete(
    State(s): State<AppState>,
    Path((pid, uid)): Path<(ProfileId, String)>,
) -> Result<StatusCode, Error> {
    on_profile(&s, pid, move |conn| db::nap_delete(conn, pid, &uid)).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The export's files the browser picked out of the Takeout zip.
#[derive(Deserialize)]
struct Export {
    files: Vec<google_health::File>,
}

/// Fill the profile's gaps from a Google Health export; again changes
/// nothing. Time series fall on days in the server's time zone. The export
/// is read off the database lock; its raw rows are kept in batches as they
/// are read, the database free between them, then the days fill in one
/// transaction. A client that gives up doesn't cut it short.
async fn import_google_health(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    permit: ImportPermit,
    Json(export): Json<Export>,
) -> Res<ImportCounts> {
    let (db, tz) = (s.db.clone(), s.tz.clone());
    let counts = import_work(permit, move || {
        let conn = || db.lock().unwrap_or_else(PoisonError::into_inner);
        owner(&conn(), pid)?;
        let (read, records) = google_health::read(&export.files, &tz, &mut |rows| {
            google_health::keep_raw(&mut conn(), pid, rows)
        })?;
        let mut counts = google_health::fill(&mut conn(), pid, &read)?;
        counts.records = records;
        Ok(counts)
    })
    .await?;
    Ok(Json(counts))
}

/// Remove what Google Health imports brought (ADR 0019 raw rows too); the
/// device's and the hand's stay. Waits for an import that runs.
async fn remove_google_health(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
) -> Result<StatusCode, Error> {
    let turn = s
        .imports
        .clone()
        .acquire_owned()
        .await
        .map_err(|e| Error::Internal(format!("import turn: {e}")))?;
    on_profile(&s, pid, move |conn| {
        let _turn = turn;
        db::google_import_delete(conn, pid).map(drop)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Keep a page of the phone's raw records (upserted, no window); the days
/// it names are made again from them (nights, resting energy). The sync's
/// status stays. The answer is counts.
async fn records(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Json(body): Json<Value>,
) -> Res<RawCounts> {
    let post = RecordsPost::read(&body, &s.tz)?;
    drop(body);
    let tz = s.tz.clone();
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::records_put(conn, pid, &post, now_ms(), &tz)
        })
        .await?,
    ))
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
    let tz = s.tz.clone();
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::device_replace(conn, pid, &post, now_ms(), &tz)
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
    let tz = s.tz.clone();
    on_profile(&s, pid, move |conn| {
        db::device_delete(conn, pid, now_ms(), &tz)
    })
    .await?;
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

/// Every device workout waiting for Add or Dismiss, on any day.
async fn pending(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
) -> Res<Vec<PendingActivity>> {
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::pending_activity_list(conn, pid, None)
        })
        .await?,
    ))
}

/// A device workout key from the path: never queried unless well formed.
fn checked_key(key: &str) -> Result<(), Error> {
    if is_key(key) {
        Ok(())
    } else {
        Err(Error::not_found("device_workout", ""))
    }
}

async fn add(
    State(s): State<AppState>,
    Path((pid, key)): Path<(ProfileId, String)>,
) -> Created<model::Activity> {
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
) -> Res<DeviceDays> {
    r.checked()?;
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::device_day_list(conn, pid, r.from.as_deref(), r.to.as_deref())
        })
        .await?,
    ))
}
