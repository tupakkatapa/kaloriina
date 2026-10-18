//! JSON API under `/api` plus the embedded web UI.
//!
//! - **Areas:** each module serves one area and lists its own routes
//!   (`routes()`); a new area is a module and one `merge` here.
//! - **Writes:** a browser's write from another site is refused once, on
//!   every route (`same_origin`, 403 `cross_site`). Behind it, every
//!   POST/PUT/PATCH with a body takes it as `Json`, so axum answers non-JSON
//!   requests with 415 (a cross-site form can't send JSON); a photo upload
//!   takes an image body, any other type 415 alike. GETs never write.
//! - **Contract:** creates answer 201 and, given a client `uid`, are safe to
//!   retry; updates of whole entities carry the `rev` they were made from
//!   (409 `stale` otherwise); every error is `{error, code, field?,
//!   resource?}` (see `IntoResponse for Error`).
//! - **Database:** handlers run their queries off the async workers
//!   (`on_db`), holding the one connection only while they do.

/// What the area modules share: each starts with `use super::prelude::*`.
mod prelude {
    pub(super) use std::hash::{DefaultHasher, Hash, Hasher};
    pub(super) use std::sync::PoisonError;

    pub(super) use axum::body::{Body, to_bytes};
    pub(super) use axum::extract::{MatchedPath, Path, Query, State};
    pub(super) use axum::http::uri::Authority;
    pub(super) use axum::http::{HeaderMap, HeaderValue, Method, Request, StatusCode, Uri, header};
    pub(super) use axum::middleware::{Next, from_fn, from_fn_with_state, map_response};
    pub(super) use axum::response::{IntoResponse, Response};
    pub(super) use axum::routing::{any, get, post};
    pub(super) use axum::{Json, Router};
    pub(super) use include_dir::{Dir, include_dir};
    pub(super) use rusqlite::Connection;
    pub(super) use serde::{Deserialize, Serialize};
    pub(super) use serde_json::{Value, json};
    pub(super) use tower_http::compression::CompressionLayer;
    pub(super) use tower_http::timeout::RequestBodyTimeoutLayer;
    pub(super) use tower_http::trace::{DefaultOnResponse, TraceLayer};
    pub(super) use tracing::Level;

    pub(super) use crate::db;
    pub(super) use crate::dri;
    pub(super) use crate::error::Error;
    pub(super) use crate::model::{
        self, ActivityInput, EntryInput, EntryPatch, ExerciseInput, FoodInput, GROUPS, MealInput,
        ProfileId, ProfileInput, RecipeInput, Source, Target, TargetsInput, WeightInput,
        WorkoutInput, checked_barcode, is_date,
    };
    pub(super) use crate::nutrients::{self, Nutrients, REGISTRY};
    pub(super) use crate::off::Lookup;
    pub(super) use crate::{AppState, off};

    pub(super) use super::{
        Created, ImportPermit, JsonBytes, Range, Replace, Res, WEB, checked_date, created,
        import_work, media_type, on_db, on_profile, owner,
    };
}

use prelude::*;

pub use backups::{newest_backup, stale_backup};
pub(crate) use hooks::{HOOK_TIMEOUT, hook_client};

mod activities;
mod backups;
mod cronometer;
mod device;
mod diary;
mod feedback;
mod foods;
mod habits;
mod hooks;
mod meta;
mod photos;
mod profiles;
mod reports;
mod scale;
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
        .merge(activities::routes())
        .merge(reports::routes())
        .merge(transfer::routes())
        .merge(cronometer::routes())
        .merge(habits::routes())
        .merge(hooks::routes())
        .merge(scale::routes())
        .merge(device::routes())
        .merge(backups::routes())
        .merge(photos::routes())
        .merge(feedback::routes())
        .route(
            "/api/{*rest}",
            any(|| async { Error::not_found("route", "") }),
        )
        .layer(map_response(json_errors))
        .layer(map_response(build_header))
        .layer(from_fn(same_origin));
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
        // A body that stops arriving (a phone gone off the network) ends
        // the request instead of holding it, and a stop, open.
        .layer(RequestBodyTimeoutLayer::new(BODY_STALL_MAX))
        .layer(trace)
        .layer(from_fn(nosniff))
        .layer(CompressionLayer::new())
        .layer(from_fn_with_state(state.clone(), known_host))
        .with_state(state)
}

