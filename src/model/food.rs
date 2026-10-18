//! Foods, servings, recipes and meals, and their checks.

use std::collections::BTreeMap;

use super::prelude::*;
use super::{Amount, checked_opt_uid};
use crate::nutrients::{KCAL_PER_G_CARBS, KCAL_PER_G_FAT, KCAL_PER_G_PROTEIN};

/// How far a total is known (ADR 0030, [`super::coverage`]): by key, the
/// share (0 to 1) of the food behind it that carries the key, listed only
/// where short of all, and [`super::DRY`], the dry matter behind the total
/// (per 100 g for a food). A key of the total not listed is known in full;
/// one the total lacks, not at all.
pub type Known = BTreeMap<String, f64>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Serving {
    pub label: String,
    pub grams: f64,
}

/// The serving a food's values were typed for (they're kept per 100 g),
/// and whether its weight is a guess: then every gram figure of the food is
/// approximate, while its values per that serving stay exact.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Basis {
    pub serving: String,
    #[serde(default)]
    pub estimated: bool,
}

text_enum! {
    /// Where a food's values come from: your own (foods and recipes), or
    /// a database.
    pub enum Source {
        Custom = "custom",
        Off = "off",
        Fineli = "fineli",
    }
}

text_enum! {
    /// What a food is: one with values of its own, or a recipe whose values
    /// are its ingredients'.
    #[derive(Default)]
    pub enum FoodKind {
        #[default]
        Food = "food",
        Recipe = "recipe",
    }
}

text_enum! {
    /// What a food search covers: your foods, your recipes, or a
    /// database's (`Source` for the rest).
    pub enum FoodScope {
        Custom = "custom",
        Recipe = "recipe",
        Off = "off",
        Fineli = "fineli",
    }
}

text_enum! {
    /// The order of food search results.
    pub enum Sort {
        /// Favourites first, then your own foods and recipes, then recently
        /// logged, then names starting with the query.
        Relevance = "relevance",
        Name = "name",
        /// Lowest energy first.
        Energy = "energy",
        /// Most protein first.
        Protein = "protein",
        /// Most protein per kcal first.
        ProteinPerKcal = "protein_per_kcal",
        /// Closest to what's left of a day's targets ([`fit_score`]).
        Fit = "fit",
    }
}

text_enum! {
    /// What kind of food it is, for the built-in habits that count its
    /// grams. A food has at most one; most have none.
    pub enum FoodCategory {
        SweetsSnacks = "sweets_snacks",
        FastFood = "fast_food",
        SugaryDrinks = "sugary_drinks",
        FruitVeg = "fruit_veg",
        ProcessedMeat = "processed_meat",
    }
}

impl FoodCategory {
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::SweetsSnacks => "Sweets and snacks",
            Self::FastFood => "Fast food",
            Self::SugaryDrinks => "Sugary drinks",
            Self::FruitVeg => "Fruit and vegetables",
            Self::ProcessedMeat => "Processed meat",
        }
    }
}

/// A category as sent: absent or a [`FoodCategory`] key.
///
/// # Errors
/// Another word; blamed on `category`.
pub fn checked_category(category: Option<&str>) -> Result<Option<String>, Error> {
    category
        .map(|c| {
            FoodCategory::parse(c)
                .map(|c| c.as_str().to_owned())
                .ok_or_else(|| {
                    Error::invalid_field(
                        "category",
                        format!("category must be {}", FoodCategory::choices()),
                    )
                })
        })
        .transpose()
}

/// The serving every recipe has: all of it, at its current weight. Its
/// grams are the server's to set; its place in the list is yours.
pub const WHOLE_RECIPE: &str = "Whole recipe";
/// The serving of one portion of a recipe that `makes` some: its weight ÷
/// `makes`. The server's, like [`WHOLE_RECIPE`]; gone when `makes` is.
pub const PORTION: &str = "Portion";

