//! Foods, their servings, search, favourites, recipes and meals.

use super::prelude::*;
use crate::model::copied;
use crate::model::{
    Borne, Facts, Hydration, Known, Labels, Part, Scoring, borne_of, drink_by_kind, labels,
    recipe_cover, stored_labels, sweetened,
};

/// A food's stored labels (`food_label`) as a JSON array, for `food_id`.
macro_rules! labels_of {
    ($food_id:literal) => {
        concat!(
            "(SELECT json_group_array(label) FROM food_label WHERE food_id = ",
            $food_id,
            ")"
        )
    };
}

pub(super) const FOOD_COLS: &str = concat!(
    "id, name, brand, barcode, source, per100, cooked_g, archived, \
     rev, makes, notes, category, basis, basis_estimated, kind, drink, fineli_class, ",
    labels_of!("id")
);

/// Labels read as stored ([`labels_of!`]): what search filters by, so every
/// view agrees with it (a recipe's are judged with its coverage).
fn labels_at(r: &Row, i: usize) -> rusqlite::Result<Labels> {
    Ok(stored_labels(&from_json::<Vec<String>>(
        &r.get::<_, String>(i)?,
    )?))
}

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
    let estimated = r.get(13)?;
    let per100: Nutrients = from_json(&r.get::<_, String>(5)?)?;
    let (drink, source, name): (bool, Source, String) = (r.get(15)?, r.get(4)?, r.get(1)?);
    Ok(Food {
        labels: labels_at(r, 17)?,
        known: Known::new(),
        entries_updated: None,
        hydration: Hydration::of(&per100, drink),
        borne: borne_of(
            &per100,
            &Facts {
                drink,
                source,
                class: r.get::<_, Option<String>>(16)?.as_deref(),
                name: &name,
            },
        ),
        drink,
        id: r.get(0)?,
        name,
        brand: r.get(2)?,
        barcode: r.get(3)?,
        source,
        kind: r.get(14)?,
        per100,
        cooked_g: r.get(6)?,
        archived: r.get(7)?,
        servings: Vec::new(),
        rev: r.get(8)?,
        makes: r.get(9)?,
        notes: r.get(10)?,
        category: r.get(11)?,
        basis: r
            .get::<_, Option<String>>(12)?
            .map(|serving| Basis { serving, estimated }),
    })
}

/// `food` with its servings, and a recipe's coverage and hydration
/// through its parts.
pub(super) fn with_servings(conn: &Connection, mut food: Food) -> Result<Food, Error> {
    food.servings = servings_of(conn, food.id)?;
    if food.kind == FoodKind::Recipe {
        (food.known, food.borne) = recipe_cover_of(conn, food.id, &mut BTreeMap::new())?;
        let h = super::recipe_hydration(conn, food.id, &mut BTreeMap::new())?;
        food.hydration = h
            .known()
            .then(|| Hydration::from_parts(h.water * 100.0, h.alcohol * 100.0));
    }
    Ok(food)
}

fn servings_of(conn: &Connection, food_id: i64) -> rusqlite::Result<Vec<Serving>> {
    conn.prepare_cached("SELECT label, grams FROM serving WHERE food_id = ? ORDER BY id")?
        .query_map([food_id], |r| {
            Ok(Serving {
                label: r.get(0)?,
                grams: r.get(1)?,
            })
        })?
        .collect()
}

pub fn food_get(conn: &Connection, id: i64) -> Result<Option<Food>, Error> {
    let food = conn
        .query_row(
            &format!("SELECT {FOOD_COLS} FROM food WHERE id = ?"),
            [id],
            food_row,
        )
        .optional()?;
    food.map(|f| with_servings(conn, f)).transpose()
}

