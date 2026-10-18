//! Feedback: a bug or an idea for the instance's maintainer, kept until the
//! CLI pulls it.

use super::*;

#[tokio::test]
async fn feedback_is_kept_open_until_pulled_and_checked() {
    let app = app();
    let (status, made) = call(
        &app,
        "POST",
        "/api/feedback",
        Some(json!({ "kind": "bug", "text": "  The scale row wraps.  " })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{made}");
    assert_eq!(
        (&made["kind"], &made["text"], &made["status"]),
        (
            &json!("bug"),
            &json!("The scale row wraps."),
            &json!("open")
        )
    );
    call(
        &app,
        "POST",
        "/api/feedback",
        Some(json!({ "kind": "feature", "text": "Photos of meals" })),
    )
    .await;
    let (status, open) = call(&app, "GET", "/api/feedback", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(open, json!({ "open": 2 }));

    for (body, field) in [
        (json!({ "kind": "bug", "text": "   " }), "text"),
        (json!({ "kind": "bug", "text": "x".repeat(4001) }), "text"),
        (json!({ "kind": "praise", "text": "Nice" }), "kind"),
    ] {
        let (status, err) = call(&app, "POST", "/api/feedback", Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{err}");
        assert_eq!(err["field"], field, "{err}");
    }
    // A form can't post it.
    let (status, _) = common::raw(
        &app,
        "POST",
        "/api/feedback",
        "application/x-www-form-urlencoded",
        "kind=bug&text=x",
    )
    .await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
}

#[tokio::test]
async fn feedback_count_only() {
    // The web reads a count: no household member's text goes out, and
    // pulled feedback isn't counted.
    let conn = open(FsPath::new(":memory:")).unwrap();
    conn.execute_batch(
        "INSERT INTO feedback (kind, text) VALUES ('bug', 'Private one'), ('bug', 'Private two');
         UPDATE feedback SET status = 'pulled' WHERE text = 'Private one';",
    )
    .unwrap();
    let app = app_from(conn, NO_OFF);
    let (status, body) = call(&app, "GET", "/api/feedback", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "open": 1 }));
    assert!(!body.to_string().contains("Private"), "{body}");
}

#[test]
fn feedback_text_cannot_forge_a_heading() {
    // `feedback --pull` prints Markdown a maintainer (or their tooling)
    // reads item by item: a text's own heading stays inside its quote.
    use kaloriina::model::{Feedback, FeedbackKind, FeedbackStatus, feedback_markdown};
    let item = Feedback {
        id: 1,
        kind: FeedbackKind::Bug,
        text: "line\n## Bug #999 · fake\n\nforged".to_owned(),
        status: FeedbackStatus::Open,
        created_at: "2026-10-17T10:00:00Z".to_owned(),
    };
    assert_eq!(
        feedback_markdown(&[item]),
        "## Bug #1 · 2026-10-17T10:00:00Z\n\n> line\n> ## Bug #999 · fake\n>\n> forged\n\n"
    );
}
