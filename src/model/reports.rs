//! Reports over the diary as served: where a nutrient came from, and a
//! profile's totals since its first day (All time). `db` fills them.

use super::ActivityType;
use super::prelude::*;

/// A food's part of one nutrient over a range.
#[derive(Debug, Serialize)]
pub struct Contributor {
    pub food_id: i64,
    pub name: String,
    /// In the nutrient's stored unit.
    pub amount: f64,
    /// Of the range's total, 0–1.
    pub share: f64,
}

#[derive(Debug, Serialize)]
pub struct NutrientSources {
    pub nutrient: String,
    /// Everything eaten in the range, imported history included: the same
    /// number the Summary averages.
    pub total: f64,
    /// The part no food can be named for: imported day totals.
    pub unattributed: f64,
    /// The largest contributors first, at most `db::SOURCES_MAX`.
    pub foods: Vec<Contributor>,
}

/// A food rich in a nutrient, for a low warning's good sources.
#[derive(Debug, Serialize)]
pub struct RichFood {
    pub food_id: i64,
    pub name: String,
    /// The nutrient per 100 kcal of the food, in its stored unit.
    pub per_100kcal: f64,
    /// Whether the profile has eaten it (Planned aside).
    pub eaten: bool,
}

/// One activity type's activities, minutes and metres, all time.
#[derive(Debug, Serialize)]
pub struct TypeTotal {
    #[serde(rename = "type")]
    pub kind: ActivityType,
    pub activities: i64,
    pub minutes: i64,
    pub distance_m: i64,
}

/// A profile's totals since its first day (Profile → All time), stored
/// units: the client says them in its units and fun measures.
#[derive(Debug, Default, Serialize)]
pub struct Stats {
    /// The first day anything was eaten, if any.
    pub first_day: Option<String>,
    /// Days anything was eaten (Planned aside), and the most in a row.
    pub days_logged: usize,
    pub longest_streak: usize,
    /// Entries eaten, imported history included.
    pub entries: i64,
    pub kcal_eaten: f64,
    /// Hydration's total (ADR 0020), not the food's gross water.
    pub water_ml: f64,
    pub caffeine_mg: f64,
    pub alcohol_g: f64,
    /// The keys of those totals (`energy`, `water`, `caffeine`, `alcohol`)
    /// some day's food didn't all carry (coverage, ADR 0030; a food
    /// without the key, an imported day total): each a lower bound.
    pub at_least: Vec<&'static str>,
    /// Grams of beef and of potatoes eaten: a Fineli food by its
    /// ingredient class (a plain cooked one by its ingredient's), a food of
    /// your own or from Open Food Facts by its name (mixed with pork, not
    /// at all), a recipe by its ingredients' shares. Lower bounds: other
    /// dishes count as neither. Only said with `classes_known`.
    pub beef_g: f64,
    pub potato_g: f64,
    /// Whether any food has its Fineli ingredient class (a `kaloriina
    /// fineli` run fills them): without, beef and potato can't be told.
    pub classes_known: bool,
    /// Activities done, their minutes and metres, and by type (most first).
    pub activities: i64,
    pub minutes_trained: i64,
    pub distance_m: i64,
    pub by_type: Vec<TypeTotal>,
    /// Steps and sleep (nights and naps) as the Activity days show them.
    pub steps: i64,
    pub asleep_min: i64,
    /// The days the device counted steps on, for steps a day.
    pub step_days: i64,
    /// The first day with steps and with sleep, as those totals start.
    pub steps_from: Option<String>,
    pub sleep_from: Option<String>,
    pub naps: i64,
    pub weigh_ins: i64,
    /// The first activity, nap and weigh-in, as those totals start.
    pub activities_from: Option<String>,
    pub naps_from: Option<String>,
    pub weigh_ins_from: Option<String>,
    /// The library's foods of your own (archived and seeded ones aside),
    /// recipes and meals (every profile's: the library is shared).
    pub custom_foods: i64,
    pub recipes: i64,
    pub meals: i64,
}
