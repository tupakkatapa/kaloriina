//! Nutrient registry and per-amount nutrient maps.
//!
//! The registry holds the 61 nutrients the diary export's `dailysummary.csv`
//! carries, so imported history loses nothing, in display order by category.
//! Labels name the stored quantity; outside vocabularies (export headers,
//! Open Food Facts and Fineli fields) live in their importers.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Nutrient {
    pub key: &'static str,
    pub label: &'static str,
    pub unit: &'static str,
    pub category: Category,
}

/// The sections nutrients are listed under, in display order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Category {
    General,
    Carbohydrates,
    Fats,
    Protein,
    Vitamins,
    Minerals,
}

/// Which way a single target number points.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Goal {
    /// Reach it: protein, fibre, vitamins, minerals.
    AtLeast,
    /// Stay under it: salt, saturated fat, sugars.
    AtMost,
    /// Land near it: energy and the energy-giving macronutrients.
    About,
}

/// kJ in one kcal.
pub const KJ_PER_KCAL: f64 = 4.184;
/// Vitamin D: international units per µg.
pub const IU_PER_UG: f64 = 40.0;
/// Grams of salt (sodium chloride) per gram of sodium.
pub const SALT_PER_SODIUM: f64 = 2.5;

/// How far over an "about" target may go before it counts as over.
pub const ABOUT_TOLERANCE: f64 = 0.10;

impl Goal {
    /// The min/max bounds a single target number stands for.
    #[must_use]
    pub fn bounds(self, target: f64) -> (Option<f64>, Option<f64>) {
        match self {
            Self::AtLeast => (Some(target), None),
            Self::AtMost => (None, Some(target)),
            // Rounded so the wire shows 209, not 209.00000000000003.
            Self::About => (
                Some(target),
                Some((target * (1.0 + ABOUT_TOLERANCE) * 1e6).round() / 1e6),
            ),
        }
    }
}

impl Nutrient {
    /// How the EU nutrition label shows it: label, unit and the factor from
    /// the stored unit (sodium mg → salt g, vitamin D IU → µg).
    #[must_use]
    pub fn display(&self) -> (&'static str, &'static str, f64) {
        match self.key {
            "sodium" => ("Salt", "g", SALT_PER_SODIUM / 1000.0),
            "vitamin_d" => ("Vitamin D", "µg", 1.0 / IU_PER_UG),
            "sugars" => ("Sugars (carbs)", self.unit, 1.0),
            _ => (self.label, self.unit, 1.0),
        }
    }

    #[must_use]
    pub fn goal(&self) -> Goal {
        match self.key {
            "energy" | "net_carbs" | "carbs" | "fat" => Goal::About,
            "sodium" | "saturated" | "trans_fats" | "sugars" | "added_sugars" | "alcohol"
            | "caffeine" | "cholesterol" | "oxalate" => Goal::AtMost,
            _ => Goal::AtLeast,
        }
    }
}

const fn n(
    key: &'static str,
    label: &'static str,
    unit: &'static str,
    category: Category,
) -> Nutrient {
    Nutrient {
        key,
        label,
        unit,
        category,
    }
}

use Category::{Carbohydrates, Fats, General, Minerals, Protein, Vitamins};

