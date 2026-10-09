//! Diary entries, groups, the weight log and imported totals.

use super::prelude::*;
use super::{Food, Source};

/// Food not eaten yet.
pub const PLANNED: &str = "Planned";
/// Food eaten.
pub const CONSUMED: &str = "Consumed";
/// Diary groups shown on every day, in order. Imported history may add others.
pub const GROUPS: [&str; 2] = [PLANNED, CONSUMED];

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub id: i64,
    pub day: String,
    pub group: String,
    pub food_id: Option<i64>,
    pub name: String,
    pub grams: Option<f64>,
    /// How it was measured: `quantity` of the food's serving `serving`, or
    /// grams when both are `None`.
    pub serving: Option<String>,
    pub quantity: Option<f64>,
    /// The amount as read: "2 × Slice (40 g)", "150 g"; imported rows keep
    /// their export's text.
    pub amount: String,
    pub nutrients: Option<Nutrients>,
    pub imported: bool,
    pub created_at: String,
    /// Stable sync identity; never reused, unlike `id`.
    pub uid: String,
    /// The database the food came from; `None` for imported history. Read
    /// from the food: a merged food's entries are repointed, so it always
    /// names one.
    pub source: Option<Source>,
    /// When it was eaten, "HH:MM"; display only.
    pub time: Option<String>,
}

/// Amount label for a plain gram quantity, to at most one decimal.
#[must_use]
pub fn gram_amount(grams: f64) -> String {
    format!("{} g", round_to(grams, 1))
}

/// "2 × Slice (40 g)": a quantity of a serving, with the grams it makes.
#[must_use]
pub fn serving_amount(quantity: f64, serving: &str, grams: f64) -> String {
    format!(
        "{} × {serving} ({})",
        round_to(quantity, 2),
        gram_amount(grams)
    )
}

/// `value` to at most `digits` decimals, as a plain number.
#[must_use]
pub fn round_to(value: f64, digits: i32) -> f64 {
    let scale = 10f64.powi(digits);
    (value * scale).round() / scale
}

/// How much of a food: grams, or a quantity of one of its servings.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Amount {
    #[serde(default)]
    pub grams: Option<f64>,
    #[serde(default)]
    pub serving: Option<String>,
    #[serde(default)]
    pub quantity: Option<f64>,
}

/// Grams, the serving and quantity they came from, and the amount text.
#[derive(Debug, Clone, PartialEq)]
pub struct Measured {
    pub grams: f64,
    pub serving: Option<String>,
    pub quantity: Option<f64>,
    pub amount: String,
}

impl Amount {
    /// The grams this amount is of `food`: grams as given, or quantity ×
    /// the named serving.
    ///
    /// # Errors
    /// Neither or both given, an unknown serving, or out of bounds.
    pub fn of(&self, food: &Food) -> Result<Measured, Error> {
        match (self.grams, self.serving.as_deref(), self.quantity) {
            (Some(g), None, None) => {
                let g = grams(g)?;
                Ok(Measured {
                    grams: g,
                    serving: None,
                    quantity: None,
                    amount: gram_amount(g),
                })
            }
            (None, Some(label), Some(q)) => {
                let s = food
                    .servings
                    .iter()
                    .find(|s| s.label == label)
                    .ok_or_else(|| {
                        Error::invalid_field(
                            "serving",
                            format!("{} has no serving “{label}”", food.name),
                        )
                    })?;
                if !(q.is_finite() && q > 0.0) {
                    return Err(Error::invalid_field(
                        "quantity",
                        "quantity must be more than 0",
                    ));
                }
                let g = grams(q * s.grams)?;
                Ok(Measured {
                    grams: g,
                    serving: Some(s.label.clone()),
                    quantity: Some(q),
                    amount: serving_amount(q, &s.label, g),
                })
            }
            _ => Err(bad("give grams, or a serving and its quantity")),
        }
    }
}

/// What a log writes: a food (an amount of it), a meal (all its items),
/// or copies of earlier entries. Exactly one of `food_id`, `meal_id` and
/// `entry_ids`.
#[derive(Debug, Clone, Deserialize)]
pub struct EntryInput {
    pub day: String,
    pub group: String,
    #[serde(default)]
    pub food_id: Option<i64>,
    #[serde(flatten)]
    pub amount: Amount,
    /// A meal instead of a food, logged as one entry per item, times
    /// `portions` (1 by default).
    #[serde(default)]
    pub meal_id: Option<i64>,
    #[serde(default)]
    pub portions: Option<f64>,
    /// Entries of the profile to copy (their snapshots, not their time).
    #[serde(default)]
    pub entry_ids: Option<Vec<i64>>,
    /// When it was eaten, "HH:MM"; given to every entry the log writes.
    #[serde(default)]
    pub time: Option<String>,
    /// The client's id for this write: sending it again logs nothing more
    /// and answers with what the first one logged.
    #[serde(default)]
    pub uid: Option<String>,
}

