//! Feedback for the instance's maintainer: read and pulled here or by
//! `kaloriina feedback`. Online only; not a profile's, so never exported.

use super::prelude::*;
use model::{Feedback, FeedbackInput, FeedbackStatus};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/feedback", get(list).post(create))
        .route("/api/feedback/open", get(open))
        .route("/api/feedback/pull", post(pull))
}

async fn create(State(s): State<AppState>, Json(input): Json<FeedbackInput>) -> Created<Feedback> {
    let input = input.checked()?;
    let feedback = on_db(&s, move |conn| {
        db::feedback_insert(conn, &input, model::FEEDBACK_MAX)
    })
    .await?;
    Ok(created(feedback))
}

/// What waits to be pulled, from every profile.
#[derive(Serialize)]
struct Waiting {
    open: i64,
}

/// How much feedback waits: the count the app shows, without the texts.
async fn list(State(s): State<AppState>) -> Res<Waiting> {
    let open = on_db(&s, |conn| db::feedback_open_count(conn)).await?;
    Ok(Json(Waiting { open }))
}

/// The open feedback, oldest first: what the maintainer has yet to handle.
async fn open(State(s): State<AppState>) -> Res<Vec<Feedback>> {
    let open = on_db(&s, |conn| {
        db::feedback_list(conn, Some(FeedbackStatus::Open))
    })
    .await?;
    Ok(Json(open))
}

/// The feedback handled.
#[derive(Deserialize)]
struct Pull {
    ids: Vec<i64>,
}

/// Mark `ids` pulled; one that isn't open is passed over. Answers what
/// still waits.
async fn pull(State(s): State<AppState>, Json(p): Json<Pull>) -> Res<Waiting> {
    let open = on_db(&s, move |conn| {
        db::feedback_pull(conn, &p.ids)?;
        db::feedback_open_count(conn)
    })
    .await?;
    Ok(Json(Waiting { open }))
}
