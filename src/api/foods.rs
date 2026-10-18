//! Foods (yours, Open Food Facts and Fineli), search with filters,
//! favourites, recent foods, barcodes, recipes and meals.

use super::prelude::*;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/foods", post(food_create))
        .route(
            "/api/foods/{id}",
            get(food_read).put(food_update).delete(food_delete),
        )
        .route("/api/foods/{id}/usage", get(usage))
        .route("/api/foods/{id}/copy", post(food_copy))
        .route("/api/foods/{id}/merge", post(merge))
        .route("/api/foods/barcode/{code}", post(barcode))
        .route("/api/profiles/{pid}/foods", get(search))
        .route("/api/profiles/{pid}/foods/recent", get(recent))
        .route(
            "/api/profiles/{pid}/foods/favorites",
            get(favorites).post(favorite_add),
        )
        .route(
            "/api/profiles/{pid}/foods/favorites/{food_id}",
            axum::routing::delete(favorite_remove),
        )
        .route("/api/recipes", post(recipe_create))
        .route("/api/recipes/{id}", get(recipe_read).put(recipe_update))
        .route("/api/meals", get(meals).post(meal_create))
        .route(
            "/api/meals/{id}",
            get(meal_read).put(meal_update).delete(meal_delete),
        )
        .route("/api/meals/{id}/copy", post(meal_copy))
}

#[derive(Deserialize)]
struct Search {
    #[serde(default)]
    q: String,
    #[serde(default)]
    archived: bool,
    /// Comma list of databases (`custom,recipe,off,fineli`); all by default.
    sources: Option<String>,
    /// Comma lists of `nutrient:value` per 100 g, in stored units.
    min: Option<String>,
    max: Option<String>,
    sort: Option<String>,
    /// The day `sort=fit` fits (`YYYY-MM-DD`).
    day: Option<String>,
}

/// The `label` parameters (repeatable) as vocabulary keys: every food
/// found has them all.
fn label_filter(pairs: &[(String, String)]) -> Result<Vec<&'static str>, Error> {
    pairs
        .iter()
        .filter(|(k, _)| k == "label")
        .map(|(_, v)| {
            model::find_label(v)
                .map(|l| l.key.as_str())
                .ok_or_else(|| Error::invalid_field("label", format!("unknown label “{v}”")))
        })
        .collect()
}

