//! Nutrient registry and per-amount nutrient maps.
//!
//! The registry holds the 61 nutrients the diary export's `dailysummary.csv`
//! carries, so imported history loses nothing, plus creatine (as labelled:
//! creatine monohydrate grams), in display order by category, plus EPA+DHA,
//! derived from EPA and DHA ([`DERIVED`]).
//! Labels name the stored quantity; outside vocabularies (export headers,
//! Open Food Facts and Fineli fields) live in their importers.

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
    Carbs,
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
/// Atwater's general factors, kcal per gram: protein and carbohydrate 4,
/// fat 9 (web/nutrients.mjs `KCAL_PER_G`).
pub const KCAL_PER_G_PROTEIN: f64 = 4.0;
pub const KCAL_PER_G_CARBS: f64 = 4.0;
pub const KCAL_PER_G_FAT: f64 = 9.0;

/// How far either way of an "about" target still counts as on it.
pub const ABOUT_TOLERANCE: f64 = 0.05;

impl Goal {
    /// The min/max bounds a single target number stands for.
    #[must_use]
    pub fn bounds(self, target: f64) -> (Option<f64>, Option<f64>) {
        match self {
            Self::AtLeast => (Some(target), None),
            Self::AtMost => (None, Some(target)),
            // Rounded so the wire shows 209, not 209.00000000000003.
            Self::About => {
                let at = |k: f64| Some((target * k * 1e6).round() / 1e6);
                (at(1.0 - ABOUT_TOLERANCE), at(1.0 + ABOUT_TOLERANCE))
            }
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
            // A gram of water is a millilitre, as hydration shows it.
            "water" => (self.label, "ml", 1.0),
            _ => (self.label, self.unit, 1.0),
        }
    }

    /// How the US Nutrition Facts label shows it: sodium as sodium (mg),
    /// vitamin D in µg, net carbs named apart from total carbs (which the
    /// label leads with, fibre included), and fiber spelt as it spells it.
    #[must_use]
    pub fn display_us(&self) -> (&'static str, &'static str, f64) {
        match self.key {
            "sodium" => (self.label, self.unit, 1.0),
            "net_carbs" => ("Net carbs", self.unit, 1.0),
            "sugars" => ("Total sugars", self.unit, 1.0),
            "fiber" => ("Fiber", self.unit, 1.0),
            "insoluble_fiber" => ("Insoluble fiber", self.unit, 1.0),
            "soluble_fiber" => ("Soluble fiber", self.unit, 1.0),
            _ => self.display(),
        }
    }

