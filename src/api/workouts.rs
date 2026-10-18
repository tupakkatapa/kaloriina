//! Exercises (the base set and yours) and workouts.

use super::prelude::*;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/exercises", get(exercises).post(exercise_create))
        .route(
            "/api/exercises/{id}",
            get(exercise_read)
                .put(exercise_update)
                .delete(exercise_delete),
        )
        .route("/api/workouts", get(workouts).post(workout_create))
        .route(
            "/api/workouts/{id}",
            get(workout_read).put(workout_update).delete(workout_delete),
        )
        .route("/api/workouts/{id}/usage", get(workout_usage))
        .route("/api/workouts/{id}/copy", post(workout_copy))
}

async fn exercises(State(s): State<AppState>) -> Res<Vec<model::Exercise>> {
    Ok(Json(on_db(&s, |conn| db::exercise_list(conn)).await?))
}

async fn exercise_read(State(s): State<AppState>, Path(id): Path<i64>) -> Res<model::Exercise> {
    Ok(Json(
        on_db(&s, move |conn| {
            db::exercise_get(conn, id)?.ok_or_else(|| Error::not_found("exercise", id))
        })
        .await?,
    ))
}

async fn exercise_create(
    State(s): State<AppState>,
    Json(e): Json<ExerciseInput>,
) -> Created<model::Exercise> {
    let e = e.checked()?;
    let exercise = on_db(&s, move |conn| db::exercise_save(conn, None, &e)).await?;
    Ok(created(exercise))
}

async fn exercise_update(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    Replace(e): Replace<ExerciseInput>,
) -> Res<model::Exercise> {
    let e = e.checked()?;
    Ok(Json(
        on_db(&s, move |conn| db::exercise_save(conn, Some(id), &e)).await?,
    ))
}

async fn exercise_delete(
    State(s): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, Error> {
    on_db(&s, move |conn| db::exercise_delete(conn, id)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn workouts(State(s): State<AppState>) -> Res<Vec<model::Workout>> {
    Ok(Json(on_db(&s, |conn| db::workout_list(conn)).await?))
}

async fn workout_read(State(s): State<AppState>, Path(id): Path<i64>) -> Res<model::Workout> {
    Ok(Json(
        on_db(&s, move |conn| {
            db::workout_get(conn, id)?.ok_or_else(|| Error::not_found("workout", id))
        })
        .await?,
    ))
}

/// A copy of a saved workout: 201 with it.
async fn workout_copy(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    Json(c): Json<model::CopyInput>,
) -> Created<model::Workout> {
    let c = c.checked()?;
    let copy = on_db(&s, move |conn| db::workout_copy(conn, id, c.uid.as_deref())).await?;
    Ok(created(copy))
}

async fn workout_create(
    State(s): State<AppState>,
    Json(w): Json<WorkoutInput>,
) -> Created<model::Workout> {
    let w = w.checked()?;
    let workout = on_db(&s, move |conn| db::workout_save(conn, None, &w)).await?;
    Ok(created(workout))
}

async fn workout_update(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    Replace(w): Replace<WorkoutInput>,
) -> Res<model::Workout> {
    let w = w.checked()?;
    Ok(Json(
        on_db(&s, move |conn| db::workout_save(conn, Some(id), &w)).await?,
    ))
}

async fn workout_usage(State(s): State<AppState>, Path(id): Path<i64>) -> Res<model::WorkoutUsage> {
    Ok(Json(
        on_db(&s, move |conn| db::workout_usage(conn, id)).await?,
    ))
}

async fn workout_delete(
    State(s): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, Error> {
    on_db(&s, move |conn| db::workout_delete(conn, id)).await?;
    Ok(StatusCode::NO_CONTENT)
}
