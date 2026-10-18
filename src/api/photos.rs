//! Photos on a day and group (ADR 0022). The upload is the image itself,
//! not JSON: a raw JPEG body (any other type is 415, so a cross-site form
//! still can't post one), its place in the query. Served by the photo's
//! random `uid`, which a restore can't hand out again, and revalidated on
//! every view, so a deleted photo 404s. Online only: the client never
//! queues one.

use axum::body::Bytes;
use axum::extract::DefaultBodyLimit;

use super::prelude::*;
use model::{Photo, PhotoInput, PhotoMime};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/profiles/{pid}/photos",
            post(upload).layer(DefaultBodyLimit::max(model::PHOTO_BYTES_MAX)),
        )
        .route("/api/profiles/{pid}/photos/{uid}", get(read).delete(remove))
}

async fn upload(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Query(input): Query<PhotoInput>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<(StatusCode, Json<Photo>), Error> {
    let mime = media_type(&headers)
        .and_then(|t| PhotoMime::parse(&t))
        .ok_or_else(|| {
            Error::UnsupportedMedia(format!("send the photo as {}", PhotoMime::choices()))
        })?;
    let input = input.checked()?;
    model::checked_image(mime, &body)?;
    on_profile(&s, pid, move |conn| {
        db::photo_insert(conn, pid, &input, mime, &body, model::PHOTO_BYTES_TOTAL_MAX)
    })
    .await
    .map(created)
}

/// The photo's bytes, revalidated on every view: its `uid` is its `ETag`
/// (a photo never changes), so an unchanged one is a 304.
async fn read(
    State(s): State<AppState>,
    Path((pid, uid)): Path<(ProfileId, String)>,
    headers: HeaderMap,
) -> Result<Response, Error> {
    let tag = format!("\"{uid}\"");
    let (mime, bytes) = on_profile(&s, pid, move |conn| {
        db::photo_bytes(conn, pid, &uid)?.ok_or_else(|| Error::not_found("photo", uid))
    })
    .await?;
    let cache = [
        (header::CACHE_CONTROL, "private, no-cache".to_owned()),
        (header::ETAG, tag.clone()),
    ];
    let unchanged = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|t| t.trim() == tag));
    if unchanged {
        return Ok((StatusCode::NOT_MODIFIED, cache).into_response());
    }
    Ok((cache, [(header::CONTENT_TYPE, mime.as_str())], bytes).into_response())
}

async fn remove(
    State(s): State<AppState>,
    Path((pid, uid)): Path<(ProfileId, String)>,
) -> Result<StatusCode, Error> {
    on_profile(&s, pid, move |conn| db::photo_delete(conn, pid, &uid)).await?;
    Ok(StatusCode::NO_CONTENT)
}