#[derive(Debug, Clone, Serialize)]
pub struct Food {
    pub id: i64,
    pub name: String,
    pub brand: Option<String>,
    pub barcode: Option<String>,
    pub source: Source,
    pub kind: FoodKind,
    pub per100: Nutrients,
    pub cooked_g: Option<f64>,
    /// Portions a recipe makes; `null` on other foods.
    pub makes: Option<u32>,
    /// A recipe's notes (how it's made, or anything), free text of several
    /// lines; `null` on other foods.
    pub notes: Option<String>,
    pub archived: bool,
    /// A [`FoodCategory`] key, or `null`.
    pub category: Option<String>,
    /// In order; the first is the default (logging and ingredients start
    /// from it).
    pub servings: Vec<Serving>,
    /// The serving its values were typed for; `null` is per 100 g.
    pub basis: Option<Basis>,
    /// Bumped by every change; an update must name the one it read.
    pub rev: i64,
    /// A drink: its values are per 100 ml, judged by the drink thresholds,
    /// and its water estimated where it has no value (ADR 0020).
    pub drink: bool,
    /// What 100 g of it adds to hydration; `null` where it says nothing
    /// (no water value, not a drink).
    pub hydration: Option<Hydration>,
    /// Its weight for the keys only drinks and supplements hold
    /// ([`super::Borne`], ADR 0030): left out when none.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub borne: super::Borne,
    /// Its labels ([`super::labels`]), from its values.
    pub labels: super::Labels,
    /// A recipe's [`Known`] per 100 g (ADR 0030); left out for other
    /// foods.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub known: Known,
    /// How many diary entries a save's new values rewrote (its own, and
    /// those of recipes holding it); only in a save's or a merge's answer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entries_updated: Option<usize>,
}

/// Editable food fields, shared by create and update.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct FoodInput {
    pub name: String,
    pub brand: Option<String>,
    pub barcode: Option<String>,
    #[serde(default)]
    pub per100: Nutrients,
    #[serde(default)]
    pub servings: Vec<Serving>,
    #[serde(default)]
    pub archived: bool,
    /// A [`FoodCategory`] key; absent or `null` is none.
    #[serde(default)]
    pub category: Option<String>,
    /// The serving its values were typed for; absent or `null` is none
    /// (per 100 g). Must name one of `servings`.
    #[serde(default)]
    pub basis: Option<Basis>,
    /// The revision this update was made from (required on update).
    #[serde(default)]
    pub rev: Option<i64>,
    /// Drink (values per 100 ml). Absent or as the food has it, the server
    /// derives it (from the importers, the category, the servings and the
    /// values); sent changed, it is yours from then on. An importer's is
    /// its word, never yours.
    #[serde(default)]
    pub drink: Option<bool>,
    /// A create's retry key: a create naming one saved before
    /// answers with that record. Ignored by an update.
    #[serde(default)]
    pub uid: Option<String>,
}

/// What 100 g of a food adds to hydration (ADR 0020), in ml: its `water`
/// (a drink's estimated, [`super::water_of`]), and `alcohol`, the urine
/// its alcohol costs ([`super::ALCOHOL_ML_PER_G`] a gram, never more than
/// the water). It hydrates `water − alcohol`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Hydration {
    pub water: f64,
    pub alcohol: f64,
}

impl Hydration {
    /// A food's, from its values per 100 g: `None` where it says nothing.
    #[must_use]
    pub fn of(per100: &Nutrients, drink: bool) -> Option<Self> {
        let water = super::water_of(per100, 100.0, drink)?;
        Some(Self::from_parts(
            water,
            per100.get("alcohol").unwrap_or(0.0),
        ))
    }

    /// From its water and alcohol (g).
    #[must_use]
    pub fn from_parts(water: f64, alcohol: f64) -> Self {
        Self {
            water,
            alcohol: (alcohol * super::ALCOHOL_ML_PER_G).min(water),
        }
    }
}

/// What makes a food a drink of itself: the sugary drinks' category, a
/// Water of your own, or a serving poured: a volume ("250 ml", "0,33 l
/// bottle", "Can 0,33 l", "33 cl", "1 dl") or a drink's measure ("shot",
/// "cocktail", "pint"). A bare "dl" (Fineli's, for flour and rice too) is
/// no volume of a drink, and neither is a decilitre of something
/// energy-dense or named a sauce or soup without alcohol (`per100`: a
/// gravy served "1 dl").
#[must_use]
pub fn drink_by_kind(
    name: &str,
    category: Option<&str>,
    servings: &[Serving],
    per100: &Nutrients,
) -> bool {
    let spooned = per100.get("alcohol").is_none_or(|a| a <= 0.0)
        && (per100.get("energy").is_some_and(|e| e > SPOONED_KCAL) || {
            let name = name.to_lowercase();
            SPOONED.iter().any(|w| name.contains(w))
        });
    category == Some(FoodCategory::SugaryDrinks.as_str())
        || name.eq_ignore_ascii_case("water")
        || servings
            .iter()
            .any(|s| poured(&s.label).is_some_and(|unit| unit != "dl" || !spooned))
}

