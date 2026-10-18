//! Habits: trackers of your own ("Snus", "pouches"), counted by hand as one
//! total per day, and the built-ins ([`BUILTINS`]), read from what was
//! eaten: a nutrient, or the grams of a food category.

use super::metric::Per;
use super::prelude::*;
use super::{FoodCategory, Gone, refuse_gone};
use crate::nutrients::SALT_PER_SODIUM;

text_enum! {
    /// Which way a habit's goal points.
    pub enum GoalDir {
        AtLeast = "at_least",
        AtMost = "at_most",
    }
}

/// Where a built-in's daily amount comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BuiltinSource {
    /// A nutrient's daily total, eaten (every group but Planned), imported
    /// day totals included: the number the Summary sums.
    Nutrient(&'static str),
    /// The grams eaten of foods in the category; a recipe without one of
    /// its own counts its ingredients' share.
    Category(FoodCategory),
    /// Water in what was eaten and drunk (a food's water value; a drink
    /// without one, an estimate; a recipe through its parts), less
    /// [`ALCOHOL_ML_PER_G`] a gram of alcohol, never below 0 for an entry
    /// (an imported group total is one entry) (ADR 0020).
    Hydration,
}

/// Water (ml) a gram of alcohol may take back: its acute diuresis, about
/// 10 ml/g (Eggleton, J Physiol 1942). An upper estimate: beer up to ~4 %
/// shows no net diuresis (Hobson & Maughan, Alcohol Alcohol. 2010), and
/// stronger drinks only a transient one (Polhuis et al., Nutrients 2017);
/// the entries don't carry a drink's strength, so it applies to every gram.
/// Caffeine takes none: coffee hydrates as water does at habitual intake
/// (Killer et al., `PLoS ONE` 2014; Maughan et al., Am J Clin Nutr 2016,
/// beverage hydration index), and the acute diuresis of a large dose
/// (≥ ~300 mg, Maughan & Griffin, J Hum Nutr Diet 2003) gives no
/// defensible ml per mg (ADR 0020).
pub const ALCOHOL_ML_PER_G: f64 = 10.0;

/// A habit read from food. Amounts are in the source's
/// stored unit (g, mg); shown as `amount × factor` in `unit`.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Builtin {
    pub key: &'static str,
    pub name: &'static str,
    /// The shown unit, plural; `one` is its singular.
    pub unit: &'static str,
    pub one: &'static str,
    pub factor: f64,
    /// Upper bounds of shade steps 1–3 (shown unit); above is step 4.
    pub bounds: [f64; 3],
    /// The target key holding its goal.
    pub metric: &'static str,
    /// Its goal's direction: the metric's (a test keeps them equal).
    pub goal_dir: GoalDir,
    /// Whether the Summary's numbers are a day's or a week's.
    pub per: Per,
    /// A line under its calendar's key.
    pub note: Option<&'static str>,
    pub source: BuiltinSource,
}

/// A standard drink: 12 g of alcohol, the Finnish definition.
const DRINK_G: f64 = 12.0;

const CATEGORY_NOTE: Option<&str> =
    Some("Counts foods of this category; set a food's category in its editor.");

/// Grams a day of a food category, a limit counted a week.
const fn category(
    key: &'static str,
    c: FoodCategory,
    metric: &'static str,
    unit: &'static str,
    bounds: [f64; 3],
) -> Builtin {
    Builtin {
        key,
        name: c.label(),
        unit,
        one: unit,
        factor: 1.0,
        bounds,
        metric,
        goal_dir: GoalDir::AtMost,
        per: Per::Week,
        note: CATEGORY_NOTE,
        source: BuiltinSource::Category(c),
    }
}