/// Items of a comma list, blanks skipped.
fn items(list: Option<&str>) -> impl Iterator<Item = &str> {
    list.unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// `protein:20,energy:100` as validated registry keys and amounts.
fn nutrient_rules(field: &str, list: Option<&str>) -> Result<Vec<(&'static str, f64)>, Error> {
    let bad = |msg: String| Error::invalid_field(field, msg);
    let rules = items(list)
        .map(|rule| {
            let (key, value) = rule
                .split_once(':')
                .ok_or_else(|| bad(format!("expected nutrient:amount, got “{rule}”")))?;
            let n = nutrients::find(key).ok_or_else(|| bad(format!("unknown nutrient “{key}”")))?;
            let amount = value
                .parse::<f64>()
                .ok()
                .filter(|v| v.is_finite() && *v >= 0.0)
                .ok_or_else(|| bad(format!("bad amount “{value}” for {key}")))?;
            Ok((n.key, amount))
        })
        .collect::<Result<Vec<_>, Error>>()?;
    for (i, (key, _)) in rules.iter().enumerate() {
        if rules[..i].iter().any(|(k, _)| k == key) {
            let label = nutrients::find(key).map_or(*key, |n| n.label);
            return Err(bad(format!("{label}: listed twice")));
        }
    }
    Ok(rules)
}

/// Longest search, in characters and words. Every word is matched against
/// every food while the database is locked, so the size is bounded.
const SEARCH_CHARS_MAX: usize = 200;
const SEARCH_WORDS_MAX: usize = 8;

impl Search {
    fn query(&self, profile: ProfileId) -> Result<db::FoodQuery<'_>, Error> {
        if self.q.chars().count() > SEARCH_CHARS_MAX
            || self.q.split_whitespace().count() > SEARCH_WORDS_MAX
        {
            return Err(Error::invalid_field(
                "q",
                format!(
                    "search must be at most {SEARCH_CHARS_MAX} characters and {SEARCH_WORDS_MAX} words"
                ),
            ));
        }
        let sources = items(self.sources.as_deref())
            .map(|s| {
                model::FoodScope::parse(s).ok_or_else(|| {
                    Error::invalid_field(
                        "sources",
                        format!("unknown source “{s}” (use {})", model::FoodScope::choices()),
                    )
                })
            })
            .collect::<Result<_, _>>()?;
        let sort = match self.sort.as_deref() {
            None => model::Sort::Relevance,
            Some(s) => model::Sort::parse(s).ok_or_else(|| {
                Error::invalid_field(
                    "sort",
                    format!("unknown sort “{s}” (use {})", model::Sort::choices()),
                )
            })?,
        };
        if sort == model::Sort::Fit {
            match self.day.as_deref() {
                Some(d) if is_date(d) => {}
                _ => {
                    return Err(Error::invalid_field(
                        "day",
                        "sort=fit needs the day to fit (YYYY-MM-DD)",
                    ));
                }
            }
        }
        Ok(db::FoodQuery {
            q: self.q.trim(),
            archived: self.archived,
            sources,
            min: nutrient_rules("min", self.min.as_deref())?,
            max: nutrient_rules("max", self.max.as_deref())?,
            sort,
            profile,
            left: None,
            labels: Vec::new(),
        })
    }
}

/// What's left of the profile's energy, protein, carbohydrate and fat
/// targets on `day`, Planned food counted. A target that isn't set leaves
/// nothing of its nutrient.
fn left_on(conn: &Connection, pid: ProfileId, day: &str) -> Result<model::Macros, Error> {
    let targets = db::target_list(conn, pid)?;
    let target = |key: &str| targets.iter().find(|t| t.metric == key).map(|t| t.value);
    let Some(energy) = target("energy") else {
        return Err(Error::invalid_field(
            "sort",
            "sort=fit needs an energy target",
        ));
    };
    let mut eaten = Nutrients::default();
    for n in db::group_totals(conn, pid, day, day)?.values() {
        eaten.add(n);
    }
    let left =
        |key: &str, target: Option<f64>| target.unwrap_or(0.0) - eaten.get(key).unwrap_or(0.0);
    Ok(model::Macros {
        energy: left("energy", Some(energy)),
        protein: left("protein", target("protein")),
        net_carbs: left("net_carbs", target("net_carbs")),
        fat: left("fat", target("fat")),
    })
}

/// Foods matching a search, ranked for the profile (its favourites, then
/// its own foods and recipes, then what it logged recently), or by how they
/// fit what's left of `day` (`sort=fit`).
async fn search(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Query(q): Query<Search>,
    Query(pairs): Query<Vec<(String, String)>>,
) -> Res<Vec<model::Food>> {
    q.query(pid)?;
    let labels = label_filter(&pairs)?;
    Ok(Json(
        on_profile(&s, pid, move |conn| {
            let mut query = q.query(pid)?;
            query.labels = labels;
            if let (model::Sort::Fit, Some(day)) = (query.sort, q.day.as_deref()) {
                query.left = Some(left_on(conn, pid, day)?);
            }
            db::food_search(conn, &query)
        })
        .await?,
    ))
}

/// What uses a food: what a merge would move.
async fn usage(State(s): State<AppState>, Path(id): Path<i64>) -> Res<model::Usage> {
    Ok(Json(on_db(&s, move |conn| db::food_usage(conn, id)).await?))
}

