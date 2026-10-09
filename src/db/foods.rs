//! Foods, their servings, search, favourites, recipes and meals.

use super::prelude::*;

pub(super) const FOOD_COLS: &str = "id, name, brand, barcode, source, per100, cooked_g, archived, \
     rev, makes, instructions, category";

/// SET clauses writing category `?n`. `category_auto` means the importer
/// owns the field: an importer's write (`auto`) lands only then; a user's
/// changes it (clearing included) and is theirs from then on unless it
/// stayed the same.
fn category_sets(n: u8, auto: bool) -> String {
    if auto {
        format!("category = CASE WHEN category_auto THEN ?{n} ELSE category END")
    } else {
        format!(
            "category = ?{n},
             category_auto = CASE WHEN category IS ?{n} THEN category_auto ELSE 0 END"
        )
    }
}

pub(super) fn food_row(r: &Row) -> rusqlite::Result<Food> {
    Ok(Food {
        id: r.get(0)?,
        name: r.get(1)?,
        brand: r.get(2)?,
        barcode: r.get(3)?,
        source: r.get(4)?,
        per100: from_json(&r.get::<_, String>(5)?)?,
        cooked_g: r.get(6)?,
        archived: r.get(7)?,
        servings: Vec::new(),
        rev: r.get(8)?,
        makes: r.get(9)?,
        instructions: r.get(10)?,
        category: r.get(11)?,
    })
}

