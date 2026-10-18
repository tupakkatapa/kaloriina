//! Outbound hooks (ADR 0024): the Home Assistant webhook a profile sets in
//! Connections, and the workout events the server forwards to it. A local
//! listener stands in for Home Assistant.

use std::sync::{Arc, Mutex};

use axum::Json;
use axum::extract::{Path, State};
use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::post;

use super::*;
use kaloriina::{AppState, router};

const HA: &str = "/api/profiles/1/hooks/home-assistant";
const EVENTS: &str = "/api/profiles/1/hooks/home-assistant/events";

/// What the stand-in received: the webhook id in the path, and the body.
type Seen = Arc<Mutex<Vec<(String, Value)>>>;

/// A stand-in Home Assistant on a free port: `/api/webhook/{id}` records
/// what it gets and answers 200; `/api/webhook/moved` redirects to the
/// recording one. Its base URL and what it saw.
async fn home_assistant() -> (String, Seen) {
    let seen = Seen::default();
    let stub = Router::new()
        .route(
            "/api/webhook/moved",
            post(|| async { (StatusCode::FOUND, [(header::LOCATION, "/api/webhook/x")]) }),
        )
        .route(
            "/api/webhook/{id}",
            post(
                |State(seen): State<Seen>, Path(id): Path<String>, Json(body): Json<Value>| async move {
                    seen.lock().unwrap().push((id, body));
                    StatusCode::OK.into_response()
                },
            ),
        )
        .with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, stub).await.unwrap() });
    (format!("http://{addr}"), seen)
}

async fn set(app: &Router, body: Value) -> (StatusCode, Value) {
    call(app, "PUT", HA, Some(body)).await
}