/// The built-in habits, in the order they're listed. A new one is one
/// entry here.
pub const BUILTINS: &[Builtin] = &[
    Builtin {
        key: "water",
        name: "Hydration",
        unit: "L",
        one: "L",
        factor: 0.001,
        bounds: [1.0, 1.5, 2.0],
        metric: "water",
        goal_dir: GoalDir::AtLeast,
        per: Per::Day,
        note: Some(
            "Water in what you eat and drink (a drink without a water value, estimated), less alcohol's effect.",
        ),
        source: BuiltinSource::Hydration,
    },
    Builtin {
        key: "alcohol",
        name: "Alcohol",
        unit: "drinks",
        one: "drink",
        factor: 1.0 / DRINK_G,
        bounds: [1.0, 3.0, 5.0],
        metric: "alcohol",
        goal_dir: GoalDir::AtMost,
        per: Per::Week,
        note: Some("A drink is 12 g of alcohol."),
        source: BuiltinSource::Nutrient("alcohol"),
    },
    Builtin {
        key: "caffeine",
        name: "Caffeine",
        unit: "mg",
        one: "mg",
        factor: 1.0,
        bounds: [100.0, 250.0, 400.0],
        metric: "caffeine",
        goal_dir: GoalDir::AtMost,
        per: Per::Day,
        note: Some(
            "Fineli foods have no caffeine: log coffee and tea from a food of your own with caffeine set.",
        ),
        source: BuiltinSource::Nutrient("caffeine"),
    },
    Builtin {
        key: "added_sugars",
        name: "Added sugar",
        unit: "g",
        one: "g",
        factor: 1.0,
        bounds: [10.0, 25.0, 50.0],
        metric: "added_sugars",
        goal_dir: GoalDir::AtMost,
        per: Per::Day,
        note: None,
        source: BuiltinSource::Nutrient("added_sugars"),
    },
    Builtin {
        key: "salt",
        name: "Salt",
        unit: "g",
        one: "g",
        factor: SALT_PER_SODIUM / 1000.0,
        bounds: [2.0, 5.0, 8.0],
        metric: "sodium",
        goal_dir: GoalDir::AtMost,
        per: Per::Day,
        note: None,
        source: BuiltinSource::Nutrient("sodium"),
    },
    Builtin {
        key: "creatine",
        name: "Creatine",
        unit: "g",
        one: "g",
        factor: 1.0,
        bounds: [1.0, 2.0, 2.5],
        metric: "creatine",
        goal_dir: GoalDir::AtLeast,
        per: Per::Day,
        note: Some(
            "Counts foods with creatine set, like Creatine monohydrate; meat's own creatine isn't in Fineli.",
        ),
        source: BuiltinSource::Nutrient("creatine"),
    },
    category(
        "sweets_snacks",
        FoodCategory::SweetsSnacks,
        "category:sweets_snacks",
        "g",
        [25.0, 50.0, 100.0],
    ),
    category(
        "fast_food",
        FoodCategory::FastFood,
        "category:fast_food",
        "g",
        [100.0, 250.0, 500.0],
    ),
    // Drunk, so in litres: a gram of a drink is a millilitre, as
    // Hydration has it.
    Builtin {
        unit: "L",
        one: "L",
        factor: 0.001,
        bounds: [0.1, 0.25, 0.5],
        ..category(
            "sugary_drinks",
            FoodCategory::SugaryDrinks,
            "category:sugary_drinks",
            "L",
            [0.1, 0.25, 0.5],
        )
    },
    Builtin {
        goal_dir: GoalDir::AtLeast,
        per: Per::Day,
        ..category(
            "fruit_veg",
            FoodCategory::FruitVeg,
            "category:fruit_veg",
            "g",
            [100.0, 250.0, 500.0],
        )
    },
    category(
        "processed_meat",
        FoodCategory::ProcessedMeat,
        "category:processed_meat",
        "g",
        [25.0, 50.0, 100.0],
    ),
];

/// One habit's amount on one day: a built-in's (`habit` its key, the
/// source's stored unit) or a tracker's (`habit` its id).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HabitDayRow {
    pub habit: String,
    pub day: String,
    pub amount: f64,
    /// Whether `amount` is the day's (ADR 0030): a nutrient built-in's only
    /// once foods carrying its nutrient were [`KNOWN`] of the day's food
    /// (by dry matter; caffeine, alcohol and creatine by what could hold
    /// them), hydration's of foods whose water is known, a category's once
    /// every food eaten has a category (imported totals carry only energy,
    /// the macros and alcohol); else it is a lower bound, not to be
    /// compared. Trackers' always are.
    ///
    /// [`KNOWN`]: crate::nutrients::KNOWN
    pub known: bool,
}

/// A tracker of your own.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Habit {
    pub id: i64,
    pub name: String,
    pub unit: String,
    /// A good day's amount, reached (`at_least`) or not passed (`at_most`).
    pub goal_value: Option<f64>,
    pub goal_dir: GoalDir,
    pub archived: bool,
    pub rev: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HabitInput {
    pub name: String,
    pub unit: String,
    #[serde(default)]
    pub goal_value: Option<f64>,
    /// `at_least` or `at_most` (the default).
    #[serde(default)]
    pub goal_dir: Option<String>,
    /// Gone: `goal_value` with `goal_dir` `at_most`.
    #[serde(default)]
    pub day_limit: Gone,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub rev: Option<i64>,
    /// A create's retry key: a create naming one saved before
    /// answers with that record. Ignored by an update.
    #[serde(default)]
    pub uid: Option<String>,
}

/// A checked [`HabitInput`]: what is stored.
#[derive(Debug, Clone, PartialEq)]
pub struct CheckedHabit {
    pub name: String,
    pub unit: String,
    pub goal_value: Option<f64>,
    pub goal_dir: GoalDir,
    pub archived: bool,
    pub rev: Option<i64>,
    pub uid: Option<String>,
}

