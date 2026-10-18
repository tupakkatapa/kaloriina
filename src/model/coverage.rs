//! Coverage (ADR 0030): how much of a total of a nutrient is known. A
//! total is only as complete as the food behind it that gave the nutrient;
//! the rest held an unknown amount of it.
//!
//! The weight of a food is its dry matter (grams less water): what holds
//! the nutrients. Energy was the weight before, and it failed every food
//! that carries a nutrient but no energy: a vitamin tablet, creatine,
//! caffeine in a diet cola. Water holds none: a litre of water without a
//! vitamin C value leaves nothing unknown.
//!
//! Caffeine, alcohol and creatine ([`BORNE`]) come from a few foods only:
//! drinks, and supplements that name them. A solid without the key holds
//! none of them, so their weight is the grams of what could hold them
//! ([`borne_weight`]), not the day's dry matter: coffee and a diet cola are
//! next to no dry matter but all of the day's caffeine.

use std::collections::BTreeMap;

use super::prelude::*;
use super::{Known, Source};

/// The key of a [`Known`] that holds the dry matter behind it, in grams
/// (per 100 g for a food): what a total of several is weighed by.
pub const DRY: &str = "dry";

/// The keys weighed by what could hold them ([`borne_weight`]) instead of
/// dry matter.
pub const BORNE: [&str; 3] = ["caffeine", "alcohol", "creatine"];

/// A food's weight for each [`BORNE`] key it carries or could hold, per
/// 100 g: grams of a drink, a hundred times the grams of a supplement that
/// names it. Left out where it neither carries nor could hold the key.
pub type Borne = BTreeMap<String, f64>;

/// Fineli's ingredient classes that may hold caffeine: coffee, tea, soft
/// and energy drinks (EFSA J 2015;13:4102: coffee, tea, colas and energy
/// drinks give nearly all of adults' caffeine). Milks, juices, alcohol and
/// water hold none.
const CAFFEINE_CLASSES: [&str; 9] = [
    "COFFEE", "TEA", "DRINKSO", "DRINKCO", "SDRINK", "DRINKART", "DRSPORT", "FBDRINK", "DRINKOTH",
];

/// Fineli's ingredient classes that may hold alcohol.
const ALCOHOL_CLASSES: [&str; 6] = ["ALCOTH", "BEER", "CIDER", "DRINKART", "SPIRIT", "WINE"];

/// Words in a food's name that say it holds a [`BORNE`] key (lower case;
/// Finnish and English): a supplement's, or an alcoholic drink's.
fn names(key: &str) -> &'static [&'static str] {
    match key {
        "caffeine" => &[
            "caffeine",
            "kofeiini",
            "koffein",
            "coffee",
            "kahvi",
            "espresso",
            "energy drink",
            "energiajuoma",
        ],
        "creatine" => &["creatine", "kreatiini"],
        "alcohol" => &[
            "olut",
            "beer",
            "ale",
            "lager",
            "stout",
            "porter",
            "cider",
            "siideri",
            "lonkero",
            "long drink",
            "viini",
            "wine",
            "viina",
            "vodka",
            "gin",
            "rum",
            "whisk",
            "konjak",
            "cognac",
            "brandy",
            "likööri",
            "liqueur",
            "snaps",
            "cocktail",
            "mule",
        ],
        _ => &[],
    }
}

/// A strength in a name ("6,5%", "38 %"): an alcoholic drink's.
fn strength(name: &str) -> bool {
    name.match_indices('%')
        .any(|(i, _)| name[..i].trim_end().ends_with(|c: char| c.is_ascii_digit()))
}

/// A dose of a supplement counts as this many grams of drink a gram: a
/// 4 g caffeine tablet as 400 g, about a cup of coffee's worth.
const SUPPLEMENT_WEIGHT: f64 = 100.0;

/// A drink at least this much water (g/100 g) is water: it holds no
/// caffeine or alcohol worth asking about.
const PLAIN_WATER: f64 = 99.5;