pub const REGISTRY: [Nutrient; 61] = [
    n("energy", "Energy", "kcal", General),
    n("alcohol", "Alcohol", "g", General),
    n("caffeine", "Caffeine", "mg", General),
    n("water", "Water", "g", General),
    n("oxalate", "Oxalate", "mg", General),
    n("phytate", "Phytate", "mg", General),
    n("net_carbs", "Carbohydrate", "g", Carbohydrates),
    n("carbs", "Total carbohydrate", "g", Carbohydrates),
    n("sugars", "Sugars", "g", Carbohydrates),
    n("added_sugars", "Added sugars", "g", Carbohydrates),
    n("starch", "Starch", "g", Carbohydrates),
    n("fiber", "Fibre", "g", Carbohydrates),
    n("insoluble_fiber", "Insoluble fibre", "g", Carbohydrates),
    n("soluble_fiber", "Soluble fibre", "g", Carbohydrates),
    n("fat", "Fat", "g", Fats),
    n("saturated", "Saturated fat", "g", Fats),
    n("monounsaturated", "Monounsaturated fat", "g", Fats),
    n("polyunsaturated", "Polyunsaturated fat", "g", Fats),
    n("trans_fats", "Trans fat", "g", Fats),
    n("cholesterol", "Cholesterol", "mg", Fats),
    n("omega_3", "Omega-3", "g", Fats),
    n("ala", "ALA", "g", Fats),
    n("epa", "EPA", "g", Fats),
    n("dha", "DHA", "g", Fats),
    n("omega_6", "Omega-6", "g", Fats),
    n("la", "LA", "g", Fats),
    n("aa", "AA", "g", Fats),
    n("protein", "Protein", "g", Protein),
    n("cystine", "Cystine", "g", Protein),
    n("histidine", "Histidine", "g", Protein),
    n("isoleucine", "Isoleucine", "g", Protein),
    n("leucine", "Leucine", "g", Protein),
    n("lysine", "Lysine", "g", Protein),
    n("methionine", "Methionine", "g", Protein),
    n("phenylalanine", "Phenylalanine", "g", Protein),
    n("threonine", "Threonine", "g", Protein),
    n("tryptophan", "Tryptophan", "g", Protein),
    n("tyrosine", "Tyrosine", "g", Protein),
    n("valine", "Valine", "g", Protein),
    n("vitamin_a", "Vitamin A", "µg", Vitamins),
    n("b1", "B1 (thiamine)", "mg", Vitamins),
    n("b2", "B2 (riboflavin)", "mg", Vitamins),
    n("b3", "B3 (niacin)", "mg", Vitamins),
    n("b5", "B5 (pantothenic acid)", "mg", Vitamins),
    n("b6", "B6 (pyridoxine)", "mg", Vitamins),
    n("b12", "B12 (cobalamin)", "µg", Vitamins),
    n("folate", "Folate", "µg", Vitamins),
    n("vitamin_c", "Vitamin C", "mg", Vitamins),
    n("vitamin_d", "Vitamin D", "IU", Vitamins),
    n("vitamin_e", "Vitamin E", "mg", Vitamins),
    n("vitamin_k", "Vitamin K", "µg", Vitamins),
    n("sodium", "Sodium", "mg", Minerals),
    n("potassium", "Potassium", "mg", Minerals),
    n("calcium", "Calcium", "mg", Minerals),
    n("magnesium", "Magnesium", "mg", Minerals),
    n("phosphorus", "Phosphorus", "mg", Minerals),
    n("iron", "Iron", "mg", Minerals),
    n("zinc", "Zinc", "mg", Minerals),
    n("copper", "Copper", "mg", Minerals),
    n("manganese", "Manganese", "mg", Minerals),
    n("selenium", "Selenium", "µg", Minerals),
];

/// Find a registry entry by key.
#[must_use]
pub fn find(key: &str) -> Option<&'static Nutrient> {
    REGISTRY.iter().find(|n| n.key == key)
}

/// Sparse nutrient amounts keyed by registry key. Missing = unknown.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(transparent)]
pub struct Nutrients(BTreeMap<String, f64>);

/// Written without arithmetic noise: 475, not 474.99999999999994 (nine
/// decimals keep every real amount, down to micrograms of micrograms).
impl Serialize for Nutrients {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = s.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            map.serialize_entry(k, &((v * 1e9).round() / 1e9))?;
        }
        map.end()
    }
}

impl Nutrients {
    #[must_use]
    pub fn get(&self, key: &str) -> Option<f64> {
        self.0.get(key).copied()
    }

    pub fn insert(&mut self, key: &str, value: f64) {
        self.0.insert(key.to_owned(), value);
    }