/// A checked [`EntryInput`]: where it logs, and what.
#[derive(Debug, Clone)]
pub struct EntryLog {
    pub day: String,
    pub group: &'static str,
    pub uid: Option<String>,
    pub time: Option<String>,
    pub what: Logs,
}

/// What an entry log writes.
#[derive(Debug, Clone)]
pub enum Logs {
    Food { food_id: i64, amount: Amount },
    Meal { meal_id: i64, portions: f64 },
    Copy { entry_ids: Vec<i64> },
}

/// A logged entry changed: moved, re-measured or timed.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct EntryPatch {
    #[serde(default)]
    pub group: Option<String>,
    #[serde(flatten)]
    pub amount: Amount,
    /// `null` clears the time; left out keeps it.
    #[serde(default)]
    pub time: Nullable<String>,
}

/// A nullable field of a patch: left out (kept), `null` (cleared) or a
/// new value.
#[derive(Debug, Clone, Default, PartialEq)]
pub enum Nullable<T> {
    #[default]
    Keep,
    Clear,
    Set(T),
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Nullable<T> {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(Option::<T>::deserialize(d)?.map_or(Self::Clear, Self::Set))
    }
}

impl<T> Nullable<T> {
    /// The value after the patch, given the one before.
    pub fn applied(self, before: Option<T>) -> Option<T> {
        match self {
            Self::Keep => before,
            Self::Clear => None,
            Self::Set(v) => Some(v),
        }
    }
}

/// A key the API took once and no longer does: present at all (`null`
/// too), the request is refused (see [`refuse_gone`]), so an older
/// client never has a value silently dropped.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Gone(bool);

impl<'de> Deserialize<'de> for Gone {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        serde::de::IgnoredAny::deserialize(d)?;
        Ok(Self(true))
    }
}

/// The first of `keys` that was sent, refused: `(sent, key, instead)`,
/// `instead` saying what takes its place.
///
/// # Errors
/// A gone key was present.
pub fn refuse_gone(keys: &[(Gone, &str, &str)]) -> Result<(), Error> {
    match keys.iter().find(|(gone, ..)| gone.0) {
        Some((_, key, instead)) => Err(Error::invalid_field(
            key,
            format!("this API no longer takes {key}: {instead}"),
        )),
        None => Ok(()),
    }
}

/// New entries go to one of [`GROUPS`]; other group names exist only in
/// imported history.
///
/// # Errors
/// Any other group.
pub fn checked_group(s: &str) -> Result<&'static str, Error> {
    GROUPS.into_iter().find(|g| *g == s).ok_or_else(|| {
        Error::invalid_field(
            "group",
            format!("group must be {}", either(GROUPS.into_iter())),
        )
    })
}

/// A client-made id: [`UID_MIN`]–[`UID_MAX`] letters, digits or `-` (`:` is the server's, for
/// meal items).
///
/// # Errors
/// Anything else.
pub fn checked_uid(uid: &str) -> Result<&str, Error> {
    if (UID_MIN..=UID_MAX).contains(&uid.len())
        && uid.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        Ok(uid)
    } else {
        Err(Error::invalid_field(
            "uid",
            format!("uid must be {UID_MIN}–{UID_MAX} letters, digits or -"),
        ))
    }
}

/// A time of day, "HH:MM" from 00:00 to 23:59.
///
/// # Errors
/// Anything else; blamed on `time`.
pub fn checked_time(t: &str) -> Result<&str, Error> {
    let b = t.as_bytes();
    let ok = b.len() == 5
        && b[2] == b':'
        && [0, 1, 3, 4].iter().all(|&i| b[i].is_ascii_digit())
        && &t[..2] <= "23"
        && b[3] <= b'5';
    if ok {
        Ok(t)
    } else {
        Err(Error::invalid_field(
            "time",
            "time must be HH:MM, 00:00–23:59",
        ))
    }
}

