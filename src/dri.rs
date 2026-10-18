//! Daily targets recommended for an adult from EU reference values.
//!
//! Values are EFSA Dietary Reference Values for adults (≥ 18 years), taken
//! from the EFSA DRV Finder dataset
//! (<https://multimedia.efsa.europa.eu/drvs/index.htm>, `data.json`, read
//! 2026-10-06). Where EFSA only says "as low as possible" (saturated fat,
//! added sugars) the WHO limit of 10 % of energy is used. The energy
//! target itself is the client's (ADR 0020: the energy model lives in
//! `web/expenditure.mjs`); the values set as a share of energy scale with
//! the one it passes.

use crate::model::{Sex, Target};
use crate::nutrients::{IU_PER_UG, KCAL_PER_G_CARBS, KCAL_PER_G_FAT, KCAL_PER_G_PROTEIN};

/// What the recommendations depend on.
#[derive(Debug, Clone, Copy)]
pub struct Person {
    pub sex: Sex,
    pub age: u32,
    pub weight_kg: f64,
}

const KCAL_PER_MJ: f64 = 239.006;

/// Grams of a macronutrient that supply `share` of `kcal`.
fn grams_of(share: f64, kcal: f64, kcal_per_g: f64) -> f64 {
    share * kcal / kcal_per_g
}

/// Computed values rounded to read well: whole units from 100 up, one
/// decimal below (which leaves every EFSA table value exact).
fn tidy(v: f64) -> f64 {
    if v >= 100.0 {
        v.round()
    } else {
        (v * 10.0).round() / 10.0
    }
}

/// Fat's share of energy: the middle of EFSA's 20–35 % range, rounded.
const FAT_SHARE: f64 = 0.30;

