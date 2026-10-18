//! A food's verdict, Healthy, OK or Unhealthy: the band of its Nutri-Score
//! (2023 update; ADR 0033) per 100 g, or per 100 ml for a drink. Energy,
//! sugars, saturates and salt score against it; protein, fibre and its
//! share of fruit, vegetables and legumes for it. One red decides nothing:
//! salty pickles are mostly vegetables.
//!
//! Tables: Santé publique France, Nutri-Score Q&A on the updated algorithm
//! (2025-03-17), Tables 5–10; the beverages' from the Scientific
//! Committee's 2023 update. Points are the cuts a value is over.

use super::prelude::*;
use crate::nutrients::KJ_PER_KCAL;

/// Over 1.2 % ABV (× 0.789 g/ml): no nutrition claim (Reg. 1924/2006
/// Art. 4(3)) and no Nutri-Score; Unhealthy, for its alcohol.
pub(super) const ALCOHOL_MAX: f64 = 0.95;

/// Energy, kJ.
const ENERGY: [f64; 10] = [
    335.0, 670.0, 1005.0, 1340.0, 1675.0, 2010.0, 2345.0, 2680.0, 3015.0, 3350.0,
];
/// Sugars, g.
const SUGARS: [f64; 15] = [
    3.4, 6.8, 10.0, 14.0, 17.0, 20.0, 24.0, 27.0, 31.0, 34.0, 37.0, 41.0, 44.0, 48.0, 51.0,
];
/// Saturates, g (food and drink).
const SATURATES: [f64; 10] = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0];
/// Salt, g (food and drink).
const SALT: [f64; 20] = [
    0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.2, 2.4, 2.6, 2.8, 3.0, 3.2, 3.4, 3.6, 3.8,
    4.0,
];
/// Protein, g.
const PROTEIN: [f64; 7] = [2.4, 4.8, 7.2, 9.6, 12.0, 14.0, 17.0];
/// Fibre, g (food and drink).
const FIBRE: [f64; 5] = [3.0, 4.1, 5.2, 6.3, 7.4];
/// Fats, oils, nuts and seeds: energy from saturates, kJ.
const SATURATES_ENERGY: [f64; 10] = [
    120.0, 240.0, 360.0, 480.0, 600.0, 720.0, 840.0, 960.0, 1080.0, 1200.0,
];
/// Fats, oils, nuts and seeds: saturates as % of fat, reached.
const SATURATES_RATIO: [f64; 10] = [10.0, 16.0, 22.0, 28.0, 34.0, 40.0, 46.0, 52.0, 58.0, 64.0];
/// kJ per g of saturates (Nutri-Score's).
const KJ_PER_G_SATURATES: f64 = 37.0;
/// Drinks: energy, kJ.
const DRINK_ENERGY: [f64; 10] = [
    30.0, 90.0, 150.0, 210.0, 240.0, 270.0, 300.0, 330.0, 360.0, 390.0,
];
/// Drinks: sugars, g.
const DRINK_SUGARS: [f64; 10] = [0.5, 2.0, 3.5, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0];
/// Drinks: protein, g.
const DRINK_PROTEIN: [f64; 7] = [1.2, 1.5, 1.8, 2.1, 2.4, 2.7, 3.0];
/// Drinks: non-nutritive sweeteners, one class worse.
const SWEETENERS: i32 = 4;
/// Fruit, vegetables and legumes: over these shares, these points (food;
/// drink).
const FRUIT_VEG: [(f64, i32, i32); 3] = [(0.4, 1, 2), (0.6, 2, 4), (0.8, 5, 6)];
/// From this much fat (g) a food scores as a fat, oil, nut or seed.
// ponytail: Nutri-Score's category read from the values; a stored food
// group if a sauce this fat (mayonnaise) needs the general table.
const FATS_FROM: f64 = 40.0;
/// A reason names a part of the score worth at least this many points.
const REASON_MIN: i32 = 2;
/// A verdict names at most this many reasons against, and as many for.
const REASONS_SHOWN: usize = 2;

/// What a food is judged as besides its values: a drink (per 100 ml, the
/// drinks' tables), its share of fruit, vegetables and legumes (0 to 1) and
/// whether it is a drink with sweeteners.
#[derive(Debug, Clone, Copy, Default)]
pub struct Scoring {
    pub drink: bool,
    pub fruit_veg: f64,
    pub sweetened: bool,
}

