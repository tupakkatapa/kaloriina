//! Diary entries, groups, the weight log and imported totals.

use super::prelude::*;
use super::{Food, Source};

/// Food not eaten yet.
pub const PLANNED: &str = "Planned";
/// Food eaten.
pub const EATEN: &str = "Eaten";
/// Diary groups shown on every day, in order. Imported history may add others.
pub const GROUPS: [&str; 2] = [PLANNED, EATEN];

/// What a day or summary counts as eaten: every group but Planned.
#[must_use]
pub fn eaten(group: &str) -> bool {
    group != PLANNED
}

text_enum! {
    /// What an entry is: your own (a food, grams and values), a due day of
    /// a daily series (its food read now; no row until ticked), or imported
    /// history (no food or values of its own: they're in its group's
    /// total; matched to a food, its food's, out of that total).
    pub enum EntryKind {
        Own = "own",
        Due = "due",
        Imported = "imported",
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    /// `None` for a due day of a series ([`Repeat`]): it has no row until
    /// it is ticked.
    pub id: Option<i64>,
    /// Its address under `/entries/`: the id, or a due day's
    /// `daily-{item}-{day}` ([`EntryKey`]).
    pub key: String,
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
    pub created_at: String,
    /// Stable sync identity; never reused, unlike `id`. A due day's is the
    /// uid its tick takes: its key.
    pub uid: String,
    /// The database the food came from; `None` without a food. Read
    /// from the food: a merged food's entries are repointed, so it always
    /// names one.
    pub source: Option<Source>,
    /// When it was eaten, "HH:MM"; display only.
    pub time: Option<String>,
    /// Its food's weight is a guess ([`super::Basis::estimated`]), read
    /// from the food like `source`: its grams are approximate.
    pub weight_estimated: bool,
    /// The series it repeats in: a due day's, or the one a tick ticked.
    pub repeat: Option<Repeat>,
    /// Imported history: the import group it came from, which it is removed
    /// with (`DELETE …/imported/{day}/{src_group}`); `None` for your own.
    pub src_group: Option<String>,
    pub kind: EntryKind,
    /// Its food is measured by volume: a drink whose values are per
    /// 100 ml (not Fineli's, not a recipe), read from the food; its grams
    /// read as millilitres.
    pub by_volume: bool,
}

impl Entry {
    /// Imported history: read-only but for its group.
    #[must_use]
    pub fn imported(&self) -> bool {
        self.kind == EntryKind::Imported
    }
}

/// A daily series (ADR 0023): a food and amount due in Planned every day
/// from `start` until ticked (an entry logged with `repeat_of`) or skipped.
/// Un-ticked days read the series and its food as they are now.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Repeat {
    pub id: i64,
    pub start: String,
}

/// Where an entry is addressed: a stored entry by id, or a series' day
/// (`daily-{item}-{day}`), which is due, ticked or skipped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntryKey {
    Id(i64),
    Due { item: i64, day: String },
}

/// Only ASCII digits: what `str::parse` also takes with a sign.
fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

impl EntryKey {
    /// A series' day's address.
    #[must_use]
    pub fn due(item: i64, day: &str) -> String {
        format!("daily-{item}-{day}")
    }

    /// # Errors
    /// Neither an id nor `daily-{item}-{YYYY-MM-DD}`.
    pub fn parse(s: &str) -> Result<Self, Error> {
        let due = s
            .strip_prefix("daily-")
            .and_then(|rest| rest.split_once('-'))
            .filter(|(item, day)| digits(item) && is_date(day));
        let key = match due {
            Some((item, day)) => item.parse().ok().map(|item| Self::Due {
                item,
                day: day.to_owned(),
            }),
            None => digits(s).then(|| s.parse().ok().map(Self::Id)).flatten(),
        };
        key.ok_or_else(|| {
            Error::invalid("an entry's address is its id or daily-{item}-{YYYY-MM-DD}")
        })
    }
}

/// One diary group of a day: its entries and totals.
#[derive(Debug, Clone, Serialize)]
pub struct Group {
    pub name: String,
    pub entries: Vec<Entry>,
    pub totals: Nutrients,
    /// How far `totals` is known ([`super::Known`], ADR 0030), as the day's
    /// `known` is: a recipe's energy as far as its ingredients carry it.
    pub known: super::Known,
}

