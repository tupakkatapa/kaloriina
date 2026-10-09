//! JSON API under `/api` plus the embedded web UI.
//!
//! - **Areas:** each module serves one area and lists its own routes
//!   (`routes()`); a new area is a module and one `merge` here.
//! - **Writes:** every POST/PUT/PATCH takes a `Json` body, so axum answers
//!   non-JSON requests with 415 (a cross-site form can't send JSON). DELETE
//!   has no body, but a cross-site DELETE needs a CORS preflight, and no CORS
//!   headers are served. GETs never write.
//! - **Contract:** creates answer 201 and, given a client `uid`, are safe to
//!   retry; updates of whole entities carry the `rev` they were made from
//!   (409 `stale` otherwise); every error is `{error, code, field?,
//!   resource?}` (see `IntoResponse for Error`).
//! - **Database:** handlers run their queries off the async workers
//!   (`on_db`), holding the one connection only while they do.

/// What the area modules share: each starts with `use super::prelude::*`.
mod prelude {
    pub(super) use std::collections::BTreeMap;
    pub(super) use std::hash::{DefaultHasher, Hash, Hasher};
    pub(super) use std::sync::PoisonError;

    pub(super) use axum::body::{Body, to_bytes};
    pub(super) use axum::extract::{MatchedPath, Path, Query, State};
    pub(super) use axum::http::uri::Authority;
    pub(super) use axum::http::{HeaderMap, HeaderValue, Request, StatusCode, Uri, header};
    pub(super) use axum::middleware::{Next, from_fn, from_fn_with_state, map_response};
    pub(super) use axum::response::{IntoResponse, Response};
    pub(super) use axum::routing::{any, get, post};
    pub(super) use axum::{Json, Router};
    pub(super) use include_dir::{Dir, include_dir};
    pub(super) use rusqlite::Connection;
    pub(super) use serde::{Deserialize, Serialize};
    pub(super) use serde_json::{Value, json};
    pub(super) use tower_http::compression::CompressionLayer;
    pub(super) use tower_http::trace::{DefaultOnResponse, TraceLayer};
    pub(super) use tracing::Level;

    pub(super) use crate::db;
    pub(super) use crate::dri;
    pub(super) use crate::error::Error;
    pub(super) use crate::model::{
        self, EntryInput, EntryPatch, ExerciseInput, FoodInput, GROUPS, MealInput, ProfileId,
        ProfileInput, RecipeInput, SessionInput, Source, Target, TargetsInput, WeightInput,
        WorkoutInput, checked_barcode, is_date,
    };
    pub(super) use crate::nutrients::{self, Nutrients, REGISTRY};
    pub(super) use crate::off::Lookup;
    pub(super) use crate::{AppState, off};

    pub(super) use super::{
        Created, JsonBytes, Range, Res, WEB, checked_date, created, on_db, on_profile, owner,
    };
}

use prelude::*;

pub use backups::newest_backup;

mod activity;
mod backups;
mod cronometer;
mod diary;
mod foods;
mod habits;
mod meta;
mod profiles;
mod reports;
mod scale;
mod sessions;
mod transfer;
mod web;
mod workouts;

type Res<T> = Result<Json<T>, Error>;
/// A create: 201 with what was stored.
type Created<T> = Result<(StatusCode, Json<T>), Error>;

fn created<T>(value: T) -> (StatusCode, Json<T>) {
    (StatusCode::CREATED, Json(value))
}

static WEB: Dir = include_dir!("$CARGO_MANIFEST_DIR/web");

/// Build the application router.
pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .merge(meta::routes())
        .merge(profiles::routes())
        .merge(diary::routes())
        .merge(foods::routes())
        .merge(workouts::routes())
        .merge(sessions::routes())
        .merge(reports::routes())
        .merge(transfer::routes())
        .merge(cronometer::routes())
        .merge(habits::routes())
        .merge(scale::routes())
        .merge(activity::routes())
        .merge(backups::routes())
        .route(
            "/api/{*rest}",
            any(|| async { Error::not_found("API route", "") }),
        )
        .layer(map_response(json_errors));
    // One INFO line per request: the method and the route's pattern
    // (`/api/profiles/{pid}/day/{date}`), never the filled-in path or query:
    // those carry diary dates, barcodes and search words.
    let trace = TraceLayer::new_for_http()
        .make_span_with(|req: &Request<Body>| {
            let route = req
                .extensions()
                .get::<MatchedPath>()
                .map_or("static", MatchedPath::as_str);
            tracing::info_span!("request", method = %req.method(), route = %route)
        })
        .on_response(DefaultOnResponse::new().level(Level::INFO));
    api.fallback(get(web::static_file))
        .layer(trace)
        .layer(from_fn(nosniff))
        .layer(CompressionLayer::new())
        .layer(from_fn_with_state(state.clone(), known_host))
        .with_state(state)
}