    /// The same amounts without `key`.
    #[must_use]
    pub fn without(&self, key: &str) -> Self {
        let mut out = self.clone();
        out.0.remove(key);
        out
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Multiply every amount, e.g. by `grams / 100` for per-100 g values.
    #[must_use]
    pub fn scale(&self, factor: f64) -> Self {
        Self(
            self.0
                .iter()
                .map(|(k, v)| (k.clone(), v * factor))
                .collect(),
        )
    }

    pub fn add(&mut self, other: &Self) {
        for (k, v) in &other.0 {
            *self.0.entry(k.clone()).or_default() += v;
        }
    }

    #[must_use]
    pub fn sum<'a>(items: impl IntoIterator<Item = &'a Self>) -> Self {
        let mut total = Self::default();
        for item in items {
            total.add(item);
        }
        total
    }

    /// Reject unknown keys and non-finite or negative values.
    ///
    /// # Errors
    /// Returns the offending key.
    pub fn validate(&self) -> Result<(), String> {
        match self
            .0
            .iter()
            .find(|(k, v)| find(k).is_none() || !v.is_finite() || **v < 0.0)
        {
            Some((k, _)) => Err(k.clone()),
            None => Ok(()),
        }
    }

    /// Per-100 g values a food can have: each at most [`per100_max`] of
    /// its unit. Only new foods are held to it (their API writes, Open Food
    /// Facts and Fineli); history (entries, day totals, imports) never is.
    /// Run after [`Nutrients::validate`].
    ///
    /// # Errors
    /// The first nutrient over its maximum, with that maximum.
    pub fn validate_per100(&self) -> Result<(), (&'static Nutrient, f64)> {
        for (k, v) in &self.0 {
            if let Some(n) = find(k) {
                let max = per100_max(n.unit);
                if *v > max {
                    return Err((n, max));
                }
            }
        }
        Ok(())
    }
}

impl Nutrients {
    /// A food these nutrients are `grams` of (100 when unknown), or of
    /// more grams where that's needed to keep every per-100 value within
    /// [`per100_max`]: the grams, and the food's per-100 values. How quick
    /// adds became foods (migration 31 and old export files).
    #[must_use]
    pub fn per100_fitting(&self, grams: Option<f64>) -> (f64, Self) {
        let mut g = grams.unwrap_or(100.0);
        for (k, v) in &self.0 {
            if let Some(n) = find(k) {
                // The next float up, so the division can't round over the cap.
                let need = (v * 100.0 / per100_max(n.unit)).next_up();
                g = g.max(need);
            }
        }
        (g, self.scale(100.0 / g))
    }
}

/// The most of a nutrient 100 g of food can hold, by stored unit: energy
/// 900 kcal (pure fat), anything else 100 g in that unit.
pub const PER100_MAX: [(&str, f64); 5] = [
    ("kcal", 900.0),
    ("g", 100.0),
    ("mg", 100_000.0),
    ("µg", 1e8),
    ("IU", 1e8 * IU_PER_UG),
];

/// [`PER100_MAX`] of `unit`; 100 for a unit it doesn't name.
#[must_use]
pub fn per100_max(unit: &str) -> f64 {
    PER100_MAX
        .iter()
        .find(|(u, _)| *u == unit)
        .map_or(100.0, |(_, max)| *max)
}

