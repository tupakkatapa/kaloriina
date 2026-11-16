//! Reports over the diary: where a nutrient came from (top foods), foods
//! rich in it, a profile's totals since its first day (All time), and its
//! trends by week or month.

use super::prelude::*;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/profiles/{pid}/summary/foods", get(sources))
        .route("/api/profiles/{pid}/foods/rich", get(rich))
        .route("/api/profiles/{pid}/stats", get(stats))
        .route("/api/profiles/{pid}/trends", get(trends))
}

#[derive(Deserialize)]
struct TrendsQuery {
    #[serde(flatten)]
    range: Range,
    /// `week` (the default) or `month`.
    by: Option<String>,
}

/// Per week or month of `[from, to]`: the means of what was eaten, the
/// weight trend and the daily items' adherence ([`model::trends`]).
async fn trends(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Query(q): Query<TrendsQuery>,
) -> Res<model::Trends> {
    use jiff::ToSpan;
    use jiff::civil::Date;
    let (from, to) = both(&q.range)?;
    let by = q.by.as_deref().map_or(Ok(model::By::Week), |by| {
        model::By::parse(by).ok_or_else(|| {
            Error::invalid_field("by", format!("by must be {}", model::By::choices()))
        })
    })?;
    let day = |d: &str| {
        d.parse::<Date>()
            .map_err(|e| Error::Internal(format!("{d}: {e}")))
    };
    let (first, last, today) = (day(&from)?, day(&to)?, day(&s.diary_today())?);
    if model::trend_buckets(first, last, by) > model::TREND_BUCKETS_MAX {
        return Err(Error::invalid_field(
            "from",
            format!(
                "from is too far back: at most {} {}s",
                model::TREND_BUCKETS_MAX,
                by.as_str()
            ),
        ));
    }
    let eaten = super::diary::eaten_days(
        &s,
        pid,
        &from,
        &to,
        Some(vec!["energy", "protein", "alcohol"]),
    )
    .await?
    .into_iter()
    .map(|d| {
        Ok(model::EatenDay {
            day: day(&d.day)?,
            energy: d.total.get("energy"),
            protein: d.total.get("protein"),
            alcohol: d.total.get("alcohol"),
            incomplete: d.incomplete,
            energy_unknown: d.energy_unknown,
        })
    })
    .collect::<Result<Vec<_>, Error>>()?;
    let since = first
        .saturating_sub((model::TREND_DAYS - 1).days())
        .to_string();
    let (weights, daily) = on_profile(&s, pid, move |conn| {
        Ok((
            db::weight_list(conn, pid, Some(&since), Some(&to))?,
            db::daily_days(conn, pid, &from, &to)?,
        ))
    })
    .await?;
    let weights = weights
        .into_iter()
        .map(|w| Ok((day(&w.day)?, w.kg)))
        .collect::<Result<Vec<_>, Error>>()?;
    let read = model::TrendDays {
        eaten: &eaten,
        weights: &weights,
        daily: &daily,
    };
    Ok(Json(model::trends(first, last, by, today, &read)))
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