    /// Its name where room is tight, from the label's (`label`): net carbs
    /// are the macro trio's "Carbs" on either label.
    #[must_use]
    pub fn short(&self, label: &'static str) -> &'static str {
        match self.key {
            "net_carbs" => "Carbs",
            _ => label,
        }
    }

    /// The FDA Daily Value ([`FDA_DV`]) in the stored unit; `None` for a
    /// nutrient without one.
    #[must_use]
    pub fn fda_dv(&self) -> Option<f64> {
        FDA_DV
            .iter()
            .find(|(key, _)| *key == self.key)
            .map(|(_, dv)| *dv)
    }

    /// The EU nutrient reference value ([`EU_NRV`]) in the stored unit;
    /// `None` for a nutrient without one.
    #[must_use]
    pub fn nrv(&self) -> Option<f64> {
        EU_NRV
            .iter()
            .find(|(key, _)| *key == self.key)
            .map(|(_, nrv)| *nrv)
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

    /// Computed from others ([`DERIVED`]), never typed.
    #[must_use]
    pub fn derived(&self) -> bool {
        DERIVED.iter().any(|(key, _)| *key == self.key)
    }

    /// Its target is an adequate intake (EFSA AI: what healthy people
    /// eat), not a requirement (PRI): falling short is "below the
    /// recommended amount", not a deficiency. EFSA's DRVs for adults.
    #[must_use]
    pub fn ai(&self) -> bool {
        matches!(
            self.key,
            "water"
                | "fiber"
                | "ala"
                | "la"
                | "epa_dha"
                | "b5"
                | "b12"
                | "vitamin_d"
                | "vitamin_e"
                | "vitamin_k"
                | "potassium"
                | "magnesium"
                | "phosphorus"
                | "copper"
                | "manganese"
                | "selenium"
        )
    }
}

/// The FDA Daily Values (21 CFR 101.9(c), adults and children 4 years and
/// over) in the stored unit: the US label's %DV.
pub const FDA_DV: [(&str, f64); 29] = [
    ("fat", 78.0),
    ("saturated", 20.0),
    ("cholesterol", 300.0),
    ("sodium", 2300.0),
    ("carbs", 275.0),
    ("fiber", 28.0),
    ("added_sugars", 50.0),
    ("protein", 50.0),
    ("vitamin_a", 900.0),
    ("b1", 1.2),
    ("b2", 1.3),
    ("b3", 16.0),
    ("b5", 5.0),
    ("b6", 1.7),
    ("b12", 2.4),
    ("folate", 400.0),
    ("vitamin_c", 90.0),
    // 20 µg.
    ("vitamin_d", 20.0 * IU_PER_UG),
    ("vitamin_e", 15.0),
    ("vitamin_k", 120.0),
    ("potassium", 4700.0),
    ("calcium", 1300.0),
    ("magnesium", 420.0),
    ("phosphorus", 1250.0),
    ("iron", 18.0),
    ("zinc", 11.0),
    ("copper", 0.9),
    ("manganese", 2.3),
    ("selenium", 55.0),
];

/// The EU nutrient reference values for vitamins and minerals (Reg. (EU)
/// 1169/2011 Annex XIII Part A), in the stored unit, for those the registry
/// holds: what "source of" and "high" a vitamin or mineral are measured
/// against (Reg. (EC) 1924/2006 Annex).
pub const EU_NRV: [(&str, f64); 21] = [
    ("vitamin_a", 800.0),
    ("b1", 1.1),
    ("b2", 1.4),
    ("b3", 16.0),
    ("b5", 6.0),
    ("b6", 1.4),
    ("b12", 2.5),
    ("folate", 200.0),
    ("vitamin_c", 80.0),
    // 5 µg.
    ("vitamin_d", 5.0 * IU_PER_UG),
    ("vitamin_e", 12.0),
    ("vitamin_k", 75.0),
    ("potassium", 2000.0),
    ("calcium", 800.0),
    ("magnesium", 375.0),
    ("phosphorus", 700.0),
    ("iron", 14.0),
    ("zinc", 10.0),
    ("copper", 1.0),
    ("manganese", 2.0),
    ("selenium", 55.0),
];

/// Nutrients that are the sum of others: present when every part is,
/// recomputed whenever amounts are read or written (a typed value is
/// overwritten), so they're stored for SQL to read and always agree.
pub const DERIVED: [(&str, &[&str]); 1] = [("epa_dha", &["epa", "dha"])];

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

use Category::{Carbs, Fats, General, Minerals, Protein, Vitamins};

pub const REGISTRY: [Nutrient; 63] = [
    n("energy", "Energy", "kcal", General),
    n("alcohol", "Alcohol", "g", General),
    n("caffeine", "Caffeine", "mg", General),
    n("creatine", "Creatine", "g", General),
    n("water", "Water", "g", General),
    n("oxalate", "Oxalate", "mg", General),
    n("phytate", "Phytate", "mg", General),
    n("net_carbs", "Carbs", "g", Carbs),
    n("carbs", "Total carbs", "g", Carbs),
    n("sugars", "Sugars", "g", Carbs),
    n("added_sugars", "Added sugars", "g", Carbs),
    n("starch", "Starch", "g", Carbs),
    n("fiber", "Fibre", "g", Carbs),
    n("insoluble_fiber", "Insoluble fibre", "g", Carbs),
    n("soluble_fiber", "Soluble fibre", "g", Carbs),
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
    n("epa_dha", "EPA+DHA", "g", Fats),
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

/// A total is known (ADR 0030) once the parts carrying a nutrient supplied
/// this share of its energy; under it, it is a lower bound and nothing is
/// judged by it.
pub const KNOWN: f64 = 0.8;

/// Sparse nutrient amounts by registry key, held in registry order (one slot a
/// nutrient, `None` = unknown, boxed: one allocation): parsed without
/// allocating a key, and summed slot by slot. A key outside the registry is
/// kept aside, the first one only, for [`Nutrients::validate`] to name.
#[derive(Debug, Clone, PartialEq)]
pub struct Nutrients {
    values: Box<[Option<f64>; REGISTRY.len()]>,
    unknown: Option<Box<str>>,
}

impl Default for Nutrients {
    fn default() -> Self {
        Self {
            values: Box::new([None; REGISTRY.len()]),
            unknown: None,
        }
    }
}

/// Registry keys sorted, with their index: a key's slot by binary search.
static BY_KEY: std::sync::LazyLock<Vec<(&'static str, usize)>> = std::sync::LazyLock::new(|| {
    let mut keys: Vec<_> = REGISTRY
        .iter()
        .enumerate()
        .map(|(i, n)| (n.key, i))
        .collect();
    keys.sort_unstable();
    keys
});

/// The registry index of `key`.
fn slot(key: &str) -> Option<usize> {
    BY_KEY
        .binary_search_by(|(k, _)| (*k).cmp(key))
        .ok()
        .map(|i| BY_KEY[i].1)
}

impl<'de> Deserialize<'de> for Nutrients {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de::{DeserializeSeed, MapAccess, Visitor};
        use std::fmt;

        /// A map key as its slot, or the key itself when unknown; borrowed
        /// where the input allows, so a known key costs no allocation.
        enum Key {
            Slot(usize),
            Unknown(Box<str>),
        }
        struct KeySeed;
        impl<'de> DeserializeSeed<'de> for KeySeed {
            type Value = Key;
            fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<Key, D::Error> {
                d.deserialize_str(KeySeed)
            }
        }
        impl Visitor<'_> for KeySeed {
            type Value = Key;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a nutrient key")
            }
            fn visit_str<E: serde::de::Error>(self, key: &str) -> Result<Key, E> {
                Ok(slot(key).map_or_else(|| Key::Unknown(key.into()), Key::Slot))
            }
        }
        struct MapVisitor;
        impl<'de> Visitor<'de> for MapVisitor {
            type Value = Nutrients;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a map of nutrient amounts")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Nutrients, A::Error> {
                let mut out = Nutrients::default();
                while let Some(key) = map.next_key_seed(KeySeed)? {
                    let value: f64 = map.next_value()?;
                    match key {
                        Key::Slot(i) => out.values[i] = Some(value),
                        Key::Unknown(k) => {
                            out.unknown.get_or_insert(k);
                        }
                    }
                }
                Ok(out.derived())
            }
        }
        d.deserialize_map(MapVisitor)
    }
}

