//! Goals that aren't nutrients: what a target row can hold besides a
//! nutrient key. Served as `/api/meta.metrics`; a new goal is one entry
//! here.

use serde::Serialize;

use super::FoodCategory;
use super::limits::{BODY_KG_MAX, BODY_KG_MIN};
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

/// How a stored value is shown: `shown = stored × factor` in `unit`,
/// typed in an `input` of that kind (`number`, or `time`: minutes after
/// midnight as a clock).
#[derive(Debug, Clone, Copy, Serialize)]
pub struct MetricDisplay {
    pub label: &'static str,
    pub unit: &'static str,
    pub factor: f64,
    pub input: &'static str,
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
        input: "number",
    }
}

/// Minutes in a day: the most sleep a night can hold.
pub const DAY_MIN: f64 = 1440.0;

/// A clock time to keep each day (bedtime, wake-up): minutes after
/// midnight, met within [`CLOCK_WINDOW_MIN`] either way, mod 1440.
const fn clock(key: &'static str, label: &'static str) -> Metric {
    Metric {
        key,
        label,
        unit: "min",
        goal: Goal::About,
        per: Per::Day,
        section: "sleep",
        display: MetricDisplay {
            label,
            unit: "",
            factor: 1.0,
            input: "time",
        },
        default: None,
        range: (0.0, DAY_MIN - 1.0),
    }
}

/// How far from a clock target a time still keeps it (minutes).
pub const CLOCK_WINDOW_MIN: f64 = 30.0;

/// Whether `key` is a clock time ([`clock`]).
#[must_use]
pub fn is_clock(key: &str) -> bool {
    find_metric(key).is_some_and(|m| m.display.input == "time")
}

pub const METRICS: &[Metric] = &[
    Metric {
        key: "steps",
        label: "Steps",
        unit: "steps",
        goal: Goal::AtLeast,
        per: Per::Day,
        section: "activity",
        display: shown("Steps", "steps"),
        // Paluch et al., Lancet Public Health 2022: the benefit plateaus at
        // 8–10k.
        default: Some(10_000.0),
        // Ultramarathon days reach about 60k; a daily goal past that is no
        // one's (a logged day may still be up to `STEPS_MAX`).
        range: (0.0, 60_000.0),
    },
    Metric {
        key: "workouts_per_week",
        // Every activity counts, not only the `workout` type.
        label: "Activities",
        unit: "activities",
        goal: Goal::AtLeast,
        per: Per::Week,
        section: "activity",
        display: shown("Activities", "activities"),
        default: None,
        // `WORKOUTS_PER_WEEK_MAX`: two a day, already tighter than the
        // 21 (three a day) that is physically possible.
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
            input: "number",
        },
        // Watson et al., Sleep 2015 (AASM/SRS): 7 hours or more.
        default: Some(420.0),
        // 4–14 h: under 4 h a night is sleep deprivation, past 14 h
        // hypersomnia; neither is a goal.
        range: (240.0, 840.0),
    },
    clock("bedtime", "Bedtime"),
    clock("wake_time", "Wake-up"),
    Metric {
        key: "active_kcal",
        label: "Active energy",
        unit: "kcal",
        goal: Goal::AtLeast,
        per: Per::Day,
        section: "activity",
        display: shown("Active energy", "kcal"),
        default: None,
        // About 4,000 kcal is a pro cyclist's grand-tour stage; a daily goal
        // past it isn't sustainable (a logged day may reach `ACTIVE_KCAL_MAX`).
        range: (0.0, 4_000.0),
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
    Metric {
        key: "goal_body_fat",
        label: "Goal body fat",
        unit: "%",
        goal: Goal::About,
        per: Per::Once,
        section: "body",
        display: shown("Goal body fat", "%"),
        default: None,
        // Essential fat: about 3–5 % in men, 10–13 % in women (ACE);
        // `ESSENTIAL_FAT` holds the floor by sex. Above 60 % no goal is needed.
        range: (ESSENTIAL_FAT.0, 60.0),
    },
    Metric {
        key: "goal_muscle",
        label: "Goal muscle",
        unit: "%",
        goal: Goal::About,
        per: Per::Once,
        section: "body",
        display: shown("Goal muscle", "%"),
        default: None,
        // A scale's skeletal muscle share: about 25–45 % in adults, so
        // 20–60 holds any goal a body reaches.
        range: (20.0, 60.0),
    },
    category("category:sweets_snacks", FoodCategory::SweetsSnacks, "g"),
    category("category:fast_food", FoodCategory::FastFood, "g"),
    category("category:sugary_drinks", FoodCategory::SugaryDrinks, "g"),
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
        // 10 kg of one kind of food a day is more than a stomach takes in.
        range: (0.0, CATEGORY_G_MAX),
    }
}