/// What is known of a food, for [`borne_weight`].
pub struct Facts<'a> {
    pub drink: bool,
    pub source: Source,
    /// Fineli's ingredient class.
    pub class: Option<&'a str>,
    pub name: &'a str,
}

/// The weight a gram of food `facts` with values `per100` has for [`BORNE`]
/// `key`, or 0: what could hold it (or does) and how much.
/// - Caffeine: a drink of your own or Open Food Facts', and Fineli's of a
///   class that holds it.
/// - Alcohol: a drink whose name says so (a strength, "olut", "wine"; a
///   cola's label never states its alcohol), and Fineli's of an alcoholic
///   class.
/// - A supplement whose name says it holds caffeine or creatine, and
///   doesn't say how much, weighs [`SUPPLEMENT_WEIGHT`] a gram: a dose
///   missing is a cup missing.
///
/// Plain water holds neither; what carries the key weighs its grams.
#[must_use]
pub fn borne_weight(key: &str, per100: &Nutrients, facts: &Facts) -> f64 {
    if per100.get(key).is_some() {
        return 1.0;
    }
    let own = facts.source != Source::Fineli;
    // Alcohol by name only in a drink: cheese of 10 % fat is none.
    let named = own && (key != "alcohol" || facts.drink) && {
        let name = facts.name.to_lowercase();
        let words: Vec<&str> = name.split(|c: char| !c.is_alphanumeric()).collect();
        names(key).iter().any(|n| {
            // A short word whole ("gin", not "ginger").
            words.iter().any(|w| {
                if n.len() <= 4 {
                    w == n
                } else {
                    w.starts_with(n)
                }
            }) || (n.contains(' ') && name.contains(n))
        }) || (key == "alcohol" && strength(&name))
    };
    if named && !facts.drink && key != "alcohol" {
        return SUPPLEMENT_WEIGHT;
    }
    let classes: &[&str] = match key {
        "caffeine" => &CAFFEINE_CLASSES,
        "alcohol" => &ALCOHOL_CLASSES,
        _ => &[],
    };
    let drunk = facts.drink
        && per100.get("water").is_none_or(|w| w < PLAIN_WATER)
        && if own {
            key == "caffeine" || named
        } else {
            facts.class.is_some_and(|c| classes.contains(&c))
        };
    if drunk || named { 1.0 } else { 0.0 }
}

/// A food's [`Borne`] per 100 g.
#[must_use]
pub fn borne_of(per100: &Nutrients, facts: &Facts) -> Borne {
    BORNE
        .iter()
        .filter_map(|&key| {
            let w = borne_weight(key, per100, facts);
            (w > 0.0).then(|| (key.to_owned(), w * 100.0))
        })
        .collect()
}

/// The water in values `n` of `grams` as hydration counts it (ADR 0020):
/// their water value; a drink without one, its grams less its solids
/// (carbohydrate, fibre, protein, fat, alcohol) where any of
/// carbohydrate, protein or fat is known, never below 0; else `None`.
#[must_use]
pub fn water_of(n: &Nutrients, grams: f64, drink: bool) -> Option<f64> {
    if let Some(water) = n.get("water") {
        return Some(water);
    }
    if !drink {
        return None;
    }
    let (carbs, net, protein, fat) = (
        n.get("carbs"),
        n.get("net_carbs"),
        n.get("protein"),
        n.get("fat"),
    );
    carbs.or(net).or(protein).or(fat)?;
    let carbs = carbs.unwrap_or_else(|| net.unwrap_or(0.0) + n.get("fiber").unwrap_or(0.0));
    Some(
        (grams
            - carbs
            - protein.unwrap_or(0.0)
            - fat.unwrap_or(0.0)
            - n.get("alcohol").unwrap_or(0.0))
        .max(0.0),
    )
}

/// The dry matter in values `n` of `grams`: its grams less its water
/// ([`water_of`]); all of it when the water isn't known.
#[must_use]
pub fn dry_of(n: &Nutrients, grams: f64, drink: bool) -> f64 {
    (grams - water_of(n, grams, drink).unwrap_or(0.0)).max(0.0)
}