/// Merge a duplicate (`from`) into this food; see `db::food_merge`.
async fn merge(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    Json(m): Json<model::MergeInput>,
) -> Res<model::Food> {
    Ok(Json(
        on_db(&s, move |conn| db::food_merge(conn, id, &m)).await?,
    ))
}

async fn recent(State(s): State<AppState>, Path(pid): Path<ProfileId>) -> Res<Vec<model::Food>> {
    Ok(Json(
        on_profile(&s, pid, move |conn| db::food_recent(conn, pid)).await?,
    ))
}

async fn favorites(State(s): State<AppState>, Path(pid): Path<ProfileId>) -> Res<Vec<model::Food>> {
    Ok(Json(
        on_profile(&s, pid, move |conn| db::favorite_list(conn, pid)).await?,
    ))
}

#[derive(Deserialize)]
struct Favorite {
    food_id: i64,
}

async fn favorite_add(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Json(f): Json<Favorite>,
) -> Result<StatusCode, Error> {
    on_profile(&s, pid, move |conn| {
        db::favorite_set(conn, pid, f.food_id, true)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn favorite_remove(
    State(s): State<AppState>,
    Path((pid, food_id)): Path<(ProfileId, i64)>,
) -> Result<StatusCode, Error> {
    on_profile(&s, pid, move |conn| {
        db::favorite_set(conn, pid, food_id, false)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// A food as read; a recipe's with its ingredients (as `GET /recipes/{id}`
/// lists them), which its log screen shows.
#[derive(Serialize)]
struct FoodRead {
    #[serde(flatten)]
    food: model::Food,
    #[serde(skip_serializing_if = "Option::is_none")]
    items: Option<Vec<model::Item>>,
}

/// [`FoodRead`] of `food`.
fn food_read_of(conn: &Connection, food: model::Food) -> Result<FoodRead, Error> {
    if food.kind != model::FoodKind::Recipe {
        return Ok(FoodRead { food, items: None });
    }
    let id = food.id;
    let r = db::recipe_get(conn, id)?.ok_or_else(|| Error::not_found("food", id))?;
    Ok(FoodRead {
        food: r.food,
        items: Some(r.items),
    })
}

async fn food_read(State(s): State<AppState>, Path(id): Path<i64>) -> Res<FoodRead> {
    Ok(Json(
        on_db(&s, move |conn| {
            let food = db::food_get(conn, id)?.ok_or_else(|| Error::not_found("food", id))?;
            food_read_of(conn, food)
        })
        .await?,
    ))
}

/// A copy of a saved food or recipe: 201 with it, as read.
async fn food_copy(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    Json(c): Json<model::CopyInput>,
) -> Created<FoodRead> {
    let c = c.checked()?;
    let copy = on_db(&s, move |conn| {
        let food = db::food_copy(conn, id, c.uid.as_deref())?;
        food_read_of(conn, food)
    })
    .await?;
    Ok(created(copy))
}

/// Delete a food or recipe nothing uses; see `db::food_delete`.
async fn food_delete(State(s): State<AppState>, Path(id): Path<i64>) -> Result<StatusCode, Error> {
    on_db(&s, move |conn| db::food_delete(conn, id)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn food_create(State(s): State<AppState>, Json(f): Json<FoodInput>) -> Created<model::Food> {
    let f = f.checked()?;
    let food = on_db(&s, move |conn| db::food_insert(conn, &f, Source::Custom)).await?;
    Ok(created(food))
}

async fn food_update(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    Replace(f): Replace<FoodInput>,
) -> Res<model::Food> {
    let f = f.checked()?;
    Ok(Json(
        on_db(&s, move |conn| db::food_update(conn, id, &f)).await?,
    ))
}

/// Local food by barcode, else fetched from Open Food Facts and cached: 404
/// when OFF has no such product, 502 when it's unreachable or its values are
/// impossible (over the per-100 caps). A write (it may
/// cache), so it takes a JSON body (`{}`) like every other write: a
/// cross-site form can't send one.
async fn barcode(
    State(s): State<AppState>,
    Path(code): Path<String>,
    Json(_): Json<Value>,
) -> Res<model::Food> {
    checked_barcode(&code)?;
    let c = code.clone();
    if let Some(food) = on_db(&s, move |conn| db::food_by_barcode(conn, &c)).await? {
        return Ok(Json(food));
    }
    let Some(http) = &s.http else {
        return Err(Error::Upstream(
            "barcode lookup is unavailable: the server could not load TLS certificates".into(),
        ));
    };
    let input = match off::lookup(http, &s.off_url, &code).await {
        Lookup::Found(input) => input.checked()?,
        Lookup::Missing => return Err(Error::not_found("barcode", code)),
        Lookup::Impossible(why) => {
            return Err(Error::Upstream(format!(
                "Open Food Facts' values for this product can't be right ({why})"
            )));
        }
        Lookup::Unavailable => {
            return Err(Error::Upstream(
                "Open Food Facts is unreachable; try again".into(),
            ));
        }
    };
    Ok(Json(
        on_db(&s, move |conn| {
            // A concurrent scan may have inserted it meanwhile.
            match db::food_by_barcode(conn, &code)? {
                Some(food) => Ok(food),
                None => db::food_insert(conn, &input, Source::Off),
            }
        })
        .await?,
    ))
}

async fn recipe_read(State(s): State<AppState>, Path(id): Path<i64>) -> Res<model::Recipe> {
    Ok(Json(
        on_db(&s, move |conn| {
            db::recipe_get(conn, id)?.ok_or_else(|| Error::not_found("recipe", id))
        })
        .await?,
    ))
}

async fn recipe_create(
    State(s): State<AppState>,
    Json(r): Json<RecipeInput>,
) -> Created<model::Recipe> {
    let r = r.checked()?;
    let recipe = on_db(&s, move |conn| db::recipe_save(conn, None, &r)).await?;
    Ok(created(recipe))
}

async fn recipe_update(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    Replace(r): Replace<RecipeInput>,
) -> Res<model::Recipe> {
    let r = r.checked()?;
    Ok(Json(
        on_db(&s, move |conn| db::recipe_save(conn, Some(id), &r)).await?,
    ))
}

async fn meals(State(s): State<AppState>) -> Res<Vec<model::Meal>> {
    Ok(Json(on_db(&s, |conn| db::meal_list(conn)).await?))
}

async fn meal_read(State(s): State<AppState>, Path(id): Path<i64>) -> Res<model::Meal> {
    Ok(Json(
        on_db(&s, move |conn| {
            db::meal_get(conn, id)?.ok_or_else(|| Error::not_found("meal", id))
        })
        .await?,
    ))
}

async fn meal_create(State(s): State<AppState>, Json(m): Json<MealInput>) -> Created<model::Meal> {
    let m = m.checked()?;
    let meal = on_db(&s, move |conn| db::meal_save(conn, None, &m)).await?;
    Ok(created(meal))
}

async fn meal_update(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    Replace(m): Replace<MealInput>,
) -> Res<model::Meal> {
    let m = m.checked()?;
    Ok(Json(
        on_db(&s, move |conn| db::meal_save(conn, Some(id), &m)).await?,
    ))
}

/// A copy of a saved meal: 201 with it.
async fn meal_copy(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    Json(c): Json<model::CopyInput>,
) -> Created<model::Meal> {
    let c = c.checked()?;
    let copy = on_db(&s, move |conn| db::meal_copy(conn, id, c.uid.as_deref())).await?;
    Ok(created(copy))
}

async fn meal_delete(State(s): State<AppState>, Path(id): Path<i64>) -> Result<StatusCode, Error> {
    on_db(&s, move |conn| db::meal_delete(conn, id)).await?;
    Ok(StatusCode::NO_CONTENT)
}