pub(super) fn with_servings(conn: &Connection, mut food: Food) -> rusqlite::Result<Food> {
    let mut stmt =
        conn.prepare_cached("SELECT label, grams FROM serving WHERE food_id = ? ORDER BY id")?;
    food.servings = stmt
        .query_map([food.id], |r| {
            Ok(Serving {
                label: r.get(0)?,
                grams: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(food)
}

pub fn food_get(conn: &Connection, id: i64) -> Result<Option<Food>, Error> {
    let food = conn
        .query_row(
            &format!("SELECT {FOOD_COLS} FROM food WHERE id = ?"),
            [id],
            food_row,
        )
        .optional()?;
    Ok(food.map(|f| with_servings(conn, f)).transpose()?)
}

pub fn food_by_barcode(conn: &Connection, barcode: &str) -> Result<Option<Food>, Error> {
    let food = conn
        .query_row(
            &format!("SELECT {FOOD_COLS} FROM food WHERE barcode = ?"),
            [barcode],
            food_row,
        )
        .optional()?;
    Ok(food.map(|f| with_servings(conn, f)).transpose()?)
}

/// Most foods a search returns.
pub(super) const SEARCH_LIMIT: usize = 50;
/// Most foods in a profile's recent list.
pub(super) const RECENT_LIMIT: usize = 20;

/// A food search for one profile. Nutrient rules are per 100 g in stored
/// units, keyed by registry keys the caller has validated.
#[derive(Debug, Clone)]
pub struct FoodQuery<'a> {
    pub q: &'a str,
    pub archived: bool,
    /// Databases to search; empty means all.
    pub sources: Vec<Source>,
    pub min: Vec<(&'static str, f64)>,
    pub max: Vec<(&'static str, f64)>,
    pub sort: Sort,
    /// Ranked by this profile's favourites and logging.
    pub profile: ProfileId,
    /// What's left of the day's targets, which [`Sort::Fit`] ranks by.
    pub left: Option<Macros>,
}

/// `LIKE` pattern text for `s`, its wildcards escaped with `\\`.
pub(super) fn like_escaped(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// Foods matching a query, at most [`SEARCH_LIMIT`]. Every word of `q` must appear in the
/// name or brand, in any order (or `q` is the exact barcode). A food without
/// a value for a nutrient rule fails it; sorting by a nutrient puts missing
/// values last.
pub fn food_search(conn: &Connection, query: &FoodQuery) -> Result<Vec<Food>, Error> {
    // Folded here once; each food folds its name and brand once in the subquery.
    let words: Vec<String> = query
        .q
        .split_whitespace()
        .map(|w| like_escaped(&w.to_lowercase()))
        .collect();
    let first = words.first().cloned().unwrap_or_default();
    let sources = if query.sources.is_empty() {
        Source::ALL.to_vec()
    } else {
        query.sources.clone()
    };
    let rules = |rules: &[(&str, f64)]| json(&rules.iter().copied().collect::<BTreeMap<_, _>>());
    // Fixed strings only: nothing from the request reaches the SQL text.
    let order = match query.sort {
        Sort::Relevance => {
            "EXISTS (SELECT 1 FROM favorite v WHERE v.food_id = f.id AND v.profile_id = ?8) DESC,
             source IN ('custom', 'recipe') DESC, e.last IS NULL, e.last DESC,"
        }
        Sort::Name => "",
        Sort::Energy => "energy IS NULL, energy,",
        Sort::Protein => "protein IS NULL, protein DESC,",
        Sort::ProteinPerKcal => "protein / energy IS NULL, protein / energy DESC,",
        // No score (no energy) last: scores are at least -1.
        Sort::Fit => {
            "coalesce(fit_score(energy, protein, json_extract(per100, '$.net_carbs'),
                 json_extract(per100, '$.fat'),
                 -- min(id) is one index seek; ORDER BY id LIMIT 1 scanned.
                 coalesce((SELECT grams FROM serving WHERE id =
                     (SELECT min(id) FROM serving s WHERE s.food_id = f.id)),
                     100),
                 l.le, l.lp, l.lc, l.lf), -9) DESC,"
        }
    };
    let left = query.left.unwrap_or_default();
    foods_with_servings(
        conn,
        &format!(
            "WITH l (le, lp, lc, lf) AS (SELECT ?9, ?10, ?11, ?12)
         SELECT {FOOD_COLS} FROM (
             SELECT *, json_extract(per100, '$.energy') AS energy,
                 json_extract(per100, '$.protein') AS protein,
                 fold(name) AS fname, fold(coalesce(brand, '')) AS fbrand
             FROM food
         ) f
         CROSS JOIN l
         LEFT JOIN (SELECT food_id, MAX(id) AS last FROM entry
                    WHERE profile_id = ?8 GROUP BY food_id) e
             ON e.food_id = f.id
         WHERE archived = ?3
             AND source IN (SELECT value FROM json_each(?4))
             AND (barcode = ?2 OR NOT EXISTS (SELECT 1 FROM json_each(?1) w
                 WHERE NOT (fname LIKE '%' || w.value || '%' ESCAPE '\\'
                     OR fbrand LIKE '%' || w.value || '%' ESCAPE '\\')))
             AND NOT EXISTS (SELECT 1 FROM json_each(?5) r
                 WHERE coalesce(json_extract(per100, '$.' || r.key) >= r.value, 0) = 0)
             AND NOT EXISTS (SELECT 1 FROM json_each(?6) r
                 WHERE coalesce(json_extract(per100, '$.' || r.key) <= r.value, 0) = 0)
         ORDER BY {order} fname LIKE ?7 ESCAPE '\\' DESC, name COLLATE NOCASE
         LIMIT {SEARCH_LIMIT}"
        ),
        params![
            json(&words),
            query.q,
            query.archived,
            json(&sources),
            rules(&query.min),
            rules(&query.max),
            format!("{first}%"),
            query.profile,
            left.energy,
            left.protein,
            left.net_carbs,
            left.fat,
        ],
    )
}

/// The foods `sql` selects (`FOOD_COLS` first), each with its servings.
pub(super) fn foods_with_servings(
    conn: &Connection,
    sql: &str,
    params: impl Params,
) -> Result<Vec<Food>, Error> {
    let mut stmt = conn.prepare_cached(sql)?;
    let foods = stmt
        .query_map(params, food_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(foods
        .into_iter()
        .map(|f| with_servings(conn, f))
        .collect::<rusqlite::Result<_>>()?)
}

/// Foods this profile logged, most recent first, archived ones left out.
pub fn food_recent(conn: &Connection, profile: ProfileId) -> Result<Vec<Food>, Error> {
    foods_with_servings(
        conn,
        &format!(
            "SELECT {FOOD_COLS} FROM food f
         JOIN (SELECT food_id, MAX(id) AS last FROM entry
               WHERE profile_id = ? AND food_id IS NOT NULL GROUP BY food_id) e
             ON e.food_id = f.id
         WHERE NOT archived
         ORDER BY e.last DESC
         LIMIT {RECENT_LIMIT}"
        ),
        [profile],
    )
}

pub(super) fn write_servings(
    tx: &Transaction,
    id: i64,
    servings: &[Serving],
) -> rusqlite::Result<()> {
    tx.execute("DELETE FROM serving WHERE food_id = ?", [id])?;
    let mut stmt =
        tx.prepare_cached("INSERT INTO serving (food_id, label, grams) VALUES (?, ?, ?)")?;
    for s in servings {
        stmt.execute(params![id, s.label, s.grams])?;
    }
    Ok(())
}

/// A barcode belongs to at most one food.
pub(super) fn barcode_free(
    conn: &Connection,
    barcode: Option<&str>,
    id: Option<i64>,
) -> Result<(), Error> {
    let Some(barcode) = barcode else {
        return Ok(());
    };
    let owner: Option<String> = conn
        .query_row(
            "SELECT name FROM food WHERE barcode = ?1 AND id IS NOT ?2",
            params![barcode, id],
            |r| r.get(0),
        )
        .optional()?;
    match owner {
        Some(name) => Err(Error::conflict(
            Conflict::BarcodeTaken,
            format!("barcode {barcode} already belongs to “{name}”"),
        )),
        None => Ok(()),
    }
}

pub fn food_insert(
    conn: &mut Connection,
    input: &FoodInput,
    source: Source,
) -> Result<Food, Error> {
    let tx = write(conn)?;
    barcode_free(&tx, input.barcode.as_deref(), None)?;
    tx.execute(
        "INSERT INTO food (name, brand, barcode, source, per100, archived, category, category_auto)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            input.name,
            input.brand,
            input.barcode,
            source,
            json(&input.per100),
            input.archived,
            input.category,
            // Open Food Facts' category is the importer's.
            source == Source::Off && input.category.is_some()
        ],
    )?;
    let id = tx.last_insert_rowid();
    write_servings(&tx, id, &input.servings)?;
    let food = written(food_get(&tx, id)?);
    tx.commit()?;
    Ok(food)
}

/// Update a plain food; a recipe id is not found here.
pub fn food_update(conn: &mut Connection, id: i64, input: &FoodInput) -> Result<Food, Error> {
    let tx = write(conn)?;
    // A recipe is changed only through `recipe_save`, which keeps its
    // nutrients computed from the ingredients: here it isn't found, whatever
    // the rev says.
    let old = food_get(&tx, id)?
        .filter(|f| f.source != Source::Recipe)
        .ok_or_else(|| Error::not_found("food", id))?;
    // Fineli's name and values are its own (a re-import would overwrite
    // them): only servings, the barcode and archiving are yours to change.
    if old.source == Source::Fineli
        // Total carbohydrate is derived from the rest, so it isn't compared.
        && (old.name != input.name
            || old.brand != input.brand
            || old.per100.without("carbs") != input.per100.without("carbs"))
    {
        return Err(Error::conflict(
            Conflict::BaseReadOnly,
            format!(
                "{} is from Fineli: its name and values can't change",
                old.name
            ),
        ));
    }
    barcode_free(&tx, input.barcode.as_deref(), Some(id))?;
    bump_rev(&tx, "food", "food", id, input.rev)?;
    tx.execute(
        &format!(
            "UPDATE food SET name = ?2, brand = ?3, barcode = ?4, per100 = ?5, archived = ?6,
                 {}
             WHERE id = ?1",
            category_sets(7, false)
        ),
        params![
            id,
            input.name,
            input.brand,
            input.barcode,
            json(&input.per100),
            input.archived,
            input.category
        ],
    )?;
    write_servings(&tx, id, &input.servings)?;
    refresh_dependents(&tx, id)?;
    let food = written(food_get(&tx, id)?);
    tx.commit()?;
    Ok(food)
}

/// Insert or update foods from Fineli, keyed by their Fineli id, in one
/// transaction. Updated foods keep their id, so diary entries, recipes and
/// meals using them stay linked. Archiving sticks, whether you or Fineli
/// (a withdrawn food) did it, and so do servings whose label isn't one of
/// `own_labels` (Fineli's): yours. Returns how
/// many foods were new.
pub fn food_upsert_fineli(
    conn: &mut Connection,
    foods: &[(i64, FoodInput)],
    own_labels: &[&str],
) -> Result<usize, Error> {
    let tx = write(conn)?;
    let mut added = 0;
    for (fineli_id, input) in foods {
        let existing: Option<i64> = tx
            .query_row(
                "SELECT id FROM food WHERE fineli_id = ?",
                [fineli_id],
                |r| r.get(0),
            )
            .optional()?;
        let id = if let Some(id) = existing {
            tx.execute(
                &format!(
                    "UPDATE food SET name = ?2, brand = ?3, per100 = ?4, archived = archived OR ?5,
                         rev = rev + 1, {}
                     WHERE id = ?1",
                    category_sets(6, true)
                ),
                params![
                    id,
                    input.name,
                    input.brand,
                    json(&input.per100),
                    input.archived,
                    input.category
                ],
            )?;
            id
        } else {
            tx.execute(
                "INSERT INTO food
                     (name, brand, source, per100, archived, fineli_id, category, category_auto)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    input.name,
                    input.brand,
                    Source::Fineli,
                    json(&input.per100),
                    input.archived,
                    fineli_id,
                    input.category,
                    // The importer owns it, even while it has none.
                    true
                ],
            )?;
            added += 1;
            tx.last_insert_rowid()
        };
        // Fineli's servings are updated in place, so their order (and with
        // it the default you chose) stays; new ones go last, withdrawn ones
        // go. Yours (other labels) are kept as they are.
        let labels: Vec<&str> = input.servings.iter().map(|s| s.label.as_str()).collect();
        tx.prepare_cached(
            "DELETE FROM serving WHERE food_id = ?1
                 AND label IN (SELECT value FROM json_each(?2))
                 AND label NOT IN (SELECT value FROM json_each(?3))",
        )?
        .execute(params![id, json(&own_labels), json(&labels)])?;
        for s in &input.servings {
            let n = tx
                .prepare_cached("UPDATE serving SET grams = ?3 WHERE food_id = ?1 AND label = ?2")?
                .execute(params![id, s.label, s.grams])?;
            if n == 0 {
                tx.prepare_cached("INSERT INTO serving (food_id, label, grams) VALUES (?, ?, ?)")?
                    .execute(params![id, s.label, s.grams])?;
            }
        }
        if existing.is_some() {
            refresh_dependents(&tx, id)?;
        }
    }
    tx.commit()?;
    Ok(added)
}

/// The profile's favorite foods by name, archived ones included: starring
/// is an explicit choice.
pub fn favorite_list(conn: &Connection, profile: ProfileId) -> Result<Vec<Food>, Error> {
    foods_with_servings(
        conn,
        &format!(
            "SELECT {FOOD_COLS} FROM food WHERE id IN
                 (SELECT food_id FROM favorite WHERE profile_id = ?)
             ORDER BY name COLLATE NOCASE"
        ),
        [profile],
    )
}

/// Star or unstar a food; both are idempotent.
pub fn favorite_set(
    conn: &Connection,
    profile: ProfileId,
    food_id: i64,
    on: bool,
) -> Result<(), Error> {
    if on {
        food_get(conn, food_id)?
            .ok_or_else(|| Error::invalid(format!("unknown food {food_id}")))?;
        conn.execute(
            "INSERT OR IGNORE INTO favorite (profile_id, food_id) VALUES (?, ?)",
            params![profile, food_id],
        )?;
    } else {
        conn.execute(
            "DELETE FROM favorite WHERE profile_id = ? AND food_id = ?",
            params![profile, food_id],
        )?;
    }
    Ok(())
}

// ------------------------------------------------------------- recipes

pub(super) fn item_rows(conn: &Connection, sql: &str, id: i64) -> rusqlite::Result<Vec<Item>> {
    let mut stmt = conn.prepare_cached(sql)?;
    stmt.query_map([id], |r| {
        Ok(Item {
            food_id: r.get(0)?,
            grams: r.get(1)?,
            name: r.get(2)?,
            source: r.get(3)?,
            per100: from_json(&r.get::<_, String>(4)?)?,
        })
    })?
    .collect()
}

pub(super) const RECIPE_ITEMS: &str = "SELECT i.food_id, i.grams, f.name, f.source, f.per100
     FROM recipe_item i
     JOIN food f ON f.id = i.food_id WHERE i.recipe_id = ? ORDER BY i.rowid";

pub fn recipe_get(conn: &Connection, id: i64) -> Result<Option<Recipe>, Error> {
    match food_get(conn, id)? {
        Some(food) if food.source == Source::Recipe => Ok(Some(Recipe {
            items: item_rows(conn, RECIPE_ITEMS, id)?,
            food,
        })),
        _ => Ok(None),
    }
}

pub(super) fn food_exists(conn: &Connection, id: i64) -> Result<(), Error> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM food WHERE id = ?)",
        [id],
        |r| r.get(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(Error::invalid(format!("unknown food {id}")))
    }
}

/// Does `haystack` (transitively) use `needle` as an ingredient?
pub(super) fn uses(conn: &Connection, haystack: i64, needle: i64) -> rusqlite::Result<bool> {
    conn.query_row(
        "WITH RECURSIVE sub(id) AS (
             SELECT ?1 UNION SELECT food_id FROM recipe_item JOIN sub ON recipe_id = sub.id
         ) SELECT EXISTS (SELECT 1 FROM sub WHERE id = ?2)",
        [haystack, needle],
        |r| r.get(0),
    )
}

