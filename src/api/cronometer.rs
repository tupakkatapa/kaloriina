//! Cronometer history imported from the app: the `kaloriina import`
//! importer behind a route. The files travel as JSON strings, so the write
//! keeps the JSON-only CSRF guard. Its rows can be matched to a food.

use super::prelude::*;
use crate::import;
use axum::extract::DefaultBodyLimit;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/profiles/{pid}/import/cronometer",
            post(cronometer).layer(DefaultBodyLimit::max(model::IMPORT_BYTES_MAX)),
        )
        .route("/api/profiles/{pid}/imported/match", post(imported_match))
}

/// The export's two files, as text; at least one.
#[derive(Deserialize)]
struct Files {
    servings: Option<String>,
    summary: Option<String>,
}

/// Replace the profile's imported history on every day the files cover,
/// all or nothing; the profile's own entries stay.
async fn cronometer(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    permit: ImportPermit,
    Json(files): Json<Files>,
) -> Res<import::Report> {
    if files.servings.is_none() && files.summary.is_none() {
        return Err(Error::invalid(
            "choose servings.csv, dailysummary.csv or both",
        ));
    }
    let db = s.db.clone();
    let report = import_work(permit, move || {
        // Up to 64 MiB of CSV: read off the lock, which only the write takes.
        let parsed = import::read(
            files.servings.as_deref().map(str::as_bytes),
            files.summary.as_deref().map(str::as_bytes),
        )?;
        drop(files);
        let mut conn = db.lock().unwrap_or_else(PoisonError::into_inner);
        owner(&conn, pid)?;
        db::cronometer_apply(&mut conn, pid, parsed)
    })
    .await?;
    Ok(Json(report))
}

/// Imported rows of one name, and the food they are.
#[derive(Deserialize)]
struct Match {
    name: String,
    food_id: i64,
}

/// Match the profile's imported rows of a name, on every day, to a food
/// (`db::imported_match`); a re-import keeps the match.
async fn imported_match(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Json(m): Json<Match>,
) -> Res<model::import::MatchReport> {
    let name = model::text(&m.name, "name", model::NAME_MAX)?;
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::imported_match(conn, pid, &name, m.food_id)
        })
        .await?,
    ))
}