/// Written without arithmetic noise: 475, not 474.99999999999994 (nine
/// decimals keep every real amount, down to micrograms of micrograms),
/// [`DERIVED`] amounts recomputed, keys in registry order.
impl Serialize for Nutrients {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let all = self.clone().derived();
        let mut map = s.serialize_map(Some(all.values.iter().flatten().count()))?;
        for (n, v) in REGISTRY.iter().zip(*all.values) {
            if let Some(v) = v {
                map.serialize_entry(n.key, &((v * 1e9).round() / 1e9))?;
            }
        }
        map.end()
    }
}

impl Nutrients {
    /// With every [`DERIVED`] amount recomputed from its parts.
    fn derived(mut self) -> Self {
        for (key, parts) in DERIVED {
            // The sum of the parts known is a floor, not the sum: EFSA's
            // EPA+DHA intake is for both.
            match parts.iter().map(|p| self.get(p)).sum::<Option<f64>>() {
                Some(sum) => self.insert(key, sum),
                None => self.remove(key),
            }
        }
        self
    }

    #[must_use]
    pub fn get(&self, key: &str) -> Option<f64> {
        self.values[slot(key)?]
    }

    /// The keys it has a value for, in registry order.
    pub fn keys(&self) -> impl Iterator<Item = &'static str> + '_ {
        REGISTRY
            .iter()
            .zip(self.values.iter())
            .filter(|(_, v)| v.is_some())
            .map(|(n, _)| n.key)
    }