/// The longest a request body may pause between parts.
const BODY_STALL_MAX: std::time::Duration = std::time::Duration::from_mins(1);

/// Every API answer names the build that served it (the hash the app's
/// files are served under), so a page left open across an upgrade can tell
/// it is stale.
async fn build_header(mut res: Response) -> Response {
    if let Ok(v) = HeaderValue::from_str(web::build_hash()) {
        res.headers_mut().insert("x-kaloriina-build", v);
    }
    res
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

/// The body's media type from its `Content-Type`, lower-case and without
/// parameters.
fn media_type(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .map(|t| t.trim().to_ascii_lowercase())
}

/// A JSON request body as its bytes, for routes that read a big body in
/// parts (profile import, the scale webhook) instead of as one tree. Any
/// other content type is 415, as `Json` answers.
struct JsonBytes(axum::body::Bytes);

impl<S: Send + Sync> axum::extract::FromRequest<S> for JsonBytes {
    type Rejection = Response;

    async fn from_request(req: Request<Body>, state: &S) -> Result<Self, Response> {
        let json = media_type(req.headers()).is_some_and(|t| {
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

/// A whole-entity update: PUT replaces, so every field `T` reads must be
/// present (`null` where it may be). A missing one is 400 `invalid` naming
/// it, never a reset to its default: "missing = keep" is PATCH, and can't
/// say "clear". Creates keep their defaults (plain `Json`).
struct Replace<T>(T);

/// An input a PUT replaces whole.
trait Whole: serde::de::DeserializeOwned {
    /// The keys an update may leave out: create-only or gone ones.
    const OPTIONAL: &'static [&'static str] = &[];

    /// The keys it reads. A `flatten`ed struct reads a map, so names none
    /// here: it lists its own.
    fn fields() -> Vec<&'static str> {
        field_names::<Self>().to_vec()
    }
}

// `uid` is a create's retry key: an update leaves it out.
impl Whole for WorkoutInput {
    const OPTIONAL: &'static [&'static str] = &["uid"];
}
impl Whole for FoodInput {
    /// Left out, the server derives them.
    const OPTIONAL: &'static [&'static str] = &["drink", "uid"];
}
impl Whole for RecipeInput {
    const OPTIONAL: &'static [&'static str] = &["uid"];
}
impl Whole for MealInput {
    const OPTIONAL: &'static [&'static str] = &["uid"];
}
impl Whole for model::HabitInput {
    const OPTIONAL: &'static [&'static str] = &["day_limit", "uid"];
}
impl Whole for ActivityInput {
    const OPTIONAL: &'static [&'static str] = &["uid"];
}
impl Whole for ExerciseInput {
    fn fields() -> Vec<&'static str> {
        let own = ["name", "measure", "variant_of", "rev"];
        own.into_iter()
            .chain(field_names::<model::ExerciseTraits>().iter().copied())
            .collect()
    }
}
impl Whole for ProfileInput {
    fn fields() -> Vec<&'static str> {
        ["name", "rev"]
            .into_iter()
            .chain(field_names::<model::Body>().iter().copied())
            .collect()
    }
}

impl<S: Send + Sync, T: Whole> axum::extract::FromRequest<S> for Replace<T> {
    type Rejection = Response;

