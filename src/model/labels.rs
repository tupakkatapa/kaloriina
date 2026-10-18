//! A food's labels: a verdict, Healthy, OK or Unhealthy, with its reasons
//! (the score's, [`super::score`]), and its sublabels ("High x", "Low x",
//! "Source of x") from its values per 100 g, or per 100 ml for a drink.
//! Pure; stored per food (`food_label`) so search filters them in SQL, and
//! recomputed whenever a food's values, its drink flag, its category or
//! [`LABEL_RULES_VERSION`] change.
//!
//! The positive sublabels are the EU nutrition claims (Reg. (EC) 1924/2006
//! Annex), the negatives the UK FSA front-of-pack reds (Nov 2016, Annex 3),
//! and the vitamins and minerals are judged against the EU nutrient
//! reference values ([`crate::nutrients::EU_NRV`]). A sublabel describes;
//! only the score judges.

use std::sync::LazyLock;

use super::prelude::*;
use super::score::{ALCOHOL_MAX, Reason, Scoring, judge, stored_reason};
use crate::nutrients::{EU_NRV, KCAL_PER_G_FAT, KCAL_PER_G_PROTEIN, KNOWN, REGISTRY};

/// Bump on any change to the rules or the vocabulary: every food is
/// relabelled at the next start.
pub const LABEL_RULES_VERSION: i64 = 3;

/// What a label says: the verdict, or a sublabel's shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LabelKind {
    Verdict,
    High,
    Low,
    Source,
}

/// One label of the vocabulary (`/api/meta.labels`): its key (a food
/// search's `?label=`), its text, its kind, the nutrient it is about
/// (`null` for a verdict) and whether it is good news.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Label {
    pub key: String,
    pub text: String,
    pub kind: LabelKind,
    pub nutrient: Option<&'static str>,
    pub positive: bool,
}

/// A food's labels: its verdict (`null` when neither applies), its
/// sublabels in vocabulary order and why the verdict is what it is.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Labels {
    pub verdict: Option<&'static str>,
    pub subs: Vec<&'static Label>,
    pub why: Vec<&'static Reason>,
}

impl Labels {
    /// The keys stored for a food: the verdict, the sublabels, then the
    /// reasons (`why_<key>`).
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.verdict
            .into_iter()
            .chain(self.subs.iter().map(|l| l.key.as_str()))
            .chain(self.why.iter().map(|r| r.stored))
    }
}

/// kcal per 100 g at or under which "per 100 kcal" means nothing: the EU
/// "energy-free" claim.
const ENERGY_FREE: f64 = 4.0;
/// "Low salt": at most 0.3 g of salt, as sodium (mg), food and drink.
const LOW_SALT_SODIUM: f64 = 120.0;

/// The thresholds of a food (per 100 g) or a drink (per 100 ml).
struct Table {
    low_energy: f64,
    low_fat: f64,
    low_saturated: f64,
    low_sugars: f64,
    /// A vitamin or mineral's share of its NRV: Source of, High is twice.
    source_nrv: f64,
    /// The FSA reds: over these is high.
    red: [(&'static str, f64); 4],
}

const FOOD: Table = Table {
    low_energy: 40.0,
    low_fat: 3.0,
    low_saturated: 1.5,
    low_sugars: 5.0,
    source_nrv: 0.15,
    red: [
        ("fat", 17.5),
        ("saturated", 5.0),
        ("sugars", 22.5),
        // 1.5 g of salt.
        ("sodium", 600.0),
    ],
};

const DRINK: Table = Table {
    low_energy: 20.0,
    low_fat: 1.5,
    low_saturated: 0.75,
    low_sugars: 2.5,
    source_nrv: 0.075,
    red: [
        ("fat", 8.75),
        ("saturated", 2.5),
        ("sugars", 11.25),
        // 0.75 g of salt.
        ("sodium", 300.0),
    ],
};

fn label(kind: LabelKind, nutrient: Option<&'static str>, text: &str, positive: bool) -> Label {
    let key = match (kind, nutrient) {
        (LabelKind::Verdict, _) | (_, None) => text.to_lowercase(),
        (LabelKind::High, Some(n)) => format!("high_{n}"),
        (LabelKind::Low, Some(n)) => format!("low_{n}"),
        (LabelKind::Source, Some(n)) => format!("source_{n}"),
    };
    Label {
        key,
        text: text.to_owned(),
        kind,
        nutrient,
        positive,
    }
}

/// A registry label inside a sentence: "vitamin C", "iron", but "B1
/// (thiamine)".
fn in_sentence(label: &str) -> String {
    let mut chars = label.chars();
    match (chars.next(), chars.next()) {
        (Some(first), Some(second)) if second.is_lowercase() => first
            .to_lowercase()
            .chain(label[first.len_utf8()..].chars())
            .collect(),
        _ => label.to_owned(),
    }
}

/// Every label in display order: the verdicts, the positives (protein,
/// fibre, the lows, omega-3, then each vitamin and mineral with an NRV in
/// registry order, High before Source of), then the negatives.
pub static LABELS: LazyLock<Vec<Label>> = LazyLock::new(|| {
    use LabelKind::{High, Low, Source, Verdict};
    let mut out = vec![
        label(Verdict, None, "Healthy", true),
        label(Verdict, None, "OK", false),
        label(Verdict, None, "Unhealthy", false),
        label(High, Some("protein"), "High protein", true),
        label(Source, Some("protein"), "Source of protein", true),
        label(High, Some("fiber"), "High fibre", true),
        label(Source, Some("fiber"), "Source of fibre", true),
        label(Low, Some("energy"), "Low calorie", true),
        label(Low, Some("fat"), "Low fat", true),
        label(Low, Some("saturated"), "Low sat. fat", true),
        label(Low, Some("sugars"), "Low sugar", true),
        label(Low, Some("sodium"), "Low salt", true),
        label(Source, Some("omega_3"), "Source of omega-3", true),
    ];
    for n in REGISTRY.iter().filter(|n| n.nrv().is_some()) {
        let name = in_sentence(n.label);
        out.push(label(High, Some(n.key), &format!("High {name}"), true));
        out.push(label(
            Source,
            Some(n.key),
            &format!("Source of {name}"),
            true,
        ));
    }
    out.extend([
        label(High, Some("fat"), "High fat", false),
        label(High, Some("saturated"), "High sat. fat", false),
        label(High, Some("sugars"), "High sugar", false),
        label(High, Some("sodium"), "High salt", false),
    ]);
    out
});

/// The vocabulary's label `key`, if there is one.
#[must_use]
pub fn find_label(key: &str) -> Option<&'static Label> {
    LABELS.iter().find(|l| l.key == key)
}

fn sub(kind: LabelKind, nutrient: &str, positive: bool) -> &'static Label {
    LABELS
        .iter()
        .find(|l| l.kind == kind && l.nutrient == Some(nutrient) && l.positive == positive)
        .expect("every rule names a label of the vocabulary")
}

