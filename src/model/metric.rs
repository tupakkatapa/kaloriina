//! Goals that aren't nutrients: what a target row can hold besides a
//! nutrient key. Served as `/api/meta.metrics`; a new goal is one entry
//! here.

use serde::Serialize;

use super::FoodCategory;
use super::limits::{BODY_KG_MAX, BODY_KG_MIN, GRAMS_MAX};
use crate::nutrients::{self, Goal};

/// What one target number counts over.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Per {
    Day,
    Week,
    /// A point to reach, not an amount that repeats (goal weight).
    Once,
}

/// How a stored value is shown: `shown = stored × factor` in `unit`.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct MetricDisplay {
    pub label: &'static str,
    pub unit: &'static str,
    pub factor: f64,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Metric {
    pub key: &'static str,
    pub label: &'static str,
    /// The stored unit.
    pub unit: &'static str,
    pub goal: Goal,
    pub per: Per,
    /// Where the Targets screen lists it.
    pub section: &'static str,
    pub display: MetricDisplay,
    /// Applies while the profile has no row of its own, and is what
    /// `/recommended` gives for everyone.
    pub default: Option<f64>,
    /// Values a target may take, stored unit: `[min, max]`.
    pub range: (f64, f64),
}

const fn shown(label: &'static str, unit: &'static str) -> MetricDisplay {
    MetricDisplay {
        label,
        unit,
        factor: 1.0,
    }
}

/// Minutes in a day: the most sleep a night can hold.
const DAY_MIN: f64 = 1440.0;

pub const METRICS: &[Metric] = &[
    Metric {
        key: "steps",
        label: "Steps",
        unit: "steps",
        goal: Goal::AtLeast,
        per: Per::Day,
        section: "activity",
        display: shown("Steps", "steps"),
        // Paluch et al., Lancet Public Health 2022: the benefit plateaus at 8–10k.
        default: Some(10_000.0),
        // `STEPS_MAX` (a test keeps them equal).
        range: (0.0, 200_000.0),
    },
    Metric {
        key: "workouts_per_week",
        label: "Workouts",
        unit: "workouts",
        goal: Goal::AtLeast,
        per: Per::Week,
        section: "activity",
        display: shown("Workouts", "workouts"),
        default: None,
        // `WORKOUTS_PER_WEEK_MAX`.
        range: (0.0, 14.0),
    },
    Metric {
        key: "sleep_min",
        label: "Sleep",
        unit: "min",
        goal: Goal::AtLeast,
        per: Per::Day,
        section: "sleep",
        display: MetricDisplay {
            label: "Sleep",
            unit: "h",
            factor: 1.0 / 60.0,
        },
        // Watson et al., Sleep 2015 (AASM/SRS): 7 hours or more.
        default: Some(420.0),
        range: (0.0, DAY_MIN),
    },
    Metric {
        key: "goal_weight",
        label: "Goal weight",
        unit: "kg",
        goal: Goal::About,
        per: Per::Once,
        section: "body",
        display: shown("Goal weight", "kg"),
        default: None,
        range: (BODY_KG_MIN, BODY_KG_MAX),
    },
    category("category:sweets_snacks", FoodCategory::SweetsSnacks, "g"),
    category("category:fast_food", FoodCategory::FastFood, "g"),
    // A drink's gram is a millilitre near enough.
    category("category:sugary_drinks", FoodCategory::SugaryDrinks, "ml"),
    // NNR 2023: at least 500 g of fruit, berries and vegetables a day
    // (recommended, not a default: `/recommended` gives it).
    Metric {
        goal: Goal::AtLeast,
        ..category("category:fruit_veg", FoodCategory::FruitVeg, "g")
    },
    category("category:processed_meat", FoodCategory::ProcessedMeat, "g"),
];

/// Grams a day of foods in category `c`, a limit unless said otherwise
/// (`key` is `category:<c>`, a test checks).
const fn category(key: &'static str, c: FoodCategory, unit: &'static str) -> Metric {
    Metric {
        key,
        label: c.label(),
        unit: "g",
        goal: Goal::AtMost,
        per: Per::Day,
        section: "habits",
        display: shown(c.label(), unit),
        default: None,
        range: (0.0, GRAMS_MAX),
    }
}

#[must_use]
pub fn find_metric(key: &str) -> Option<&'static Metric> {
    METRICS.iter().find(|m| m.key == key)
}

/// A target key's label, direction and allowed values: a nutrient's
/// (any amount ≥ 0) or a metric's. `None`: not a target key.
#[must_use]
pub fn target_key(key: &str) -> Option<(&'static str, Goal, (f64, f64))> {
    nutrients::find(key)
        .map(|n| (n.label, n.goal(), (0.0, f64::INFINITY)))
        .or_else(|| find_metric(key).map(|m| (m.label, m.goal, m.range)))
}

#[cfg(test)]
mod tests {
    use super::super::limits::{STEPS_MAX, WORKOUTS_PER_WEEK_MAX};
    use super::*;

    #[test]
    fn ranges_follow_the_input_limits() {
        let max = |key| find_metric(key).unwrap().range.1;
        assert_close!(max("steps"), f64::from(i32::try_from(STEPS_MAX).unwrap()));
        assert_close!(max("workouts_per_week"), f64::from(WORKOUTS_PER_WEEK_MAX));
        for m in METRICS {
            assert!(nutrients::find(m.key).is_none(), "{} is a nutrient", m.key);
            if let Some(d) = m.default {
                assert!((m.range.0..=m.range.1).contains(&d), "{}", m.key);
            }
        }
    }

    #[test]
    fn every_food_category_is_a_metric() {
        for c in FoodCategory::ALL {
            let m = find_metric(&format!("category:{}", c.as_str())).unwrap();
            assert_eq!(m.label, c.label());
            let goal = if *c == FoodCategory::FruitVeg {
                Goal::AtLeast
            } else {
                Goal::AtMost
            };
            assert_eq!(m.goal, goal, "{}", m.key);
        }
        let categories = METRICS.iter().filter(|m| m.key.starts_with("category:"));
        assert_eq!(categories.count(), FoodCategory::ALL.len());
    }
}
