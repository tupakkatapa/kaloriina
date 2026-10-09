//! Profiles: their body and goal, targets (recommended and set) and the
//! weight log.

use super::prelude::*;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/profiles", get(list).post(create))
        .route("/api/profiles/{pid}", get(read).put(update).delete(delete))
        .route("/api/profiles/{pid}/recommended", get(recommended))
        .route(
            "/api/profiles/{pid}/targets",
            get(targets_read).put(targets_update),
        )
        .route("/api/profiles/{pid}/weights", get(weights))
        .route(
            "/api/profiles/{pid}/water-food",
            get(water_food).put(water_food_set),
        )
        .route(
            "/api/profiles/{pid}/weights/{day}",
            axum::routing::put(weight_set).delete(weight_delete),
        )
}

async fn list(State(s): State<AppState>) -> Res<Vec<model::Profile>> {
    Ok(Json(on_db(&s, |conn| db::profile_list(conn)).await?))
}

async fn read(State(s): State<AppState>, Path(pid): Path<ProfileId>) -> Res<model::Profile> {
    Ok(Json(on_db(&s, move |conn| owner(conn, pid)).await?))
}

/// A new profile starts without targets: it has no weigh-in yet, and
/// recommendations need one. The client logs the weight, then sets the
/// recommended targets.
async fn create(State(s): State<AppState>, Json(p): Json<ProfileInput>) -> Created<model::Profile> {
    let p = p.checked(&s.today())?;
    let profile = on_db(&s, move |conn| db::profile_insert(conn, &p, &[])).await?;
    Ok(created(profile))
}

async fn update(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Json(p): Json<ProfileInput>,
) -> Res<model::Profile> {
    let p = p.checked(&s.today())?;
    Ok(Json(
        on_profile(&s, pid, move |conn| db::profile_update(conn, pid, &p)).await?,
    ))
}

async fn delete(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
) -> Result<StatusCode, Error> {
    on_db(&s, move |conn| db::profile_delete(conn, pid)).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct Today {
    day: Option<String>,
}

/// Targets recommended from the profile's body and its latest weigh-in,
/// with its age on `?day` (the client's today; the server's without it).
/// Nothing is saved.
async fn recommended(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Query(q): Query<Today>,
) -> Res<Vec<Target>> {
    let today = match &q.day {
        Some(d) => checked_date(d)?.to_owned(),
        None => s.today(),
    };
    let profile = on_db(&s, move |conn| owner(conn, pid)).await?;
    Ok(Json(dri::recommend(
        &profile.body.person(profile.latest_weight_kg, &today)?,
    )))
}

async fn targets_read(State(s): State<AppState>, Path(pid): Path<ProfileId>) -> Res<Vec<Target>> {
    Ok(Json(
        on_profile(&s, pid, move |conn| db::target_list(conn, pid)).await?,
    ))
}

async fn targets_update(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Json(input): Json<TargetsInput>,
) -> Res<Vec<Target>> {
    let list = input.checked()?;
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::target_replace(conn, pid, input.rev, &list)?;
            db::target_list(conn, pid)
        })
        .await?,
    ))
}

async fn weights(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Query(r): Query<Range>,
) -> Res<Vec<model::Weight>> {
    r.checked()?;
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::weight_list(conn, pid, r.from.as_deref(), r.to.as_deref())
        })
        .await?,
    ))
}

/// Log a day's weight (replacing that day's), up to tomorrow (UTC): no
/// client is further ahead. `set_at` says when it was typed (a replay keeps
/// it), clamped to the last week. Repeating it changes nothing.
async fn weight_set(
    State(s): State<AppState>,
    Path((pid, day)): Path<(ProfileId, String)>,
    Json(w): Json<WeightInput>,
) -> Res<model::Weight> {
    model::checked_day_so_far(&day)?;
    let w = w.checked()?;
    let set_at = w.set_at(model::now_ms());
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::weight_set(conn, pid, &day, w.kg, set_at)
        })
        .await?,
    ))
}

async fn weight_delete(
    State(s): State<AppState>,
    Path((pid, day)): Path<(ProfileId, String)>,
) -> Result<StatusCode, Error> {
    checked_date(&day)?;
    on_profile(&s, pid, move |conn| {
        db::weight_delete(conn, pid, &day, model::now_ms())
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

fn water_food_of(conn: &Connection, pid: ProfileId) -> Result<model::WaterFood, Error> {
    let food = db::water_food_get(conn, pid)?;
    let chosen = food.is_some() && db::water_food_choice(conn, pid)? == food.as_ref().map(|f| f.id);
    Ok(model::WaterFood { food, chosen })
}

/// The food "+ Water" logs for this profile (see [`db::water_food_get`]).
async fn water_food(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
) -> Res<model::WaterFood> {
    Ok(Json(
        on_profile(&s, pid, move |conn| water_food_of(conn, pid)).await?,
    ))
}

/// Pick it (`food_id`), or go back to the default (`null`). Repeating it
/// changes nothing.
async fn water_food_set(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Json(input): Json<model::WaterFoodInput>,
) -> Res<model::WaterFood> {
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::water_food_set(conn, pid, input.food_id)?;
            water_food_of(conn, pid)
        })
        .await?,
    ))
}
