//! Cross-site writes, the import permit, storage errors and shutdown: the
//! platform's own guards, route by route.

use super::*;
use axum::body::Body;
use axum::http::{Request, header};
use http_body_util::BodyExt;
use kaloriina::{AppState, router};
use tower::ServiceExt;

const WORKOUTS: &str = "/api/profiles/1/sync/health/workouts";

/// Send `body` as `ctype` with extra `headers`; the status and JSON answer.
async fn send(
    app: &Router,
    method: &str,
    uri: &str,
    headers: &[(&str, &str)],
    ctype: &str,
    body: &str,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, ctype);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let res = app
        .clone()
        .oneshot(req.body(Body::from(body.to_owned())).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// An app with the phone's payload synced and its workouts waiting.
async fn app_with_waiting_workouts() -> Router {
    let app = app();
    call(&app, "PUT", WORKOUTS, Some(json!({ "mode": "ask" }))).await;
    let body = include_str!("../fixtures/health/payload.json");
    let (status, res) = common::raw(
        &app,
        "POST",
        "/api/profiles/1/sync/health",
        "application/json",
        body,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
    app
}

#[tokio::test]
async fn a_cross_site_form_post_is_refused() {
    // Adding a waiting workout takes no body, so the JSON-only rule can't
    // stop a form another site posts.
    let app = app_with_waiting_workouts().await;
    let (status, res) = send(
        &app,
        "POST",
        &format!("{WORKOUTS}/a-1"),
        &[
            ("host", "localhost:8080"),
            ("origin", "https://evil.example"),
            ("sec-fetch-site", "cross-site"),
        ],
        "application/x-www-form-urlencoded",
        "x=1",
    )
    .await;
    assert_eq!(
        (status, &res["code"]),
        (StatusCode::FORBIDDEN, &json!("cross_site")),
        "{res}"
    );
    let (_, list) = call(&app, "GET", "/api/profiles/1/activities", None).await;
    assert!(
        list.as_array()
            .unwrap()
            .iter()
            .all(|a| a["source_key"] != "a-1"),
        "{list}"
    );
}

#[tokio::test]
async fn clients_without_browser_headers_and_same_origin_pages_pass() {
    let app = app_with_waiting_workouts().await;
    // The phone, openScale and the CLI send neither header.
    let (status, res) = send(&app, "POST", &format!("{WORKOUTS}/a-1"), &[], "", "").await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    // The app's own page: its Origin names the Host, ports and case aside.
    for (host, origin, site) in [
        (
            "localhost:8080",
            "http://localhost:8080",
            Some("same-origin"),
        ),
        ("LocalHost", "https://localhost:443", None),
        ("[::1]:8080", "http://[::1]:8080", Some("none")),
    ] {
        let mut headers = vec![("host", host), ("origin", origin)];
        if let Some(site) = site {
            headers.push(("sec-fetch-site", site));
        }
        let (status, res) = send(
            &app,
            "POST",
            "/api/feedback",
            &headers,
            "application/json",
            r#"{"kind":"bug","text":"x"}"#,
        )
        .await;
        assert_ne!(status, StatusCode::FORBIDDEN, "{origin}: {res}");
    }
}

#[tokio::test]
async fn a_null_origin_a_foreign_host_or_a_same_site_page_is_refused() {
    let app = app();
    for headers in [
        vec![("host", "localhost:8080"), ("origin", "null")],
        vec![
            ("host", "localhost:8080"),
            ("origin", "http://localhost.evil:8080"),
        ],
        vec![("host", "localhost:8080"), ("sec-fetch-site", "same-site")],
        vec![("origin", "http://localhost:8080")],
    ] {
        let (status, res) = send(
            &app,
            "DELETE",
            "/api/profiles/1/naps/x",
            &headers,
            "application/json",
            "",
        )
        .await;
        assert_eq!(
            (status, &res["code"]),
            (StatusCode::FORBIDDEN, &json!("cross_site")),
            "{headers:?}: {res}"
        );
    }
    // Reads stay open: a cross-site GET can't read the answer anyway.
    let (status, _) = send(
        &app,
        "GET",
        "/api/profiles",
        &[("origin", "null"), ("sec-fetch-site", "cross-site")],
        "",
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

/// The app and its state, for tests that hold its permit or its lock.
fn app_and_state() -> (Router, AppState) {
    let state = AppState::new(open(FsPath::new(":memory:")).unwrap(), NO_OFF.to_owned());
    (router(state.clone()), state)
}

/// Hold `state`'s database lock, as a long write would, until the answer
/// is dropped.
pub(crate) fn hold_db(state: &AppState) -> std::sync::mpsc::Sender<()> {
    let db = state.db.clone();
    let (locked, is_locked) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        let _held = db.lock().unwrap();
        locked.send(()).unwrap();
        // Ends when the sender drops.
        let _ = released.recv();
    });
    is_locked.recv().unwrap();
    release
}

/// A profile export, read from `app`, under a name the instance hasn't.
async fn exported(app: &Router) -> Value {
    let (status, mut file) = call(app, "GET", "/api/profiles/1/export", None).await;
    assert_eq!(status, StatusCode::OK, "{file}");
    file["profile"]["name"] = json!("Restored");
    file
}

#[tokio::test]
async fn a_second_import_is_busy_while_one_runs() {
    // Each import holds up to 64 MiB: two at once don't fit the service's
    // memory, so the second is refused before its body is read.
    let (app, state) = app_and_state();
    let file = exported(&app).await;
    let running = state.imports.clone().try_acquire_owned().unwrap();
    for (uri, body) in [
        ("/api/profiles/import", file.clone()),
        (
            "/api/profiles/1/import/cronometer",
            json!({ "summary": "Date\n" }),
        ),
        (
            "/api/profiles/1/import/google-health",
            json!({ "files": [] }),
        ),
    ] {
        let req = Request::builder()
            .method("POST")
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE, "{uri}");
        assert_eq!(res.headers()[header::RETRY_AFTER], "30", "{uri}");
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let res: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            res,
            json!({ "code": "busy", "error": "Another import is running" }),
            "{uri}"
        );
    }
    drop(running);
    let (status, res) = call(&app, "POST", "/api/profiles/import", Some(file)).await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
}

