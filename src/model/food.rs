//! Foods, servings, recipes and meals, and their checks.

use super::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Serving {
    pub label: String,
    pub grams: f64,
}

text_enum! {
    /// Where a food's values come from.
    pub enum Source {
        Custom = "custom",
        Off = "off",
        Recipe = "recipe",
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
    pub per100: Nutrients,
    pub cooked_g: Option<f64>,
    /// Portions a recipe makes; `null` on other foods.
    pub makes: Option<u32>,
    /// How a recipe is made, free text of several lines; `null` on other
    /// foods.
    pub instructions: Option<String>,
    pub archived: bool,
    /// A [`FoodCategory`] key, or `null`.
    pub category: Option<String>,
    /// In order; the first is the default (logging and ingredients start
    /// from it).
    pub servings: Vec<Serving>,
    /// Bumped by every change; an update must name the one it read.
    pub rev: i64,
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
    /// The revision this update was made from (required on update).
    #[serde(default)]
    pub rev: Option<i64>,
}

/// An ingredient or meal item as written by the client.
#[derive(Debug, Clone, Deserialize)]
pub struct ItemInput {
    pub food_id: i64,
    pub grams: f64,
}

/// An ingredient or meal item as read back, with what the editor shows
/// of its food: name, source and values.
#[derive(Debug, Clone, Serialize)]
pub struct Item {
    pub food_id: i64,
    pub grams: f64,
    pub name: String,
    pub source: Source,
    pub per100: Nutrients,
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
    /// How it's made: up to [`INSTRUCTIONS_MAX`] characters, line breaks
    /// kept; blank or absent is none.
    #[serde(default)]
    pub instructions: Option<String>,
    /// A [`FoodCategory`] key: the recipe counts whole under it. None
    /// counts its ingredients' categories instead.
    #[serde(default)]
    pub category: Option<String>,
    /// The recipe's (food's) revision this update was made from.
    #[serde(default)]
    pub rev: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct Recipe {
    #[serde(flatten)]
    pub food: Food,
    pub items: Vec<Item>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MealInput {
    pub name: String,
    pub items: Vec<ItemInput>,
    #[serde(default)]
    pub rev: Option<i64>,
}

/// Merge food `from` into the one addressed; `rev` is that one's.
#[derive(Debug, Clone, Deserialize)]
pub struct MergeInput {
    pub from: i64,
    #[serde(default)]
    pub rev: Option<i64>,
}

/// What uses a food, counted: diary entries (all profiles), recipes and
/// meals holding it, and profiles starring it.
#[derive(Debug, Serialize)]
pub struct Usage {
    pub entries: i64,
    pub recipes: i64,
    pub meals: i64,
    pub favorites: i64,
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
    /// The macros' energy (4 kcal/g protein and carbohydrate, 9 fat), none
    /// below zero.
    fn split(&self) -> [f64; 3] {
        [4.0 * self.protein, 4.0 * self.net_carbs, 9.0 * self.fat].map(|x| x.max(0.0))
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
        item.grams = grams(item.grams).map_err(|e| bad(format!("item {}: {e}", i + 1)))?;
    }
    Ok(())
}

impl FoodInput {
    /// A new or changed food: [`FoodInput::checked_kept`], and per-100
    /// values within [`nutrients::per100_max`].
    ///
    /// # Errors
    /// The first field that fails, named in the user's words.
    pub fn checked(self) -> Result<Self, Error> {
        let food = self.checked_kept()?;
        food.per100.validate_per100().map_err(|(n, max)| {
            Error::invalid_field(
                "per100",
                format!("{} must be at most {max} {} per 100 g", n.label, n.unit),
            )
        })?;
        Ok(food)
    }

    /// A food as kept (a profile import's): trimmed and bounded text, known
    /// non-negative nutrients, valid servings, and total carbohydrate
    /// derived from carbohydrate plus fibre whenever carbohydrate is given,
    /// whatever the writer sent. History is never refused for the per-100 caps.
    ///
    /// # Errors
    /// The first field that fails, named in the user's words.
    pub fn checked_kept(mut self) -> Result<Self, Error> {
        self.name = text(&self.name, "name", NAME_MAX)?;
        self.brand = opt_text(self.brand.as_deref(), "brand", NAME_MAX)?;
        self.barcode = self
            .barcode
            .as_deref()
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .map(|b| checked_barcode(b).map(str::to_owned))
            .transpose()?;
        self.per100
            .validate()
            .map_err(|key| match nutrients::find(&key) {
                Some(n) => bad(format!("{}: must be a number ≥ 0", n.label)),
                None => bad(format!("unknown nutrient {key}")),
            })?;
        if let Some(available) = self.per100.get("net_carbs") {
            let fibre = self.per100.get("fiber").unwrap_or(0.0);
            self.per100.insert("carbs", available + fibre);
        }
        self.category = checked_category(self.category.as_deref())?;
        self.servings = checked_servings(&self.servings)?;
        if self.servings.iter().any(|s| s.label == WHOLE_RECIPE) {
            return Err(bad(format!("“{WHOLE_RECIPE}” is kept for recipes")));
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
        self.instructions = opt_multiline(
            self.instructions.as_deref(),
            "instructions",
            INSTRUCTIONS_MAX,
        )?;
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
