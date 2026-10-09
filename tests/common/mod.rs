use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use kaloriina::{AppState, Connection, ProfileId, router};

/// The profile migration 3 creates for existing data.
pub const ME: ProfileId = ProfileId(1);
use serde_json::Value;
use tower::ServiceExt;

pub fn app_from(conn: Connection, off_url: &str) -> Router {
    router(AppState::new(conn, off_url.to_owned()))
}

/// Send a request with an explicit content type; the body is parsed as JSON
/// (`Null` when empty or not JSON).
pub async fn raw(
    app: &Router,
    method: &str,
    uri: &str,
    ctype: &str,
    body: &str,
) -> (StatusCode, Value) {
    let req = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, ctype)
        .body(Body::from(body.to_owned()))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// Send JSON (or nothing) and parse the JSON reply.
pub async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let body = body.map(|v| v.to_string()).unwrap_or_default();
    raw(app, method, uri, "application/json", &body).await
}

/// Import `servings.csv` alone, as `kaloriina import` does without a summary.
pub fn import_servings(
    conn: &mut Connection,
    profile: ProfileId,
    reader: impl std::io::Read,
) -> Result<usize, kaloriina::Error> {
    kaloriina::import::import(conn, profile, Some(reader), None::<&[u8]>).map(|r| r.entries)
}

/// Import `dailysummary.csv` alone.
pub fn import_summary(
    conn: &mut Connection,
    profile: ProfileId,
    reader: impl std::io::Read,
) -> Result<kaloriina::import::SummaryReport, kaloriina::Error> {
    kaloriina::import::import(conn, profile, None::<&[u8]>, Some(reader))
        .map(|r| r.summary.expect("a summary was given"))
}