    /// Set `key`; one outside the registry is kept aside for
    /// [`Nutrients::validate`] to refuse.
    pub fn insert(&mut self, key: &str, value: f64) {
        match slot(key) {
            Some(i) => self.values[i] = Some(value),
            None => {
                self.unknown.get_or_insert_with(|| key.into());
            }
        }
    }

    fn remove(&mut self, key: &str) {
        if let Some(i) = slot(key) {
            self.values[i] = None;
        }
    }

    /// The same amounts without `key`.
    #[must_use]
    pub fn without(&self, key: &str) -> Self {
        let mut out = self.clone();
        out.remove(key);
        out
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.values.iter().all(Option::is_none) && self.unknown.is_none()
    }

    /// Multiply every amount, e.g. by `grams / 100` for per-100 g values.
    #[must_use]
    pub fn scale(&self, factor: f64) -> Self {
        Self {
            values: Box::new(self.values.map(|v| v.map(|v| v * factor))),
            unknown: self.unknown.clone(),
        }
    }

    pub fn add(&mut self, other: &Self) {
        for (mine, theirs) in self.values.iter_mut().zip(other.values.iter()) {
            if let Some(v) = theirs {
                *mine = Some(mine.unwrap_or(0.0) + v);
            }
        }
    }

    /// For each key `other` has, add `by(key)` to this one's: what stands
    /// behind a total, key by key (ADR 0030).
    pub fn add_behind(&mut self, other: &Self, by: impl Fn(&str) -> f64) {
        for ((mine, theirs), n) in self
            .values
            .iter_mut()
            .zip(other.values.iter())
            .zip(&REGISTRY)
        {
            if theirs.is_some() {
                *mine = Some(mine.unwrap_or(0.0) + by(n.key));
            }
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

    /// Each key with its amount, in registry order.
    fn pairs(&self) -> impl Iterator<Item = (&'static Nutrient, f64)> + '_ {
        REGISTRY
            .iter()
            .zip(self.values.iter())
            .filter_map(|(n, v)| v.map(|v| (n, v)))
    }

    /// Reject unknown keys and non-finite or negative values.
    ///
    /// # Errors
    /// Returns the offending key.
    pub fn validate(&self) -> Result<(), String> {
        if let Some(k) = &self.unknown {
            return Err(k.to_string());
        }
        match self.pairs().find(|(_, v)| !v.is_finite() || *v < 0.0) {
            Some((n, _)) => Err(n.key.to_owned()),
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
        for (n, v) in self.pairs() {
            let max = per100_max(n.unit);
            if v > max {
                return Err((n, max));
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
        for (n, v) in self.pairs() {
            // Aimed at what 100 g can physically hold, not the rounding
            // margin; the next float up, so the division can't round over.
            let need = (v * 100.0 / physical(n.unit)).next_up();
            g = g.max(need);
        }
        (g, self.scale(100.0 / g))
    }
}

/// What 100 g of food can physically hold of a nutrient, by stored unit:
/// energy 900 kcal (pure fat), anything else 100 g in that unit.
pub const PER100_PHYSICAL: [(&str, f64); 5] = [
    ("kcal", 900.0),
    ("g", 100.0),
    ("mg", 100_000.0),
    ("µg", 1e8),
    ("IU", 1e8 * IU_PER_UG),
];

/// The most of a nutrient 100 g of food may hold, by stored unit:
/// [`PER100_PHYSICAL`] with a 10 % margin, as published data is rounded
/// over it (Fineli's calculated dishes: 101.28 g water). It stops typos
/// like 1e300. Served as the input limits.
pub const PER100_MAX: [(&str, f64); 5] = {
    let mut table = PER100_PHYSICAL;
    let mut i = 0;
    while i < table.len() {
        // × 11 / 10, not × 1.1: 900 × 1.1 is 990.0000000000001.
        table[i].1 = table[i].1 * 11.0 / 10.0;
        i += 1;
    }
    table
};

/// What 100 g can hold of `unit` ([`PER100_PHYSICAL`]); that of grams for
/// a unit it doesn't name.
fn physical(unit: &str) -> f64 {
    PER100_PHYSICAL
        .iter()
        .find(|(u, _)| *u == unit)
        .map_or(100.0, |(_, max)| *max)
}

/// [`PER100_MAX`] of `unit`; that of grams for a unit it doesn't name.
#[must_use]
pub fn per100_max(unit: &str) -> f64 {
    physical(unit) * 11.0 / 10.0
}

#[cfg(test)]
impl Nutrients {
    pub fn of(pairs: &[(&str, f64)]) -> Self {
        let mut out = Self::default();
        for (k, v) in pairs {
            out.insert(k, *v);
        }
        out
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
        assert_close!(lo.unwrap(), 1900.0);
        assert_close!(hi.unwrap(), 2100.0);
        assert_eq!(Goal::About.bounds(1850.0), (Some(1757.5), Some(1942.5)));
        assert_eq!(find("sodium").unwrap().goal(), Goal::AtMost);
        assert_eq!(find("energy").unwrap().goal(), Goal::About);
        assert_eq!(find("iron").unwrap().goal(), Goal::AtLeast);
    }

    #[test]
    fn every_fda_daily_value_names_a_nutrient() {
        // A misspelt key would quietly have no %DV.
        for (key, _) in FDA_DV {
            assert!(find(key).is_some(), "{key}");
        }
        assert_close!(find("vitamin_d").unwrap().fda_dv().unwrap(), 800.0);
    }

    #[test]
    fn every_nrv_names_a_nutrient_in_registry_order() {
        let keys: Vec<&str> = EU_NRV.iter().map(|(k, _)| *k).collect();
        let registry: Vec<&str> = REGISTRY
            .iter()
            .filter(|n| n.nrv().is_some())
            .map(|n| n.key)
            .collect();
        assert_eq!(keys, registry);
        assert_close!(find("vitamin_d").unwrap().nrv().unwrap(), 200.0);
        assert!(find("sodium").unwrap().nrv().is_none());
    }

    #[test]
    fn parses_into_slots_and_keeps_an_unknown_key_for_validate() {
        let n: Nutrients =
            serde_json::from_str(r#"{"zinc": 1, "energy": 2, "bogus": 3, "nope": 4}"#).unwrap();
        assert_eq!(n.keys().collect::<Vec<_>>(), ["energy", "zinc"]);
        assert_eq!(n.validate(), Err("bogus".into()));
        // Written in registry order.
        assert_eq!(
            serde_json::to_string(&nut(&[("zinc", 1.0), ("energy", 2.0)])).unwrap(),
            r#"{"energy":2.0,"zinc":1.0}"#
        );
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
        assert_eq!(seen, [General, Carbs, Fats, Protein, Vitamins, Minerals]);
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

    /// EFSA's DRV type for adults: an adequate intake (AI) for these, a
    /// population reference intake (or average requirement) for the rest
    /// with a target. Sodium's "safe and adequate intake" is a limit here.
    #[test]
    fn adequate_intakes_are_efsas() {
        let ai: Vec<&str> = REGISTRY.iter().filter(|n| n.ai()).map(|n| n.key).collect();
        assert_eq!(
            ai,
            [
                "water",
                "fiber",
                "ala",
                "epa_dha",
                "la",
                "b5",
                "b12",
                "vitamin_d",
                "vitamin_e",
                "vitamin_k",
                "potassium",
                "magnesium",
                "phosphorus",
                "copper",
                "manganese",
                "selenium",
            ]
        );
    }

    #[test]
    fn epa_dha_is_derived_from_epa_and_dha() {
        let n = find("epa_dha").unwrap();
        assert_eq!((n.label, n.unit, n.category), ("EPA+DHA", "g", Fats));
        assert!(n.derived() && n.ai() && !find("epa").unwrap().derived());
        let read = |json: &str| serde_json::from_str::<Nutrients>(json).unwrap();
        // Read or written, a typed value gives way to the sum.
        let fish = read(r#"{"epa": 0.5, "dha": 1.2, "epa_dha": 9}"#);
        assert_eq!(fish.get("epa_dha"), Some(1.7));
        // Absent unless both parts are known: DHA alone is no EPA+DHA.
        assert_eq!(
            serde_json::to_string(&nut(&[("dha", 0.3), ("epa_dha", 9.0)])).unwrap(),
            r#"{"dha":0.3}"#
        );
        assert_eq!(read(r#"{"energy": 1, "epa_dha": 9}"#).get("epa_dha"), None);
        assert_eq!(
            serde_json::to_string(&nut(&[("energy", 1.0)])).unwrap(),
            r#"{"energy":1.0}"#
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
        assert_eq!(over(&[("energy", 991.0)]), Err("energy"));
        assert_eq!(over(&[("protein", 110.1)]), Err("protein"));
        assert_eq!(over(&[("protein", 1e308)]), Err("protein"));
        assert_eq!(over(&[("sodium", 110_000.1)]), Err("sodium"));
        assert_eq!(
            over(&[("energy", 900.0), ("fat", 100.0), ("sodium", 40_000.0)]),
            Ok(())
        );
        assert_eq!(over(&[("water", 101.36)]), Ok(()), "Fineli's rounding");
        assert_eq!(
            over(&[("vitamin_d", 4.4e9)]),
            Ok(()),
            "110 g of vitamin D, in IU"
        );
        assert_eq!(over(&[("b12", 1.1e8)]), Ok(()), "µg");
        assert!(nut(&[("vitamin_d", 4.41e9)]).validate_per100().is_err());
    }

    #[test]
    fn water_shows_ml() {
        // A gram of water is a millilitre: shown as hydration is.
        let water = find("water").unwrap();
        assert_eq!(water.display(), ("Water", "ml", 1.0));
        assert_eq!(water.display_us(), ("Water", "ml", 1.0));
    }

    #[test]
    fn sugars_are_named_plainly() {
        // Its category heading already says carbs: no "(carbs)".
        let sugars = find("sugars").unwrap();
        assert_eq!(sugars.display(), ("Sugars", "g", 1.0));
        assert_eq!(sugars.display_us(), ("Total sugars", "g", 1.0));
    }

    #[test]
    fn the_us_label_spells_fiber() {
        for (key, us) in [
            ("fiber", "Fiber"),
            ("insoluble_fiber", "Insoluble fiber"),
            ("soluble_fiber", "Soluble fiber"),
        ] {
            let n = find(key).unwrap();
            assert_eq!(n.display_us().0, us);
            assert!(n.display().0.contains("ibre"), "EU keeps {}", n.label);
        }
    }

    #[test]
    fn per100_max_is_the_physical_table_with_its_margin() {
        assert_eq!(PER100_PHYSICAL[0], ("kcal", 900.0), "pure fat");
        assert_eq!(PER100_PHYSICAL[1], ("g", 100.0));
        // Exactly, bit for bit: the served limits read 990, not
        // 990.0000000000001.
        let exact =
            |unit: &str, max: f64| assert_eq!(per100_max(unit).to_bits(), max.to_bits(), "{unit}");
        for (unit, max) in [
            ("kcal", 990.0),
            ("g", 110.0),
            ("mg", 110_000.0),
            ("µg", 1.1e8),
        ] {
            exact(unit, max);
        }
        exact("IU", 4.4e9);
        exact("kJ?", 110.0);
        // What's served is the same table.
        for (unit, max) in PER100_MAX {
            exact(unit, max);
        }
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