/// A day as the diary shows it: food by group, what was eaten, targets,
/// workouts, body, habits and Health Connect's day.
#[derive(Serialize)]
pub struct DayView {
    pub day: String,
    /// [`GROUPS`] in order, then imported history's other groups by name.
    /// Planned lists the series due that day first, entry-shaped (no id),
    /// and counts them in its `totals` (ADR 0023).
    pub groups: Vec<Group>,
    /// Every group, planned included.
    pub total: Nutrients,
    /// What was eaten: every group but Planned.
    pub eaten: Nutrients,
    /// How far `eaten` is known ([`super::Known`]; ADR 0030).
    pub known: super::Known,
    pub targets: Vec<super::Target>,
    pub activities: Vec<super::Activity>,
    /// Workouts planned that day, not done yet.
    pub plans: Vec<super::Plan>,
    /// The day's logged weight, if any.
    pub weight: Option<f64>,
    /// Where it came from: `hand`, `openscale` or `health_connect`.
    pub weight_source: Option<super::WeightSource>,
    /// Body composition from the day's chosen reading (the morning one,
    /// `scale_chosen`: the first after waking).
    pub composition: Option<Composition>,
    /// The day's note, if any.
    pub note: Option<String>,
    /// The day's check-in, if any.
    pub check_in: Option<CheckIn>,
    /// The day's body measurements, in [`BodyPart`] order.
    pub measurements: Vec<BodyValue>,
    /// The built-ins the day's food held (above 0), stored units (see
    /// `meta.habits`), in registry order.
    pub builtins: Vec<BuiltinValue>,
    /// Each tracker's total that day, archived ones included.
    pub habits: Vec<HabitValue>,
    /// Health Connect's day (energy, steps, the night that ended it,
    /// heart) with its sleep (night and naps), if any.
    pub device_day: Option<super::ShownDay>,
    /// The resting energy in effect that day, if any.
    pub resting: Option<super::Resting>,
    /// The day's naps, by start.
    pub naps: Vec<super::Nap>,
    /// The stage spans of the night that ended the day, by start: the
    /// device's, else an import's.
    pub stages: Vec<super::SleepStage>,
    /// The day's photos, oldest first.
    pub photos: Vec<super::Photo>,
    /// Device workouts waiting for Add or Dismiss.
    pub pending_activities: Vec<super::PendingActivity>,
    /// The food "+ Water" logs, if any: its entries read as ml or L.
    pub water_food_id: Option<i64>,
}

/// Body fat, water and muscle in %, each `null` when the scale gave none.
#[derive(Debug, Clone, Serialize)]
pub struct Composition {
    pub body_fat: Option<f64>,
    pub water: Option<f64>,
    pub muscle: Option<f64>,
}

/// One built-in habit's amount on the day.
#[derive(Debug, Clone, Serialize)]
pub struct BuiltinValue {
    pub habit: String,
    pub amount: f64,
    /// See [`super::HabitDayRow::known`].
    pub known: bool,
}

/// One habit tracker's total on the day.
#[derive(Debug, Clone, Serialize)]
pub struct HabitValue {
    pub habit_id: i64,
    pub amount: f64,
}

/// One body part's measurement on the day, in cm.
#[derive(Debug, Clone, Serialize)]
pub struct BodyValue {
    pub kind: BodyPart,
    pub value: f64,
}

/// Amount label for a plain gram quantity, to at most one decimal. A guessed
/// weight isn't marked in it: clients read the entry's `weight_estimated`.
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
/// copies of earlier entries, or a series' tick. Exactly one of
/// `food_id`, `meal_id`, `entry_ids` and `repeat_of`.
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
    /// A series ticked on `day`: its food and amount as they are now,
    /// linked; once per series and day. Its uid is `daily-{item}-{day}`
    /// (the due day's key) unless given, so two devices log it once.
    #[serde(default)]
    pub repeat_of: Option<i64>,
    /// A food's log only: repeat it daily from `start` (its day when left
    /// out), as an entry's patch does, in the same write.
    #[serde(default)]
    pub repeat: Option<RepeatInput>,
    /// Before `repeat_of`; refused by name.
    #[serde(default)]
    pub daily_item_id: Gone,
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
    Food {
        food_id: i64,
        amount: Amount,
        repeat: Option<RepeatInput>,
    },
    Meal {
        meal_id: i64,
        portions: f64,
    },
    Copy {
        entry_ids: Vec<i64>,
    },
    Daily {
        item: i64,
    },
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
    /// `{start}` repeats it daily from `start` (its day when left out),
    /// `null` stops its series (ticked days keep their entries); left out
    /// keeps it.
    #[serde(default)]
    pub repeat: Nullable<RepeatInput>,
}

/// Repeat daily from `start`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct RepeatInput {
    #[serde(default)]
    pub start: Option<String>,
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

/// A client-made id: [`UID_MIN`]–[`UID_MAX`] letters, digits or `-` (`:` is the
/// server's, for meal items).
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