/// Over this many kcal a 100 g, a decilitre is a cook's measure (a sauce,
/// cream, flour), not a drink; alcohol aside.
const SPOONED_KCAL: f64 = 70.0;

/// Words naming what is measured in decilitres but eaten (lower case).
const SPOONED: [&str; 8] = [
    "kastike", "sauce", "sås", "keitto", "soup", "dressing", "öljy", "oil",
];

/// Words of a serving label that pour a drink (lower case).
const MEASURES: [&str; 7] = [
    "shot", "cocktail", "drink", "pint", "tuoppi", "glass", "lasi",
];

/// The unit of the volume in a serving label (a number, then ml, cl, dl
/// or l, as words of it: "0,33 l bottle", "Can 0,33 l", "500ml"), or
/// `Some("")` for a drink's measure ([`MEASURES`]). Migration 63 read
/// whole labels by the volume rule.
fn poured(label: &str) -> Option<&'static str> {
    let label = label.trim().to_lowercase();
    let words: Vec<&str> = label.split_whitespace().collect();
    let number = |n: &str| {
        n.starts_with(|c: char| c.is_ascii_digit())
            && n.chars()
                .all(|c| c.is_ascii_digit() || c == '.' || c == ',')
    };
    for (i, word) in words.iter().enumerate() {
        if MEASURES.contains(word) {
            return Some("");
        }
        for unit in ["ml", "cl", "dl", "l"] {
            let joined = word.strip_suffix(unit).is_some_and(number);
            let apart = *word == unit && i > 0 && number(words[i - 1]);
            if joined || apart {
                return Some(unit);
            }
        }
    }
    None
}

/// An ingredient or meal item as written by the client: grams, or a
/// quantity of one of its food's servings (checked against the food when
/// saved, by [`Amount::of`]).
#[derive(Debug, Clone, Deserialize)]
pub struct ItemInput {
    pub food_id: i64,
    #[serde(flatten)]
    pub amount: Amount,
}

impl ItemInput {
    /// `grams` of food `food_id`.
    #[must_use]
    pub fn grams(food_id: i64, grams: f64) -> Self {
        Self {
            food_id,
            amount: Amount {
                grams: Some(grams),
                ..Amount::default()
            },
        }
    }
}

