//! Reports over the diary: where a nutrient came from (top foods), foods
//! rich in it, and a profile's totals since its first day (All time).

use super::prelude::*;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/profiles/{pid}/summary/foods", get(sources))
        .route("/api/profiles/{pid}/foods/rich", get(rich))
        .route("/api/profiles/{pid}/stats", get(stats))
}

/// Read under the lock a part at a time, so a Diary read waits for one
/// part's read at most, and summed off it.
async fn stats(State(s): State<AppState>, Path(pid): Path<ProfileId>) -> Res<model::Stats> {
    let (base, parts) = on_profile(&s, pid, move |conn| db::stats_read(conn, pid)).await?;
    let mut read = Vec::with_capacity(parts.len());
    for (from, to) in parts {
        read.push(on_profile(&s, pid, move |conn| db::stats_part(conn, pid, &from, &to)).await?);
    }
    let stats = tokio::task::spawn_blocking(move || db::stats_of(base, read))
        .await
        .map_err(|e| Error::Internal(format!("stats task failed: {e}")))??;
    Ok(Json(stats))
}

/// Both ends of a range, required.
fn both(r: &Range) -> Result<(String, String), Error> {
    match r.checked()? {
        (Some(from), Some(to)) => Ok((from.to_owned(), to.to_owned())),
        _ => Err(Error::invalid("from and to are required")),
    }
}

#[derive(Deserialize)]
struct SourcesQuery {
    #[serde(flatten)]
    range: Range,
    nutrient: Option<String>,
}

/// `?nutrient=` as a registry key, required.
fn nutrient_of(q: Option<&str>) -> Result<&'static str, Error> {
    Ok(q.and_then(nutrients::find)
        .ok_or_else(|| Error::invalid_field("nutrient", "nutrient must be a known nutrient key"))?
        .key)
}

#[derive(Deserialize)]
struct RichQuery {
    nutrient: Option<String>,
    /// Per 100 kcal, stored unit; 0 without.
    min: Option<f64>,
}

async fn rich(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Query(q): Query<RichQuery>,
) -> Res<Vec<model::RichFood>> {
    let nutrient = nutrient_of(q.nutrient.as_deref())?;
    let min = q.min.unwrap_or(0.0);
    if !min.is_finite() || min < 0.0 {
        return Err(Error::invalid_field(
            "min",
            "min must be a number of at least 0",
        ));
    }
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::rich_foods(conn, pid, nutrient, min)
        })
        .await?,
    ))
}

async fn sources(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Query(q): Query<SourcesQuery>,
) -> Res<model::NutrientSources> {
    let (from, to) = both(&q.range)?;
    let nutrient = nutrient_of(q.nutrient.as_deref())?;
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::nutrient_sources(conn, pid, &from, &to, nutrient)
        })
        .await?,
    ))
}