#[tokio::test]
async fn a_dropped_import_keeps_the_permit_until_its_work_ends() {
    // The client gives up while the import waits for the database: the
    // work goes on, and so does its hold on the memory budget.
    let (app, state) = app_and_state();
    let file = exported(&app).await;
    let held = hold_db(&state);
    let dropped = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        call(&app, "POST", "/api/profiles/import", Some(file)),
    )
    .await;
    assert!(dropped.is_err(), "the import didn't wait for the lock");
    assert!(
        state.imports.clone().try_acquire_owned().is_err(),
        "the permit went with the request"
    );
    drop(held);
    let permit = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        state.imports.clone().acquire_owned(),
    )
    .await
    .expect("the work ended")
    .unwrap();
    drop(permit);
    let (_, profiles) = call(&app, "GET", "/api/profiles", None).await;
    assert_eq!(profiles.as_array().unwrap().len(), 2, "{profiles}");
}

#[tokio::test]
async fn a_locked_database_answers_busy() {
    // `kaloriina fineli` (another process) holds the write lock past the
    // busy timeout: the write is told to retry, not "Internal error".
    let dir = std::env::temp_dir().join(format!("kaloriina-busy-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("db");
    let app = app_from(open(&path).unwrap(), NO_OFF);
    let other = kaloriina::Connection::open(&path).unwrap();
    other.execute_batch("BEGIN IMMEDIATE").unwrap();
    let (status, res) = call(
        &app,
        "POST",
        "/api/feedback",
        Some(json!({ "kind": "bug", "text": "x" })),
    )
    .await;
    assert_eq!(
        (status, res),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "code": "busy",
                    "error": "The database is busy (an import is running). Try again." })
        )
    );
    other.execute_batch("ROLLBACK").unwrap();
    drop(other);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn a_full_disk_answers_storage() {
    // The database can't grow (here: its page cap; on a host, the disk).
    let conn = open(FsPath::new(":memory:")).unwrap();
    let pages: i64 = conn
        .query_row("PRAGMA page_count", [], |r| r.get(0))
        .unwrap();
    conn.execute_batch(&format!("PRAGMA max_page_count = {pages}"))
        .unwrap();
    let app = app_from(conn, NO_OFF);
    let mut status = StatusCode::CREATED;
    let mut res = Value::Null;
    for _ in 0..200 {
        (status, res) = call(
            &app,
            "POST",
            "/api/feedback",
            Some(json!({ "kind": "bug", "text": "x".repeat(4000) })),
        )
        .await;
        if status != StatusCode::CREATED {
            break;
        }
    }
    assert_eq!(
        (status, res),
        (
            StatusCode::INSUFFICIENT_STORAGE,
            json!({ "code": "storage",
                    "error": "The server's disk is full: new changes can't be saved" })
        )
    );
}

/// A free local port.
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[test]
fn a_stalled_upload_does_not_hold_a_stop() {
    // A deploy stops the server while a phone on a weak link is part-way
    // through a body: the stop still ends within the drain deadline.
    use std::io::Write;
    use std::time::{Duration, Instant};
    let dir = std::env::temp_dir().join(format!("kaloriina-stop-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let port = free_port();
    let mut server = std::process::Command::new(env!("CARGO_BIN_EXE_kaloriina"))
        .args(["serve", "--time-zone", "UTC", "--port", &port.to_string()])
        .arg("--db")
        .arg(dir.join("db"))
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let started = Instant::now();
    let mut stalled = loop {
        if let Ok(s) = std::net::TcpStream::connect(("127.0.0.1", port)) {
            break s;
        }
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "never listened"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    stalled
        .write_all(
            b"POST /api/feedback HTTP/1.1\r\nHost: localhost\r\n\
              Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{",
        )
        .unwrap();
    std::thread::sleep(Duration::from_millis(300));
    let term = std::process::Command::new("kill")
        .args(["-TERM", &server.id().to_string()])
        .status()
        .unwrap();
    assert!(term.success());
    let stopping = Instant::now();
    let exited = loop {
        if server.try_wait().unwrap().is_some() {
            break stopping.elapsed();
        }
        if stopping.elapsed() > Duration::from_secs(15) {
            server.kill().unwrap();
            server.wait().unwrap();
            panic!("still serving 15 s after SIGTERM");
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    drop(stalled);
    std::fs::remove_dir_all(&dir).unwrap();
    assert!(exited < Duration::from_secs(11), "stopped after {exited:?}");
}