/// One reason for a verdict (`labels.why`): a part of the score against
/// or for the food. Stored as `why_<key>`, which no search filters by.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Reason {
    pub key: &'static str,
    pub text: &'static str,
    pub positive: bool,
    #[serde(skip)]
    pub(super) stored: &'static str,
}

const fn reason(
    key: &'static str,
    stored: &'static str,
    text: &'static str,
    positive: bool,
) -> Reason {
    Reason {
        key,
        text,
        positive,
        stored,
    }
}

/// Every reason in the order a verdict names them: against, then for.
pub static REASONS: [Reason; 9] = [
    reason("sugars", "why_sugars", "sugar", false),
    reason("saturated", "why_saturated", "sat. fat", false),
    reason("sodium", "why_sodium", "salt", false),
    reason("energy", "why_energy", "calories", false),
    reason("sweeteners", "why_sweeteners", "sweeteners", false),
    reason("alcohol", "why_alcohol", "alcohol", false),
    reason("fruit_veg", "why_fruit_veg", "fruit & veg", true),
    reason("fiber", "why_fiber", "fibre", true),
    reason("protein", "why_protein", "protein", true),
];

/// The reason stored as `stored`, if one is.
pub(super) fn stored_reason(stored: &str) -> Option<&'static Reason> {
    REASONS.iter().find(|r| r.stored == stored)
}

/// Whether a drink's `name` says it holds sweeteners: a whole word,
/// any case. Fineli names its own ("keinotekoisesti makeutettu").
#[must_use]
pub fn sweetened(name: &str) -> bool {
    const WORDS: [&str; 6] = [
        "zero",
        "max",
        "light",
        "diet",
        "sokeriton",
        "keinotekoisesti",
    ];
    name.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .any(|w| WORDS.contains(&w))
}

/// How many of `cuts` `v` is over.
fn over(v: f64, cuts: &[f64]) -> i32 {
    cuts.iter().map(|c| i32::from(v > *c)).sum()
}

#[derive(Clone, Copy, PartialEq)]
enum Table {
    Foods,
    Fats,
    Drinks,
}