/// Every response, JSON included, is taken for the type it says it is, and
/// no link sends the server's name on.
async fn nosniff(req: Request<Body>, next: Next) -> Response {
    let mut res = next.run(req).await;
    let headers = res.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    res
}

/// A JSON request body as its bytes, for routes that read a big body in
/// parts (profile import, the scale webhook) instead of as one tree. Any
/// other content type is 415, as `Json` answers.
struct JsonBytes(axum::body::Bytes);

impl<S: Send + Sync> axum::extract::FromRequest<S> for JsonBytes {
    type Rejection = Response;

    async fn from_request(req: Request<Body>, state: &S) -> Result<Self, Response> {
        let json = req
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(';').next())
            .map(|t| t.trim().to_ascii_lowercase())
            .is_some_and(|t| {
                t == "application/json" || (t.starts_with("application/") && t.ends_with("+json"))
            });
        if !json {
            return Err(StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response());
        }
        axum::body::Bytes::from_request(req, state)
            .await
            .map(Self)
            .map_err(IntoResponse::into_response)
    }
}

/// Run `f` on the database on a blocking thread, holding the connection
/// only while it runs, so slow queries never stall the async workers.
async fn on_db<T, F>(s: &AppState, f: F) -> Result<T, Error>
where
    T: Send + 'static,
    F: FnOnce(&mut Connection) -> Result<T, Error> + Send + 'static,
{
    let db = s.db.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = db.lock().unwrap_or_else(PoisonError::into_inner);
        f(&mut conn)
    })
    .await
    .map_err(|e| Error::Internal(format!("database task failed: {e}")))?
}

/// Like [`on_db`], for a `/profiles/{pid}/…` handler: 404 unless the
/// profile exists.
async fn on_profile<T, F>(s: &AppState, pid: ProfileId, f: F) -> Result<T, Error>
where
    T: Send + 'static,
    F: FnOnce(&mut Connection) -> Result<T, Error> + Send + 'static,
{
    on_db(s, move |conn| {
        owner(conn, pid)?;
        f(conn)
    })
    .await
}

/// 404 unless profile `pid` exists.
fn owner(conn: &Connection, pid: ProfileId) -> Result<model::Profile, Error> {
    db::profile_get(conn, pid)?.ok_or_else(|| Error::not_found("profile", pid.0))
}

fn checked_date(s: &str) -> Result<&str, Error> {
    if is_date(s) {
        Ok(s)
    } else {
        Err(Error::invalid("date must be YYYY-MM-DD"))
    }
}

/// A range of days, either end open.
#[derive(Deserialize)]
struct Range {
    from: Option<String>,
    to: Option<String>,
}

impl Range {
    fn checked(&self) -> Result<(Option<&str>, Option<&str>), Error> {
        let from = self.from.as_deref().map(checked_date).transpose()?;
        let to = self.to.as_deref().map(checked_date).transpose()?;
        if let (Some(f), Some(t)) = (from, to)
            && f > t
        {
            return Err(Error::invalid("from must not be after to"));
        }
        Ok((from, to))
    }
}

/// Framework rejection bodies are short messages; cap what gets buffered.
const REJECTION_BODY_MAX: usize = 64 * 1024;

/// Every `/api` error body: `{"error": message, "code": stable code}`, plus
/// `field` when one input field is to blame and `resource` for a missing
/// one. Clients branch on `code`/`resource`/`field`, never on the text.
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let (status, code) = match &self {
            Self::Invalid { .. } => (StatusCode::BAD_REQUEST, "invalid"),
            Self::NotFound { .. } => (StatusCode::NOT_FOUND, "not_found"),
            Self::Conflict { kind, .. } => (StatusCode::CONFLICT, kind.code()),
            Self::Upstream(_) => (StatusCode::BAD_GATEWAY, "unavailable"),
            _ => {
                tracing::error!(error = %self, "request failed");
                return error_body(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({ "error": "Internal error", "code": "internal" }),
                );
            }
        };
        let mut body = json!({ "error": sentence(&self.to_string()), "code": code });
        match self {
            Self::Invalid { field: Some(f), .. } => body["field"] = json!(f),
            Self::NotFound { resource, .. } => body["resource"] = json!(resource),
            Self::Conflict { kind, .. } => {
                if let Some(f) = kind.field() {
                    body["field"] = json!(f);
                }
            }
            _ => {}
        }
        error_body(status, body)
    }
}