async fn send(app: &Router, body: Value) -> Value {
    let (status, res) = call(app, "POST", EVENTS, Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    res
}

#[tokio::test]
async fn the_hook_is_set_kept_and_removed_without_echoing_its_id() {
    let app = app();
    let (status, none) = call(&app, "GET", HA, None).await;
    assert_eq!((status, none), (StatusCode::OK, Value::Null));

    let (status, saved) = set(
        &app,
        json!({ "url": " http://192.168.1.5:8123/ ", "webhook_id": "kaloriina-Workout_1",
                "events": ["workout_started", "workout_finished", "workout_started"] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(
        saved,
        json!({ "url": "http://192.168.1.5:8123", "events": ["workout_started", "workout_finished"],
                "last_result": null }),
        "trimmed, one of each event, and never the webhook id"
    );
    let (_, read) = call(&app, "GET", HA, None).await;
    assert_eq!(read, saved);
    assert!(!read.to_string().contains("kaloriina-Workout_1"), "{read}");

    // Same URL: the id may be left out and is kept.
    let (status, kept) = set(
        &app,
        json!({ "url": "http://192.168.1.5:8123", "events": [] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{kept}");
    assert_eq!(kept["events"], json!([]));
    // Another URL: the id goes there only when given again.
    let (status, e) = set(
        &app,
        json!({ "url": "http://192.168.1.6:8123", "events": [] }),
    )
    .await;
    assert_eq!(
        (status, &e["field"]),
        (StatusCode::BAD_REQUEST, &json!("webhook_id")),
        "{e}"
    );

    let (status, _) = call(&app, "DELETE", HA, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, none) = call(&app, "GET", HA, None).await;
    assert_eq!(none, Value::Null);
}

#[tokio::test]
async fn a_hook_is_checked() {
    let app = app();
    let ok = |url: &str, id: &str, events: Value| json!({ "url": url, "webhook_id": id, "events": events });
    let long_url = format!("http://ha.lan/{}", "a".repeat(500));
    let long_id = "a".repeat(201);
    for (body, field) in [
        (ok("ftp://ha.lan", "id1", json!([])), "url"),
        (ok("javascript:alert(1)", "id1", json!([])), "url"),
        (ok("http://", "id1", json!([])), "url"),
        (ok("http://user:pw@ha.lan", "id1", json!([])), "url"),
        (ok("http://ha.lan/?x=1", "id1", json!([])), "url"),
        (ok(&long_url, "id1", json!([])), "url"),
        (ok("http://ha.lan", "", json!([])), "webhook_id"),
        (
            ok("http://ha.lan", "../../api/services", json!([])),
            "webhook_id",
        ),
        (ok("http://ha.lan", &long_id, json!([])), "webhook_id"),
        (ok("http://ha.lan", "id1", json!(["test"])), "events"),
        (ok("http://ha.lan", "id1", json!(["lunch"])), "events"),
        // A first save names its id.
        (
            json!({ "url": "http://ha.lan", "events": [] }),
            "webhook_id",
        ),
    ] {
        let (status, e) = set(&app, body.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}: {e}");
        assert_eq!(e["field"], field, "{body}: {e}");
    }
    // At the limits, https too.
    let id = "a".repeat(200);
    let url = format!(
        "https://ha.lan/{}",
        "a".repeat(500 - "https://ha.lan/".len())
    );
    let (status, e) = set(&app, ok(&url, &id, json!([]))).await;
    assert_eq!(status, StatusCode::OK, "{e}");

    let (status, e) = call(&app, "POST", EVENTS, Some(json!({ "event": "lunch" }))).await;
    assert_eq!(
        (status, &e["field"]),
        (StatusCode::BAD_REQUEST, &json!("event")),
        "{e}"
    );
}

#[tokio::test]
async fn chosen_events_are_forwarded_with_their_body() {
    let app = app();
    let (url, seen) = home_assistant().await;
    // Nothing set: nothing sent.
    let res = send(
        &app,
        json!({ "event": "workout_started", "workout": "Legs" }),
    )
    .await;
    assert_eq!(res, json!({ "sent": false, "result": null }));

    let (status, e) = set(
        &app,
        json!({ "url": url, "webhook_id": "kaloriina-1", "events": ["workout_started"] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{e}");
    let res = send(
        &app,
        json!({ "event": "workout_started", "workout": "Legs" }),
    )
    .await;
    assert_eq!(res["sent"], true, "{res}");
    assert_eq!(res["result"]["ok"], true, "{res}");
    assert_eq!(res["result"]["status"], 200, "{res}");
    assert_eq!(res["result"]["event"], "workout_started", "{res}");
    let (_, me) = call(&app, "GET", "/api/profiles/1", None).await;
    {
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        let (id, body) = &seen[0];
        assert_eq!(id, "kaloriina-1");
        assert_eq!(body["event"], "workout_started");
        assert_eq!(body["workout"], "Legs");
        assert_eq!(body.get("session"), None, "no session: {body}");
        assert_eq!(body["profile"], me["name"]);
        assert!(
            body["at"].as_str().unwrap().ends_with('Z'),
            "an instant: {body}"
        );
    }

    // Not chosen: not sent, and the last result stays.
    let res = send(&app, json!({ "event": "workout_finished" })).await;
    assert_eq!(res, json!({ "sent": false, "result": null }));
    assert_eq!(seen.lock().unwrap().len(), 1);
    // The test always goes.
    let res = send(&app, json!({ "event": "test" })).await;
    assert_eq!(res["result"]["ok"], true, "{res}");
    assert_eq!(seen.lock().unwrap()[1].1["event"], "test");
    let (_, read) = call(&app, "GET", HA, None).await;
    assert_eq!(read["last_result"], res["result"]);
}

#[tokio::test]
async fn failures_are_recorded_and_redirects_not_followed() {
    let state = AppState::new(open(FsPath::new(":memory:")).unwrap(), NO_OFF.to_owned());
    assert_eq!(
        state.hook_timeout,
        std::time::Duration::from_secs(5),
        "the default"
    );
    let app = router(AppState {
        hook_timeout: std::time::Duration::from_millis(100),
        ..state
    });
    let (url, seen) = home_assistant().await;
    let send_to = |url: String, id: &'static str| {
        let app = app.clone();
        async move {
            let (status, e) =
                set(&app, json!({ "url": url, "webhook_id": id, "events": [] })).await;
            assert_eq!(status, StatusCode::OK, "{e}");
            send(&app, json!({ "event": "test" })).await
        }
    };

    let res = send_to(url, "moved").await;
    assert_eq!(res["result"]["ok"], false, "{res}");
    assert_eq!(res["result"]["status"], 302, "{res}");
    assert!(
        seen.lock().unwrap().is_empty(),
        "the redirect isn't followed"
    );

    // Nothing listening: a port bound, then let go.
    let closed = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap();
    let res = send_to(format!("http://{closed}"), "id1").await;
    assert_eq!(res["result"]["ok"], false, "{res}");
    assert_eq!(res["result"]["status"], Value::Null, "{res}");
    assert!(res["result"]["error"].is_string(), "{res}");

    assert_eq!(res["result"]["error"], "couldn't connect", "{res}");

    // Accepts, never answers: given up after the timeout, and said so.
    let silent = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = silent.local_addr().unwrap();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((socket, _)) = silent.accept().await {
            held.push(socket);
        }
    });
    let started = std::time::Instant::now();
    let res = send_to(format!("http://{addr}"), "id1").await;
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    assert_eq!(res["result"]["ok"], false, "{res}");
    assert_eq!(res["result"]["error"], "timed out after 100ms", "{res}");
    // Never the secret in what's shown.
    assert!(!res.to_string().contains("id1"), "{res}");
    let (_, read) = call(&app, "GET", HA, None).await;
    assert_eq!(read["last_result"], res["result"]);
}

#[tokio::test]
async fn a_hook_is_its_profiles() {
    let app = app();
    let (url, seen) = home_assistant().await;
    let (status, e) = set(
        &app,
        json!({ "url": url, "webhook_id": "mine", "events": ["workout_finished"] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{e}");
    let (status, p) = call(
        &app,
        "POST",
        "/api/profiles",
        Some(json!({
            "name": "Other", "sex": null, "birth_date": null, "height_cm": null,
            "activity": null, "goal_kg_per_week": 0.0
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    let other = format!("/api/profiles/{}/hooks/home-assistant", p["id"]);
    let (_, none) = call(&app, "GET", &other, None).await;
    assert_eq!(none, Value::Null);
    let (_, res) = call(
        &app,
        "POST",
        &format!("{other}/events"),
        Some(json!({ "event": "workout_finished" })),
    )
    .await;
    assert_eq!(res["sent"], false, "{res}");
    assert!(seen.lock().unwrap().is_empty());

    for (method, path, body) in [
        ("GET", "/api/profiles/999/hooks/home-assistant", None),
        (
            "PUT",
            "/api/profiles/999/hooks/home-assistant",
            Some(json!({ "url": url, "webhook_id": "x1", "events": [] })),
        ),
        ("DELETE", "/api/profiles/999/hooks/home-assistant", None),
        (
            "POST",
            "/api/profiles/999/hooks/home-assistant/events",
            Some(json!({ "event": "test" })),
        ),
    ] {
        let (status, e) = call(&app, method, path, body).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}: {e}");
        assert_eq!(e["resource"], "profile", "{e}");
    }
}

#[tokio::test]
async fn hook_refuses_link_local() {
    let app = app();
    for url in [
        "http://169.254.169.254/latest",
        "http://169.254.1.1:8123",
        "http://0.0.0.0:8123",
        "http://0:8123",
        "http://[fe80::1]:8123",
        "http://[::]:8123",
        "http://[::ffff:169.254.169.254]",
    ] {
        let (status, e) = set(
            &app,
            json!({ "url": url, "webhook_id": "id1", "events": [] }),
        )
        .await;
        assert_eq!(
            (status, &e["field"]),
            (StatusCode::BAD_REQUEST, &json!("url")),
            "{url}: {e}"
        );
    }
    // Loopback and the LAN are Home Assistant's homes.
    for url in [
        "http://127.0.0.1:8123",
        "http://[::1]:8123",
        "http://10.0.0.2",
        "http://ha.lan",
    ] {
        let (status, e) = set(
            &app,
            json!({ "url": url, "webhook_id": "id1", "events": [] }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{url}: {e}");
    }
}

#[tokio::test]
async fn hook_stores_the_parsed_url() {
    let app = app();
    let (url, seen) = home_assistant().await;
    let (status, saved) = set(
        &app,
        json!({ "url": "HTTP://HA.Lan:80/Base/", "webhook_id": "id1", "events": [] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["url"], "http://ha.lan/Base", "as parsed: {saved}");
    // Called at the parsed base, its path joined segment by segment.
    let (status, saved) = set(
        &app,
        json!({ "url": format!("{url}/"), "webhook_id": "kaloriina-1", "events": [] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["url"], url);
    let res = send(&app, json!({ "event": "test" })).await;
    assert_eq!(res["result"]["ok"], true, "{res}");
    assert_eq!(seen.lock().unwrap()[0].0, "kaloriina-1");
}

#[tokio::test]
async fn meta_serves_the_hook_events() {
    let (_, meta) = call(&app(), "GET", "/api/meta", None).await;
    assert_eq!(
        meta["hook_events"],
        json!([
            { "key": "workout_started", "label": "Workout started" },
            { "key": "workout_finished", "label": "Workout finished" },
        ])
    );
}

#[tokio::test]
async fn workout_saved_is_no_event() {
    let app = app();
    let (status, e) = set(
        &app,
        json!({ "url": "http://192.168.1.5:8123", "webhook_id": "k1", "events": ["workout_saved"] }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{e}");
    let (status, e) = call(
        &app,
        "POST",
        &format!("{HA}/events"),
        Some(json!({ "event": "workout_saved" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{e}");
}
