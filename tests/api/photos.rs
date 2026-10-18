//! Photos: a raw JPEG body on a day and group (ADR 0022), checked by its
//! bytes, kept per profile and served by its uid, revalidated on every view.

use super::*;
use axum::body::Body;
use axum::http::{HeaderMap, Request, header};
use http_body_util::BodyExt;
use kaloriina::{AppState, router};
use tower::ServiceExt;

const PHOTOS: &str = "/api/profiles/1/photos";

/// A JPEG's bytes as far as the server reads them: SOI, a JFIF segment,
/// a baseline frame `width` × `height`, a scan and `pad` bytes of data.
fn jpeg(width: u16, height: u16, pad: usize) -> Vec<u8> {
    let mut b = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
    b.extend(b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0");
    b.extend([0xFF, 0xC0, 0x00, 0x11, 0x08]);
    b.extend(height.to_be_bytes());
    b.extend(width.to_be_bytes());
    b.extend([0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    b.extend([0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00]);
    b.extend(std::iter::repeat_n(0x55, pad));
    b.extend([0xFF, 0xD9]);
    b
}

async fn send(
    app: &Router,
    method: &str,
    uri: &str,
    ctype: Option<&str>,
    body: Vec<u8>,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut req = Request::builder().method(method).uri(uri);
    if let Some(t) = ctype {
        req = req.header(header::CONTENT_TYPE, t);
    }
    let res = app
        .clone()
        .oneshot(req.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let (status, headers) = (res.status(), res.headers().clone());
    let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    (status, headers, bytes)
}

fn json_of(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap_or(Value::Null)
}

async fn upload(app: &Router, query: &str, ctype: &str, body: Vec<u8>) -> (StatusCode, Value) {
    let (status, _, bytes) =
        send(app, "POST", &format!("{PHOTOS}?{query}"), Some(ctype), body).await;
    (status, json_of(&bytes))
}

const AT: &str = "day=2026-10-06&group=Eaten";

#[tokio::test]
async fn a_photo_is_stored_served_privately_and_listed_on_its_day() {
    let app = app();
    let image = jpeg(1600, 1200, 300);
    let (status, made) = upload(
        &app,
        &format!("{AT}&uid=photo-0001"),
        "image/jpeg",
        image.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{made}");
    assert_eq!(
        (&made["day"], &made["group"], &made["mime"], &made["size"]),
        (
            &json!(DAY),
            &json!("Eaten"),
            &json!("image/jpeg"),
            &json!(image.len()),
        )
    );
    assert!(made.get("entry_id").is_none(), "{made}");
    // A retry stores nothing more.
    let (status, again) = upload(
        &app,
        &format!("{AT}&uid=photo-0001"),
        "image/jpeg",
        image.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(again, made);

    let (status, headers, bytes) =
        send(&app, "GET", &format!("{PHOTOS}/photo-0001"), None, vec![]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, image);
    assert_eq!(headers[header::CONTENT_TYPE], "image/jpeg");
    let (_, day) = call(&app, "GET", &format!("/api/profiles/1/day/{DAY}"), None).await;
    assert_eq!(day["photos"], json!([made]), "{day}");

    let (status, _, _) = send(
        &app,
        "DELETE",
        &format!("{PHOTOS}/photo-0001"),
        None,
        vec![],
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _, _) = send(&app, "GET", &format!("{PHOTOS}/photo-0001"), None, vec![]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

/// GET with `If-None-Match`.
async fn revalidate(app: &Router, uid: &str, etag: &str) -> (StatusCode, HeaderMap, Vec<u8>) {
    let req = Request::builder()
        .uri(format!("{PHOTOS}/{uid}"))
        .header(header::IF_NONE_MATCH, etag)
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let (status, headers) = (res.status(), res.headers().clone());
    let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    (status, headers, bytes)
}

#[tokio::test]
async fn photo_url_is_the_uid_and_revalidates() {
    let app = app();
    let (status, made) = upload(
        &app,
        &format!("{AT}&uid=photo-0001"),
        "image/jpeg",
        jpeg(10, 10, 0),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{made}");
    let (status, headers, _) =
        send(&app, "GET", &format!("{PHOTOS}/photo-0001"), None, vec![]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CACHE_CONTROL], "private, no-cache");
    assert_eq!(headers[header::ETAG], "\"photo-0001\"");

    // Unchanged: a 304 without the bytes.
    let (status, headers, bytes) = revalidate(&app, "photo-0001", "\"photo-0001\"").await;
    assert_eq!(status, StatusCode::NOT_MODIFIED);
    assert_eq!(headers[header::ETAG], "\"photo-0001\"");
    assert!(bytes.is_empty());
    // Another tag: the bytes.
    let (status, _, bytes) = revalidate(&app, "photo-0001", "\"other\"").await;
    assert_eq!(status, StatusCode::OK);
    assert!(!bytes.is_empty());

    // Deleted: the cached copy's revalidation is a 404.
    let (status, _, _) = send(
        &app,
        "DELETE",
        &format!("{PHOTOS}/photo-0001"),
        None,
        vec![],
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _, _) = revalidate(&app, "photo-0001", "\"photo-0001\"").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn restore_never_reissues_a_photo_url() {
    let state = AppState::new(open(FsPath::new(":memory:")).unwrap(), NO_OFF.to_owned());
    let db = state.db.clone();
    let app = router(state);
    let first = jpeg(10, 10, 1);
    let (status, a) = upload(&app, AT, "image/jpeg", first.clone()).await;
    assert_eq!(status, StatusCode::CREATED, "{a}");
    let old = format!("{PHOTOS}/{}", a["uid"].as_str().unwrap());
    let (status, _, bytes) = send(&app, "GET", &old, None, vec![]).await;
    assert_eq!((status, bytes), (StatusCode::OK, first));

    // A restore from before the photo: its row and the id counter rewound.
    db.lock()
        .unwrap()
        .execute_batch(
            "DELETE FROM photo; UPDATE sqlite_sequence SET seq = 0 WHERE name = 'photo';",
        )
        .unwrap();
    let second = jpeg(10, 10, 2);
    let (status, b) = upload(&app, AT, "image/jpeg", second.clone()).await;
    assert_eq!(status, StatusCode::CREATED, "{b}");
    assert_eq!(b["id"], a["id"], "the id is handed out again");

    let (status, _, _) = send(&app, "GET", &old, None, vec![]).await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "the old URL shows nothing new"
    );
    let new = format!("{PHOTOS}/{}", b["uid"].as_str().unwrap());
    assert_ne!(new, old);
    let (status, _, bytes) = send(&app, "GET", &new, None, vec![]).await;
    assert_eq!((status, bytes), (StatusCode::OK, second));
}

#[tokio::test]
async fn webp_is_refused() {
    let app = app();
    let mut webp = b"RIFF\x0e\0\0\0WEBPVP8L\x06\0\0\0\x2f".to_vec();
    webp.extend([0; 5]);
    let (status, err) = upload(&app, AT, "image/webp", webp).await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE, "{err}");
    assert_eq!(err["code"], "unsupported_media_type", "{err}");
    assert_eq!(err["error"], "Send the photo as image/jpeg", "{err}");
}

#[tokio::test]
async fn only_an_image_body_of_its_kind_and_size_is_taken() {
    let app = app();
    // Not an image type (a form, JSON): 415, as a cross-site form is.
    for ctype in [
        "multipart/form-data; boundary=x",
        "application/json",
        "image/png",
    ] {
        let (status, err) = upload(&app, AT, ctype, jpeg(10, 10, 0)).await;
        assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE, "{ctype}: {err}");
        assert_eq!(err["code"], "unsupported_media_type");
    }
    // Bytes that aren't what the type says, or no frame size: 400.
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.extend([0; 64]);
    for body in [png, vec![0xFF, 0xD8, 0xFF, 0xD9], vec![]] {
        let (status, err) = upload(&app, AT, "IMAGE/JPEG; q=1", body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{err}");
    }
    // Over 4096 px either way.
    for (w, h) in [(4097, 100), (100, 4097)] {
        let (status, err) = upload(&app, AT, "image/jpeg", jpeg(w, h, 0)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{err}");
    }
    // Over 2 MiB: 413.
    let (status, err) = upload(&app, AT, "image/jpeg", jpeg(10, 10, 2 * 1024 * 1024)).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{err}");
    // The day, group and uid are checked.
    for (query, field) in [
        ("day=6.10.2026&group=Eaten", "day"),
        ("day=2026-10-06&group=Lunch", "group"),
        ("day=2026-10-06&group=Eaten&uid=x", "uid"),
    ] {
        let (status, err) = upload(&app, query, "image/jpeg", jpeg(10, 10, 0)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {err}");
        assert_eq!(err["field"], field, "{query}: {err}");
    }
    let (status, _, bytes) = send(&app, "GET", &format!("{PHOTOS}/nope"), None, vec![]).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{}", json_of(&bytes));
}

#[tokio::test]
async fn a_photo_is_its_profiles() {
    let app = app();
    let (status, made) = upload(&app, AT, "image/jpeg", jpeg(10, 10, 0)).await;
    assert_eq!(status, StatusCode::CREATED, "{made}");
    let uid = made["uid"].as_str().unwrap();

    // Another profile sees nothing of it.
    let (status, other) = call(
        &app,
        "POST",
        "/api/profiles",
        Some(
            json!({ "name": "Other", "sex": null, "birth_date": null, "height_cm": null,
                     "activity": null, "goal_kg_per_week": 0.0 }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{other}");
    let other = other["id"].as_i64().unwrap();
    for method in ["GET", "DELETE"] {
        let (status, _, _) = send(
            &app,
            method,
            &format!("/api/profiles/{other}/photos/{uid}"),
            None,
            vec![],
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method}");
    }
    let (_, day) = call(&app, "GET", &format!("/api/profiles/1/day/{DAY}"), None).await;
    assert_eq!(day["photos"][0]["uid"], uid, "{day}");

    // Not in the profile's export.
    let (status, file) = call(&app, "GET", "/api/profiles/1/export", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(file.get("photos").is_none(), "{file}");
}