/// Per-100 g nutrients of a recipe from its ingredients.
pub fn recipe_per100(parts: &[(Nutrients, f64)], cooked_g: Option<f64>) -> Nutrients {
    let total: f64 = parts.iter().map(|(_, g)| g).sum();
    let weight = cooked_g.unwrap_or(total);
    if weight <= 0.0 {
        return Nutrients::default();
    }
    let sum = Nutrients::sum(
        &parts
            .iter()
            .map(|(p, g)| p.scale(g / 100.0))
            .collect::<Vec<_>>(),
    );
    sum.scale(100.0 / weight)
}

pub(super) fn recompute(tx: &Transaction, recipe_id: i64) -> rusqlite::Result<()> {
    let mut stmt = tx.prepare_cached(
        "SELECT f.per100, i.grams FROM recipe_item i
         JOIN food f ON f.id = i.food_id WHERE i.recipe_id = ?",
    )?;
    let parts = stmt
        .query_map([recipe_id], |r| {
            Ok((from_json(&r.get::<_, String>(0)?)?, r.get(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let cooked_g: Option<f64> =
        tx.query_row("SELECT cooked_g FROM food WHERE id = ?", [recipe_id], |r| {
            r.get(0)
        })?;
    tx.execute(
        "UPDATE food SET per100 = ? WHERE id = ?",
        params![json(&recipe_per100(&parts, cooked_g)), recipe_id],
    )?;
    let weight = cooked_g.unwrap_or_else(|| parts.iter().map(|(_, g): &(Nutrients, f64)| g).sum());
    let n = tx.execute(
        "UPDATE serving SET grams = ?3 WHERE food_id = ?1 AND label = ?2",
        params![recipe_id, WHOLE_RECIPE, weight],
    )?;
    if n == 0 {
        // A recipe saved before the serving existed: it goes first.
        let mut servings = vec![Serving {
            label: WHOLE_RECIPE.to_owned(),
            grams: weight,
        }];
        // Plain queries only: this also runs inside old migrations.
        let mut stmt =
            tx.prepare_cached("SELECT label, grams FROM serving WHERE food_id = ? ORDER BY id")?;
        for s in stmt.query_map([recipe_id], |r| {
            Ok(Serving {
                label: r.get(0)?,
                grams: r.get(1)?,
            })
        })? {
            servings.push(s?);
        }
        write_servings(tx, recipe_id, &servings)?;
    }
    Ok(())
}

/// Recompute every recipe, ingredients first.
pub(super) fn recompute_all_recipes(tx: &Transaction) -> rusqlite::Result<()> {
    let leaves: Vec<i64> = tx
        .prepare("SELECT id FROM food WHERE source != ?")?
        .query_map([Source::Recipe], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in leaves {
        recompute_dependents(tx, id)?;
    }
    Ok(())
}

/// Recompute every recipe that (transitively) uses `food_id`.
/// Terminates because saving a cyclic recipe is rejected.
// ponytail: visits each dependent once per path, 2^depth on diamond-shaped
// recipe graphs (~350 ms at depth 14, <1 ms at realistic depth ≤3); collect
// dependents with a recursive CTE and recompute in depth order if that bites.
pub(super) fn recompute_dependents(tx: &Transaction, food_id: i64) -> rusqlite::Result<()> {
    for parent in parents(tx, food_id)? {
        recompute(tx, parent)?;
        recompute_dependents(tx, parent)?;
    }
    Ok(())
}

/// The recipes holding `food_id` directly.
fn parents(tx: &Transaction, food_id: i64) -> rusqlite::Result<Vec<i64>> {
    tx.prepare_cached("SELECT DISTINCT recipe_id FROM recipe_item WHERE food_id = ?")?
        .query_map([food_id], |r| r.get(0))?
        .collect()
}

/// [`recompute_dependents`] for a running server: each recipe's
/// [`PORTION`] follows too. Migrations use the plain one, so they never
/// depend on what `makes` means.
pub(super) fn refresh_dependents(tx: &Transaction, food_id: i64) -> rusqlite::Result<()> {
    for parent in parents(tx, food_id)? {
        recompute(tx, parent)?;
        sync_portion(tx, parent)?;
        refresh_dependents(tx, parent)?;
    }
    Ok(())
}

/// Keep a recipe's [`PORTION`] serving at its weight ÷ `makes`: added last
/// when missing, removed when it makes no number of portions. Call after
/// [`recompute`], which sets the weight.
pub(super) fn sync_portion(tx: &Transaction, recipe_id: i64) -> rusqlite::Result<()> {
    let (makes, weight): (Option<u32>, Option<f64>) = tx.query_row(
        "SELECT makes, (SELECT grams FROM serving WHERE food_id = ?1 AND label = ?2)
         FROM food WHERE id = ?1",
        params![recipe_id, WHOLE_RECIPE],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let (Some(makes), Some(weight)) = (makes, weight) else {
        tx.execute(
            "DELETE FROM serving WHERE food_id = ? AND label = ?",
            params![recipe_id, PORTION],
        )?;
        return Ok(());
    };
    let grams = weight / f64::from(makes);
    let n = tx.execute(
        "UPDATE serving SET grams = ?3 WHERE food_id = ?1 AND label = ?2",
        params![recipe_id, PORTION, grams],
    )?;
    if n == 0 {
        tx.execute(
            "INSERT INTO serving (food_id, label, grams) VALUES (?, ?, ?)",
            params![recipe_id, PORTION, grams],
        )?;
    }
    Ok(())
}

/// Create (`id = None`) or replace a recipe.
pub fn recipe_save(
    conn: &mut Connection,
    id: Option<i64>,
    input: &RecipeInput,
) -> Result<Recipe, Error> {
    let tx = write(conn)?;
    let id = if let Some(id) = id {
        if recipe_get(&tx, id)?.is_none() {
            return Err(Error::not_found("recipe", id));
        }
        bump_rev(&tx, "food", "recipe", id, input.rev)?;
        let n = tx.execute(
            &format!(
                "UPDATE food SET name = ?2, cooked_g = ?3, archived = ?4, makes = ?6,
                     instructions = ?7, {}
                 WHERE id = ?1 AND source = ?5",
                category_sets(8, false)
            ),
            params![
                id,
                input.name,
                input.cooked_g,
                input.archived,
                Source::Recipe,
                input.makes,
                input.instructions,
                input.category
            ],
        )?;
        if n == 0 {
            return Err(Error::not_found("recipe", id));
        }
        id
    } else {
        tx.execute(
            "INSERT INTO food (name, source, cooked_g, archived, makes, instructions, category)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                input.name,
                Source::Recipe,
                input.cooked_g,
                input.archived,
                input.makes,
                input.instructions,
                input.category
            ],
        )?;
        tx.last_insert_rowid()
    };
    tx.execute("DELETE FROM recipe_item WHERE recipe_id = ?", [id])?;
    for item in &input.items {
        food_exists(&tx, item.food_id)?;
        if uses(&tx, item.food_id, id)? {
            return Err(Error::invalid("a recipe cannot contain itself"));
        }
        tx.execute(
            "INSERT INTO recipe_item (recipe_id, food_id, grams) VALUES (?, ?, ?)",
            params![id, item.food_id, item.grams],
        )?;
    }
    // "Whole recipe" stays where it was put, first when it wasn't sent;
    // `recompute` sets its grams.
    let mut servings = input.servings.clone();
    if !servings.iter().any(|s| s.label == WHOLE_RECIPE) {
        servings.insert(
            0,
            Serving {
                label: WHOLE_RECIPE.to_owned(),
                grams: 1.0,
            },
        );
    }
    write_servings(&tx, id, &servings)?;
    recompute(&tx, id)?;
    sync_portion(&tx, id)?;
    refresh_dependents(&tx, id)?;
    let recipe = written(recipe_get(&tx, id)?);
    tx.commit()?;
    Ok(recipe)
}

// --------------------------------------------------------------- meals

pub(super) const MEAL_ITEMS: &str = "SELECT i.food_id, i.grams, f.name, f.source, f.per100
     FROM meal_item i
     JOIN food f ON f.id = i.food_id WHERE i.meal_id = ? ORDER BY i.rowid";

pub fn meal_list(conn: &Connection) -> Result<Vec<Meal>, Error> {
    let ids: Vec<i64> = conn
        .prepare_cached("SELECT id FROM meal ORDER BY name COLLATE NOCASE")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    ids.into_iter()
        .map(|id| Ok(written(meal_get(conn, id)?)))
        .collect()
}

pub fn meal_get(conn: &Connection, id: i64) -> Result<Option<Meal>, Error> {
    let head: Option<(String, i64)> = conn
        .query_row("SELECT name, rev FROM meal WHERE id = ?", [id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    head.map(|(name, rev)| {
        Ok(Meal {
            id,
            name,
            items: item_rows(conn, MEAL_ITEMS, id)?,
            rev,
        })
    })
    .transpose()
}

pub fn meal_save(conn: &mut Connection, id: Option<i64>, input: &MealInput) -> Result<Meal, Error> {
    let tx = write(conn)?;
    let id = if let Some(id) = id {
        bump_rev(&tx, "meal", "meal", id, input.rev)?;
        tx.execute(
            "UPDATE meal SET name = ? WHERE id = ?",
            params![input.name, id],
        )?;
        id
    } else {
        tx.execute("INSERT INTO meal (name) VALUES (?)", [&input.name])?;
        tx.last_insert_rowid()
    };
    tx.execute("DELETE FROM meal_item WHERE meal_id = ?", [id])?;
    for item in &input.items {
        food_exists(&tx, item.food_id)?;
        tx.execute(
            "INSERT INTO meal_item (meal_id, food_id, grams) VALUES (?, ?, ?)",
            params![id, item.food_id, item.grams],
        )?;
    }
    let meal = written(meal_get(&tx, id)?);
    tx.commit()?;
    Ok(meal)
}

pub fn meal_delete(conn: &Connection, id: i64) -> Result<(), Error> {
    match conn.execute("DELETE FROM meal WHERE id = ?", [id])? {
        0 => Err(Error::not_found("meal", id)),
        _ => Ok(()),
    }
}

// --------------------------------------------------------------- merge

/// What uses food `id`; 404 when there's no such food.
pub fn food_usage(conn: &Connection, id: i64) -> Result<Usage, Error> {
    food_get(conn, id)?.ok_or_else(|| Error::not_found("food", id))?;
    Ok(conn.query_row(
        "SELECT (SELECT count(*) FROM entry WHERE food_id = ?1),
             (SELECT count(DISTINCT recipe_id) FROM recipe_item WHERE food_id = ?1),
             (SELECT count(DISTINCT meal_id) FROM meal_item WHERE food_id = ?1),
             (SELECT count(*) FROM favorite WHERE food_id = ?1)",
        [id],
        |r| {
            Ok(Usage {
                entries: r.get(0)?,
                recipes: r.get(1)?,
                meals: r.get(2)?,
                favorites: r.get(3)?,
            })
        },
    )?)
}

/// Merge food `input.from` (B) into `id` (A): everything using B uses A
/// (a profile's water food too), then B is deleted. Diary entries keep the values they were logged with;
/// recipes using B are recalculated with A's. B's barcode moves to A when A
/// has none, and B's servings A lacks (by label) are added after A's. A
/// recipe or meal that now holds A twice holds it once, the grams summed.
/// Recipes and meals that changed move on a `rev`.
///
/// # Errors
/// - 404 A, or 409 `stale` (`rev` is A's);
/// - 400 `from`: B is A, unknown, or only one of the two is a recipe; A
///   uses B;
/// - 409 `base_read_only` when B is from Fineli (merge the other way), 409
///   `barcode_taken` when both have a barcode.
pub fn food_merge(conn: &mut Connection, id: i64, input: &MergeInput) -> Result<Food, Error> {
    let tx = write(conn)?;
    let into = food_get(&tx, id)?.ok_or_else(|| Error::not_found("food", id))?;
    let from = match food_get(&tx, input.from)? {
        Some(f) if f.id != id => f,
        Some(_) => {
            return Err(Error::invalid_field(
                "from",
                "a food can't merge into itself",
            ));
        }
        None => {
            return Err(Error::invalid_field(
                "from",
                format!("unknown food {}", input.from),
            ));
        }
    };
    merge_refused(&tx, &into, &from)?;
    bump_rev(&tx, "food", "food", id, input.rev)?;
    take_barcode_and_servings(&tx, &into, &from)?;
    // ?1 is A, ?2 is B.
    for sql in [
        "UPDATE food SET rev = rev + 1
             WHERE id IN (SELECT recipe_id FROM recipe_item WHERE food_id = ?2)",
        "UPDATE meal SET rev = rev + 1
             WHERE id IN (SELECT meal_id FROM meal_item WHERE food_id = ?2)",
        "UPDATE entry SET food_id = ?1 WHERE food_id = ?2",
        "INSERT OR IGNORE INTO favorite (profile_id, food_id)
             SELECT profile_id, ?1 FROM favorite WHERE food_id = ?2",
        "UPDATE recipe_item SET food_id = ?1 WHERE food_id = ?2",
        "UPDATE meal_item SET food_id = ?1 WHERE food_id = ?2",
        "UPDATE profile SET water_food_id = ?1 WHERE water_food_id = ?2",
    ] {
        tx.prepare_cached(sql)?.execute(params![id, from.id])?;
    }
    // A recipe or meal holding A twice: the first row gets the grams of all.
    for sql in [
        "UPDATE recipe_item SET grams = (SELECT sum(grams) FROM recipe_item t
                 WHERE t.recipe_id = recipe_item.recipe_id AND t.food_id = ?1)
             WHERE food_id = ?1 AND rowid = (SELECT min(rowid) FROM recipe_item t
                 WHERE t.recipe_id = recipe_item.recipe_id AND t.food_id = ?1)",
        "DELETE FROM recipe_item WHERE food_id = ?1 AND rowid != (SELECT min(rowid)
             FROM recipe_item t WHERE t.recipe_id = recipe_item.recipe_id AND t.food_id = ?1)",
        "UPDATE meal_item SET grams = (SELECT sum(grams) FROM meal_item t
                 WHERE t.meal_id = meal_item.meal_id AND t.food_id = ?1)
             WHERE food_id = ?1 AND rowid = (SELECT min(rowid) FROM meal_item t
                 WHERE t.meal_id = meal_item.meal_id AND t.food_id = ?1)",
        "DELETE FROM meal_item WHERE food_id = ?1 AND rowid != (SELECT min(rowid)
             FROM meal_item t WHERE t.meal_id = meal_item.meal_id AND t.food_id = ?1)",
    ] {
        tx.prepare_cached(sql)?.execute([id])?;
    }
    // Its favourites, servings and own items go with it.
    tx.execute("DELETE FROM favorite WHERE food_id = ?", [from.id])?;
    tx.execute("DELETE FROM food WHERE id = ?", [from.id])?;
    refresh_dependents(&tx, id)?;
    let food = written(food_get(&tx, id)?);
    tx.commit()?;
    Ok(food)
}

/// Why B (`from`) can't merge into A (`into`), if it can't; see
/// [`food_merge`].
fn merge_refused(tx: &Transaction, into: &Food, from: &Food) -> Result<(), Error> {
    if from.source == Source::Fineli {
        return Err(Error::conflict(
            Conflict::BaseReadOnly,
            format!("{} is from Fineli: merge it the other way", from.name),
        ));
    }
    if into.barcode.is_some() && from.barcode.is_some() {
        return Err(Error::conflict(
            Conflict::BarcodeTaken,
            "both foods have a barcode: remove one first",
        ));
    }
    if (into.source == Source::Recipe) != (from.source == Source::Recipe) {
        return Err(Error::invalid_field(
            "from",
            "a recipe merges only with another recipe",
        ));
    }
    if uses(tx, into.id, from.id)? {
        return Err(Error::invalid_field(
            "from",
            "a recipe cannot contain itself",
        ));
    }
    Ok(())
}

/// A takes B's barcode when it has none, and B's servings whose labels
/// (ignoring case) it lacks, after its own, up to [`SERVINGS_MAX`]. The
/// recipe servings stay the server's.
fn take_barcode_and_servings(tx: &Transaction, into: &Food, from: &Food) -> rusqlite::Result<()> {
    if into.barcode.is_none() && from.barcode.is_some() {
        tx.execute("UPDATE food SET barcode = NULL WHERE id = ?", [from.id])?;
        tx.execute(
            "UPDATE food SET barcode = ? WHERE id = ?",
            params![from.barcode, into.id],
        )?;
    }
    let mut labels: Vec<String> = into
        .servings
        .iter()
        .map(|s| s.label.to_lowercase())
        .collect();
    for s in &from.servings {
        let label = s.label.to_lowercase();
        if labels.len() >= SERVINGS_MAX
            || labels.contains(&label)
            || [WHOLE_RECIPE, PORTION].contains(&s.label.as_str())
        {
            continue;
        }
        tx.execute(
            "INSERT INTO serving (food_id, label, grams) VALUES (?, ?, ?)",
            params![into.id, s.label, s.grams],
        )?;
        labels.push(label);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ItemInput;

    fn grams_of(food: &Food, label: &str) -> Option<f64> {
        food.servings
            .iter()
            .find(|s| s.label == label)
            .map(|s| s.grams)
    }

    /// Migrations recompute recipes with the plain `recompute`: `makes`
    /// means nothing to them, so the Portion stays as the server left it.
    #[test]
    fn a_migration_recompute_leaves_the_portion_alone() {
        let mut conn = super::super::open(Path::new(":memory:")).unwrap();
        let oats = FoodInput {
            name: "Oats".into(),
            per100: Nutrients::of(&[("energy", 380.0)]),
            ..FoodInput::default()
        };
        let oats = food_insert(&mut conn, &oats, Source::Custom).unwrap();
        let porridge = RecipeInput {
            name: "Porridge".into(),
            cooked_g: None,
            makes: Some(4),
            items: vec![ItemInput {
                food_id: oats.id,
                grams: 400.0,
            }],
            servings: vec![],
            archived: false,
            instructions: None,
            category: None,
            rev: None,
        };
        let id = recipe_save(&mut conn, None, &porridge).unwrap().food.id;
        conn.execute("UPDATE recipe_item SET grams = 800", [])
            .unwrap();
        let tx = write(&mut conn).unwrap();
        recompute_all_recipes(&tx).unwrap();
        tx.commit().unwrap();
        let after = food_get(&conn, id).unwrap().unwrap();
        assert_eq!(grams_of(&after, WHOLE_RECIPE), Some(800.0));
        assert_eq!(grams_of(&after, PORTION), Some(100.0));
    }
}