impl HabitInput {
    /// Trimmed name (1–50 characters) and unit (1–20), a goal of 0–999 and
    /// a known direction.
    ///
    /// # Errors
    /// Blank or long text, a goal out of range; blamed on its field.
    pub fn checked(self) -> Result<CheckedHabit, Error> {
        refuse_gone(&[(
            self.day_limit,
            "day_limit",
            "send goal_value with goal_dir at_most",
        )])?;
        let name = text(&self.name, "name", LABEL_MAX)?;
        let unit = text(&self.unit, "unit", UNIT_MAX)?;
        super::checked_opt_uid(self.uid.as_deref())?;
        let goal_value = self.goal_value;
        if goal_value.is_some_and(|l| !(l.is_finite() && (0.0..=HABIT_AMOUNT_MAX).contains(&l))) {
            return Err(Error::invalid_field(
                "goal_value",
                format!("goal must be 0–{HABIT_AMOUNT_MAX}"),
            ));
        }
        let goal_dir = match self.goal_dir.as_deref() {
            None => GoalDir::AtMost,
            Some(dir) => GoalDir::parse(dir).ok_or_else(|| {
                Error::invalid_field(
                    "goal_dir",
                    format!("goal_dir must be {}", GoalDir::choices()),
                )
            })?,
        };
        Ok(CheckedHabit {
            name,
            unit,
            goal_value,
            goal_dir,
            archived: self.archived,
            rev: self.rev,
            uid: self.uid,
        })
    }
}

/// One tracker's total on one day.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HabitDay {
    pub habit_id: i64,
    pub day: String,
    pub amount: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HabitAmountInput {
    pub amount: f64,
}

impl HabitAmountInput {
    /// # Errors
    /// Not more than 0, or over 999.
    pub fn checked(self) -> Result<Self, Error> {
        checked_habit_amount(self.amount)?;
        Ok(self)
    }
}

/// A day's total: more than 0, at most 999.
///
/// # Errors
/// Out of range; blamed on `amount`.
pub fn checked_habit_amount(amount: f64) -> Result<f64, Error> {
    if amount.is_finite() && amount > 0.0 && amount <= HABIT_AMOUNT_MAX {
        Ok(amount)
    } else {
        Err(Error::invalid_field(
            "amount",
            format!("amount must be more than 0, at most {HABIT_AMOUNT_MAX}"),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(name: &str, unit: &str, goal_value: Option<f64>) -> HabitInput {
        HabitInput {
            name: name.into(),
            unit: unit.into(),
            goal_value,
            goal_dir: None,
            day_limit: Gone::default(),
            archived: false,
            rev: None,
            uid: None,
        }
    }

    #[test]
    fn inputs_are_bounded() {
        let ok = input(" Snus ", "pouches", Some(0.0)).checked().unwrap();
        assert_eq!((ok.name.as_str(), ok.unit.as_str()), ("Snus", "pouches"));
        for (bad, field) in [
            (input("", "x", None), "name"),
            (input(&"n".repeat(51), "x", None), "name"),
            (input("Snus", &"u".repeat(21), None), "unit"),
            (input("Snus", "x", Some(-1.0)), "goal_value"),
            (input("Snus", "x", Some(999.5)), "goal_value"),
            (input("Snus", "x", Some(f64::NAN)), "goal_value"),
        ] {
            match bad.checked() {
                Err(Error::Invalid { field: Some(f), .. }) => assert_eq!(f, field),
                other => panic!("{field}: {other:?}"),
            }
        }
        for amount in [0.0, -1.0, 999.01, f64::INFINITY] {
            assert!(checked_habit_amount(amount).is_err(), "{amount}");
        }
        assert!(checked_habit_amount(999.0).is_ok());
    }

    #[test]
    fn builtins_read_known_sources_and_point_their_metrics_way() {
        use crate::model::target_key;
        use crate::nutrients::Goal;
        for b in BUILTINS {
            assert_eq!(
                BUILTINS.iter().filter(|x| x.key == b.key).count(),
                1,
                "{}",
                b.key
            );
            assert!(
                b.key.parse::<i64>().is_err(),
                "{}: never a tracker id",
                b.key
            );
            let (_, goal, _) = target_key(b.metric).expect(b.metric);
            let dir = match goal {
                Goal::AtLeast => GoalDir::AtLeast,
                Goal::AtMost => GoalDir::AtMost,
                Goal::About => panic!("{}: a habit's goal has a direction", b.key),
            };
            assert_eq!(b.goal_dir, dir, "{}", b.key);
            match b.source {
                BuiltinSource::Nutrient(n) => {
                    assert!(nutrients::find(n).is_some(), "{n}");
                    assert_eq!(b.metric, n, "a nutrient's goal is its target");
                }
                BuiltinSource::Category(c) => {
                    assert_eq!(b.key, c.as_str());
                    assert_eq!(b.metric, format!("category:{}", c.as_str()));
                    assert_eq!(b.name, c.label());
                }
                BuiltinSource::Hydration => assert_eq!(b.metric, "water"),
            }
            assert!(b.bounds.windows(2).all(|w| w[0] < w[1]), "{}", b.key);
        }
        for c in FoodCategory::ALL {
            assert!(
                BUILTINS
                    .iter()
                    .any(|b| b.source == BuiltinSource::Category(*c)),
                "{}",
                c.as_str()
            );
        }
    }
}