/// The labels of these values per 100 g (per 100 ml for a drink), as far
/// as `known` (a recipe's or meal's coverage, ADR 0030; empty for a food)
/// proves them. A value under [`KNOWN`] of the energy behind it is a
/// floor: it proves an "at least" (High, Source of, a red, points against),
/// never a "Low" or a ratio to energy. The verdict is the score's
/// ([`super::score`]), with `scoring` (a drink, its fruit & veg share,
/// sweeteners).
#[must_use]
pub fn labels(per100: &Nutrients, scoring: &Scoring, known: &super::Known) -> Labels {
    use LabelKind::{High, Low, Source};
    let t = if scoring.drink { &DRINK } else { &FOOD };
    let energy = per100.get("energy");
    // Given, and known: the energy behind it reaches KNOWN of the total's.
    let full = |key: &str| {
        per100.get(key).is_some()
            && known
                .get(key)
                .is_none_or(|kcal| energy.is_some_and(|e| e > 0.0 && kcal / e >= KNOWN))
    };
    let at_least = |key: &str, min: f64| per100.get(key).is_some_and(|v| v >= min);
    let at_most = |key: &str, max: f64| full(key) && per100.get(key).is_some_and(|v| v <= max);
    let known_energy = energy.filter(|_| full("energy"));
    // Per 100 kcal, where that means something and energy is known.
    let energy = known_energy.filter(|e| *e > ENERGY_FREE);
    let per_kcal = |key: &str| Some(per100.get(key)? * 100.0 / energy?);
    // The share of energy from protein, where that means something.
    let protein = per_kcal("protein").map(|p| p * KCAL_PER_G_PROTEIN / 100.0);
    let mut hits: Vec<&'static Label> = Vec::new();
    let mut add = |on: bool, l: &'static Label| {
        if on {
            hits.push(l);
        }
    };
    if per100.get("alcohol").is_none_or(|a| a <= ALCOHOL_MAX) {
        let high_protein = protein.is_some_and(|p| p >= 0.20);
        add(high_protein, sub(High, "protein", true));
        add(
            !high_protein && protein.is_some_and(|p| p >= 0.12),
            sub(Source, "protein", true),
        );
        let high_fibre = at_least("fiber", 6.0) || per_kcal("fiber").is_some_and(|v| v >= 3.0);
        add(high_fibre, sub(High, "fiber", true));
        add(
            !high_fibre && (at_least("fiber", 3.0) || per_kcal("fiber").is_some_and(|v| v >= 1.5)),
            sub(Source, "fiber", true),
        );
        add(at_most("energy", t.low_energy), sub(Low, "energy", true));
        add(at_most("fat", t.low_fat), sub(Low, "fat", true));
        // Saturates and trans fat together (1924/2006 Annex), trans where
        // given; at most 10 % of energy.
        let saturated = per100
            .get("saturated")
            .map(|s| s + per100.get("trans_fats").unwrap_or(0.0));
        add(
            full("saturated")
                && saturated.is_some_and(|s| s <= t.low_saturated)
                && saturated
                    .zip(known_energy)
                    .is_some_and(|(s, e)| s * KCAL_PER_G_FAT <= 0.10 * e),
            sub(Low, "saturated", true),
        );
        add(at_most("sugars", t.low_sugars), sub(Low, "sugars", true));
        add(at_most("sodium", LOW_SALT_SODIUM), sub(Low, "sodium", true));
        // Per 100 g and per 100 kcal; the latter waived where it means
        // nothing (no or next to no energy).
        let omega = |key: &str, min: f64| {
            at_least(key, min)
                && match per_kcal(key) {
                    Some(v) => v >= min,
                    // Energy given but not known: unproven.
                    None => per100.get("energy").is_none_or(|e| e <= ENERGY_FREE),
                }
        };
        add(
            omega("ala", 0.3) || omega("epa_dha", 0.04),
            sub(Source, "omega_3", true),
        );
        for (key, nrv) in EU_NRV {
            let source = nrv * t.source_nrv;
            let high = at_least(key, 2.0 * source);
            add(high, sub(High, key, true));
            add(!high && at_least(key, source), sub(Source, key, true));
        }
    }
    for (key, red) in t.red {
        add(
            per100.get(key).is_some_and(|v| v > red),
            sub(High, key, false),
        );
    }
    let order = |l: &&Label| LABELS.iter().position(|x| std::ptr::eq(x, *l));
    hits.sort_by_key(order);
    let (verdict, why) = judge(per100, scoring, full);
    Labels {
        verdict,
        subs: hits,
        why,
    }
}