/// A part of the score: its reason key and its points, `None` when its
/// value isn't given.
type Part = (&'static str, Option<i32>);

/// The parts against a food on `table`: sugars, saturates, salt, energy,
/// sweeteners. `fat` is known in full or `None`.
fn against(per100: &Nutrients, s: &Scoring, table: Table, fat: Option<f64>) -> [Part; 5] {
    let get = |key| per100.get(key);
    let fat_free = fat.is_some_and(|f| f <= 1.0);
    // Saturates can't be over fat: at most 1 g scores 0 whatever they are.
    let saturated = get("saturated").or(fat_free.then_some(0.0));
    let kj = get("energy").map(|e| e * KJ_PER_KCAL);
    let sugars = if table == Table::Drinks {
        &DRINK_SUGARS[..]
    } else {
        &SUGARS[..]
    };
    [
        ("sugars", get("sugars").map(|v| over(v, sugars))),
        (
            "saturated",
            match table {
                Table::Fats => saturated.zip(fat).map(|(v, f)| {
                    over(v * KJ_PER_G_SATURATES, &SATURATES_ENERGY)
                        + SATURATES_RATIO
                            .iter()
                            .map(|c| i32::from(f > 0.0 && 100.0 * v / f >= *c))
                            .sum::<i32>()
                }),
                _ => saturated.map(|v| over(v, &SATURATES)),
            },
        ),
        // Salt = sodium × 2.5, multiplied first so the cuts hold exactly.
        (
            "sodium",
            get("sodium").map(|v| over(v * 2.5 / 1000.0, &SALT)),
        ),
        (
            "energy",
            match table {
                Table::Foods => kj.map(|v| over(v, &ENERGY)),
                Table::Drinks => kj.map(|v| over(v, &DRINK_ENERGY)),
                // Its energy is scored as its saturates'.
                Table::Fats => None,
            },
        ),
        (
            "sweeteners",
            (table == Table::Drinks && s.sweetened).then_some(SWEETENERS),
        ),
    ]
}

/// The parts worth most, at most [`REASONS_SHOWN`] of [`REASON_MIN`] or
/// more points, most first.
fn top(parts: &[Part]) -> Vec<&'static str> {
    let mut worth: Vec<(&'static str, i32)> = parts
        .iter()
        .filter_map(|&(k, p)| p.filter(|p| *p >= REASON_MIN).map(|p| (k, p)))
        .collect();
    worth.sort_by_key(|(_, p)| -p);
    worth.truncate(REASONS_SHOWN);
    worth.into_iter().map(|(k, _)| k).collect()
}

/// The verdict of these values per 100 g (ml) and its reasons, as far as
/// `full` (given and known in full, ADR 0030) proves them. A full score
/// needs energy, fat, saturates (or fat at most 1 g, the 0-point line),
/// sugars and salt in full; missing protein or fibre scores 0, as
/// Nutri-Score scores an undeclared one. Short of a full score, the given
/// negatives (a recipe's floors too) still prove Unhealthy once they reach
/// its line: what's unknown can only add. A food's fat picks its table.
pub(super) fn judge(
    per100: &Nutrients,
    s: &Scoring,
    full: impl Fn(&str) -> bool,
) -> (Option<&'static str>, Vec<&'static Reason>) {
    if per100.get("alcohol").is_some_and(|a| a > ALCOHOL_MAX) {
        return (Some("unhealthy"), vec![&REASONS[5]]);
    }
    let fat = per100.get("fat").filter(|_| full("fat"));
    let fat_free = fat.is_some_and(|f| f <= 1.0);
    let complete = ["energy", "fat", "sugars", "sodium"]
        .iter()
        .all(|k| full(k))
        && (full("saturated") || fat_free);
    let table = match (s.drink, fat) {
        (true, _) => Table::Drinks,
        (false, None) => return (None, Vec::new()),
        (false, Some(f)) if f >= FATS_FROM => Table::Fats,
        (false, Some(_)) => Table::Foods,
    };
    let get = |key| per100.get(key);
    let against = against(per100, s, table, fat);
    let n: i32 = against.iter().filter_map(|(_, p)| *p).sum();
    let protein_counts = match table {
        Table::Foods => n < 11,
        Table::Fats => n < 7,
        Table::Drinks => true,
    };
    let fruit_veg = FRUIT_VEG
        .iter()
        .filter(|(share, ..)| s.fruit_veg > *share)
        .map(|&(_, food, drink)| if s.drink { drink } else { food })
        .next_back();
    let protein = if s.drink {
        &DRINK_PROTEIN[..]
    } else {
        &PROTEIN[..]
    };
    let for_ = [
        ("fruit_veg", fruit_veg),
        ("fiber", get("fiber").map(|v| over(v, &FIBRE))),
        (
            "protein",
            get("protein")
                .filter(|_| protein_counts)
                .map(|v| over(v, protein)),
        ),
    ];
    let score = n - for_.iter().filter_map(|(_, p)| *p).sum::<i32>();
    // Healthy is A or B, Unhealthy D or E.
    let unhealthy = if table == Table::Drinks { 7 } else { 11 };
    let verdict = if score >= unhealthy {
        Some("unhealthy")
    } else if !complete {
        None
    } else if score <= 2 {
        Some("healthy")
    } else {
        Some("ok")
    };
    if verdict.is_none() {
        return (None, Vec::new());
    }
    let named = [top(&against), top(&for_)].concat();
    let why = REASONS.iter().filter(|r| named.contains(&r.key)).collect();
    (verdict, why)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sweeteners_are_whole_words() {
        for name in [
            "Pepsi Max",
            "Coca-Cola Zero",
            "Dr Pepper Zero",
            "Cola light",
            "Energiajuoma, vitaminoitu, keinotekoisesti makeutettu",
            "Limsa, sokeriton",
        ] {
            assert!(sweetened(name), "{name}");
        }
        for name in ["Coca-Cola", "Maxim protein drink", "Maito, kevyt", "Zeroth"] {
            assert!(!sweetened(name), "{name}");
        }
    }

    #[test]
    fn reasons_are_stored_under_their_own_keys() {
        assert_eq!(stored_reason("why_sodium").map(|r| r.text), Some("salt"));
        assert!(stored_reason("sodium").is_none());
        assert!(stored_reason("high_sodium").is_none());
    }
}