#[must_use]
pub fn find_metric(key: &str) -> Option<&'static Metric> {
    METRICS.iter().find(|m| m.key == key)
}

/// Grams a day a food-category target may be.
const CATEGORY_G_MAX: f64 = 10_000.0;

/// Essential body fat, % (male, female): below it is no goal a body
/// stays healthy at (American Council on Exercise).
pub const ESSENTIAL_FAT: (f64, f64) = (5.0, 12.0);

/// Energy a day (kcal) a target may be.
const ENERGY_KCAL: (f64, f64) = (800.0, 6_000.0);

/// Nutrient targets past what any diet holds, stored unit: `[min, max]`.
const NUTRIENT_RANGES: &[(&str, (f64, f64))] = &[
    // Under 800 kcal is a very-low-calorie diet, for medical supervision
    // only (NICE CG189); past 6,000 kcal a day isn't eaten day after day.
    ("energy", ENERGY_KCAL),
    // About 4 g/kg for a 100 kg lifter; past 400 g the liver can't clear
    // the urea (Bilsborough & Mann 2006: ~3.5 g/kg ceiling).
    ("protein", (0.0, 400.0)),
    // The energy ceiling eaten as nothing else: 4 kcal/g, 9 kcal/g.
    ("carbs", (0.0, ENERGY_KCAL.1 / 4.0)),
    ("net_carbs", (0.0, ENERGY_KCAL.1 / 4.0)),
    ("fat", (0.0, ENERGY_KCAL.1 / 9.0)),
    // Past about 1 L an hour for 8 waking hours kidneys can't excrete it:
    // hyponatraemia.
    ("water", (0.0, 8_000.0)),
];

/// A nutrient target's allowed values: [`NUTRIENT_RANGES`], else what
/// 10 kg of food made only of it could hold ([`nutrients::per100_max`]).
#[must_use]
pub fn nutrient_range(n: &nutrients::Nutrient) -> (f64, f64) {
    NUTRIENT_RANGES
        .iter()
        .find(|(k, _)| *k == n.key)
        .map_or((0.0, nutrients::per100_max(n.unit) * 100.0), |(_, r)| *r)
}

/// A target key's label, direction and allowed values: a nutrient's
/// ([`nutrient_range`]) or a metric's. `None`: not a target key.
#[must_use]
pub fn target_key(key: &str) -> Option<(&'static str, Goal, (f64, f64))> {
    nutrients::find(key)
        .map(|n| (n.label, n.goal(), nutrient_range(n)))
        .or_else(|| find_metric(key).map(|m| (m.label, m.goal, m.range)))
}

#[cfg(test)]
mod tests {
    use super::super::limits::{ACTIVE_KCAL_MAX, STEPS_MAX, WORKOUTS_PER_WEEK_MAX};
    use super::*;

    #[test]
    fn ranges_stay_within_the_input_limits() {
        let max = |key| find_metric(key).unwrap().range.1;
        assert!(max("steps") <= f64::from(i32::try_from(STEPS_MAX).unwrap()));
        assert_close!(max("workouts_per_week"), f64::from(WORKOUTS_PER_WEEK_MAX));
        assert!(max("active_kcal") <= f64::from(i32::try_from(ACTIVE_KCAL_MAX).unwrap()));
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