/// Stored label keys (`food_label`) as [`Labels`]: what a food read from
/// the database carries, so every view agrees with search.
#[must_use]
pub fn stored_labels(keys: &[String]) -> Labels {
    let mut out = Labels::default();
    for key in keys {
        match find_label(key) {
            Some(l) if l.kind == LabelKind::Verdict => out.verdict = Some(l.key.as_str()),
            Some(l) => out.subs.push(l),
            None => out.why.extend(stored_reason(key)),
        }
    }
    let order = |l: &&Label| LABELS.iter().position(|x| std::ptr::eq(x, *l));
    out.subs.sort_by_key(order);
    let order = |r: &&Reason| super::REASONS.iter().position(|x| std::ptr::eq(x, *r));
    out.why.sort_by_key(order);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// The shared case table (`tests/fixtures/label-cases.json`): each case's
    /// values per 100 g or ml, whether it's a drink, and the verdict and
    /// sublabel keys it must get, in order. Every threshold edge for food and
    /// drink.
    #[test]
    fn the_case_table_holds() {
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            #[serde(default)]
            drink: bool,
            #[serde(default)]
            fruit_veg: f64,
            #[serde(default)]
            sweetened: bool,
            per100: BTreeMap<String, f64>,
            /// A recipe's coverage (kcal behind a key, per 100 g).
            #[serde(default)]
            known: crate::model::Known,
            verdict: Option<String>,
            subs: Vec<String>,
            #[serde(default)]
            why: Vec<String>,
        }
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../../tests/fixtures/label-cases.json")).unwrap();
        assert!(cases.len() > 40, "{}", cases.len());
        let mut failed = Vec::new();
        for c in cases {
            let per100: Nutrients =
                serde_json::from_value(serde_json::to_value(&c.per100).unwrap()).unwrap();
            let scoring = Scoring {
                drink: c.drink,
                fruit_veg: c.fruit_veg,
                sweetened: c.sweetened,
            };
            let got = labels(&per100, &scoring, &c.known);
            let subs: Vec<&str> = got.subs.iter().map(|l| l.key.as_str()).collect();
            let why: Vec<&str> = got.why.iter().map(|r| r.key).collect();
            if got.verdict != c.verdict.as_deref() || subs != c.subs || why != c.why {
                failed.push(format!(
                    "{}: got {:?} {subs:?} {why:?}, want {:?} {:?} {:?}",
                    c.name, got.verdict, c.verdict, c.subs, c.why
                ));
            }
        }
        assert!(failed.is_empty(), "{}", failed.join("\n"));
    }

    #[test]
    fn the_vocabulary_is_unique_and_ordered() {
        let mut keys: Vec<&str> = LABELS.iter().map(|l| l.key.as_str()).collect();
        assert_eq!(&keys[..4], ["healthy", "ok", "unhealthy", "high_protein"]);
        assert_eq!(keys.last(), Some(&"high_sodium"));
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), LABELS.len());
        let c = find_label("source_vitamin_c").unwrap();
        assert_eq!((c.text.as_str(), c.positive), ("Source of vitamin C", true));
        assert_eq!(find_label("high_b1").unwrap().text, "High B1 (thiamine)");
        assert!(find_label("fruit_veg").is_none());
    }
}