/// An ingredient or meal item as read back, with what the editor shows
/// of its food: name, source, values and servings.
#[derive(Debug, Clone, Serialize)]
pub struct Item {
    pub food_id: i64,
    pub grams: f64,
    /// How it was measured: `quantity` of the food's serving `serving`, or
    /// grams when both are `None` (also once that serving is gone).
    pub serving: Option<String>,
    pub quantity: Option<f64>,
    pub name: String,
    pub source: Source,
    pub kind: FoodKind,
    pub per100: Nutrients,
    pub servings: Vec<Serving>,
    /// Its food's weight is a guess ([`Basis::estimated`]).
    pub weight_estimated: bool,
    /// A recipe's [`Known`] per 100 g; empty (left out) for other foods.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub known: Known,
    /// Its food's labels ([`Food::labels`]).
    pub labels: super::Labels,
    /// Its food is a drink ([`Food::drink`]).
    pub drink: bool,
    /// Its food's [`Food::borne`].
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub borne: super::Borne,
    /// Its food's share of fruit, vegetables and legumes (0 to 1): a
    /// food's by its category, a recipe's by its parts (ADR 0033).
    #[serde(skip)]
    pub fruit_veg: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RecipeInput {
    pub name: String,
    pub cooked_g: Option<f64>,
    /// Portions it makes (1 to [`MAKES_MAX`]), kept as a [`PORTION`] serving.
    #[serde(default)]
    pub makes: Option<u32>,
    pub items: Vec<ItemInput>,
    #[serde(default)]
    pub servings: Vec<Serving>,
    #[serde(default)]
    pub archived: bool,
    /// Notes (how it's made, or anything): up to [`NOTES_MAX`] characters,
    /// line breaks kept; blank or absent is none.
    #[serde(default)]
    pub notes: Option<String>,
    /// A [`FoodCategory`] key: the recipe counts whole under it. None
    /// counts its ingredients' categories instead.
    #[serde(default)]
    pub category: Option<String>,
    /// The recipe's (food's) revision this update was made from.
    #[serde(default)]
    pub rev: Option<i64>,
    /// A create's retry key: a create naming one saved before
    /// answers with that record. Ignored by an update.
    #[serde(default)]
    pub uid: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Recipe {
    #[serde(flatten)]
    pub food: Food,
    /// Its `per100`'s [`Known`] is its food's (`known`).
    pub items: Vec<Item>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MealInput {
    pub name: String,
    pub items: Vec<ItemInput>,
    #[serde(default)]
    pub rev: Option<i64>,
    /// A create's retry key: a create naming one saved before
    /// answers with that record. Ignored by an update.
    #[serde(default)]
    pub uid: Option<String>,
}

/// Merge food `from` into the one addressed; `rev` is that one's.
#[derive(Debug, Clone, Deserialize)]
pub struct MergeInput {
    pub from: i64,
    #[serde(default)]
    pub rev: Option<i64>,
}

/// What uses a food, counted: diary entries (all profiles), recipes and
/// meals holding it, profiles starring it, daily items of it and profiles
/// whose water it is.
#[derive(Debug, Serialize)]
pub struct Usage {
    pub entries: i64,
    pub recipes: i64,
    pub meals: i64,
    pub favorites: i64,
    pub daily_items: i64,
    pub water: i64,
    /// `DELETE` takes it: nothing but favourites uses it, and it isn't
    /// Fineli's (which `kaloriina fineli` would add again).
    pub deletable: bool,
}

/// A copy of a saved food, recipe, meal or workout: its retry key only.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct CopyInput {
    /// See [`FoodInput::uid`]; each Copy press makes its own.
    #[serde(default)]
    pub uid: Option<String>,
}

impl CopyInput {
    /// # Errors
    /// A malformed uid.
    pub fn checked(self) -> Result<Self, Error> {
        checked_opt_uid(self.uid.as_deref())?;
        Ok(self)
    }
}

/// What a copy is called: "`name` (copy)", `name` cut to fit [`NAME_MAX`].
#[must_use]
pub fn copied(name: &str) -> String {
    const SUFFIX: &str = " (copy)";
    let kept: String = name.chars().take(NAME_MAX - SUFFIX.len()).collect();
    format!("{}{SUFFIX}", kept.trim_end())
}

/// Energy (kcal) and the energy-giving macros (g): per 100 g of a food, or
/// what's left of a day's targets.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Macros {
    pub energy: f64,
    pub protein: f64,
    pub net_carbs: f64,
    pub fat: f64,
}

impl Macros {
    /// The macros' energy by Atwater's factors, none below zero.
    fn split(&self) -> [f64; 3] {
        [
            KCAL_PER_G_PROTEIN * self.protein,
            KCAL_PER_G_CARBS * self.net_carbs,
            KCAL_PER_G_FAT * self.fat,
        ]
        .map(|x| x.max(0.0))
    }
}

/// How well a food fits what's `left` of a day: the cosine similarity of
/// their macro energy splits (1 = the same mix), minus 1 when its first
/// serving (`portion_g`) holds more energy than is left. `None` (ranked
/// last) for a food without energy.
#[must_use]
pub fn fit_score(food: &Macros, portion_g: f64, left: &Macros) -> Option<f64> {
    if !food.energy.is_finite() {
        return None;
    }
    let (f, r) = (food.split(), left.split());
    let norm = |v: &[f64; 3]| v.iter().map(|x| x * x).sum::<f64>().sqrt();
    let dot: f64 = f.iter().zip(&r).map(|(a, b)| a * b).sum();
    let (nf, nr) = (norm(&f), norm(&r));
    let cosine = if nf > 0.0 && nr > 0.0 {
        dot / (nf * nr)
    } else {
        0.0
    };
    let too_much = food.energy * portion_g / 100.0 > left.energy.max(0.0);
    Some(cosine - if too_much { 1.0 } else { 0.0 })
}

#[derive(Debug, Serialize)]
pub struct Meal {
    pub id: i64,
    pub name: String,
    pub items: Vec<Item>,
    pub rev: i64,
    /// Its labels ([`super::labels`]) from its items' values per 100 g,
    /// as a food (never a drink).
    pub labels: super::Labels,
}

/// # Errors
/// Not more than 0, above [`GRAMS_MAX`] or not finite.
pub fn grams(g: f64) -> Result<f64, Error> {
    if g.is_finite() && g > 0.0 && g <= GRAMS_MAX {
        Ok(g)
    } else {
        Err(bad(format!(
            "grams must be more than 0 and at most {GRAMS_MAX}"
        )))
    }
}

/// A barcode: [`BARCODE_DIGITS_MIN`] to [`BARCODE_DIGITS_MAX`] digits.
#[must_use]
pub fn is_barcode(s: &str) -> bool {
    (BARCODE_DIGITS_MIN..=BARCODE_DIGITS_MAX).contains(&s.len())
        && s.bytes().all(|b| b.is_ascii_digit())
}

/// # Errors
/// Not a barcode.
pub fn checked_barcode(code: &str) -> Result<&str, Error> {
    if is_barcode(code) {
        Ok(code)
    } else {
        Err(Error::invalid_field(
            "barcode",
            format!("barcode must be {BARCODE_DIGITS_MIN}–{BARCODE_DIGITS_MAX} digits"),
        ))
    }
}

/// # Errors
/// A serving's label or grams are out of bounds; names which one.
pub fn checked_servings(list: &[Serving]) -> Result<Vec<Serving>, Error> {
    if list.len() > SERVINGS_MAX {
        return Err(bad(format!("at most {SERVINGS_MAX} servings")));
    }
    for (i, s) in list.iter().enumerate() {
        let label = s.label.trim();
        if list[..i]
            .iter()
            .any(|t| t.label.trim().eq_ignore_ascii_case(label))
        {
            return Err(bad(format!("serving “{label}” is listed twice")));
        }
    }
    list.iter()
        .enumerate()
        .map(|(i, s)| {
            let at = |e: Error| bad(format!("serving {}: {e}", i + 1));
            Ok(Serving {
                label: text(&s.label, "label", LABEL_MAX).map_err(at)?,
                grams: grams(s.grams).map_err(at)?,
            })
        })
        .collect()
}

/// # Errors
/// No items, or an item's grams are out of bounds.
pub fn check_items(list: &mut [ItemInput]) -> Result<(), Error> {
    if list.is_empty() {
        return Err(bad("at least one item is needed"));
    }
    if list.len() > ITEMS_MAX {
        return Err(bad(format!("at most {ITEMS_MAX} items")));
    }
    for (i, item) in list.iter_mut().enumerate() {
        if let Some(g) = item.amount.grams {
            item.amount.grams = Some(grams(g).map_err(|e| bad(format!("item {}: {e}", i + 1)))?);
        }
    }
    Ok(())
}

/// Grams per 100 g a sent total carbohydrate may differ from carbohydrate
/// plus fibre: labels round each to the gram.
pub const CARBS_SLACK_G: f64 = 0.5;

impl FoodInput {
    /// A new or changed food: [`FoodInput::checked_kept`], per-100 values
    /// within [`nutrients::per100_max`], and a total carbohydrate that, when
    /// sent beside carbohydrate, is it plus fibre (to [`CARBS_SLACK_G`]),
    /// or at least it with fibre unsaid.
    ///
    /// # Errors
    /// The first field that fails, named in the user's words.
    pub fn checked(self) -> Result<Self, Error> {
        if let (Some(total), Some(available)) =
            (self.per100.get("carbs"), self.per100.get("net_carbs"))
        {
            let off = match self.per100.get("fiber") {
                Some(fibre) => (total - available - fibre).abs(),
                // Fibre unsaid is the difference, which can't be negative.
                None => available - total,
            };
            if off > CARBS_SLACK_G {
                return Err(Error::invalid_field(
                    "carbs",
                    "total carbohydrate must be carbohydrate plus fibre",
                ));
            }
        }
        let food = self.checked_kept()?;
        food.per100.validate_per100().map_err(|(n, max)| {
            // Typed per a serving, the likely cause is its weight.
            let check = food.basis.as_ref().map_or_else(String::new, |b| {
                format!("; check the weight of “{}”", b.serving)
            });
            Error::invalid_field(
                "per100",
                format!(
                    "{} must be at most {max} {} per 100 g{check}",
                    n.label, n.unit
                ),
            )
        })?;
        Ok(food)
    }