    async fn from_request(req: Request<Body>, state: &S) -> Result<Self, Response> {
        let JsonBytes(bytes) = JsonBytes::from_request(req, state).await?;
        // Not an object: `Json` says what's wrong with it.
        if let Ok(Value::Object(body)) = serde_json::from_slice::<Value>(&bytes)
            && let Some(f) = T::fields()
                .into_iter()
                .find(|f| !T::OPTIONAL.contains(f) && !body.contains_key(*f))
        {
            return Err(Error::invalid_field(f, format!("{f} is required")).into_response());
        }
        Json::<T>::from_bytes(&bytes)
            .map(|Json(t)| Self(t))
            .map_err(IntoResponse::into_response)
    }
}

/// The keys serde reads for struct `T`, as its derive declares them; none
/// for a struct with a `flatten`ed field (that reads a map).
fn field_names<T: serde::de::DeserializeOwned>() -> &'static [&'static str] {
    use serde::de::{Error as _, Visitor, value::Error as DeError};

    /// Hears the field list `deserialize_struct` is given, then stops.
    struct Names<'a>(&'a mut &'static [&'static str]);

    impl<'de> serde::Deserializer<'de> for Names<'_> {
        type Error = DeError;

        fn deserialize_any<V: Visitor<'de>>(self, _: V) -> Result<V::Value, DeError> {
            Err(DeError::custom("not a struct"))
        }

        fn deserialize_struct<V: Visitor<'de>>(
            self,
            _: &'static str,
            fields: &'static [&'static str],
            _: V,
        ) -> Result<V::Value, DeError> {
            *self.0 = fields;
            Err(DeError::custom("names only"))
        }

        serde::forward_to_deserialize_any! {
            bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string
            bytes byte_buf option unit unit_struct newtype_struct seq tuple
            tuple_struct map enum identifier ignored_any
        }
    }

    let mut names: &'static [&'static str] = &[];
    // Always an error: only the names it heard are wanted.
    let _ = T::deserialize(Names(&mut names));
    names
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

/// The instance's one import permit (`AppState::imports`), taken before
/// the body is read: a second import is 503 `busy` instead of a second
/// 64 MiB body in memory.
struct ImportPermit(tokio::sync::OwnedSemaphorePermit);

impl axum::extract::FromRequestParts<AppState> for ImportPermit {
    type Rejection = Response;

    async fn from_request_parts(
        _: &mut axum::http::request::Parts,
        s: &AppState,
    ) -> Result<Self, Response> {
        s.imports
            .clone()
            .try_acquire_owned()
            .map(Self)
            .map_err(|_| busy("Another import is running"))
    }
}

/// Run an import's work (read, then write) on a blocking thread that holds
/// `permit` until the work ends: a client that gives up cuts neither short.
async fn import_work<T, F>(permit: ImportPermit, f: F) -> Result<T, Error>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, Error> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let ImportPermit(_held) = permit;
        f()
    })
    .await
    .map_err(|e| Error::Internal(format!("import task failed: {e}")))?
}

/// 404 unless profile `pid` exists.
fn owner(conn: &Connection, pid: ProfileId) -> Result<model::Profile, Error> {
    db::profile_get(conn, pid)?.ok_or_else(|| Error::not_found("profile", pid.0))
}

fn checked_date(s: &str) -> Result<&str, Error> {
    if is_date(s) {
        Ok(s)
    } else {
        Err(Error::invalid("date must be a real date (YYYY-MM-DD)"))
    }
}

/// Query parameter `field`, if given, as a date.
fn query_date<'a>(value: Option<&'a str>, field: &str) -> Result<Option<&'a str>, Error> {
    value
        .map(|d| {
            checked_date(d).map_err(|_| {
                Error::invalid_field(field, format!("{field} must be a real date (YYYY-MM-DD)"))
            })
        })
        .transpose()
}

/// A range of days, either end open.
#[derive(Deserialize)]
struct Range {
    from: Option<String>,
    to: Option<String>,
}

