//! A profile out to one file and back in.

use super::prelude::*;
use axum::extract::DefaultBodyLimit;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/profiles/{pid}/export", get(export))
        .route(
            "/api/profiles/import",
            post(import).layer(DefaultBodyLimit::max(model::IMPORT_BYTES_MAX)),
        )
}

/// The profile as one JSON file (format v1), saved as
/// `kaloriina-<name>-<day>.json`: an ASCII `filename`, the name as spelt in
/// `filename*`.
async fn export(State(s): State<AppState>, Path(pid): Path<ProfileId>) -> Result<Response, Error> {
    let file = on_profile(&s, pid, move |conn| db::profile_export(conn, pid)).await?;
    let day = file.exported_at.get(..10).unwrap_or("export");
    let name = &file.profile.name;
    let disposition = format!(
        "attachment; filename=\"{}\"; filename*=UTF-8''{}",
        model::export_filename(name, day),
        model::export_filename_utf8(name, day)
    );
    // Both names are ASCII by construction, so this always holds.
    let disposition = HeaderValue::try_from(disposition)
        .map_err(|e| Error::Internal(format!("export file name: {e}")))?;
    Ok(([(header::CONTENT_DISPOSITION, disposition)], Json(file)).into_response())
}

#[derive(Deserialize)]
struct ImportQuery {
    /// Keep the file's profile id (when free) and its openScale binding:
    /// the restore path. The app's own import never sends it.
    #[serde(default)]
    restore: bool,
}

/// A new profile from an export: 201 with it, or nothing written. Read
/// typed from the body's bytes, header first (see
/// [`model::ProfileExport::read`]).
async fn import(
    State(s): State<AppState>,
    Query(q): Query<ImportQuery>,
    JsonBytes(body): JsonBytes,
) -> Created<model::Profile> {
    let file = model::ProfileExport::read(&body)?;
    drop(body);
    let checked = file.checked(&s.today())?;
    let profile = on_db(&s, move |conn| {
        db::profile_import(conn, &checked, q.restore)
    })
    .await?;
    Ok(created(profile))
}