/// The values set as a share of an energy target of `kcal` a day: the
/// macros (protein first, at 0.83 g/kg), saturated fat, added sugars, ALA,
/// LA, thiamin and niacin.
fn by_energy(p: &Person, kcal: f64) -> [(&'static str, f64); 8] {
    let mj = kcal / KCAL_PER_MJ;
    let protein = 0.83 * p.weight_kg;
    // Carbohydrate gets the energy protein and fat leave, kept inside EFSA's
    // 45–60 % range.
    let carb_share = (1.0 - FAT_SHARE - protein * KCAL_PER_G_PROTEIN / kcal).clamp(0.45, 0.60);
    [
        ("net_carbs", grams_of(carb_share, kcal, KCAL_PER_G_CARBS)),
        ("fat", grams_of(FAT_SHARE, kcal, KCAL_PER_G_FAT)),
        // EFSA: "as low as possible"; WHO: under 10 % of energy.
        ("saturated", grams_of(0.10, kcal, KCAL_PER_G_FAT)),
        ("added_sugars", grams_of(0.10, kcal, KCAL_PER_G_CARBS)),
        ("ala", grams_of(0.005, kcal, KCAL_PER_G_FAT)),
        ("la", grams_of(0.04, kcal, KCAL_PER_G_FAT)),
        ("b1", 0.1 * mj),
        ("b3", 1.6 * mj),
    ]
}

/// Recommended daily targets, one number per nutrient (keyed by registry
/// key), plus the goals recommended for everyone (steps, sleep, fruit and
/// vegetables). Never the energy target: the client's model sets it, and
/// passes it as `energy` (kcal a day) for the values that are a share of
/// it; without one those are left out. Bounds follow each nutrient's goal
/// (see `Goal`); EFSA's upper safety limits are left out because food
/// alone rarely reaches them.
#[must_use]
pub fn recommend(p: &Person, energy: Option<f64>) -> Vec<Target> {
    let male = p.sex == Sex::Male;
    let by_sex = |m: f64, f: f64| if male { m } else { f };

    let targets = [
        ("protein", 0.83 * p.weight_kg),
        ("fiber", 25.0),
        // Sodium: EFSA safe and adequate intake, 2 g (5 g of salt).
        ("sodium", 2000.0),
        ("water", by_sex(2500.0, 2000.0)),
        // Vitamins.
        ("vitamin_a", by_sex(750.0, 650.0)),
        ("b2", 1.6),
        ("b5", 5.0),
        ("b6", by_sex(1.7, 1.6)),
        ("b12", 4.0),
        ("folate", 330.0),
        ("vitamin_c", by_sex(110.0, 95.0)),
        // Vitamin D is stored in IU; 1 µg = 40 IU.
        ("vitamin_d", 15.0 * IU_PER_UG),
        ("vitamin_e", by_sex(13.0, 11.0)),
        ("vitamin_k", 70.0),
        // Minerals.
        ("calcium", if p.age < 25 { 1000.0 } else { 950.0 }),
        ("copper", by_sex(1.6, 1.3)),
        // ponytail: EFSA gives women 16 mg until menopause, 11 mg after; age
        // 50 stands in for menopause. Add a profile flag if that's ever wrong.
        ("iron", if male || p.age >= 50 { 11.0 } else { 16.0 }),
        ("magnesium", by_sex(350.0, 300.0)),
        ("manganese", 3.0),
        ("phosphorus", 550.0),
        ("potassium", 3500.0),
        ("selenium", 70.0),
        // Zinc depends on phytate intake; 600 mg/day is a typical mixed diet.
        ("zinc", by_sex(11.7, 9.3)),
        // NNR 2023: at least 500 g of fruit, berries and vegetables a day.
        ("category:fruit_veg", 500.0),
    ];
    targets
        .into_iter()
        .chain(energy.map(|kcal| by_energy(p, kcal)).into_iter().flatten())
        .map(|(key, value)| Target::single(key, tidy(value)))
        // EFSA adequate intake of EPA+DHA, 250 mg (finer than `tidy` keeps).
        .chain([Target::single("epa_dha", 0.25)])
        .chain(Target::defaults().map(|t| Target::single(&t.metric, t.value)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn person(sex: Sex, age: u32) -> Person {
        Person {
            sex,
            age,
            weight_kg: 80.0,
        }
    }

    fn get(targets: &[Target], key: &str) -> f64 {
        targets
            .iter()
            .find(|t| t.metric == key)
            .map(|t| t.value)
            .unwrap()
    }

    /// The energy the client passes in these tests, kcal a day.
    const KCAL: Option<f64> = Some(2848.0);

    #[test]
    fn energy_is_the_clients_never_recommended() {
        // ADR 0020: the energy model is the client's; the values that are a
        // share of energy come only with the energy it passes.
        let shares = [
            "net_carbs",
            "fat",
            "saturated",
            "added_sugars",
            "ala",
            "la",
            "b1",
            "b3",
        ];
        let without = recommend(&person(Sex::Male, 30), None);
        assert!(without.iter().all(|t| t.metric != "energy"));
        for key in shares {
            assert!(without.iter().all(|t| t.metric != key), "{key}");
        }
        assert_close!(get(&without, "protein"), 66.4);
        let with = recommend(&person(Sex::Male, 30), KCAL);
        assert!(with.iter().all(|t| t.metric != "energy"));
        for key in shares {
            assert!(with.iter().any(|t| t.metric == key), "{key}");
        }
    }

    #[test]
    fn male_adult_matches_efsa() {
        let t = recommend(&person(Sex::Male, 30), KCAL);
        assert_close!(get(&t, "protein"), 66.4); // 0.83 × 80
        // Fat 30 %: 2848 × 0.3 / 9.
        assert_close!(get(&t, "fat"), 94.9);
        // Carbs: 1 − 0.30 − 265.6/2848 = 61 %, capped at EFSA's 60 %.
        assert_close!(get(&t, "net_carbs"), 427.0);
        assert_close!(get(&t, "fiber"), 25.0);
        assert_close!(get(&t, "sodium"), 2000.0);
        assert_close!(get(&t, "vitamin_c"), 110.0);
        assert_close!(get(&t, "vitamin_d"), 600.0);
        assert_close!(get(&t, "iron"), 11.0);
        assert_close!(get(&t, "calcium"), 950.0);
        assert_close!(get(&t, "zinc"), 11.7);
        // EFSA AI for EPA+DHA, 250 mg, kept exact.
        assert_close!(get(&t, "epa_dha"), 0.25);
        // Thiamin 0.1 mg/MJ × 11.9 MJ.
        assert_close!(get(&t, "b1"), 1.2);
    }

    #[test]
    fn bounds_follow_each_goal() {
        let t = recommend(&person(Sex::Male, 30), KCAL);
        let find = |key: &str| t.iter().find(|t| t.metric == key).unwrap().clone();
        let sodium = find("sodium");
        assert_eq!((sodium.min, sodium.max), (None, Some(2000.0)));
        let iron = find("iron");
        assert_eq!((iron.min, iron.max), (Some(11.0), None));
        let saturated = find("saturated");
        assert_eq!((saturated.min, saturated.max), (None, Some(31.6)));
    }

    #[test]
    fn female_values_by_age() {
        let young = recommend(&person(Sex::Female, 20), KCAL);
        assert_close!(get(&young, "iron"), 16.0);
        assert_close!(get(&young, "calcium"), 1000.0);
        assert_close!(get(&young, "vitamin_a"), 650.0);
        let older = recommend(&person(Sex::Female, 55), KCAL);
        assert_close!(get(&older, "iron"), 11.0);
        assert_close!(get(&older, "calcium"), 950.0);
    }

    #[test]
    fn water_is_efsas_adequate_total_intake_at_least() {
        // EFSA: 2.5 L a day for men, 2.0 L for women, from food and drink.
        for (sex, grams) in [(Sex::Male, 2500.0), (Sex::Female, 2000.0)] {
            let t = recommend(&person(sex, 30), KCAL);
            let water = t.iter().find(|t| t.metric == "water").unwrap();
            assert_eq!((water.min, water.max), (Some(grams), None), "{sex:?}");
        }
    }

    #[test]
    fn every_key_is_in_the_registry() {
        for t in recommend(&person(Sex::Male, 30), KCAL) {
            assert!(
                crate::model::target_key(&t.metric).is_some(),
                "{}",
                t.metric
            );
        }
    }

    #[test]
    fn steps_and_sleep_are_recommended_for_everyone() {
        for p in [person(Sex::Male, 30), person(Sex::Female, 70)] {
            let t = recommend(&p, KCAL);
            assert_close!(get(&t, "steps"), 10_000.0);
            assert_close!(get(&t, "sleep_min"), 420.0);
            assert_close!(get(&t, "category:fruit_veg"), 500.0);
            assert!(t.iter().all(|t| !t.default), "set, not defaults");
        }
    }

    #[test]
    fn supplements_get_no_recommended_goal() {
        // Creatine isn't essential (no EFSA DRV): a goal would show it to
        // everyone, taking it or not.
        for p in [person(Sex::Male, 30), person(Sex::Female, 70)] {
            assert!(recommend(&p, KCAL).iter().all(|t| t.metric != "creatine"));
        }
    }
}