impl Range {
    fn checked(&self) -> Result<(Option<&str>, Option<&str>), Error> {
        let from = query_date(self.from.as_deref(), "from")?;
        let to = query_date(self.to.as_deref(), "to")?;
        if let (Some(f), Some(t)) = (from, to)
            && f > t
        {
            return Err(Error::invalid_field("from", "from must not be after to"));
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
        if let Some(res) = storage_error(&self) {
            tracing::warn!(error = %self, "request refused");
            return res;
        }
        let (status, code) = match &self {
            Self::Invalid { .. } => (StatusCode::BAD_REQUEST, "invalid"),
            Self::NotFound { .. } => (StatusCode::NOT_FOUND, "not_found"),
            Self::Conflict { kind, .. } => (StatusCode::CONFLICT, kind.code()),
            Self::Upstream(_) => (StatusCode::BAD_GATEWAY, "unavailable"),
            Self::UnsupportedMedia(_) => {
                (StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type")
            }
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

/// 503 `busy`: nothing was done; the same request may succeed in a while
/// (the app's outbox waits for it without counting a try).
fn busy(message: &str) -> Response {
    let mut res = error_body(
        StatusCode::SERVICE_UNAVAILABLE,
        json!({ "error": message, "code": "busy" }),
    );
    res.headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from_static("30"));
    res
}

/// What the database said when it couldn't do the work, in words: locked
/// by another process (an import), or out of disk.
fn storage_error(e: &Error) -> Option<Response> {
    use rusqlite::ErrorCode;
    let Error::Db(rusqlite::Error::SqliteFailure(e, _)) = e else {
        return None;
    };
    let storage = |message: &str| {
        error_body(
            StatusCode::INSUFFICIENT_STORAGE,
            json!({ "error": message, "code": "storage" }),
        )
    };
    match e.code {
        ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => Some(busy(
            "The database is busy (an import is running). Try again.",
        )),
        ErrorCode::DiskFull => Some(storage(
            "The server's disk is full: new changes can't be saved",
        )),
        ErrorCode::SystemIoFailure => Some(storage(
            "The server can't write to its disk (full or failing)",
        )),
        _ => None,
    }
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
        Some(bare_host(authority.host()))
    });
    host.map_or(HostName::Bad, HostName::Host)
}

/// A host as compared: lower-case, an IPv6 address without its brackets.
fn bare_host(host: &str) -> String {
    host.strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host)
        .to_ascii_lowercase()
}

/// Refuse a write a browser sends from another site's page (CSRF): its
/// `Sec-Fetch-Site` says so, or its `Origin` is opaque (`null`) or names
/// another host than the request's. Clients that send neither header (the
/// phone, openScale's sync, the CLI) pass. A proxy in front must pass
/// `Host` through.
async fn same_origin(req: Request<Body>, next: Next) -> Response {
    let read = matches!(*req.method(), Method::GET | Method::HEAD);
    if read || !cross_site(&req) {
        return next.run(req).await;
    }
    error_body(
        StatusCode::FORBIDDEN,
        json!({
            "error": "Changes come only from the app's own pages",
            "code": "cross_site",
        }),
    )
}

fn cross_site(req: &Request<Body>) -> bool {
    let header = |name| req.headers().get(name).map(|v| v.to_str().unwrap_or(""));
    if header("sec-fetch-site").is_some_and(|site| !matches!(site, "same-origin" | "none")) {
        return true;
    }
    let Some(origin) = header(header::ORIGIN.as_str()) else {
        return false;
    };
    let origin = (origin != "null")
        .then(|| origin.parse::<Uri>().ok())
        .flatten()
        .and_then(|u| u.host().map(bare_host));
    match (host_of(req), origin) {
        (HostName::Host(host), Some(origin)) => host != origin,
        _ => true,
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failing_disk_is_named() {
        let io = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_IOERR_WRITE),
            None,
        );
        let res = Error::Db(io).into_response();
        assert_eq!(res.status(), StatusCode::INSUFFICIENT_STORAGE);
    }
}
