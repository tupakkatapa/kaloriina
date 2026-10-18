//! Feedback for the instance's maintainer (`kaloriina feedback --pull`
//! reads it). Online only; not a profile's, so never exported.

use super::prelude::*;
use model::{Feedback, FeedbackInput};

pub(super) fn routes() -> Router<AppState> {
    Router::new().route("/api/feedback", get(list).post(create))
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

/// How much feedback waits: a count, never the texts (they are every
/// household member's; the CLI reads them).
async fn list(State(s): State<AppState>) -> Res<Waiting> {
    let open = on_db(&s, |conn| db::feedback_open_count(conn)).await?;
    Ok(Json(Waiting { open }))
}