/// The dry matter of an imported total, which has no grams: its
/// macronutrients and alcohol, nearly all of food's dry matter.
#[must_use]
pub fn macro_dry(n: &Nutrients) -> f64 {
    let carbs = n
        .get("carbs")
        .unwrap_or_else(|| n.get("net_carbs").unwrap_or(0.0) + n.get("fiber").unwrap_or(0.0));
    carbs
        + n.get("protein").unwrap_or(0.0)
        + n.get("fat").unwrap_or(0.0)
        + n.get("alcohol").unwrap_or(0.0)
}

/// The share (0 to 1) of a total's food behind its value of `key`, from its
/// [`Known`] and whether the total has the key: a key listed is its share;
/// one not listed is known in full where the total has it, or for a
/// [`BORNE`] key (nothing that could hold it was eaten), else not at all.
#[must_use]
pub fn share(known: &Known, total: &Nutrients, key: &str) -> f64 {
    match known.get(key) {
        Some(&s) => s.clamp(0.0, 1.0),
        None if total.get(key).is_some() || BORNE.contains(&key) => 1.0,
        None => 0.0,
    }
}

/// A [`Known`] from a total's weights: each key's share of `dry` (rounded
/// as amounts are written; whole when within that), listed only where
/// short of all, with `dry` itself. `behind` gives a key's dry matter
/// behind it; `borne` each [`BORNE`] key's (with, of) weights.
#[must_use]
pub fn known_from(
    dry: f64,
    behind: impl Iterator<Item = (&'static str, f64)>,
    borne: &BTreeMap<&'static str, (f64, f64)>,
) -> Known {
    let round = |v: f64| (v * 1e9).round() / 1e9;
    let dry = round(dry);
    let mut out: Known = behind
        .filter(|(key, _)| !BORNE.contains(key))
        .filter_map(|(key, b)| {
            let b = round(b);
            let s = if dry > 0.0 { b / dry } else { 1.0 };
            (s < 1.0).then(|| (key.to_owned(), s))
        })
        .collect();
    for (&key, &(with, of)) in borne {
        if of > 0.0 && round(with) < round(of) {
            out.insert(key.to_owned(), with / of);
        }
    }
    out.insert(DRY.to_owned(), dry);
    out
}

/// A part of a recipe or meal: its values per 100 g, its grams, whether
/// it's a drink, and a recipe's own [`Known`] and [`Borne`] (a food's
/// [`borne_of`]; a food's Known is empty).
pub struct Part<'a> {
    pub per100: &'a Nutrients,
    pub grams: f64,
    pub drink: bool,
    pub known: &'a Known,
    pub borne: &'a Borne,
}

/// The share (0 to 1) of a part's `key` it carries: its Known's, else all
/// of it where it has a value, else none.
fn carried(p: &Part, key: &str) -> f64 {
    p.known
        .get(key)
        .copied()
        .unwrap_or(if p.per100.get(key).is_some() {
            1.0
        } else {
            0.0
        })
}