    /// A food as kept (a profile import's): trimmed and bounded text, known
    /// non-negative nutrients, valid servings, and, with fibre known, total
    /// carbohydrate derived from carbohydrate plus fibre whenever
    /// carbohydrate is given, whatever the writer sent (carbohydrate from
    /// the total less fibre otherwise). History is never refused for the
    /// per-100 caps.
    ///
    /// # Errors
    /// The first field that fails, named in the user's words.
    pub fn checked_kept(mut self) -> Result<Self, Error> {
        self.name = text(&self.name, "name", NAME_MAX)?;
        checked_opt_uid(self.uid.as_deref())?;
        self.brand = opt_text(self.brand.as_deref(), "brand", NAME_MAX)?;
        self.barcode = self
            .barcode
            .as_deref()
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .map(|b| checked_barcode(b).map(str::to_owned))
            .transpose()?;
        self.per100.validate().map_err(|key| {
            let why = match nutrients::find(&key) {
                Some(n) => format!("{}: must be a number ≥ 0", n.label),
                None => format!("unknown nutrient {key}"),
            };
            Error::invalid_field("per100", why)
        })?;
        // Each carbohydrate is derived from the other with fibre known: net
        // wins. Unknown fibre isn't 0, so the other stays unknown.
        if let Some(fibre) = self.per100.get("fiber") {
            match (self.per100.get("net_carbs"), self.per100.get("carbs")) {
                (Some(available), _) => self.per100.insert("carbs", available + fibre),
                (None, Some(total)) => self.per100.insert("net_carbs", (total - fibre).max(0.0)),
                (None, None) => {}
            }
        }
        self.category = checked_category(self.category.as_deref())?;
        self.servings = checked_servings(&self.servings)?;
        if self.servings.iter().any(|s| s.label == WHOLE_RECIPE) {
            return Err(bad(format!("“{WHOLE_RECIPE}” is kept for recipes")));
        }
        if let Some(b) = &mut self.basis {
            b.serving = b.serving.trim().to_owned();
            if !self.servings.iter().any(|s| s.label == b.serving) {
                return Err(Error::invalid_field(
                    "basis",
                    format!("values are per “{}”, which isn't a serving", b.serving),
                ));
            }
        }
        Ok(self)
    }
}

impl RecipeInput {
    /// Like a food's checks, plus its items and `makes`. "Whole recipe" and
    /// "Portion" servings may be sent (their place in the list is kept);
    /// their grams are recomputed.
    ///
    /// # Errors
    /// The first field that fails.
    pub fn checked(mut self) -> Result<Self, Error> {
        self.name = text(&self.name, "name", NAME_MAX)?;
        checked_opt_uid(self.uid.as_deref())?;
        self.notes = opt_multiline(self.notes.as_deref(), "notes", NOTES_MAX)?;
        self.cooked_g = self.cooked_g.map(grams).transpose()?;
        if let Some(n) = self.makes
            && !(1..=MAKES_MAX).contains(&n)
        {
            return Err(Error::invalid_field(
                "makes",
                format!("makes must be 1–{MAKES_MAX} portions"),
            ));
        }
        for s in &mut self.servings {
            if [WHOLE_RECIPE, PORTION].contains(&s.label.trim()) {
                // A placeholder until the recipe's weight is known.
                s.grams = 1.0;
            }
        }
        self.category = checked_category(self.category.as_deref())?;
        self.servings = checked_servings(&self.servings)?;
        check_items(&mut self.items)?;
        Ok(self)
    }
}

impl MealInput {
    /// # Errors
    /// A blank or long name, or bad items.
    pub fn checked(mut self) -> Result<Self, Error> {
        self.name = text(&self.name, "name", NAME_MAX)?;
        checked_opt_uid(self.uid.as_deref())?;
        check_items(&mut self.items)?;
        Ok(self)
    }
}

/// The food a profile's "+ Water" logs (`null`: there is none), and whether
/// it's the profile's own pick rather than the default.
#[derive(Debug, Serialize)]
pub struct WaterFood {
    pub food: Option<Food>,
    pub chosen: bool,
}

/// Pick the water food; `null` goes back to the default.
#[derive(Debug, Clone, Deserialize)]
pub struct WaterFoodInput {
    #[serde(deserialize_with = "super::profile::present")]
    pub food_id: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A soft drink of your own, served
    /// "250 ml" or "0,33 l bottle", is a drink; a bare unit or a cup is no
    /// volume, and a gravy's decilitre no drink.
    #[test]
    fn a_volume_serving_makes_a_drink() {
        let by = |label: &str, per100: &Nutrients| {
            drink_by_kind(
                "Pepsi Max",
                None,
                &[Serving {
                    label: label.to_owned(),
                    grams: 250.0,
                }],
                per100,
            )
        };
        let none = Nutrients::default();
        for drink in [
            "250 ml",
            "0.5 l",
            "0,33 L",
            "33 cl",
            "1 dl",
            "500ml",
            "2 l bottle",
            "Can 0,33 l",
            "0,44 l can",
            "1 cocktail",
            "shot",
        ] {
            assert!(by(drink, &none), "{drink}");
        }
        for food in ["dl", "1 cup", "slice", "ml", "l"] {
            assert!(!by(food, &none), "{food}");
        }
        assert!(!drink_by_kind("Pepsi Max", None, &[], &none));
        // A decilitre of something dense, or of a sauce, is eaten; a
        // spirit's isn't.
        let dense = Nutrients::of(&[("energy", 120.0)]);
        assert!(!by("1 dl", &dense));
        assert!(by("4 cl", &dense));
        let spirit = Nutrients::of(&[("energy", 220.0), ("alcohol", 30.0)]);
        assert!(by("1 dl", &spirit));
        let gravy = |label: &str| {
            drink_by_kind(
                "Ruskeakastike",
                None,
                &[Serving {
                    label: label.to_owned(),
                    grams: 100.0,
                }],
                &Nutrients::of(&[("energy", 40.0)]),
            )
        };
        assert!(!gravy("1 dl"));
    }