fn error_body(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

/// Messages are written from the field name ("name must be …"); on the wire
/// they read as a sentence ("Name must be …").
fn sentence(message: &str) -> String {
    let mut chars = message.chars();
    chars
        .next()
        .map_or_else(String::new, |c| c.to_uppercase().chain(chars).collect())
}

/// The error axum itself produced (a body, path or query it couldn't read,
/// a wrong method), in the same shape as ours: a plain 400 `invalid` naming
/// the field where serde says which, never the framework's own wording.
fn rejection(status: StatusCode, text: &str) -> Response {
    let backticked = |after: &str| {
        text.split_once(after)
            .and_then(|(_, rest)| rest.split('`').nth(1))
            .map(str::to_owned)
    };
    let (status, code, message, field) = match status {
        StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY => {
            if let Some(f) = backticked("missing field") {
                let message = format!("{f} is required");
                (StatusCode::BAD_REQUEST, "invalid", message, Some(f))
            } else if let Some(f) = text
                .split_once("target type: ")
                .and_then(|(_, rest)| rest.split_once(": invalid type"))
                .map(|(path, _)| path)
                .filter(|path| *path != ".")
            {
                let message = format!("{f} has the wrong type");
                (
                    StatusCode::BAD_REQUEST,
                    "invalid",
                    message,
                    Some(f.to_owned()),
                )
            } else if text.starts_with("Invalid URL") {
                let message = "an id in the address isn't a number".to_owned();
                (StatusCode::BAD_REQUEST, "invalid", message, None)
            } else {
                // serde's own words after its prefix ("invalid type: …").
                let detail = text.rsplit_once(": ").map_or(text, |(_, d)| d);
                let message = format!("couldn't read the request: {detail}");
                (StatusCode::BAD_REQUEST, "invalid", message, None)
            }
        }
        StatusCode::NOT_FOUND => (status, "not_found", "not found".to_owned(), None),
        StatusCode::METHOD_NOT_ALLOWED => (
            status,
            "method_not_allowed",
            "method not allowed here".to_owned(),
            None,
        ),
        StatusCode::PAYLOAD_TOO_LARGE => {
            (status, "too_large", "request too large".to_owned(), None)
        }
        StatusCode::UNSUPPORTED_MEDIA_TYPE => (
            status,
            "unsupported_media_type",
            "send JSON (Content-Type: application/json)".to_owned(),
            None,
        ),
        s if s.is_server_error() => (s, "internal", "internal error".to_owned(), None),
        s => (s, "invalid", text.to_owned(), None),
    };
    let mut body = json!({ "error": sentence(&message), "code": code });
    if let Some(f) = field {
        body["field"] = json!(f);
    }
    error_body(status, body)
}

/// The host a request names.
enum HostName {
    /// None given (a non-browser client).
    Absent,
    /// Given, but not a host name.
    Bad,
    /// Lower-case, without its port.
    Host(String),
}

/// The `Host` header, or the URI authority (HTTP/2).
fn host_of(req: &Request<Body>) -> HostName {
    let raw = req
        .headers()
        .get(header::HOST)
        .map(|h| h.to_str().ok().map(str::to_owned))
        .or_else(|| req.uri().authority().map(|a| Some(a.as_str().to_owned())));
    let Some(raw) = raw else {
        return HostName::Absent;
    };
    let host = raw.and_then(|raw| {
        // `user@host` is no Host header a browser sends.
        let authority: Authority = raw.parse().ok().filter(|_| !raw.contains('@'))?;
        let host = authority.host();
        let host = host
            .strip_prefix('[')
            .and_then(|h| h.strip_suffix(']'))
            .unwrap_or(host);
        Some(host.to_ascii_lowercase())
    });
    host.map_or(HostName::Bad, HostName::Host)
}

/// Refuse requests naming a host other than loopback or an allowed name.
/// A web page re-resolving its own name to this machine (DNS rebinding) is
/// same-origin with the app; only the `Host` it sends gives it away.
/// Requests without any host (non-browser clients) pass.
async fn known_host(State(s): State<AppState>, req: Request<Body>, next: Next) -> Response {
    let allowed = match host_of(&req) {
        HostName::Absent => true,
        HostName::Bad => false,
        HostName::Host(host) => {
            matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1")
                || s.allowed_hosts
                    .iter()
                    .any(|a| a.eq_ignore_ascii_case(&host))
        }
    };
    if allowed {
        next.run(req).await
    } else {
        error_body(
            StatusCode::MISDIRECTED_REQUEST,
            json!({
                "error": "Unknown host name; add it with --allowed-host",
                "code": "bad_host",
            }),
        )
    }
}

async fn json_errors(res: Response) -> Response {
    let status = res.status();
    let is_json = res
        .headers()
        .get(header::CONTENT_TYPE)
        .is_some_and(|v| v.as_bytes().starts_with(b"application/json"));
    if is_json || !(status.is_client_error() || status.is_server_error()) {
        return res;
    }
    let bytes = to_bytes(res.into_body(), REJECTION_BODY_MAX)
        .await
        .unwrap_or_default();
    rejection(status, String::from_utf8_lossy(&bytes).trim())
}