impl EntryInput {
    /// What it logs, and where.
    ///
    /// # Errors
    /// A bad day, group, uid, time, portions or ids, or not exactly one of a
    /// food, a meal and entries to copy.
    pub fn checked(self) -> Result<EntryLog, Error> {
        if !is_date(&self.day) {
            return Err(Error::invalid_field("day", "day must be YYYY-MM-DD"));
        }
        let group = checked_group(&self.group)?;
        if let Some(uid) = &self.uid {
            checked_uid(uid)?;
        }
        if let Some(t) = &self.time {
            checked_time(t)?;
        }
        let what = match (self.food_id, self.meal_id, self.entry_ids) {
            (Some(food_id), None, None) => Logs::Food {
                food_id,
                amount: self.amount,
            },
            (None, Some(meal_id), None) => {
                let portions = self.portions.unwrap_or(1.0);
                if !(portions.is_finite() && portions > 0.0 && portions <= PORTIONS_MAX) {
                    return Err(Error::invalid_field(
                        "portions",
                        format!("portions must be more than 0 and at most {PORTIONS_MAX}"),
                    ));
                }
                Logs::Meal { meal_id, portions }
            }
            (None, None, Some(entry_ids)) => {
                if !(1..=ITEMS_MAX).contains(&entry_ids.len()) {
                    return Err(Error::invalid_field(
                        "entry_ids",
                        format!("give 1–{ITEMS_MAX} entries to copy"),
                    ));
                }
                Logs::Copy { entry_ids }
            }
            _ => {
                return Err(bad("give exactly one of food_id, meal_id or entry_ids"));
            }
        };
        Ok(EntryLog {
            day: self.day,
            group,
            uid: self.uid,
            time: self.time,
            what,
        })
    }
}

impl EntryPatch {
    /// Whether it gives a new amount.
    #[must_use]
    pub fn re_measures(&self) -> bool {
        self.amount.grams.is_some()
            || self.amount.serving.is_some()
            || self.amount.quantity.is_some()
    }

    /// # Errors
    /// A bad group or time.
    pub fn checked(self) -> Result<Self, Error> {
        if let Some(g) = &self.group {
            checked_group(g)?;
        }
        if let Nullable::Set(t) = &self.time {
            checked_time(t)?;
        }
        Ok(self)
    }
}

/// A day's note.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DayNote {
    pub day: String,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NoteInput {
    pub text: String,
}

impl NoteInput {
    /// # Errors
    /// Blank, too long, or with control characters.
    pub fn checked(self) -> Result<Self, Error> {
        Ok(Self {
            text: text(&self.text, "text", NOTE_MAX)?,
        })
    }
}

/// Tags every check-in offers; any other text is a tag of your own.
pub const CHECK_IN_TAGS: &[&str] = &["sick", "poor sleep", "sore", "travel", "social", "period"];

/// How a day felt: mood, energy and stress (each 1–5 or unset) and a few
/// tags. At least one of them is set.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CheckIn {
    pub day: String,
    #[serde(default)]
    pub mood: Option<i64>,
    #[serde(default)]
    pub energy: Option<i64>,
    #[serde(default)]
    pub stress: Option<i64>,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// A whole check-in: a missing field is unset.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct CheckInInput {
    #[serde(default)]
    pub mood: Option<i64>,
    #[serde(default)]
    pub energy: Option<i64>,
    #[serde(default)]
    pub stress: Option<i64>,
    #[serde(default)]
    pub tags: Vec<String>,
}

impl CheckInInput {
    /// Tags trimmed, inner spaces collapsed, lowercased and deduplicated in
    /// order.
    ///
    /// # Errors
    /// A scale outside 1–5, a bad or ninth tag, or nothing at all.
    pub fn checked(self) -> Result<Self, Error> {
        for (field, v) in [
            ("mood", self.mood),
            ("energy", self.energy),
            ("stress", self.stress),
        ] {
            if v.is_some_and(|v| !(CHECK_IN_SCALE_MIN..=CHECK_IN_SCALE_MAX).contains(&v)) {
                return Err(Error::invalid_field(
                    field,
                    format!("{field} must be {CHECK_IN_SCALE_MIN}–{CHECK_IN_SCALE_MAX}"),
                ));
            }
        }
        let mut tags: Vec<String> = Vec::new();
        for t in &self.tags {
            let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
            let t = text(&t, "tags", CHECK_IN_TAG_MAX)?.to_lowercase();
            if !tags.contains(&t) {
                tags.push(t);
            }
        }
        if tags.len() > CHECK_IN_TAGS_MAX {
            return Err(Error::invalid_field(
                "tags",
                format!("a check-in has at most {CHECK_IN_TAGS_MAX} tags"),
            ));
        }
        if self.mood.is_none() && self.energy.is_none() && self.stress.is_none() && tags.is_empty()
        {
            return Err(bad("give a mood, energy, stress or a tag"));
        }
        Ok(Self { tags, ..self })
    }
}