/// A recipe's (or meal's) [`Known`] and [`Borne`] per 100 g from its parts,
/// as its values are ([`super::super::db`]'s `recipe_per100`): each key's
/// share of the parts' dry matter (cooking moves water only), a [`BORNE`]
/// key's of what could hold it. Computed when read, never stored.
#[must_use]
pub fn recipe_cover(parts: &[Part], cooked_g: Option<f64>) -> (Known, Borne) {
    let total: f64 = parts.iter().map(|p| p.grams).sum();
    let weight = cooked_g.unwrap_or(total);
    if weight <= 0.0 || total <= 0.0 {
        return (Known::new(), Borne::new());
    }
    let dry100 = |p: &Part| {
        p.known
            .get(DRY)
            .copied()
            .unwrap_or_else(|| dry_of(p.per100, 100.0, p.drink))
    };
    // Per 100 g of the recipe as made.
    let per = |v: f64| v / weight;
    let dry = per(parts.iter().map(|p| dry100(p) * p.grams).sum());
    let keys: std::collections::BTreeSet<&'static str> =
        parts.iter().flat_map(|p| p.per100.keys()).collect();
    let behind = keys.into_iter().map(|key| {
        (
            key,
            per(parts
                .iter()
                .map(|p| carried(p, key) * dry100(p) * p.grams)
                .sum()),
        )
    });
    let mut borne = Borne::new();
    let mut weights = BTreeMap::new();
    for key in BORNE {
        let (with, of) = parts.iter().fold((0.0, 0.0), |(with, of), p| {
            let w = p.borne.get(key).copied().unwrap_or(0.0) * p.grams;
            (with + w * carried(p, key), of + w)
        });
        if of > 0.0 {
            borne.insert(key.to_owned(), per(of));
            weights.insert(key, (with, of));
        }
    }
    (known_from(dry, behind, &weights), borne)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(drink: bool, name: &str) -> Facts<'_> {
        Facts {
            drink,
            source: Source::Custom,
            class: None,
            name,
        }
    }

    /// A vitamin tablet weighs its grams, energy or not;
    /// water weighs nothing; a drink's water is estimated.
    #[test]
    fn dry_matter_is_grams_less_water() {
        let tablet = Nutrients::of(&[("vitamin_c", 60.0)]);
        assert!((dry_of(&tablet, 4.3, false) - 4.3).abs() < 1e-9);
        let water = Nutrients::of(&[("water", 700.0)]);
        assert!(dry_of(&water, 700.0, true).abs() < 1e-9);
        let cola = Nutrients::of(&[("carbs", 0.0), ("protein", 0.0)]);
        assert!(dry_of(&cola, 500.0, true).abs() < 1e-9);
        // Not a drink, no water: all of it, as nothing says otherwise.
        assert!((dry_of(&cola, 500.0, false) - 500.0).abs() < 1e-9);
    }

    /// What could hold caffeine, alcohol and creatine.
    #[test]
    fn what_could_hold_the_borne_keys() {
        let none = Nutrients::default();
        let w = |key, f: &Facts| borne_weight(key, &none, f);
        // A diet cola of your own could hold caffeine, not alcohol; a beer
        // by its strength or name, served or not as a drink.
        assert!((w("caffeine", &facts(true, "Pepsi Max")) - 1.0).abs() < 1e-9);
        assert!(w("alcohol", &facts(true, "Pepsi Max")).abs() < 1e-9);
        assert!((w("alcohol", &facts(true, "Grand Cru 6,0%")) - 1.0).abs() < 1e-9);
        assert!((w("alcohol", &facts(true, "Viina 38 %")) - 1.0).abs() < 1e-9);
        assert!((w("alcohol", &facts(true, "Moscow mule (K)")) - 1.0).abs() < 1e-9);
        // Cheese of 10 % fat is no drink.
        assert!(w("alcohol", &facts(false, "POLAR KEVYT 10%")).abs() < 1e-9);
        assert!(w("alcohol", &facts(true, "Ginger shot")).abs() < 1e-9);
        assert!(w("alcohol", &facts(true, "Original lemonade")).abs() < 1e-9);
        // A pizza, neither; a tablet naming caffeine, a cup's worth.
        assert!(w("caffeine", &facts(false, "Mexicana pizza")).abs() < 1e-9);
        assert!(w("alcohol", &facts(false, "Mexicana pizza")).abs() < 1e-9);
        let tablet = facts(false, "Elektrolyyttipore + magnesium + kofeiini");
        assert!((w("caffeine", &tablet) - SUPPLEMENT_WEIGHT).abs() < 1e-9);
        assert!((w("creatine", &facts(false, "Creatine monohydrate")) - 100.0).abs() < 1e-9);
        // Fineli milk can't hold caffeine; Fineli coffee can.
        let fineli = |class| Facts {
            drink: true,
            source: Source::Fineli,
            class: Some(class),
            name: "x",
        };
        assert!(w("caffeine", &fineli("MILKLF")).abs() < 1e-9);
        assert!((w("caffeine", &fineli("COFFEE")) - 1.0).abs() < 1e-9);
        assert!((w("alcohol", &fineli("BEER")) - 1.0).abs() < 1e-9);
        // Water is water.
        let water = Nutrients::of(&[("water", 100.0)]);
        assert!(borne_weight("caffeine", &water, &facts(true, "Vesi")).abs() < 1e-9);
    }

    /// `tests/fixtures/coverage-cases.json`, which node reads too: a value
    /// per key, keyed as the fixture says.
    fn parity_cases() -> serde_json::Value {
        serde_json::from_str(include_str!("../../tests/fixtures/coverage-cases.json")).unwrap()
    }

    fn nutrients(v: &serde_json::Value) -> Nutrients {
        serde_json::from_value(v.clone()).unwrap()
    }

    /// The same keys as `want`, each within 1e-9.
    fn assert_near(got: &BTreeMap<String, f64>, want: &serde_json::Value, what: &str) {
        let want: BTreeMap<String, f64> = serde_json::from_value(want.clone()).unwrap();
        assert_eq!(
            got.keys().collect::<Vec<_>>(),
            want.keys().collect::<Vec<_>>(),
            "{what}"
        );
        for (k, v) in &want {
            assert!((got[k] - v).abs() < 1e-9, "{what} {k}: {} vs {v}", got[k]);
        }
    }

    #[test]
    fn recipe_cover_matches_the_parity_fixture() {
        for case in parity_cases()["recipes"].as_array().unwrap() {
            let parts: Vec<(Nutrients, f64, bool, Known, Borne)> = case["parts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| {
                    let map = |k: &str| {
                        serde_json::from_value(p.get(k).cloned().unwrap_or_default())
                            .unwrap_or_default()
                    };
                    (
                        nutrients(&p["per100"]),
                        p["grams"].as_f64().unwrap(),
                        p["drink"].as_bool().unwrap_or(false),
                        map("known"),
                        map("borne"),
                    )
                })
                .collect();
            let parts: Vec<Part> = parts
                .iter()
                .map(|(per100, grams, drink, known, borne)| Part {
                    per100,
                    grams: *grams,
                    drink: *drink,
                    known,
                    borne,
                })
                .collect();
            let (known, _) = recipe_cover(&parts, case["cooked_g"].as_f64());
            assert_near(&known, &case["known"], case["name"].as_str().unwrap());
        }
    }

    /// A recipe's values per 100 g as the web's `recipePer100` works them
    /// out (`db::recipe_per100` computes them, alongside this rule).
    #[test]
    fn recipe_per100_matches_the_parity_fixture() {
        for case in parity_cases()["recipes"].as_array().unwrap() {
            let parts: Vec<(Nutrients, f64)> = case["parts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| (nutrients(&p["per100"]), p["grams"].as_f64().unwrap()))
                .collect();
            let per100 = crate::db::recipe_per100(&parts, case["cooked_g"].as_f64());
            let got = per100
                .keys()
                .map(|k| (k.to_owned(), per100.get(k).unwrap()))
                .collect();
            assert_near(&got, &case["per100"], case["name"].as_str().unwrap());
        }
    }

    #[test]
    fn share_matches_the_parity_fixture() {
        for case in parity_cases()["shares"].as_array().unwrap() {
            let known: Known = serde_json::from_value(case["known"].clone()).unwrap();
            let got = share(
                &known,
                &nutrients(&case["total"]),
                case["key"].as_str().unwrap(),
            );
            let want = case["share"].as_f64().unwrap();
            assert!((got - want).abs() < 1e-9, "{}: {got}", case["why"]);
        }
    }

    #[test]
    fn share_reads_a_known() {
        let total = Nutrients::of(&[("iron", 1.0), ("caffeine", 10.0)]);
        let known: Known = [("iron".to_owned(), 0.25), (DRY.to_owned(), 400.0)].into();
        assert!((share(&known, &total, "iron") - 0.25).abs() < 1e-9);
        assert!((share(&known, &total, "caffeine") - 1.0).abs() < 1e-9);
        assert!(share(&known, &total, "zinc").abs() < 1e-9);
        // Nothing could hold alcohol: known, none.
        assert!((share(&known, &total, "alcohol") - 1.0).abs() < 1e-9);
    }
}