#[cfg(test)]
impl Nutrients {
    pub fn of(pairs: &[(&str, f64)]) -> Self {
        Self(pairs.iter().map(|(k, v)| ((*k).to_owned(), *v)).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nut(pairs: &[(&str, f64)]) -> Nutrients {
        Nutrients::of(pairs)
    }

    #[test]
    fn goals_turn_one_number_into_bounds() {
        assert_eq!(Goal::AtLeast.bounds(100.0), (Some(100.0), None));
        assert_eq!(Goal::AtMost.bounds(5.0), (None, Some(5.0)));
        let (lo, hi) = Goal::About.bounds(2000.0);
        assert_eq!(lo, Some(2000.0));
        assert_close!(hi.unwrap(), 2200.0);
        assert_eq!(find("sodium").unwrap().goal(), Goal::AtMost);
        assert_eq!(find("energy").unwrap().goal(), Goal::About);
        assert_eq!(find("iron").unwrap().goal(), Goal::AtLeast);
    }

    #[test]
    fn keys_are_unique() {
        let mut keys: Vec<_> = REGISTRY.iter().map(|n| n.key).collect();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), REGISTRY.len());
    }

    #[test]
    fn categories_are_contiguous_in_display_order() {
        let mut seen: Vec<Category> = Vec::new();
        for n in &REGISTRY {
            if seen.last() != Some(&n.category) {
                assert!(!seen.contains(&n.category), "{:?} split", n.category);
                seen.push(n.category);
            }
        }
        assert_eq!(
            seen,
            [General, Carbohydrates, Fats, Protein, Vitamins, Minerals]
        );
    }

    #[test]
    fn scale_and_sum() {
        let per100 = nut(&[("protein", 10.0), ("energy", 200.0)]);
        let half = per100.scale(0.5);
        assert_eq!(half, nut(&[("protein", 5.0), ("energy", 100.0)]));
        let total = Nutrients::sum([&half, &nut(&[("fat", 1.0), ("protein", 1.0)])]);
        assert_eq!(
            total,
            nut(&[("protein", 6.0), ("energy", 100.0), ("fat", 1.0)])
        );
    }

    #[test]
    fn validate_rejects_bad_input() {
        assert!(nut(&[("protein", 1.0)]).validate().is_ok());
        assert_eq!(nut(&[("bogus", 1.0)]).validate(), Err("bogus".into()));
        assert_eq!(nut(&[("fat", -1.0)]).validate(), Err("fat".into()));
        assert_eq!(nut(&[("fat", f64::NAN)]).validate(), Err("fat".into()));
    }

    #[test]
    fn validate_per100_rejects_huge_values() {
        let over = |pairs: &[(&str, f64)]| nut(pairs).validate_per100().map_err(|(n, _)| n.key);
        assert_eq!(over(&[("energy", 901.0)]), Err("energy"));
        assert_eq!(over(&[("protein", 100.1)]), Err("protein"));
        assert_eq!(over(&[("protein", 1e308)]), Err("protein"));
        assert_eq!(over(&[("sodium", 100_000.1)]), Err("sodium"));
        assert_eq!(
            over(&[("energy", 900.0), ("fat", 100.0), ("sodium", 40_000.0)]),
            Ok(())
        );
        assert_eq!(
            over(&[("vitamin_d", 4e9)]),
            Ok(()),
            "100 g of vitamin D, in IU"
        );
        assert_eq!(over(&[("b12", 1e8)]), Ok(()), "µg");
        assert!(nut(&[("vitamin_d", 4.1e9)]).validate_per100().is_err());
    }

    #[test]
    fn a_quick_add_fits_as_a_food() {
        let snack = nut(&[("energy", 100.0)]);
        assert_eq!(snack.per100_fitting(None), (100.0, snack.clone()));
        let (g, per100) = snack.per100_fitting(Some(50.0));
        assert_close!(g, 50.0);
        assert_close!(per100.get("energy").unwrap(), 200.0);
        // 2,500 kcal at 100 g would be 2,500 kcal per 100 g: more grams.
        let feast = nut(&[("energy", 2500.0), ("fat", 150.0), ("protein", 1.0 / 3.0)]);
        let (g, per100) = feast.per100_fitting(None);
        assert!(g > 277.7 && g < 277.8, "{g}");
        assert!(per100.validate_per100().is_ok(), "{per100:?}");
        assert_close!(per100.scale(g / 100.0).get("energy").unwrap(), 2500.0);
    }
}