text_enum! {
    /// A body measurement, in cm.
    pub enum BodyPart {
        Waist = "waist",
        Hips = "hips",
        Chest = "chest",
    }
}

impl BodyPart {
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Waist => "Waist",
            Self::Hips => "Hips",
            Self::Chest => "Chest",
        }
    }
}

/// One day's measurement of one body part, in cm.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Measurement {
    pub day: String,
    pub kind: BodyPart,
    pub value: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MeasurementInput {
    pub value: f64,
}

impl MeasurementInput {
    /// # Errors
    /// Out of bounds.
    pub fn checked(self) -> Result<Self, Error> {
        if self.value.is_finite() && (MEASURE_CM_MIN..=MEASURE_CM_MAX).contains(&self.value) {
            Ok(self)
        } else {
            Err(Error::invalid_field(
                "value",
                format!("a measurement must be {MEASURE_CM_MIN}–{MEASURE_CM_MAX} cm"),
            ))
        }
    }
}

/// One day's body weight.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Weight {
    pub day: String,
    pub kg: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WeightInput {
    pub kg: f64,
    /// When it was typed, epoch ms (a queued write replayed later keeps
    /// its own time); now when absent.
    #[serde(default)]
    pub set_at: Option<i64>,
}

/// How far back a typed weight's `set_at` may reach: a week.
pub const SET_AT_BACK_MS: i64 = 7 * 24 * 3_600_000;

impl WeightInput {
    /// `set_at` clamped to the last week up to `now`; `now` when absent.
    #[must_use]
    pub fn set_at(&self, now: i64) -> i64 {
        self.set_at
            .map_or(now, |t| t.clamp(now - SET_AT_BACK_MS, now))
    }

    /// # Errors
    /// Out of bounds.
    pub fn checked(self) -> Result<Self, Error> {
        if self.kg.is_finite() && (BODY_KG_MIN..=BODY_KG_MAX).contains(&self.kg) {
            Ok(self)
        } else {
            Err(Error::invalid_field(
                "kg",
                format!("weight must be {BODY_KG_MIN}–{BODY_KG_MAX} kg"),
            ))
        }
    }
}

/// One diary row from `servings.csv`.
#[derive(Debug, Clone)]
pub struct ImportedEntry {
    pub day: String,
    pub group: String,
    pub name: String,
    pub amount: String,
}

/// One per-group nutrient total from `dailysummary.csv`.
#[derive(Debug, Clone)]
pub struct DayTotal {
    pub day: String,
    pub group: String,
    pub nutrients: Nutrients,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(r: Result<CheckInInput, Error>) -> Option<String> {
        match r {
            Err(Error::Invalid { field, .. }) => field,
            other => panic!("expected Invalid, got {other:?}"),
        }
    }

    #[test]
    fn check_in_inputs_are_bounded() {
        let scales = |mood, energy, stress| CheckInInput {
            mood,
            energy,
            stress,
            tags: vec![],
        };
        assert_eq!(
            field(scales(Some(0), None, None).checked()).as_deref(),
            Some("mood")
        );
        assert_eq!(
            field(scales(None, Some(6), None).checked()).as_deref(),
            Some("energy")
        );
        assert_eq!(
            field(scales(Some(3), None, Some(-1)).checked()).as_deref(),
            Some("stress")
        );
        // Missing scales are unset; nothing at all is no check-in.
        let one = scales(None, None, Some(5)).checked().unwrap();
        assert_eq!((one.mood, one.energy, one.stress), (None, None, Some(5)));
        assert!(matches!(
            CheckInInput::default().checked(),
            Err(Error::Invalid { .. })
        ));

        let tagged = |tags: &[&str]| CheckInInput {
            tags: tags.iter().map(|&t| t.to_owned()).collect(),
            ..CheckInInput::default()
        };
        assert_eq!(
            tagged(&[" Travel ", "travel", "Poor  sleep"])
                .checked()
                .unwrap()
                .tags,
            ["travel", "poor sleep"]
        );
        let long = "x".repeat(CHECK_IN_TAG_MAX + 1);
        let nine = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
        for bad in [&[long.as_str()][..], &nine, &["ok\u{7}"], &["  "]] {
            assert_eq!(
                field(tagged(bad).checked()).as_deref(),
                Some("tags"),
                "{bad:?}"
            );
        }
        // Eight after dropping a duplicate is fine.
        assert_eq!(
            tagged(&["a", "b", "c", "d", "e", "f", "g", "h", "H"])
                .checked()
                .unwrap()
                .tags
                .len(),
            CHECK_IN_TAGS_MAX
        );
    }
}