/// An optional [`checked_uid`].
///
/// # Errors
/// A malformed one.
pub fn checked_opt_uid(uid: Option<&str>) -> Result<(), Error> {
    uid.map_or(Ok(()), |u| checked_uid(u).map(|_| ()))
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
    /// A bad day, group, uid, time, portions, ids or repeat, or not exactly
    /// one of a food, a meal and entries to copy.
    pub fn checked(self) -> Result<EntryLog, Error> {
        refuse_gone(&[(self.daily_item_id, "daily_item_id", "use repeat_of")])?;
        if !is_date(&self.day) {
            return Err(Error::invalid_field(
                "day",
                "day must be a real date (YYYY-MM-DD)",
            ));
        }
        let group = checked_group(&self.group)?;
        if let Some(uid) = &self.uid {
            checked_uid(uid)?;
        }
        if let Some(t) = &self.time {
            checked_time(t)?;
        }
        match &self.repeat {
            Some(_) if self.food_id.is_none() => {
                return Err(Error::invalid_field("repeat", "only a food repeats daily"));
            }
            Some(RepeatInput { start: Some(d) }) if !is_date(d) => {
                return Err(Error::invalid_field(
                    "repeat",
                    "repeat's start must be a real date (YYYY-MM-DD)",
                ));
            }
            _ => {}
        }
        let what = match (self.food_id, self.meal_id, self.entry_ids, self.repeat_of) {
            (Some(food_id), None, None, None) => Logs::Food {
                food_id,
                amount: self.amount,
                repeat: self.repeat,
            },
            (None, Some(meal_id), None, None) => {
                let portions = self.portions.unwrap_or(1.0);
                if !(portions.is_finite() && portions > 0.0 && portions <= PORTIONS_MAX) {
                    return Err(Error::invalid_field(
                        "portions",
                        format!("portions must be more than 0 and at most {PORTIONS_MAX}"),
                    ));
                }
                Logs::Meal { meal_id, portions }
            }
            (None, None, Some(entry_ids), None) => {
                if !(1..=ITEMS_MAX).contains(&entry_ids.len()) {
                    return Err(Error::invalid_field(
                        "entry_ids",
                        format!("give 1–{ITEMS_MAX} entries to copy"),
                    ));
                }
                Logs::Copy { entry_ids }
            }
            (None, None, None, Some(item)) => Logs::Daily { item },
            _ => {
                return Err(bad(
                    "give exactly one of food_id, meal_id, entry_ids or repeat_of",
                ));
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
    /// A bad group, time or repeat start.
    pub fn checked(mut self) -> Result<Self, Error> {
        if let Some(g) = &self.group {
            self.group = Some(checked_group(g)?.to_owned());
        }
        if let Nullable::Set(t) = &self.time {
            checked_time(t)?;
        }
        if let Nullable::Set(RepeatInput { start: Some(d) }) = &self.repeat
            && !is_date(d)
        {
            return Err(Error::invalid_field(
                "repeat",
                "repeat's start must be a real date (YYYY-MM-DD)",
            ));
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

text_enum! {
    /// What a profile chose for an insight.
    pub enum InsightState {
        /// Left out until a day (the Summary's "Hide for 2 weeks").
        Hidden = "hidden",
        /// Kept at the top (a discovered pattern's "Interesting").
        Pinned = "pinned",
    }
}

/// A profile's choice for an insight, by its stable id (`low:iron`,
/// `pattern:sleep~steps`): hidden through `until` (the last day hidden), or
/// pinned (no `until`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InsightPref {
    pub id: String,
    /// Hidden when unsaid: files' older `hidden_insights` have no state.
    #[serde(default = "hidden")]
    pub state: InsightState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
}

fn hidden() -> InsightState {
    InsightState::Hidden
}

/// The longest insight id kept.
pub const INSIGHT_ID_MAX: usize = 120;

#[derive(Debug, Clone, Deserialize)]
pub struct InsightPrefInput {
    pub state: InsightState,
    #[serde(default)]
    pub until: Option<String>,
}

impl InsightPref {
    /// # Errors
    /// A blank or overlong id, a hidden one without `until` a date, or a
    /// pinned one with an `until`.
    pub fn checked(id: &str, state: InsightState, until: Option<&str>) -> Result<Self, Error> {
        match (state, until) {
            (InsightState::Hidden, Some(u)) if is_date(u) => {}
            (InsightState::Hidden, _) => {
                return Err(Error::invalid_field(
                    "until",
                    "until must be a real date (YYYY-MM-DD)",
                ));
            }
            (InsightState::Pinned, Some(_)) => {
                return Err(Error::invalid_field(
                    "until",
                    "a pinned insight has no until",
                ));
            }
            (InsightState::Pinned, None) => {}
        }
        Ok(Self {
            id: text(id, "id", INSIGHT_ID_MAX)?,
            state,
            until: until.map(str::to_owned),
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
    fn an_entry_is_addressed_by_id_or_series_day() {
        assert_eq!(EntryKey::parse("42").unwrap(), EntryKey::Id(42));
        assert_eq!(
            EntryKey::parse("daily-7-2026-10-07").unwrap(),
            EntryKey::Due {
                item: 7,
                day: "2026-10-07".into()
            }
        );
        assert_eq!(EntryKey::due(7, "2026-10-07"), "daily-7-2026-10-07");
        for bad in [
            "",
            "+42",
            "-1",
            "daily-7",
            "daily-x-2026-10-07",
            "daily-7-tomorrow",
            "daily--7-2026-10-07",
        ] {
            assert!(EntryKey::parse(bad).is_err(), "{bad}");
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