pub fn food_by_barcode(conn: &Connection, barcode: &str) -> Result<Option<Food>, Error> {
    let food = conn
        .query_row(
            &format!("SELECT {FOOD_COLS} FROM food WHERE barcode = ?"),
            [barcode],
            food_row,
        )
        .optional()?;
    food.map(|f| with_servings(conn, f)).transpose()
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
    /// What to search; empty means all.
    pub sources: Vec<FoodScope>,
    pub min: Vec<(&'static str, f64)>,
    pub max: Vec<(&'static str, f64)>,
    pub sort: Sort,
    /// Ranked by this profile's favourites and logging.
    pub profile: ProfileId,
    /// What's left of the day's targets, which [`Sort::Fit`] ranks by.
    pub left: Option<Macros>,
    /// Labels every food found has (keys of the vocabulary).
    pub labels: Vec<&'static str>,
}

/// `LIKE` pattern text for `s`, its wildcards escaped with `\\`.
pub(super) fn like_escaped(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// Foods matching a query, at most [`SEARCH_LIMIT`]. Every word of `q` must
/// appear in the name or brand, in any order (or `q` is the exact barcode). A
/// food without a value for a nutrient rule fails it; sorting by a nutrient
/// puts missing values last.
pub fn food_search(conn: &Connection, query: &FoodQuery) -> Result<Vec<Food>, Error> {
    // Folded here once; each food folds its name and brand once in the
    // subquery.
    let words: Vec<String> = query
        .q
        .split_whitespace()
        .map(|w| like_escaped(&w.to_lowercase()))
        .collect();
    let first = words.first().cloned().unwrap_or_default();
    let sources = if query.sources.is_empty() {
        FoodScope::ALL.to_vec()
    } else {
        query.sources.clone()
    };
    let rules = |rules: &[(&str, f64)]| json(&rules.iter().copied().collect::<BTreeMap<_, _>>());
    // Fixed strings only: nothing from the request reaches the SQL text.
    let order = match query.sort {
        Sort::Relevance => {
            "EXISTS (SELECT 1 FROM favorite v WHERE v.food_id = f.id AND v.profile_id = ?8) DESC,
             source = 'custom' DESC, e.last IS NULL, e.last DESC,"
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
             AND CASE kind WHEN 'recipe' THEN 'recipe' ELSE source END
                 IN (SELECT value FROM json_each(?4))
             AND (barcode = ?2 OR NOT EXISTS (SELECT 1 FROM json_each(?1) w
                 WHERE NOT (fname LIKE '%' || w.value || '%' ESCAPE '\\'
                     OR fbrand LIKE '%' || w.value || '%' ESCAPE '\\')))
             AND NOT EXISTS (SELECT 1 FROM json_each(?5) r
                 WHERE coalesce(json_extract(per100, '$.' || r.key) >= r.value, 0) = 0)
             AND NOT EXISTS (SELECT 1 FROM json_each(?6) r
                 WHERE coalesce(json_extract(per100, '$.' || r.key) <= r.value, 0) = 0)
             AND NOT EXISTS (SELECT 1 FROM json_each(?13) l
                 WHERE NOT EXISTS (SELECT 1 FROM food_label fl
                     WHERE fl.label = l.value AND fl.food_id = f.id))
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
            json(&query.labels),
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
    foods.into_iter().map(|f| with_servings(conn, f)).collect()
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

/// Items of food `id` measured by a serving that went or whose grams
/// changed (`before` → `after`) read as their grams from now on: they keep
/// what they count, and a later save can't recount them.
fn unlink_servings(
    tx: &Transaction,
    id: i64,
    before: &[Serving],
    after: &[Serving],
) -> rusqlite::Result<()> {
    for old in before {
        let same = |s: &Serving| s.label == old.label && s.grams.to_bits() == old.grams.to_bits();
        if after.iter().any(same) {
            continue;
        }
        for table in ["recipe_item", "meal_item", "daily_item"] {
            tx.execute(
                &format!(
                    "UPDATE {table} SET serving = NULL, quantity = NULL
                     WHERE food_id = ?1 AND serving = ?2"
                ),
                params![id, old.label],
            )?;
        }
    }
    Ok(())
}

/// The row of `table` a create naming `uid` made before, if one
/// did: a retried create answers it instead of making another.
pub(super) fn created_before(
    conn: &Connection,
    table: &str,
    uid: Option<&str>,
) -> rusqlite::Result<Option<i64>> {
    let Some(uid) = uid else {
        return Ok(None);
    };
    conn.prepare_cached(&format!("SELECT id FROM {table} WHERE uid = ?"))?
        .query_row([uid], |r| r.get(0))
        .optional()
}

/// A uid a create of another kind took (a food's sent to make a recipe).
pub(super) fn uid_elsewhere() -> Error {
    Error::invalid_field("uid", "uid names a record of another kind")
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

/// A new food row for `input` from `source`, with its servings (its
/// barcode checked free by the caller); the API's create and an import's
/// both make it here.
pub(super) fn insert_food(
    tx: &Transaction,
    input: &FoodInput,
    source: Source,
) -> Result<i64, Error> {
    let by_kind = drink_by_kind(
        &input.name,
        input.category.as_deref(),
        &input.servings,
        &input.per100,
    );
    // An importer's word is the derived value; yours is yours where it
    // differs from that.
    let (drink, drink_set) = match (source, input.drink) {
        (Source::Custom, Some(d)) if d != by_kind => (d, true),
        (Source::Custom, _) => (by_kind, false),
        (_, d) => (by_kind || d == Some(true), false),
    };
    tx.execute(
        "INSERT INTO food (name, brand, barcode, source, per100, archived, category, category_auto,
             basis, basis_estimated, drink, drink_set, uid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            input.name,
            input.brand,
            input.barcode,
            source,
            json(&input.per100),
            input.archived,
            input.category,
            // Open Food Facts' category is the importer's.
            source == Source::Off && input.category.is_some(),
            input.basis.as_ref().map(|b| &b.serving),
            input.basis.as_ref().is_some_and(|b| b.estimated),
            drink,
            drink_set,
            input.uid
        ],
    )?;
    let id = tx.last_insert_rowid();
    write_servings(tx, id, &input.servings)?;
    derive(tx, id)?;
    Ok(id)
}

/// SET clauses for the drink flag `col` sent as `?n` (`NULL`:
/// not said): sent and different from what it is, it's set by hand.
fn flag_sets(col: &str, n: u8) -> String {
    format!(
        "{col} = CASE WHEN ?{n} IS NOT NULL AND ?{n} != {col} THEN ?{n} ELSE {col} END,
         {col}_set = {col}_set OR (?{n} IS NOT NULL AND ?{n} != {col})"
    )
}

/// Food `id`'s derived fields, after a write of its values or flags: its
/// stored labels.
pub(super) fn derive(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    relabel(conn, id)
}

/// Rewrite food `id`'s stored labels from its values, its category (fruit
/// & veg) and its name (a drink's sweeteners).
fn relabel(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    let (per100, drink, kind, veg, name): (String, bool, FoodKind, bool, String) = conn
        .prepare_cached(
            "SELECT per100, drink, kind, category IS 'fruit_veg', name FROM food WHERE id = ?",
        )?
        .query_row([id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?;
    // A recipe's labels judge what its parts prove (ADR 0030), and its
    // fruit & veg is theirs.
    let (known, fruit_veg) = match kind {
        FoodKind::Recipe => (
            recipe_cover_of(conn, id, &mut BTreeMap::new())?.0,
            fruit_veg_share(conn, id, &mut BTreeMap::new())?,
        ),
        FoodKind::Food => (Known::new(), f64::from(u8::from(veg))),
    };
    let scoring = Scoring {
        drink,
        fruit_veg,
        sweetened: sweetened(&name),
    };
    conn.prepare_cached("DELETE FROM food_label WHERE food_id = ?")?
        .execute([id])?;
    let mut insert =
        conn.prepare_cached("INSERT INTO food_label (food_id, label) VALUES (?, ?)")?;
    for key in labels(&from_json(&per100)?, &scoring, &known).keys() {
        insert.execute(params![id, key])?;
    }
    Ok(())
}

/// Every food labelled again by this build's rules (`DERIVED`'s labels,
/// stamped `model::LABEL_RULES_VERSION`: a rules change, or a migration that
/// clears the version, reaches every food). How many foods.
pub(super) fn labels_refresh(tx: &Transaction) -> Result<usize, Error> {
    let ids: Vec<i64> = tx
        .prepare("SELECT id FROM food")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for &id in &ids {
        relabel(tx, id)?;
    }
    Ok(ids.len())
}

pub fn food_insert(
    conn: &mut Connection,
    input: &FoodInput,
    source: Source,
) -> Result<Food, Error> {
    let tx = write(conn)?;
    if let Some(id) = created_before(&tx, "food", input.uid.as_deref())? {
        return Ok(written(food_get(&tx, id)?));
    }
    barcode_free(&tx, input.barcode.as_deref(), None)?;
    let id = insert_food(&tx, input, source)?;
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
        .filter(|f| f.kind != FoodKind::Recipe)
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
    if old.source == Source::Fineli && input.basis.is_some() {
        return Err(Error::invalid_field(
            "basis",
            format!("{} is from Fineli: its values are per 100 g", old.name),
        ));
    }
    barcode_free(&tx, input.barcode.as_deref(), Some(id))?;
    bump_rev(&tx, "food", "food", id, input.rev)?;
    tx.execute(
        &format!(
            "UPDATE food SET name = ?2, brand = ?3, barcode = ?4, per100 = ?5, archived = ?6,
                 basis = ?8, basis_estimated = ?9, {}, {}
             WHERE id = ?1",
            category_sets(7, false),
            flag_sets("drink", 10)
        ),
        params![
            id,
            input.name,
            input.brand,
            input.barcode,
            json(&input.per100),
            input.archived,
            input.category,
            input.basis.as_ref().map(|b| &b.serving),
            input.basis.as_ref().is_some_and(|b| b.estimated),
            input.drink
        ],
    )?;
    // Not set by hand, a drink stays one, and becomes one by its kind.
    if drink_by_kind(
        &input.name,
        input.category.as_deref(),
        &input.servings,
        &input.per100,
    ) {
        tx.execute(
            "UPDATE food SET drink = 1 WHERE id = ? AND NOT drink_set",
            [id],
        )?;
    }
    derive(&tx, id)?;
    write_servings(&tx, id, &input.servings)?;
    unlink_servings(&tx, id, &old.servings, &input.servings)?;
    let updated = entries_follow(&tx, id)? + refresh_dependents(&tx, id)?;
    renamed_entries(&tx, id, &old.name, &input.name)?;
    let food = Food {
        entries_updated: Some(updated),
        ..written(food_get(&tx, id)?)
    };
    tx.commit()?;
    Ok(food)
}

/// A rename of yours reaches the entries logged under the old name (every
/// profile's; imported history has no food). Only the name: their amounts
/// stay as logged (their values follow the food, [`entries_follow`]). An
/// importer's rename (Fineli) doesn't come here (ADR 0006).
fn renamed_entries(tx: &Transaction, id: i64, old: &str, new: &str) -> Result<(), Error> {
    if old != new {
        tx.execute(
            "UPDATE entry SET name = ?1 WHERE food_id = ?2 AND src_grp IS NULL AND name = ?3",
            params![new, id, old],
        )?;
    }
    Ok(())
}

/// Insert or update foods from Fineli, keyed by their Fineli id, in one
/// transaction. Updated foods keep their id, so diary entries, recipes and
/// meals using them stay linked. Archiving sticks, whether you or Fineli
/// (a withdrawn food) did it, and so do servings whose label isn't one of
/// `own_labels` (Fineli's): yours. Each food's ingredient class is set
/// from `classes` (by Fineli id) in the same transaction. Returns how many
/// foods were new.
pub fn food_upsert_fineli(
    conn: &mut Connection,
    foods: &[(i64, FoodInput)],
    own_labels: &[&str],
    classes: &[(i64, String)],
) -> Result<usize, Error> {
    let tx = write(conn)?;
    let mut added = 0;
    for (fineli_id, input) in foods {
        let drink = input.drink == Some(true)
            || drink_by_kind(
                &input.name,
                input.category.as_deref(),
                &input.servings,
                &input.per100,
            );
        // Its food here, or a copy an export brought before Fineli was:
        // one with its id, else a food of your own by its name
        // and brand ("Fineli") that never had one. Taken over, it is
        // Fineli's again, and its entries and recipes stay linked.
        let existing: Option<i64> = tx
            .query_row(
                "SELECT id FROM food WHERE fineli_id = ?1
                 UNION ALL
                 SELECT id FROM food
                 WHERE fineli_id IS NULL AND source = 'custom' AND kind = 'food'
                     AND name = ?2 AND brand IS ?3
                 LIMIT 1",
                params![fineli_id, input.name, input.brand],
                |r| r.get(0),
            )
            .optional()?;
        let id = if let Some(id) = existing {
            tx.execute(
                &format!(
                    "UPDATE food SET name = ?2, brand = ?3, per100 = ?4, archived = archived OR ?5,
                         rev = rev + 1, {},
                         drink = CASE WHEN drink_set THEN drink ELSE ?7 END,
                         source = 'fineli', fineli_id = ?8, basis = NULL, basis_estimated = 0
                     WHERE id = ?1",
                    category_sets(6, true)
                ),
                params![
                    id,
                    input.name,
                    input.brand,
                    json(&input.per100),
                    input.archived,
                    input.category,
                    drink,
                    fineli_id
                ],
            )?;
            id
        } else {
            tx.execute(
                "INSERT INTO food
                     (name, brand, source, per100, archived, fineli_id, category, category_auto,
                      drink)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    input.name,
                    input.brand,
                    Source::Fineli,
                    json(&input.per100),
                    input.archived,
                    fineli_id,
                    input.category,
                    // The importer owns it, even while it has none.
                    true,
                    drink
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
        derive(&tx, id)?;
        if existing.is_some() {
            entries_follow(&tx, id)?;
            refresh_dependents(&tx, id)?;
        }
    }
    {
        let mut set =
            tx.prepare_cached("UPDATE food SET fineli_class = ?2 WHERE fineli_id = ?1")?;
        for (fineli_id, class) in classes {
            set.execute(params![fineli_id, class])?;
        }
    }
    tx.commit()?;
    Ok(added)
}

/// The food sources there are to search, in the order they're offered: your
/// own foods and recipes always, a database once it holds a food (one
/// `food_source` index lookup each).
pub fn food_sources(conn: &Connection) -> Result<Vec<FoodScope>, Error> {
    let mut sources = vec![FoodScope::Custom, FoodScope::Recipe];
    for (scope, source) in [
        (FoodScope::Fineli, Source::Fineli),
        (FoodScope::Off, Source::Off),
    ] {
        let held: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM food WHERE source = ?)",
            [source.as_str()],
            |r| r.get(0),
        )?;
        if held {
            sources.push(scope);
        }
    }
    Ok(sources)
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

/// Items with their food's servings (a serving's change unlinks the items
/// it measured: `unlink_servings`).
pub(super) fn item_rows(conn: &Connection, sql: &str, id: i64) -> rusqlite::Result<Vec<Item>> {
    let mut stmt = conn.prepare_cached(sql)?;
    let mut items = stmt
        .query_map([id], |r| {
            let per100: Nutrients = from_json(&r.get::<_, String>(4)?)?;
            let (name, source, drink): (String, Source, bool) = (r.get(2)?, r.get(3)?, r.get(10)?);
            Ok(Item {
                borne: borne_of(
                    &per100,
                    &Facts {
                        drink,
                        source,
                        class: r.get::<_, Option<String>>(11)?.as_deref(),
                        name: &name,
                    },
                ),
                drink,
                labels: labels_at(r, 9)?,
                food_id: r.get(0)?,
                grams: r.get(1)?,
                name,
                source,
                kind: r.get(8)?,
                per100,
                serving: r.get(5)?,
                quantity: r.get(6)?,
                weight_estimated: r.get(7)?,
                servings: Vec::new(),
                known: Known::new(),
                fruit_veg: f64::from(u8::from(r.get::<_, bool>(12)?)),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let (mut memo, mut shares) = (BTreeMap::new(), BTreeMap::new());
    for item in &mut items {
        item.servings = servings_of(conn, item.food_id)?;
        if item.kind == FoodKind::Recipe {
            (item.known, item.borne) = recipe_cover_of(conn, item.food_id, &mut memo)?;
            item.fruit_veg = fruit_veg_share(conn, item.food_id, &mut shares)?;
        }
    }
    Ok(items)
}

/// Store the items of a recipe or meal (`table`, keyed by `key`), each
/// measured against its food.
fn write_items(
    tx: &Transaction,
    table: &str,
    key: &str,
    id: i64,
    items: &[ItemInput],
) -> Result<(), Error> {
    tx.execute(&format!("DELETE FROM {table} WHERE {key} = ?"), [id])?;
    for item in items {
        let food = food_get(tx, item.food_id)?
            .ok_or_else(|| Error::invalid(format!("unknown food {}", item.food_id)))?;
        let m = item.amount.of(&food)?;
        tx.prepare_cached(&format!(
            "INSERT INTO {table} ({key}, food_id, grams, serving, quantity) VALUES (?, ?, ?, ?, ?)"
        ))?
        .execute(params![id, item.food_id, m.grams, m.serving, m.quantity])?;
    }
    Ok(())
}

pub(super) const RECIPE_ITEMS: &str = concat!(
    "SELECT i.food_id, i.grams, f.name, f.source, f.per100,
     i.serving, i.quantity, f.basis_estimated, f.kind, ",
    labels_of!("i.food_id"),
    ", f.drink, f.fineli_class, f.category IS 'fruit_veg' FROM recipe_item i
     JOIN food f ON f.id = i.food_id WHERE i.recipe_id = ? ORDER BY i.rowid"
);

pub fn recipe_get(conn: &Connection, id: i64) -> Result<Option<Recipe>, Error> {
    match food_get(conn, id)? {
        Some(food) if food.kind == FoodKind::Recipe => Ok(Some(Recipe {
            items: item_rows(conn, RECIPE_ITEMS, id)?,
            food,
        })),
        _ => Ok(None),
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
    let mut sum = Nutrients::sum(
        &parts
            .iter()
            .map(|(p, g)| p.scale(g / 100.0))
            .collect::<Vec<_>>(),
    );
    // Cooking changes the weight by water: what's lost boiled off, what's
    // gained soaked in.
    if let Some(water) = sum.get("water") {
        sum.insert("water", (water + weight - total).max(0.0));
    }
    sum.scale(100.0 / weight)
}

/// A recipe's share of fruit, vegetables and legumes (0 to 1, ADR 0033) by
/// its parts' grams: a food's by its category, a recipe's by its own parts
/// (`memo` keeps each once).
pub(super) fn fruit_veg_share(
    conn: &Connection,
    id: i64,
    memo: &mut BTreeMap<i64, f64>,
) -> rusqlite::Result<f64> {
    if let Some(share) = memo.get(&id) {
        return Ok(*share);
    }
    let parts: Vec<(i64, FoodKind, bool, f64)> = conn
        .prepare_cached(
            "SELECT f.id, f.kind, f.category IS 'fruit_veg', i.grams
             FROM recipe_item i JOIN food f ON f.id = i.food_id WHERE i.recipe_id = ?",
        )?
        .query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let (mut veg, mut all) = (0.0, 0.0);
    for (part, kind, own, grams) in parts {
        let share = match kind {
            FoodKind::Recipe => fruit_veg_share(conn, part, memo)?,
            FoodKind::Food => f64::from(u8::from(own)),
        };
        veg += share * grams;
        all += grams;
    }
    let share = if all > 0.0 { veg / all } else { 0.0 };
    memo.insert(id, share);
    Ok(share)
}

/// A recipe's [`Known`] and [`Borne`] per 100 g ([`recipe_cover`]), its
/// recipes' first (`memo` keeps each once).
pub(super) fn recipe_cover_of(
    conn: &Connection,
    id: i64,
    memo: &mut BTreeMap<i64, (Known, Borne)>,
) -> rusqlite::Result<(Known, Borne)> {
    if let Some(cover) = memo.get(&id) {
        return Ok(cover.clone());
    }
    let rows = conn
        .prepare_cached(
            "SELECT f.id, f.kind, f.per100, i.grams, f.drink, f.source, f.fineli_class, f.name
             FROM recipe_item i JOIN food f ON f.id = i.food_id WHERE i.recipe_id = ?",
        )?
        .query_map([id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, FoodKind>(1)?,
                from_json::<Nutrients>(&r.get::<_, String>(2)?)?,
                r.get::<_, f64>(3)?,
                r.get::<_, bool>(4)?,
                r.get::<_, Source>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, String>(7)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let cooked_g: Option<f64> =
        conn.query_row("SELECT cooked_g FROM food WHERE id = ?", [id], |r| r.get(0))?;
    let mut covers = Vec::with_capacity(rows.len());
    for (food_id, kind, per100, _, drink, source, class, name) in &rows {
        covers.push(if *kind == FoodKind::Recipe {
            recipe_cover_of(conn, *food_id, memo)?
        } else {
            let facts = Facts {
                drink: *drink,
                source: *source,
                class: class.as_deref(),
                name,
            };
            (Known::new(), borne_of(per100, &facts))
        });
    }
    let parts: Vec<Part> = rows
        .iter()
        .zip(&covers)
        .map(|(row, (known, borne))| Part {
            per100: &row.2,
            grams: row.3,
            drink: row.4,
            known,
            borne,
        })
        .collect();
    let cover = recipe_cover(&parts, cooked_g);
    memo.insert(id, cover.clone());
    Ok(cover)
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

/// Recompute every recipe, ingredients first. A leaf is a food holding no
/// items (every recipe holds one): asked of `recipe_item` alone, as this
/// runs inside old migrations, before and after recipes' `kind`.
pub(super) fn recompute_all_recipes(tx: &Transaction) -> rusqlite::Result<()> {
    let leaves: Vec<i64> = tx
        .prepare("SELECT id FROM food WHERE id NOT IN (SELECT recipe_id FROM recipe_item)")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in leaves {
        recompute_dependents(tx, id)?;
    }
    Ok(())
}

/// [`recompute_all_recipes`] for a running server (`DERIVED`'s recipes
/// family): each recipe's [`PORTION`] follows its weight too.
pub(super) fn recipes_refresh(tx: &Transaction) -> rusqlite::Result<usize> {
    recompute_all_recipes(tx)?;
    let recipes: Vec<i64> = tx
        .prepare("SELECT DISTINCT recipe_id FROM recipe_item")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for &id in &recipes {
        sync_portion(tx, id)?;
    }
    Ok(recipes.len())
}

/// Derive every food's drink flag again where it wasn't set by hand
/// ([`drink_by_kind`]; migration 65): yours is what its kind says (a
/// profile's water food stays one); an importer's word stands, and its kind
/// can add to it. A food that changes is relabelled (a drink's thresholds).
pub(super) fn rederive_drinks(tx: &Transaction) -> Result<(), Error> {
    let foods: Vec<(i64, bool)> = tx
        .prepare(
            "SELECT id, id IN (SELECT water_food_id FROM profile WHERE water_food_id IS NOT NULL)
             FROM food WHERE NOT drink_set",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (id, water) in foods {
        let f = written(food_get(tx, id)?);
        let by_kind = drink_by_kind(&f.name, f.category.as_deref(), &f.servings, &f.per100);
        let now = match f.source {
            Source::Custom => by_kind || water,
            _ => f.drink || by_kind,
        };
        if now != f.drink {
            tx.execute("UPDATE food SET drink = ? WHERE id = ?", params![now, id])?;
            derive(tx, id)?;
        }
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
/// [`PORTION`] and diary entries follow too. Migrations use the plain one,
/// so they never depend on what `makes` means. Returns how many entries
/// changed.
pub(super) fn refresh_dependents(tx: &Transaction, food_id: i64) -> rusqlite::Result<usize> {
    let mut updated = 0;
    for parent in parents(tx, food_id)? {
        recompute(tx, parent)?;
        sync_portion(tx, parent)?;
        derive(tx, parent)?;
        updated += entries_follow(tx, parent)? + refresh_dependents(tx, parent)?;
    }
    Ok(updated)
}

/// Every food's diary entries follow it ([`entries_follow`]): run after
/// migrations, which rewrite foods' values (recipes recomputed, keys
/// dropped) without them. Returns how many changed.
pub(super) fn all_entries_follow(tx: &Transaction) -> rusqlite::Result<usize> {
    let ids: Vec<i64> = tx
        .prepare(
            "SELECT DISTINCT food_id FROM entry WHERE food_id IS NOT NULL AND src_grp IS NULL",
        )?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    ids.into_iter().map(|id| entries_follow(tx, id)).sum()
}

/// Rewrite the diary entries of food `id` (every profile's, day and group)
/// as its values per 100 g times their grams: an entry's `nutrients` (and
/// the columns its trigger keeps) cache its food's, so an edit reaches the
/// past. Imported history keeps the import's. Returns how many changed.
pub(super) fn entries_follow(tx: &Transaction, id: i64) -> rusqlite::Result<usize> {
    let per100: Nutrients = from_json(
        &tx.prepare_cached("SELECT per100 FROM food WHERE id = ?")?
            .query_row([id], |r| r.get::<_, String>(0))?,
    )?;
    let rows = tx
        .prepare_cached(
            "SELECT id, grams, nutrients FROM entry
             WHERE food_id = ? AND src_grp IS NULL AND grams IS NOT NULL",
        )?
        .query_map([id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, f64>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut set = tx.prepare_cached("UPDATE entry SET nutrients = ? WHERE id = ?")?;
    let mut updated = 0;
    for (entry, grams, old) in rows {
        let new = json(&per100.scale(grams / 100.0));
        if old.as_deref() != Some(new.as_str()) {
            set.execute(params![new, entry])?;
            updated += 1;
        }
    }
    Ok(updated)
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

/// A new recipe's food row for `input` (its items, servings and values
/// are the caller's to write); the API's create and an import's both make
/// it here.
pub(super) fn insert_recipe(conn: &Connection, input: &RecipeInput) -> Result<i64, Error> {
    conn.execute(
        "INSERT INTO food (name, source, kind, cooked_g, archived, makes, notes, category, drink,
             uid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            input.name,
            Source::Custom,
            FoodKind::Recipe,
            input.cooked_g,
            input.archived,
            input.makes,
            input.notes,
            input.category,
            drink_by_kind(
                &input.name,
                input.category.as_deref(),
                &input.servings,
                &Nutrients::default(),
            ),
            input.uid
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Create (`id = None`) or replace a recipe.
pub fn recipe_save(
    conn: &mut Connection,
    id: Option<i64>,
    input: &RecipeInput,
) -> Result<Recipe, Error> {
    let tx = write(conn)?;
    if id.is_none()
        && let Some(earlier) = created_before(&tx, "food", input.uid.as_deref())?
    {
        return recipe_get(&tx, earlier)?.ok_or_else(uid_elsewhere);
    }
    let mut before = Vec::new();
    let replaced = id.is_some();
    let id = if let Some(id) = id {
        let old = recipe_get(&tx, id)?.ok_or_else(|| Error::not_found("recipe", id))?;
        bump_rev(&tx, "food", "recipe", id, input.rev)?;
        before.clone_from(&old.food.servings);
        renamed_entries(&tx, id, &old.food.name, &input.name)?;
        let n = tx.execute(
            &format!(
                "UPDATE food SET name = ?2, cooked_g = ?3, archived = ?4, makes = ?6,
                     notes = ?7, {}, drink = CASE WHEN drink_set THEN drink ELSE ?9 END
                 WHERE id = ?1 AND kind = ?5",
                category_sets(8, false)
            ),
            params![
                id,
                input.name,
                input.cooked_g,
                input.archived,
                FoodKind::Recipe,
                input.makes,
                input.notes,
                input.category,
                drink_by_kind(
                    &input.name,
                    input.category.as_deref(),
                    &input.servings,
                    &Nutrients::default(),
                )
            ],
        )?;
        if n == 0 {
            return Err(Error::not_found("recipe", id));
        }
        id
    } else {
        insert_recipe(&tx, input)?
    };
    write_items(&tx, "recipe_item", "recipe_id", id, &input.items)?;
    for item in &input.items {
        if uses(&tx, item.food_id, id)? {
            return Err(Error::invalid("a recipe cannot contain itself"));
        }
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
    derive(&tx, id)?;
    unlink_servings(&tx, id, &before, &servings_of(&tx, id)?)?;
    let updated = entries_follow(&tx, id)? + refresh_dependents(&tx, id)?;
    let mut recipe = written(recipe_get(&tx, id)?);
    // A new recipe has no entries: its answer is the plain Recipe.
    recipe.food.entries_updated = replaced.then_some(updated);
    tx.commit()?;
    Ok(recipe)
}

// --------------------------------------------------------------- meals

pub(super) const MEAL_ITEMS: &str = concat!(
    "SELECT i.food_id, i.grams, f.name, f.source, f.per100,
     i.serving, i.quantity, f.basis_estimated, f.kind, ",
    labels_of!("i.food_id"),
    ", f.drink, f.fineli_class, f.category IS 'fruit_veg' FROM meal_item i
     JOIN food f ON f.id = i.food_id WHERE i.meal_id = ? ORDER BY i.rowid"
);

pub fn meal_list(conn: &Connection) -> Result<Vec<Meal>, Error> {
    let ids: Vec<i64> = conn
        .prepare_cached("SELECT id FROM meal ORDER BY name COLLATE NOCASE")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    ids.into_iter()
        .map(|id| Ok(written(meal_get(conn, id)?)))
        .collect()
}

/// Items' share of fruit, vegetables and legumes by their grams.
fn share_of(items: &[Item]) -> f64 {
    let all: f64 = items.iter().map(|i| i.grams).sum();
    if all > 0.0 {
        items.iter().map(|i| i.fruit_veg * i.grams).sum::<f64>() / all
    } else {
        0.0
    }
}

pub fn meal_get(conn: &Connection, id: i64) -> Result<Option<Meal>, Error> {
    let head: Option<(String, i64)> = conn
        .query_row("SELECT name, rev FROM meal WHERE id = ?", [id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    head.map(|(name, rev)| {
        let items = item_rows(conn, MEAL_ITEMS, id)?;
        let parts: Vec<_> = items.iter().map(|i| (i.per100.clone(), i.grams)).collect();
        let cover: Vec<_> = items
            .iter()
            .map(|i| Part {
                per100: &i.per100,
                grams: i.grams,
                drink: i.drink,
                known: &i.known,
                borne: &i.borne,
            })
            .collect();
        Ok(Meal {
            id,
            name,
            labels: labels(
                &recipe_per100(&parts, None),
                &Scoring {
                    fruit_veg: share_of(&items),
                    ..Scoring::default()
                },
                &recipe_cover(&cover, None).0,
            ),
            items,
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
        if let Some(earlier) = created_before(&tx, "meal", input.uid.as_deref())? {
            return Ok(written(meal_get(&tx, earlier)?));
        }
        tx.execute(
            "INSERT INTO meal (name, uid) VALUES (?, ?)",
            params![input.name, input.uid],
        )?;
        tx.last_insert_rowid()
    };
    write_items(&tx, "meal_item", "meal_id", id, &input.items)?;
    let meal = written(meal_get(&tx, id)?);
    tx.commit()?;
    Ok(meal)
}

// ---------------------------------------------------------------- copy

/// What a copy doesn't take from its original, by table: its
/// identity and retry key, what makes a food an importer's (its barcode is
/// one food's), archiving (a copy is new), and a child row's parent. Every
/// other column travels, a new one too, unless listed here
/// (`every_copied_column_is_copied_or_reset`).
pub(super) const COPY_RESET: &[(&str, &[&str])] = &[
    (
        "food",
        &[
            "id",
            "rev",
            "uid",
            "barcode",
            "fineli_id",
            "fineli_class",
            "source",
            "archived",
            "category_auto",
        ],
    ),
    ("serving", &["id", "food_id"]),
    ("recipe_item", &["recipe_id"]),
    ("meal", &["id", "rev", "uid"]),
    ("meal_item", &["meal_id"]),
    ("workout", &["id", "rev", "uid", "archived"]),
];

/// `table`'s columns a copy takes, as a list: all but its [`COPY_RESET`].
fn copied_columns(conn: &Connection, table: &str) -> rusqlite::Result<String> {
    let reset = COPY_RESET
        .iter()
        .find(|(t, _)| *t == table)
        .map_or(&[][..], |(_, cols)| cols);
    let names = conn
        .prepare_cached("SELECT name FROM pragma_table_info(?) ORDER BY cid")?
        .query_map([table], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names
        .into_iter()
        .filter(|c| !reset.contains(&c.as_str()))
        .collect::<Vec<_>>()
        .join(", "))
}

/// A new row of `table` copying row `id`, named [`copied`], with `uid`;
/// its id. Its other reset columns take their defaults.
pub(super) fn copy_row(
    tx: &Transaction,
    table: &str,
    id: i64,
    uid: Option<&str>,
) -> Result<i64, Error> {
    let cols = copied_columns(tx, table)?;
    let name: String = tx.query_row(
        &format!("SELECT name FROM {table} WHERE id = ?"),
        [id],
        |r| r.get(0),
    )?;
    // `source` has no default: a copy is yours.
    let (extra, value) = if table == "food" {
        (", source", ", 'custom'")
    } else {
        ("", "")
    };
    tx.execute(
        &format!(
            "INSERT INTO {table} ({cols}, uid{extra}) SELECT {cols}, ?2{value} FROM {table}
             WHERE id = ?1"
        ),
        params![id, uid],
    )?;
    let new = tx.last_insert_rowid();
    tx.execute(
        &format!("UPDATE {table} SET name = ? WHERE id = ?"),
        params![copied(&name), new],
    )?;
    Ok(new)
}

/// Copy child `table`'s rows of parent `from` (by `key`) to `to`, in order.
fn copy_children(
    tx: &Transaction,
    table: &str,
    key: &str,
    from: i64,
    to: i64,
) -> rusqlite::Result<()> {
    let cols = copied_columns(tx, table)?;
    tx.execute(
        &format!(
            "INSERT INTO {table} ({key}, {cols}) SELECT ?2, {cols} FROM {table}
             WHERE {key} = ?1 ORDER BY rowid"
        ),
        [from, to],
    )?;
    Ok(())
}

/// A copy of food or recipe `id`: its values, servings and ingredients,
/// yours (a Fineli food's without its brand), not archived, without a
/// barcode. A `uid` copied before answers with that copy.
///
/// # Errors
/// 404 food.
pub fn food_copy(conn: &mut Connection, id: i64, uid: Option<&str>) -> Result<Food, Error> {
    let tx = write(conn)?;
    if let Some(earlier) = created_before(&tx, "food", uid)? {
        return Ok(written(food_get(&tx, earlier)?));
    }
    let old = food_get(&tx, id)?.ok_or_else(|| Error::not_found("food", id))?;
    let new = copy_row(&tx, "food", id, uid)?;
    if old.source == Source::Fineli {
        tx.execute("UPDATE food SET brand = NULL WHERE id = ?", [new])?;
    }
    copy_children(&tx, "serving", "food_id", id, new)?;
    copy_children(&tx, "recipe_item", "recipe_id", id, new)?;
    derive(&tx, new)?;
    let food = written(food_get(&tx, new)?);
    tx.commit()?;
    Ok(food)
}

/// A copy of meal `id` with its items. A `uid` copied before answers with
/// that copy.
///
/// # Errors
/// 404 meal.
pub fn meal_copy(conn: &mut Connection, id: i64, uid: Option<&str>) -> Result<Meal, Error> {
    let tx = write(conn)?;
    if let Some(earlier) = created_before(&tx, "meal", uid)? {
        return Ok(written(meal_get(&tx, earlier)?));
    }
    meal_get(&tx, id)?.ok_or_else(|| Error::not_found("meal", id))?;
    let new = copy_row(&tx, "meal", id, uid)?;
    copy_children(&tx, "meal_item", "meal_id", id, new)?;
    let meal = written(meal_get(&tx, new)?);
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
    let food = food_get(conn, id)?.ok_or_else(|| Error::not_found("food", id))?;
    let mut usage = conn.query_row(
        "SELECT (SELECT count(*) FROM entry WHERE food_id = ?1),
             (SELECT count(DISTINCT recipe_id) FROM recipe_item WHERE food_id = ?1),
             (SELECT count(DISTINCT meal_id) FROM meal_item WHERE food_id = ?1),
             (SELECT count(*) FROM favorite WHERE food_id = ?1),
             (SELECT count(*) FROM daily_item WHERE food_id = ?1),
             (SELECT count(*) FROM profile WHERE water_food_id = ?1)",
        [id],
        |r| {
            Ok(Usage {
                entries: r.get(0)?,
                recipes: r.get(1)?,
                meals: r.get(2)?,
                favorites: r.get(3)?,
                daily_items: r.get(4)?,
                water: r.get(5)?,
                deletable: false,
            })
        },
    )?;
    usage.deletable = food.source != Source::Fineli
        && usage.entries + usage.recipes + usage.meals + usage.daily_items + usage.water == 0;
    Ok(usage)
}

/// Delete food or recipe `id`, which nothing but favourites uses (they
/// go with it): what's in use is history, archived instead.
///
/// # Errors
/// 404 food; 409 `base_read_only` for a Fineli food (`kaloriina fineli`
/// would add it again), 409 `food_in_use` while something uses it.
pub fn food_delete(conn: &mut Connection, id: i64) -> Result<(), Error> {
    let tx = write(conn)?;
    let usage = food_usage(&tx, id)?;
    if !usage.deletable {
        let food = written(food_get(&tx, id)?);
        return Err(if food.source == Source::Fineli {
            Error::conflict(
                Conflict::BaseReadOnly,
                format!(
                    "{} is from Fineli, which would add it again: archive it instead",
                    food.name
                ),
            )
        } else {
            Error::conflict(
                Conflict::FoodInUse,
                format!("{} is in use: archive it instead", food.name),
            )
        });
    }
    tx.execute("DELETE FROM favorite WHERE food_id = ?", [id])?;
    tx.execute("DELETE FROM food WHERE id = ?", [id])?;
    tx.commit()?;
    Ok(())
}

/// Merge food `input.from` (B) into `id` (A): everything using B uses A
/// (a profile's water food and daily items too), then B is deleted. Diary
/// entries and recipes using B take A's values. B's barcode moves to A when A
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
        "UPDATE daily_item SET food_id = ?1 WHERE food_id = ?2",
    ] {
        tx.prepare_cached(sql)?.execute(params![id, from.id])?;
    }
    // A recipe or meal holding A twice: the first row gets the grams of all,
    // measured in grams.
    for sql in [
        "UPDATE recipe_item SET serving = NULL, quantity = NULL
             WHERE food_id = ?1 AND (SELECT count(*) FROM recipe_item t
                 WHERE t.recipe_id = recipe_item.recipe_id AND t.food_id = ?1) > 1",
        "UPDATE meal_item SET serving = NULL, quantity = NULL
             WHERE food_id = ?1 AND (SELECT count(*) FROM meal_item t
                 WHERE t.meal_id = meal_item.meal_id AND t.food_id = ?1) > 1",
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
    let updated = entries_follow(&tx, id)? + refresh_dependents(&tx, id)?;
    let food = Food {
        entries_updated: Some(updated),
        ..written(food_get(&tx, id)?)
    };
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
    if into.kind != from.kind {
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

    /// The pie (no iron, 70 g) and sausage (iron
    /// 0, 6 g) recipe's iron is known from the dry matter of the sausage
    /// and the pill: the pill carries iron with no energy, and leaves only
    /// energy partial.
    #[test]
    fn recipe_known_counts_only_parts_carrying_a_key() {
        let pie = Nutrients::of(&[("energy", 224.0), ("protein", 4.1), ("water", 50.0)]);
        let sausage = Nutrients::of(&[
            ("energy", 323.0),
            ("iron", 0.0),
            ("protein", 12.0),
            ("water", 50.0),
        ]);
        let pill = Nutrients::of(&[("iron", 10.0)]);
        let (none, no) = (Known::new(), Borne::new());
        let part = |per100, grams| Part {
            per100,
            grams,
            drink: false,
            known: &none,
            borne: &no,
        };
        let parts = [part(&pie, 70.0), part(&sausage, 6.0), part(&pill, 24.0)];
        let (known, _) = recipe_cover(&parts, None);
        // Dry: pie 35 g, sausage 3 g, pill 24 g = 62 g a 100 g.
        assert!((known[crate::model::DRY] - 62.0).abs() < 1e-9, "{known:?}");
        assert!((known["iron"] - 27.0 / 62.0).abs() < 1e-9, "{known:?}");
        // Protein: pie and sausage, 38 of 62.
        assert!((known["protein"] - 38.0 / 62.0).abs() < 1e-9);
        assert!((known["energy"] - 38.0 / 62.0).abs() < 1e-9);
        // A recipe of it carries its partial iron through.
        let per100 = recipe_per100(
            &[
                (pie.clone(), 70.0),
                (sausage.clone(), 6.0),
                (pill.clone(), 24.0),
            ],
            None,
        );
        let outer = recipe_cover(
            &[Part {
                per100: &per100,
                grams: 100.0,
                drink: false,
                known: &known,
                borne: &no,
            }],
            None,
        )
        .0;
        assert!((outer["iron"] - known["iron"]).abs() < 1e-9);
    }

    /// Coffee with milk is known for caffeine (the milk can't
    /// hold any); a cocktail of a liqueur without an alcohol value isn't.
    #[test]
    fn a_recipe_knows_caffeine_by_what_could_hold_it() {
        let coffee = Nutrients::of(&[("caffeine", 40.0), ("water", 98.0)]);
        let milk = Nutrients::of(&[("water", 90.0), ("protein", 3.0)]);
        let none = Known::new();
        let coffee_borne = Borne::from([
            ("caffeine".to_owned(), 100.0),
            ("alcohol".to_owned(), 100.0),
        ]);
        let parts = [
            Part {
                per100: &coffee,
                grams: 200.0,
                drink: true,
                known: &none,
                borne: &coffee_borne,
            },
            Part {
                per100: &milk,
                grams: 50.0,
                drink: true,
                known: &none,
                borne: &Borne::new(),
            },
        ];
        let (known, borne) = recipe_cover(&parts, None);
        assert!(!known.contains_key("caffeine"), "{known:?}");
        // Alcohol: the coffee could hold it, and gives none.
        assert!(known["alcohol"].abs() < 1e-9);
        assert!((borne["caffeine"] - 80.0).abs() < 1e-9);
    }

    /// Every column a copy takes, by table: with [`COPY_RESET`], each
    /// column of each table a copy writes is in exactly one of them, so a
    /// new column fails here until it is decided (as an export's are).
    const COPIED: &[(&str, &[&str])] = &[
        (
            "food",
            &[
                "name",
                "brand",
                "per100",
                "cooked_g",
                "makes",
                "notes",
                "category",
                "basis",
                "basis_estimated",
                "kind",
                "drink",
                "drink_set",
            ],
        ),
        ("serving", &["label", "grams"]),
        ("recipe_item", &["food_id", "grams", "serving", "quantity"]),
        ("meal", &["name"]),
        ("meal_item", &["food_id", "grams", "serving", "quantity"]),
        ("workout", &["name", "steps", "minutes", "kcal", "notes"]),
    ];

    #[test]
    fn every_copied_column_is_copied_or_reset() {
        let conn = super::super::open(Path::new(":memory:")).unwrap();
        let mut wrong = Vec::new();
        assert_eq!(
            COPIED.iter().map(|(t, _)| t).collect::<Vec<_>>(),
            COPY_RESET.iter().map(|(t, _)| t).collect::<Vec<_>>()
        );
        for ((table, copied), (_, reset)) in COPIED.iter().zip(COPY_RESET) {
            let names: Vec<String> = conn
                .prepare("SELECT name FROM pragma_table_info(?)")
                .unwrap()
                .query_map([table], |r| r.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            for name in &names {
                match (
                    copied.contains(&name.as_str()),
                    reset.contains(&name.as_str()),
                ) {
                    (true, false) | (false, true) => {}
                    (true, true) => wrong.push(format!("{table}.{name}: copied and reset")),
                    (false, false) => wrong.push(format!("{table}.{name}: neither")),
                }
            }
            for listed in copied.iter().chain(reset.iter()) {
                if !names.iter().any(|n| n == listed) {
                    wrong.push(format!("{table}.{listed}: listed, but no such column"));
                }
            }
        }
        assert!(wrong.is_empty(), "{wrong:#?}");
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
            items: vec![ItemInput::grams(oats.id, 400.0)],
            servings: vec![],
            archived: false,
            notes: None,
            category: None,
            rev: None,
            uid: None,
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

    /// The recipes family of `DERIVED` runs on a server's start, not in a
    /// migration: each recipe's Portion follows its new weight too.
    #[test]
    fn the_recipes_family_syncs_the_portion() {
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
            items: vec![ItemInput::grams(oats.id, 400.0)],
            servings: vec![],
            archived: false,
            notes: None,
            category: None,
            rev: None,
            uid: None,
        };
        let id = recipe_save(&mut conn, None, &porridge).unwrap().food.id;
        conn.execute("UPDATE recipe_item SET grams = 800", [])
            .unwrap();
        let family = super::super::DERIVED
            .iter()
            .find(|f| f.key == "recipe_rule_version")
            .unwrap();
        let super::super::Refresh::Plain(refresh) = family.refresh else {
            panic!("the recipes family needs no zone");
        };
        let tx = write(&mut conn).unwrap();
        refresh(&tx).unwrap();
        tx.commit().unwrap();
        let after = food_get(&conn, id).unwrap().unwrap();
        assert_eq!(grams_of(&after, WHOLE_RECIPE), Some(800.0));
        assert_eq!(grams_of(&after, PORTION), Some(200.0));
    }
}