    fn burger(basis: &str, protein: f64) -> FoodInput {
        FoodInput {
            name: "Burger".to_owned(),
            per100: Nutrients::of(&[("energy", 257.0), ("protein", protein)]),
            servings: vec![Serving {
                label: "Burger".to_owned(),
                grams: 210.0,
            }],
            basis: Some(Basis {
                serving: basis.to_owned(),
                estimated: true,
            }),
            ..FoodInput::default()
        }
    }

    fn invalid(r: Result<FoodInput, Error>) -> (Option<String>, String) {
        match r {
            Err(Error::Invalid { field, message }) => (field, message),
            other => panic!("expected Invalid, got {other:?}"),
        }
    }

    #[test]
    fn basis_must_name_a_serving() {
        let kept = burger(" Burger ", 10.0).checked().unwrap();
        assert_eq!(kept.basis.unwrap().serving, "Burger", "trimmed");
        // A removed or renamed basis serving, kept or new alike.
        for food in [
            burger("Slice", 10.0),
            FoodInput {
                servings: vec![],
                ..burger("Burger", 10.0)
            },
        ] {
            assert_eq!(invalid(food.clone().checked()).0.as_deref(), Some("basis"));
            assert_eq!(invalid(food.checked_kept()).0.as_deref(), Some("basis"));
        }
    }

    #[test]
    fn cap_error_names_the_basis_serving() {
        let (field, message) = invalid(burger("Burger", 150.0).checked());
        assert_eq!(field.as_deref(), Some("per100"));
        assert_eq!(
            message,
            "Protein must be at most 110 g per 100 g; check the weight of “Burger”"
        );
        let plain = FoodInput {
            basis: None,
            ..burger("Burger", 150.0)
        };
        assert_eq!(
            invalid(plain.checked()).1,
            "Protein must be at most 110 g per 100 g"
        );
    }
}
