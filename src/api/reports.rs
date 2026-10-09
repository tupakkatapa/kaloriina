//! Reports over the diary: where a nutrient came from (top foods).

use super::prelude::*;

pub(super) fn routes() -> Router<AppState> {
    Router::new().route("/api/profiles/{pid}/summary/foods", get(sources))
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

async fn sources(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Query(q): Query<SourcesQuery>,
) -> Res<db::NutrientSources> {
    let (from, to) = both(&q.range)?;
    let nutrient = q
        .nutrient
        .as_deref()
        .and_then(nutrients::find)
        .ok_or_else(|| Error::invalid_field("nutrient", "nutrient must be a known nutrient key"))?
        .key;
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            db::nutrient_sources(conn, pid, &from, &to, nutrient)
        })
        .await?,
    ))
}
