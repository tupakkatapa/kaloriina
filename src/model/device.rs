//! Device days and records from the Android companion's Health Connect
//! sync: each day's active energy, steps, sleep and heart, and the device's
//! workouts as it recorded them (the raw copy promoted into activities). A
//! POST replaces a window of days; only its envelope can be refused (400),
//! a bad value is dropped and a bad item skipped, each counted.

use std::collections::{BTreeMap, BTreeSet};

use jiff::civil::Date;
use jiff::{Timestamp, ToSpan};
use serde_json::{Map, Value};

use super::prelude::*;
use super::{ActivityType, RecordsResult, checked_uid, sneaky};

/// The `sync_state` source of the companion's status row.
pub const HEALTH_CONNECT: &str = "health_connect";
/// The raw store's source of a Google Takeout export's rows.
pub const GOOGLE_HEALTH: &str = "google_health";
/// Health Connect's recording method of a workout the device detected by
/// itself: it waits to be added, even in auto mode.
pub const AUTO_RECORDED: i64 = 2;

/// One day's values, each `None` when Health Connect had none. Sleep is the
/// night that ended this day; its four main fields come all or none.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DeviceDay {
    pub day: String,
    #[serde(default)]
    pub active_kcal: Option<i64>,
    /// Everything burned that day, resting and active, as the device
    /// counted it (Health Connect's `TotalCaloriesBurned`).
    #[serde(default)]
    pub total_kcal: Option<i64>,
    #[serde(default)]
    pub steps: Option<i64>,
    #[serde(default)]
    pub resting_hr: Option<i64>,
    #[serde(default)]
    pub hrv_ms: Option<i64>,
    #[serde(default)]
    pub asleep_min: Option<i64>,
    #[serde(default)]
    pub in_bed_min: Option<i64>,
    /// Local "HH:MM" in the phone's zone.
    #[serde(default)]
    pub bedtime: Option<String>,
    #[serde(default)]
    pub wake_time: Option<String>,
    #[serde(default)]
    pub deep_min: Option<i64>,
    #[serde(default)]
    pub rem_min: Option<i64>,
    #[serde(default)]
    pub light_min: Option<i64>,
    /// The day's heart rate (bpm): its average, lowest and highest over the
    /// whole day, and the average over the night that ended it.
    #[serde(default)]
    pub avg_hr: Option<i64>,
    #[serde(default)]
    pub min_hr: Option<i64>,
    #[serde(default)]
    pub max_hr: Option<i64>,
    #[serde(default)]
    pub sleep_avg_hr: Option<i64>,
    /// The day's resting energy (kcal a day) from Health Connect's basal
    /// metabolic rate, and the app that wrote it (its package). Derived
    /// by the server from the raw records, never read from a day item;
    /// alone it is no device day ([`Self::has_value`]).
    #[serde(default)]
    pub bmr_kcal: Option<f64>,
    #[serde(default)]
    pub bmr_origin: Option<String>,
    /// The day's distance (whole metres) from Health Connect's distance
    /// records, one app's: derived by the server from the raw records,
    /// never read from a day item.
    #[serde(default)]
    pub distance_m: Option<i64>,
}

/// "HH:MM", 00:00–23:59.
fn is_clock(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && s[..2].parse::<u8>().is_ok_and(|h| h < 24)
        && s[3..].parse::<u8>().is_ok_and(|m| m < 60)
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 2 || c.is_ascii_digit())
}

impl DeviceDay {
    /// The day with every value out of bounds dropped (a bad sleep field
    /// drops the night, the stages go with it), and whether any was.
    #[must_use]
    pub fn trimmed(mut self) -> (Self, bool) {
        let mut dropped = false;
        let mut keep = |v: &mut Option<i64>, lo: i64, hi: i64| {
            if v.is_some_and(|v| !(lo..=hi).contains(&v)) {
                *v = None;
                dropped = true;
            }
        };
        keep(&mut self.active_kcal, 0, ACTIVE_KCAL_MAX);
        keep(&mut self.total_kcal, 0, TOTAL_KCAL_MAX);
        keep(&mut self.steps, 0, STEPS_MAX);
        keep(&mut self.distance_m, 0, i64::from(DISTANCE_M_MAX));
        keep(&mut self.resting_hr, RESTING_HR_MIN, RESTING_HR_MAX);
        keep(&mut self.hrv_ms, HRV_MS_MIN, HRV_MS_MAX);
        for hr in [
            &mut self.avg_hr,
            &mut self.min_hr,
            &mut self.max_hr,
            &mut self.sleep_avg_hr,
        ] {
            keep(hr, HEART_RATE_MIN, HEART_RATE_MAX);
        }
        let night = [
            self.in_bed_min.is_some(),
            self.asleep_min.is_some(),
            self.bedtime.is_some(),
            self.wake_time.is_some(),
        ];
        let whole = self.in_bed_min.is_some_and(|b| (1..=1440).contains(&b))
            && self
                .asleep_min
                .is_some_and(|a| (0..=self.in_bed_min.unwrap_or(0)).contains(&a))
            && self.bedtime.as_deref().is_some_and(is_clock)
            && self.wake_time.as_deref().is_some_and(is_clock);
        if !whole && night.contains(&true) {
            dropped = true;
            (self.in_bed_min, self.asleep_min) = (None, None);
            (self.bedtime, self.wake_time) = (None, None);
        }
        // Resting energy comes with the app that wrote it (an Android
        // package name), or not at all.
        let package = |p: &str| {
            (1..=ACTIVITY_KEY_MAX).contains(&p.len())
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_')
        };
        let resting = self
            .bmr_kcal
            .is_some_and(|k| (0.0..=BMR_KCAL_MAX).contains(&k))
            && self.bmr_origin.as_deref().is_some_and(package);
        if !resting && (self.bmr_kcal.is_some() || self.bmr_origin.is_some()) {
            dropped = true;
            (self.bmr_kcal, self.bmr_origin) = (None, None);
        }
        let in_bed = self.in_bed_min.unwrap_or(-1);
        for stage in [&mut self.deep_min, &mut self.rem_min, &mut self.light_min] {
            if stage.is_some_and(|m| !(0..=in_bed).contains(&m)) {
                *stage = None;
                dropped = true;
            }
        }
        (self, dropped)
    }

    /// Whether anything is left to store.
    #[must_use]
    pub fn has_value(&self) -> bool {
        self.active_kcal.is_some()
            || self.total_kcal.is_some()
            || self.steps.is_some()
            || self.distance_m.is_some()
            || self.resting_hr.is_some()
            || self.hrv_ms.is_some()
            || self.in_bed_min.is_some()
            || self.avg_hr.is_some()
            || self.min_hr.is_some()
            || self.max_hr.is_some()
            || self.sleep_avg_hr.is_some()
    }
}

/// One workout the device recorded, as it recorded it: the raw copy a
/// session is promoted from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceSession {
    /// Health Connect's record id.
    pub key: String,
    /// The phone's local day of its start.
    pub day: String,
    /// UTC, RFC 3339.
    pub start_at: String,
    pub end_at: String,
    /// Health Connect's exercise type number.
    #[serde(rename = "type")]
    pub kind: i64,
    pub name: String,
    /// Active energy over it.
    #[serde(default)]
    pub kcal: Option<i64>,
    /// Total energy over it (resting included), sent when the device wrote
    /// no active energy: a device that writes total energy only. The
    /// phone's sync names it `kcal_total`.
    #[serde(default)]
    pub total_kcal: Option<i64>,
    /// Whole metres, distance types only.
    #[serde(default)]
    pub distance_m: Option<i64>,
    /// Health Connect's: 0 unknown, 1 active, 2 automatic, 3 manual entry.
    #[serde(default)]
    pub recording_method: i64,
    /// Average and peak heart rate (bpm) over it, from the device's samples.
    #[serde(default)]
    pub avg_hr: Option<i64>,
    #[serde(default)]
    pub max_hr: Option<i64>,
}

/// A device workout's session type, from Health Connect's exercise type
/// number (`ExerciseSessionType`). Strength, weightlifting, calisthenics,
/// "other workout" and an exercise class are workouts (without sets): one
/// routine at one MET however the device typed it; a type not
/// listed is "other".
#[must_use]
pub fn hc_type(kind: i64) -> ActivityType {
    match kind {
        8 | 11 | 45 | 55 | 58 => ActivityType::Workout,
        33 | 34 => ActivityType::Run,
        53 => ActivityType::Walk,
        21 => ActivityType::Hike,
        4 | 5 => ActivityType::Cycling,
        48 | 49 => ActivityType::Swim,
        31 | 61 => ActivityType::Rowing,
        60 => ActivityType::Elliptical,
        20 => ActivityType::Hiit,
        57 => ActivityType::Yoga,
        1..=3 | 9 | 12..=16 | 19 | 22 | 28 | 30 | 32 | 41..=43 | 50..=52 | 54 => {
            ActivityType::Sports
        }
        38 => ActivityType::Ski,
        29 => ActivityType::Climb,
        10 => ActivityType::Dance,
        _ => ActivityType::Other,
    }
}

/// The key prefix of a session imported from a Google Health export,
/// `gh-<exercise id>`: the import's own session (`source` `import`),
/// or a hand log that claimed it (`hand`), never a Health Connect
/// record's.
pub const IMPORT_KEY_PREFIX: &str = "gh-";

/// A workout read from an export, to be added unless already there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedWorkout {
    /// [`IMPORT_KEY_PREFIX`] and the export's id.
    pub key: String,
    /// The local day of its start.
    pub day: String,
    /// UTC, RFC 3339.
    pub start_at: String,
    pub end_at: String,
    pub kind: ActivityType,
    pub name: String,
    pub kcal: Option<u32>,
    pub distance_m: Option<u32>,
}

/// What a Google Health import did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct ImportCounts {
    /// Days whose shown values changed (new, filled or corrected).
    pub days: u64,
    /// Days that gained a night (each also counts as a day).
    pub nights: u64,
    /// Workouts added.
    pub activities: u64,
    /// Naps added.
    pub naps: u64,
    /// Workouts already there: the same one synced, logged, imported or
    /// deleted before (or a workout logged without a time that took it).
    pub kept: u64,
    /// Rows kept raw that weren't before (ADR 0019).
    pub records: u64,
    /// Export rows that couldn't be read.
    pub skipped: u64,
}

/// Resting energy in effect on a day (ADR 0032): Health Connect's
/// basal metabolic rate, the day's own or carried up to 6 days, kcal a
/// day; and the app that wrote it (its package).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Resting {
    pub kcal: f64,
    pub origin: String,
}

/// [`Resting`] on `day`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DayResting {
    pub day: String,
    #[serde(flatten)]
    pub resting: Resting,
}

/// A range of days' activity.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DeviceDays {
    /// Days with device values (or naps); their own resting energy isn't
    /// here but in `resting`, nor does it make a day.
    pub days: Vec<ShownDay>,
    pub sessions: Vec<DeviceSession>,
    /// Each day of the range with resting energy in effect, oldest first.
    pub resting: Vec<DayResting>,
    /// The naps counted in `days`' sleep, for the day view; not served
    /// (`GET …/device-days` carries the minutes in `total_asleep_min`).
    #[serde(skip)]
    pub naps: Vec<Nap>,
}

/// A day as shown: its values (all `None` on a day with only naps), the
/// sleep that counts (`total_asleep_min`: the night's time asleep and the
/// naps' time asleep, `None` without either; `asleep_min` is the night's),
/// how many naps there are, and the minutes in bed of those whose time
/// asleep isn't known (no stages: not counted asleep).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ShownDay {
    #[serde(flatten)]
    pub day: DeviceDay,
    pub total_asleep_min: Option<i64>,
    pub naps: usize,
    pub nap_in_bed_min: i64,
}

text_enum! {
    /// Where a nap came from: logged here, a sync, or an import.
    pub enum NapSource {
        Hand = "hand",
        HealthConnect = "health_connect",
        Import = "import",
    }
}

/// A nap a sync or an import sends: a block of sleep too short to be a
/// night, on its wake day; the key is the source's (its first sleep
/// session's id).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NapIn {
    pub day: String,
    pub key: String,
    /// UTC, RFC 3339.
    pub start_at: String,
    pub end_at: String,
    /// Time asleep: the span less its awake stages; `None` when the source
    /// had no stages for it (only in bed is known).
    pub asleep_min: Option<i64>,
}

/// A nap as stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Nap {
    pub uid: String,
    pub day: String,
    pub start_at: String,
    pub end_at: String,
    /// Its length, rounded: time in bed.
    pub in_bed_min: i64,
    /// Its time asleep; `None` when not known (a synced or imported nap
    /// without stages). A nap logged by hand is asleep throughout.
    pub asleep_min: Option<i64>,
    pub source: NapSource,
    pub source_key: Option<String>,
}

/// Whole minutes from `start_at` to `end_at` (RFC 3339), rounded; `None`
/// when either doesn't read.
#[must_use]
pub fn span_minutes(start_at: &str, end_at: &str) -> Option<i64> {
    let (start, end): (Timestamp, Timestamp) = (start_at.parse().ok()?, end_at.parse().ok()?);
    Some((end.as_second() - start.as_second() + 30).div_euclid(60))
}

/// A nap with a good key and times, 1 to [`NAP_MINUTES_MAX`] minutes long,
/// asleep (when known) no longer than that, its times in UTC, on its wake
/// day or one either side ([`wakes_near`]); else `None`. Every nap passes
/// it: logged, synced or imported.
#[must_use]
pub fn checked_nap(n: NapIn) -> Option<NapIn> {
    spanned(n).filter(|n| wakes_near(&n.day, &n.end_at))
}

/// [`checked_nap`] but its day.
fn spanned(n: NapIn) -> Option<NapIn> {
    let (start, end): (Timestamp, Timestamp) = (n.start_at.parse().ok()?, n.end_at.parse().ok()?);
    let minutes = span_minutes(&n.start_at, &n.end_at)?;
    (is_key(&n.key)
        && is_date(&n.day)
        && start < end
        && (1..=NAP_MINUTES_MAX).contains(&minutes)
        && n.asleep_min.is_none_or(|a| (0..=minutes).contains(&a)))
    .then(|| NapIn {
        start_at: start.to_string(),
        end_at: end.to_string(),
        ..n
    })
}

/// Whether `day` is the day a nap ending `end_at` (UTC) woke on, or one
/// either side: any zone's wake day.
fn wakes_near(day: &str, end_at: &str) -> bool {
    let wake = end_at
        .parse::<Timestamp>()
        .map(|t| t.to_zoned(jiff::tz::TimeZone::UTC).date());
    let day: Result<Date, _> = day.parse();
    match (wake, day) {
        (Ok(w), Ok(d)) => (w.saturating_sub(1.day())..=w.saturating_add(1.day())).contains(&d),
        _ => false,
    }
}

/// A nap logged by hand: its day (the wake day), start and end (RFC 3339,
/// any offset). The client's `uid` makes a retry save nothing more.
#[derive(Debug, Clone, Deserialize)]
pub struct NapInput {
    #[serde(default)]
    pub uid: Option<String>,
    pub day: String,
    pub start_at: String,
    pub end_at: String,
}

impl NapInput {
    /// As [`checked_nap`] takes a synced one, its times in UTC.
    ///
    /// # Errors
    /// A bad uid or day; times that don't read, run backwards or are no nap
    /// (`end_at`); a day not its wake day or one either side (`day`).
    pub fn checked(self) -> Result<Self, Error> {
        if let Some(uid) = &self.uid {
            checked_uid(uid)?;
        }
        if !is_date(&self.day) {
            return Err(Error::invalid_field("day", "day must be YYYY-MM-DD"));
        }
        let nap = spanned(NapIn {
            day: self.day.clone(),
            key: "hand".to_owned(),
            start_at: self.start_at.clone(),
            end_at: self.end_at.clone(),
            asleep_min: None,
        })
        .ok_or_else(|| {
            Error::invalid_field(
                "end_at",
                format!("a nap ends after it starts, within {NAP_MINUTES_MAX} minutes"),
            )
        })?;
        if !wakes_near(&nap.day, &nap.end_at) {
            return Err(Error::invalid_field(
                "day",
                "a nap's day is the day it ended, or a day either side",
            ));
        }
        Ok(Self {
            start_at: nap.start_at,
            end_at: nap.end_at,
            ..self
        })
    }
}

text_enum! {
    /// A sleep stage: Health Connect's stage types and Google Health's
    /// mapped onto these (out of bed and awake in bed are awake; asleep in
    /// no known stage is unknown).
    pub enum SleepStageKind {
        Awake = "awake",
        Light = "light",
        Deep = "deep",
        Rem = "rem",
        Unknown = "unknown",
    }
}

text_enum! {
    /// Where a sleep stage span came from.
    pub enum StageSource {
        HealthConnect = "health_connect",
        Import = "import",
    }
}

/// A span of one sleep stage in the night that ended `day` (its wake
/// day), as stored, served in the Day view and exported. A source has one
/// span starting at a time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SleepStage {
    pub day: String,
    /// UTC, RFC 3339.
    pub start_at: String,
    pub end_at: String,
    pub stage: SleepStageKind,
    pub source: StageSource,
}

/// A span with a good day and times, 1 s to a day long, its times in UTC;
/// else `None`.
#[must_use]
pub fn checked_stage(s: SleepStage) -> Option<SleepStage> {
    let (start, end): (Timestamp, Timestamp) = (s.start_at.parse().ok()?, s.end_at.parse().ok()?);
    (is_date(&s.day) && start < end && end.duration_since(start).as_secs() <= 86_400).then(|| {
        SleepStage {
            start_at: start.to_string(),
            end_at: end.to_string(),
            ..s
        }
    })
}

/// `day`'s night read right from its stage spans `stages` (one night's,
/// sorted or not): a tail of awake spans reaching the last span's end (awake
/// or out of bed after the last sleep) isn't in bed, and the wake time is
/// when sleep ended. Its spans go from the stages, its minutes from the time
/// in bed and the wake time. Nights a phone synced before the app ended them
/// so read as they now would; one without such a tail is left alone.
pub fn awake_tail_cut(day: &mut DeviceDay, stages: &mut Vec<SleepStage>) {
    let spans: Vec<(Timestamp, Timestamp, bool)> = stages
        .iter()
        .filter_map(|s| {
            Some((
                s.start_at.parse().ok()?,
                s.end_at.parse().ok()?,
                s.stage == SleepStageKind::Awake,
            ))
        })
        .collect();
    let (Some(first), Some(last)) = (
        spans.iter().map(|s| s.0).min(),
        spans.iter().map(|s| s.1).max(),
    ) else {
        return;
    };
    let mut cut = last;
    while let Some(&(a, _, _)) = spans
        .iter()
        .find(|&&(a, b, awake)| awake && a > first && a < cut && b >= cut)
    {
        cut = a;
    }
    let tail = (last.as_second() - cut.as_second() + 30).div_euclid(60);
    if tail == 0 {
        return;
    }
    stages.retain(|s| s.start_at.parse::<Timestamp>().is_ok_and(|a| a < cut));
    for s in stages.iter_mut() {
        if s.end_at.parse::<Timestamp>().is_ok_and(|b| b > cut) {
            s.end_at = cut.to_string();
        }
    }
    if let Some(in_bed) = day.in_bed_min.as_mut() {
        *in_bed = (*in_bed - tail).max(day.asleep_min.unwrap_or(0));
    }
    if let Some(wake) = day.wake_time.as_mut()
        && let Some((h, m)) = wake.split_once(':')
        && let (Ok(h), Ok(m)) = (h.parse::<i64>(), m.parse::<i64>())
    {
        let at = (h * 60 + m - tail).rem_euclid(1440);
        *wake = format!("{:02}:{:02}", at / 60, at % 60);
    }
}

/// A weigh-in another app wrote to Health Connect, from a sync.
#[derive(Debug, Clone, PartialEq)]
pub struct BodyReading {
    pub key: String,
    /// The phone's local day.
    pub day: String,
    /// Epoch milliseconds.
    pub taken_at: i64,
    pub weight: f64,
    pub body_fat: Option<f64>,
    pub lbm_kg: Option<f64>,
    pub bone_kg: Option<f64>,
    pub bmr_kcal: Option<f64>,
}

/// openScale's package names start so: its weigh-ins arrive through its own
/// webhook, so a copy it wrote to Health Connect is left out.
const OPENSCALE_ORIGIN: &str = "com.health.openscale";

/// What one POST did: its whole answer.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealthCounts {
    pub days: u64,
    pub sessions: u64,
    /// Days that carry a night's sleep.
    #[serde(default)]
    pub nights: u64,
    /// Items refused (unreadable, out of bounds, outside the window or
    /// repeated) or stored with a value dropped, each once.
    pub skipped: u64,
}

/// The last POST, as Profile → Connections shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealthResult {
    #[serde(flatten)]
    pub counts: HealthCounts,
    pub from: String,
    pub to: String,
    pub device: Option<String>,
    /// The device of the POST before: two phones on one profile replace
    /// each other's days.
    pub previous_device: Option<String>,
}

text_enum! {
    /// What a sync does with a new device workout: add it, or list it to be
    /// added or dismissed.
    #[derive(Default)]
    pub enum SyncedWorkouts {
        #[default]
        Auto = "auto",
        Ask = "ask",
    }
}

/// `PUT …/sync/health/workouts`.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct WorkoutsMode {
    pub mode: SyncedWorkouts,
}

/// A profile's Health Connect sync status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HealthStatus {
    /// Epoch milliseconds of the last POST, if any.
    pub last_seen: Option<i64>,
    pub last_result: Option<HealthResult>,
    /// The last sync's raw records pages (the phone posts them before its
    /// window; an older phone after it).
    pub records_result: Option<RecordsResult>,
    pub workouts: SyncedWorkouts,
}

/// A device workout waiting to be added or dismissed (the Day view's
/// `pending_activities`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PendingActivity {
    pub key: String,
    pub day: String,
    pub start_at: String,
    pub end_at: String,
    #[serde(rename = "type")]
    pub kind: ActivityType,
    pub name: String,
    pub minutes: u32,
    pub kcal: Option<i64>,
    pub distance_m: Option<i64>,
}

/// A device workout's minutes: rounded, at least 1, at most a day.
#[must_use]
pub fn activity_minutes(seconds: i64) -> u32 {
    u32::try_from(((seconds + 30) / 60).clamp(1, i64::from(ACTIVITY_MINUTES_MAX))).unwrap_or(1)
}

/// A sync body, read: the window it replaces and the valid items in it.
/// Its days hold the phone's day values only: nights, naps, stage spans
/// and HRV are the server's to make from the raw records, so
/// what an older phone sends of them is left out.
#[derive(Debug, Clone, PartialEq)]
pub struct HealthPost {
    pub from: String,
    pub to: String,
    pub device: Option<String>,
    pub days: Vec<DeviceDay>,
    pub sessions: Vec<DeviceSession>,
    pub body: Vec<BodyReading>,
    /// The raw records the phone read for the window, by kind, of the kinds
    /// the server makes days from ([`DERIVED_FROM`]): what Health Connect
    /// still holds there, so one it deleted goes from the raw store too. A
    /// kind not listed (an older phone, a kind not granted) stays as kept.
    pub read: BTreeMap<String, BTreeSet<String>>,
    pub skipped: u64,
}

/// The raw kinds the server makes days from: nights and their HRV, and
/// resting energy.
pub const DERIVED_FROM: [&str; 3] = [
    "SleepSession",
    "HeartRateVariabilityRmssd",
    "BasalMetabolicRate",
];

/// What an older phone sends with a day that the server makes itself
/// ([`HealthPost`]): left out, never counted as skipped.
const DERIVED_KEYS: &[&str] = &[
    "asleep_min",
    "in_bed_min",
    "bedtime",
    "wake_time",
    "deep_min",
    "rem_min",
    "light_min",
    "hrv_ms",
    "naps",
    "stages",
];

/// A whole number in `0..=max`, `Ok(None)` when absent or null, `Err`
/// when anything else (a fraction included: the phone rounds).
fn amount(m: &Map<String, Value>, key: &str, max: i64) -> Result<Option<i64>, ()> {
    match m.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_i64()
            .filter(|n| (0..=max).contains(n))
            .map(Some)
            .ok_or(()),
    }
}

/// A whole number as sent, `None` when absent, null or not one (`*bad`
/// then set): bounds are [`DeviceDay::trimmed`]'s.
fn whole(m: &Map<String, Value>, key: &str, bad: &mut bool) -> Option<i64> {
    let v = m.get(key).filter(|v| !v.is_null())?;
    let n = v.as_i64();
    *bad |= n.is_none();
    n
}

/// `field`, an optional list of at most `max` items.
fn list<'a>(obj: &'a Map<String, Value>, field: &str, max: usize) -> Result<&'a [Value], Error> {
    match obj.get(field) {
        None => Ok(&[]),
        Some(Value::Array(items)) if items.len() <= max => Ok(items),
        Some(Value::Array(_)) => Err(Error::invalid_field(
            field,
            format!("{field} holds at most {max} items"),
        )),
        Some(_) => Err(Error::invalid_field(
            field,
            format!("{field} must be a list"),
        )),
    }
}

/// `field`, an ISO day.
fn day_field(obj: &Map<String, Value>, field: &str) -> Result<Date, Error> {
    obj.get(field)
        .and_then(Value::as_str)
        .filter(|d| is_date(d))
        .and_then(|d| d.parse().ok())
        .ok_or_else(|| Error::invalid_field(field, format!("{field} must be YYYY-MM-DD")))
}

/// A label as text: control characters dropped, trimmed, at most `max`
/// characters; `None` when nothing is left.
fn label(s: &str, max: usize) -> Option<String> {
    let s: String = s.chars().filter(|c| !sneaky(*c)).collect();
    let s: String = s.trim().chars().take(max).collect();
    let s = s.trim_end();
    (!s.is_empty()).then(|| s.to_owned())
}

/// A Health Connect record id: 1–128 of `[A-Za-z0-9-]`.
#[must_use]
pub fn is_key(s: &str) -> bool {
    (1..=ACTIVITY_KEY_MAX).contains(&s.len())
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// A day's values all in bounds with one at least (resting energy alone
/// is one: a stored day may have only that), or `None` (a file's check:
/// nothing is dropped quietly).
#[must_use]
pub fn checked_day(d: DeviceDay) -> Option<DeviceDay> {
    let (d, dropped) = d.trimmed();
    (is_date(&d.day) && !dropped && (d.has_value() || d.bmr_kcal.is_some())).then_some(d)
}

/// A session's values in bounds, or `None` to skip it.
#[must_use]
pub fn checked_session(s: DeviceSession) -> Option<DeviceSession> {
    let start: Timestamp = s.start_at.parse().ok()?;
    let end: Timestamp = s.end_at.parse().ok()?;
    let long = end.duration_since(start).as_secs();
    let ok = is_key(&s.key)
        && is_date(&s.day)
        && (1..=86_400).contains(&long)
        && (0..=ACTIVITY_TYPE_MAX).contains(&s.kind)
        && [s.kcal, s.total_kcal]
            .iter()
            .all(|k| k.is_none_or(|k| (0..=i64::from(KCAL_MAX)).contains(&k)))
        && s.distance_m
            .is_none_or(|d| (0..=i64::from(DISTANCE_M_MAX)).contains(&d))
        && (0..=3).contains(&s.recording_method)
        && [s.avg_hr, s.max_hr]
            .iter()
            .all(|hr| hr.is_none_or(|b| (HEART_RATE_MIN..=HEART_RATE_MAX).contains(&b)));
    ok.then(|| DeviceSession {
        start_at: start.to_string(),
        end_at: end.to_string(),
        name: label(&s.name, ACTIVITY_NAME_MAX).unwrap_or_else(|| "Activity".to_owned()),
        ..s
    })
}

/// A day item's values (the phone's: [`HealthPost`]): `None` to skip it (no
/// day, or nothing left), else the day and whether a value was dropped.
/// The night's heart rate is an older phone's, kept until the server
/// measures the night itself.
fn read_day(m: &Map<String, Value>) -> Option<(DeviceDay, bool)> {
    let mut bad = false;
    let d = DeviceDay {
        day: m.get("day")?.as_str()?.to_owned(),
        active_kcal: whole(m, "active_kcal", &mut bad),
        total_kcal: whole(m, "total_kcal", &mut bad),
        steps: whole(m, "steps", &mut bad),
        resting_hr: whole(m, "resting_hr", &mut bad),
        avg_hr: whole(m, "avg_hr", &mut bad),
        min_hr: whole(m, "min_hr", &mut bad),
        max_hr: whole(m, "max_hr", &mut bad),
        sleep_avg_hr: whole(m, "sleep_avg_hr", &mut bad),
        ..DeviceDay::default()
    };
    // A non-number reads as absent: in the sleep group, that drops the night.
    let (d, dropped) = d.trimmed();
    (is_date(&d.day) && d.has_value()).then_some((d, dropped || bad))
}

/// A workout item: `None` to skip it, else the workout and whether its
/// energy, distance or recording method was dropped.
fn read_session(m: &Map<String, Value>) -> Option<(DeviceSession, bool)> {
    let text = |k: &str| m.get(k).and_then(Value::as_str).map(str::to_owned);
    let mut bad = false;
    let mut soft = |k: &str, max: i64| {
        amount(m, k, max).unwrap_or_else(|()| {
            bad = true;
            None
        })
    };
    let kcal = soft("kcal", i64::from(KCAL_MAX));
    let total_kcal = soft("kcal_total", i64::from(KCAL_MAX));
    let distance_m = soft("distance_m", i64::from(DISTANCE_M_MAX));
    let recording_method = soft("recording_method", 3).unwrap_or(0);
    let heart = |k: &str, bad: &mut bool| match amount(m, k, HEART_RATE_MAX) {
        Ok(Some(b)) if b >= HEART_RATE_MIN => Some(b),
        Ok(None) => None,
        _ => {
            *bad = true;
            None
        }
    };
    let (avg_hr, max_hr) = (heart("avg_hr", &mut bad), heart("max_hr", &mut bad));
    let s = checked_session(DeviceSession {
        key: text("key")?,
        day: text("day")?,
        start_at: text("start_at")?,
        end_at: text("end_at")?,
        kind: m.get("type")?.as_i64()?,
        name: match m.get("name") {
            None | Some(Value::Null) => String::new(),
            Some(v) => v.as_str()?.to_owned(),
        },
        kcal,
        total_kcal,
        distance_m,
        recording_method,
        avg_hr,
        max_hr,
    })?;
    Some((s, bad))
}

/// What a `body` item came to.
enum Body {
    /// Stored, with whether a value was dropped.
    Read(BodyReading, bool),
    /// openScale's own copy: left out, not counted.
    Left,
    Bad,
}

/// A `body` item: a weigh-in with a key, day, time and weight in bounds;
/// a value out of bounds is dropped.
fn read_body(m: &Map<String, Value>) -> Body {
    let text = |k: &str| m.get(k).and_then(Value::as_str);
    if text("origin").is_some_and(|o| o.starts_with(OPENSCALE_ORIGIN)) {
        return Body::Left;
    }
    let mut dropped = false;
    let mut value = |k: &str, lo: f64, hi: f64| {
        let v = m.get(k).filter(|v| !v.is_null())?;
        let ok = v.as_f64().filter(|x| *x > lo && *x <= hi);
        dropped |= ok.is_none();
        ok
    };
    let body_fat = value("body_fat", 0.0, 100.0);
    let lbm_kg = value("lbm_kg", 0.0, BODY_KG_MAX);
    let bone_kg = value("bone_kg", 0.0, BONE_KG_MAX);
    let bmr_kcal = value("bmr_kcal", 0.0, BMR_KCAL_MAX);
    let read = (|| {
        let key = text("key").filter(|k| is_key(k))?;
        let day = text("day").filter(|d| is_date(d))?;
        let at: Timestamp = text("at")?.parse().ok()?;
        let weight = m
            .get("kg")?
            .as_f64()
            .filter(|w| (BODY_KG_MIN..=BODY_KG_MAX).contains(w))?;
        Some(BodyReading {
            key: key.to_owned(),
            day: day.to_owned(),
            taken_at: at.as_millisecond(),
            weight,
            body_fat,
            lbm_kg,
            bone_kg,
            bmr_kcal,
        })
    })();
    read.map_or(Body::Bad, |r| Body::Read(r, dropped))
}

/// The body's `read`: per kind of [`DERIVED_FROM`], the ids the phone read
/// (other kinds, and ids that aren't, are left out).
///
/// # Errors
/// `read` not an object of lists, or a list over [`HEALTH_RECORDS_MAX`].
fn read_ids(obj: &Map<String, Value>) -> Result<BTreeMap<String, BTreeSet<String>>, Error> {
    let Some(read) = obj.get("read").filter(|v| !v.is_null()) else {
        return Ok(BTreeMap::new());
    };
    let Some(read) = read.as_object() else {
        return Err(Error::invalid_field("read", "read must be an object"));
    };
    let mut out = BTreeMap::new();
    for kind in DERIVED_FROM {
        if read.contains_key(kind) {
            let ids = list(read, kind, HEALTH_RECORDS_MAX)
                .map_err(|_| {
                    Error::invalid_field(
                        "read",
                        format!("read.{kind} must be a list of at most {HEALTH_RECORDS_MAX}"),
                    )
                })?
                .iter()
                .filter_map(Value::as_str)
                .filter(|id| is_key(id))
                .map(str::to_owned)
                .collect();
            out.insert(kind.to_owned(), ids);
        }
    }
    Ok(out)
}

impl HealthPost {
    /// Read a sync body. `latest` is the last day `to` may name: tomorrow
    /// in the server's time zone.
    ///
    /// # Errors
    /// A broken envelope (400): not an object; `from`/`to` missing, not
    /// days, reversed, more than [`ACTIVITY_WINDOW_MAX`] days apart or `to`
    /// after `latest`; `days`/`sessions` not lists or too long.
    pub fn read(body: &Value, latest: Date) -> Result<Self, Error> {
        let Some(obj) = body.as_object() else {
            return Err(bad("the body must be a JSON object"));
        };
        let (from, to) = (day_field(obj, "from")?, day_field(obj, "to")?);
        if from > to {
            return Err(Error::invalid_field("from", "from must not be after to"));
        }
        let window = i64::try_from(ACTIVITY_WINDOW_MAX).unwrap_or(i64::MAX);
        if from < to.saturating_sub((window - 1).days()) {
            return Err(Error::invalid_field(
                "to",
                format!("a sync covers at most {ACTIVITY_WINDOW_MAX} days"),
            ));
        }
        if to > latest {
            return Err(Error::invalid_field("to", "to can't be in the future"));
        }
        let days = list(obj, "days", ACTIVITY_WINDOW_MAX)?;
        let sessions = list(obj, "sessions", DEVICE_WORKOUTS_MAX)?;
        let (from, to) = (from.to_string(), to.to_string());
        let within = |d: &str| (from.as_str()..=to.as_str()).contains(&d);
        let mut post = Self {
            device: obj
                .get("device")
                .and_then(Value::as_str)
                .and_then(|d| label(d, LABEL_MAX)),
            days: Vec::new(),
            sessions: Vec::new(),
            body: Vec::new(),
            read: read_ids(obj)?,
            skipped: 0,
            from: from.clone(),
            to: to.clone(),
        };
        let mut seen = BTreeSet::new();
        for item in days {
            let Some(m) = item.as_object() else {
                post.skipped += 1;
                continue;
            };
            let day = m.get("day").and_then(Value::as_str).unwrap_or_default();
            // A day of what the server makes only (an older phone's night)
            // is no skip: it is left out.
            let derived = DERIVED_KEYS
                .iter()
                .any(|k| m.get(*k).is_some_and(|v| !v.is_null()));
            match read_day(m) {
                Some((d, dropped)) if within(day) && seen.insert(day.to_owned()) => {
                    post.skipped += u64::from(dropped);
                    post.days.push(d);
                }
                None if derived && is_date(day) && within(day) && seen.insert(day.to_owned()) => {}
                _ => post.skipped += 1,
            }
        }
        let mut seen = BTreeSet::new();
        for item in list(obj, "body", BODY_READINGS_MAX)? {
            match item.as_object().map(read_body) {
                Some(Body::Left) => {}
                Some(Body::Read(r, dropped)) if within(&r.day) && seen.insert(r.key.clone()) => {
                    post.skipped += u64::from(dropped);
                    post.body.push(r);
                }
                _ => post.skipped += 1,
            }
        }
        let mut seen = BTreeSet::new();
        for item in sessions {
            match item.as_object().and_then(read_session) {
                Some((s, dropped)) if within(&s.day) && seen.insert(s.key.clone()) => {
                    post.skipped += u64::from(dropped);
                    post.sessions.push(s);
                }
                _ => post.skipped += 1,
            }
        }
        Ok(post)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn far() -> Date {
        jiff::civil::date(2100, 1, 1)
    }

    fn session(key: &str, start: &str, end: &str) -> Value {
        json!({ "key": key, "day": "2026-10-08", "start_at": start, "end_at": end,
                "type": 33, "name": "Running", "kcal": 410 })
    }

    fn span(start: &str, end: &str, stage: SleepStageKind) -> SleepStage {
        SleepStage {
            day: "2026-10-12".to_owned(),
            start_at: start.to_owned(),
            end_at: end.to_owned(),
            stage,
            source: StageSource::HealthConnect,
        }
    }

    #[test]
    fn an_awake_tail_after_the_last_sleep_is_not_in_bed() {
        use SleepStageKind::{Awake, Light};
        // Oct 12: the last sleep ends 10:35, then 8 h 36 min awake to 19:11.
        let mut day = DeviceDay {
            day: "2026-10-12".to_owned(),
            in_bed_min: Some(913),
            asleep_min: Some(312),
            bedtime: Some("03:58".to_owned()),
            wake_time: Some("19:11".to_owned()),
            ..DeviceDay::default()
        };
        let mut stages = vec![
            span("2026-10-12T00:58:00Z", "2026-10-12T01:10:00Z", Awake),
            span("2026-10-12T01:10:00Z", "2026-10-12T07:20:00Z", Light),
            span("2026-10-12T07:20:00Z", "2026-10-12T07:25:00Z", Awake),
            span("2026-10-12T07:25:00Z", "2026-10-12T07:35:00Z", Light),
            span("2026-10-12T07:35:00Z", "2026-10-12T12:00:00Z", Awake),
            span("2026-10-12T11:00:00Z", "2026-10-12T16:11:00Z", Awake),
        ];
        awake_tail_cut(&mut day, &mut stages);
        assert_eq!(
            (day.wake_time.as_deref(), day.in_bed_min, day.asleep_min),
            (Some("10:35"), Some(397), Some(312))
        );
        assert_eq!(stages.len(), 4, "the tail's spans go");
        assert_eq!(stages[3].end_at, "2026-10-12T07:35:00Z");
        // Read again: nothing more goes; awake before the first sleep stays.
        let (was, spans) = (day.clone(), stages.clone());
        awake_tail_cut(&mut day, &mut stages);
        assert_eq!((day, stages), (was, spans));
    }

    #[test]
    fn items_out_of_bounds_are_skipped_and_counted() {
        let post = HealthPost::read(
            &json!({ "from": "2026-10-02", "to": "2026-10-08", "device": " Pixel\u{1b} 9 ",
                "days": [
                    { "day": "2026-10-08", "active_kcal": 512, "steps": 9120 },
                    { "day": "2026-10-07", "active_kcal": 511.6 },
                    { "day": "2026-10-08", "steps": 1 },
                    { "day": "2026-10-01", "steps": 1 },
                    { "day": "2026-10-03" },
                    { "day": "2026-10-04", "active_kcal": -1 },
                    { "day": "2026-10-05", "steps": "many" },
                    7,
                ],
                "sessions": [
                    session("a-1", "2026-10-08T14:02:00Z", "2026-10-08T14:48:00Z"),
                    session("a-1", "2026-10-08T15:02:00Z", "2026-10-08T15:48:00Z"),
                    session("a-2", "2026-10-08T14:02:00Z", "2026-10-08T14:02:00Z"),
                    session("a-3", "2026-10-08T14:02:00Z", "2026-10-09T14:02:01Z"),
                    session("a/4", "2026-10-08T14:02:00Z", "2026-10-08T14:48:00Z"),
                    { "key": "a-5", "day": "2026-10-08", "start_at": "2026-10-08T16:00:00+03:00",
                      "end_at": "2026-10-08T16:30:00+03:00", "type": 9999 },
                    { "key": "a-6", "day": "2026-10-08", "start_at": "2026-10-08T16:00:00+03:00",
                      "end_at": "2026-10-08T16:30:00+03:00", "type": 0, "name": "  " },
                ] }),
            far(),
        )
        .unwrap();
        assert_eq!(post.device.as_deref(), Some("Pixel 9"));
        assert_eq!(
            post.days,
            [DeviceDay {
                day: "2026-10-08".into(),
                active_kcal: Some(512),
                steps: Some(9120),
                ..DeviceDay::default()
            }]
        );
        assert_eq!(
            post.sessions
                .iter()
                .map(|s| (s.key.as_str(), s.name.as_str(), s.start_at.as_str(), s.kcal))
                .collect::<Vec<_>>(),
            [
                ("a-1", "Running", "2026-10-08T14:02:00Z", Some(410)),
                ("a-6", "Activity", "2026-10-08T13:00:00Z", None),
            ]
        );
        assert_eq!(post.skipped, 7 + 5);
    }

    fn night() -> Value {
        json!({ "in_bed_min": 475, "asleep_min": 440, "bedtime": "23:10", "wake_time": "07:05" })
    }

    fn one_day(extra: &Value) -> (Vec<DeviceDay>, u64) {
        let mut item = json!({ "day": "2026-10-08", "steps": 100 });
        for (k, v) in extra.as_object().unwrap() {
            item[k] = v.clone();
        }
        let post = HealthPost::read(
            &json!({ "from": "2026-10-08", "to": "2026-10-08", "days": [item] }),
            far(),
        )
        .unwrap();
        (post.days, post.skipped)
    }

    #[test]
    fn a_bad_value_is_dropped_and_the_day_kept() {
        let (days, skipped) = one_day(&json!({ "resting_hr": 54 }));
        assert_eq!((days[0].resting_hr, skipped), (Some(54), 0));
        // Each bound: the field goes, steps stay, the item counts once.
        for bad in [
            json!({ "resting_hr": 19 }),
            json!({ "resting_hr": 251 }),
            json!({ "resting_hr": 54.5 }),
            json!({ "resting_hr": "54" }),
            json!({ "resting_hr": 300, "avg_hr": 300 }),
        ] {
            let (days, skipped) = one_day(&bad);
            assert_eq!(skipped, 1, "{bad}");
            assert_eq!(
                (days[0].steps, days[0].resting_hr, days[0].avg_hr),
                (Some(100), None, None),
                "{bad}"
            );
        }
        // A distance out of bounds: dropped, the workout kept.
        let post = HealthPost::read(
            &json!({ "from": "2026-10-08", "to": "2026-10-08", "sessions": [{
                "key": "k", "day": "2026-10-08", "start_at": "2026-10-08T14:00:00Z",
                "end_at": "2026-10-08T14:30:00Z", "type": 33, "distance_m": 1_000_001,
                "recording_method": 2 }] }),
            far(),
        )
        .unwrap();
        assert_eq!(post.skipped, 1);
        assert_eq!(
            (
                post.sessions[0].distance_m,
                post.sessions[0].recording_method
            ),
            (None, AUTO_RECORDED)
        );
    }

    /// The night, its naps, spans and HRV are the server's to
    /// make from the raw records; what an older phone sends of them is left
    /// out, never counted as skipped.
    #[test]
    fn an_older_phones_night_is_left_out() {
        let mut item = night();
        item["deep_min"] = json!(70);
        item["hrv_ms"] = json!(48);
        item["sleep_avg_hr"] = json!(55);
        item["naps"] = json!([{ "key": "n-1", "start_at": "2026-10-08T12:00:00Z",
                                "end_at": "2026-10-08T12:30:00Z" }]);
        item["stages"] = json!([{ "start": "2026-10-07T20:10:00Z",
                                  "end": "2026-10-07T21:00:00Z", "stage": "deep" }]);
        let (days, skipped) = one_day(&item);
        assert_eq!(skipped, 0);
        assert_eq!(
            days,
            [DeviceDay {
                day: "2026-10-08".into(),
                steps: Some(100),
                // Its own heart rate stays the phone's until the server
                // measures the night (the sessions' `avg_bpm`).
                sleep_avg_hr: Some(55),
                ..DeviceDay::default()
            }]
        );
        let mut only = night();
        only["day"] = json!("2026-10-08");
        let post = HealthPost::read(
            &json!({ "from": "2026-10-08", "to": "2026-10-08", "days": [only] }),
            far(),
        )
        .unwrap();
        assert_eq!((post.days.len(), post.skipped), (0, 0));
    }

    /// A file's day (`checked_day`, the import's check): its sleep comes all
    /// or none, its stages within it, its HRV in bounds.
    #[test]
    fn a_files_sleep_comes_all_or_none() {
        let day = |extra: &Value| {
            let mut item = json!({ "day": "2026-10-08", "steps": 100 });
            for (k, v) in extra.as_object().unwrap() {
                item[k] = v.clone();
            }
            serde_json::from_value::<DeviceDay>(item).unwrap().trimmed()
        };
        let mut full = night();
        full["deep_min"] = json!(70);
        let (d, dropped) = day(&full);
        assert!(!dropped);
        assert_eq!(
            (d.in_bed_min, d.bedtime.as_deref(), d.deep_min),
            (Some(475), Some("23:10"), Some(70))
        );
        let broken = |k: &str, v: &Value| {
            let mut n = night();
            if v.is_null() {
                n.as_object_mut().unwrap().remove(k);
            } else {
                n[k] = v.clone();
            }
            n["deep_min"] = json!(60);
            day(&n)
        };
        for (k, v) in [
            ("in_bed_min", json!(0)),
            ("in_bed_min", json!(1441)),
            ("asleep_min", json!(476)),
            ("asleep_min", json!(-1)),
            ("bedtime", json!("24:00")),
            ("wake_time", json!("7:05")),
            ("bedtime", Value::Null),
        ] {
            let (d, dropped) = broken(k, &v);
            assert!(dropped, "{k} {v}");
            assert_eq!(
                (
                    d.in_bed_min,
                    d.asleep_min,
                    d.bedtime.as_deref(),
                    d.wake_time.as_deref()
                ),
                (None, None, None, None),
                "{k} {v}"
            );
            assert_eq!((d.deep_min, d.steps), (None, Some(100)), "{k} {v}");
        }
        // Stages longer than the night go alone.
        let mut long = night();
        long["rem_min"] = json!(476);
        let (d, dropped) = day(&long);
        assert_eq!((d.rem_min, d.in_bed_min, dropped), (None, Some(475), true));
        for hrv in [0, 501] {
            assert!(day(&json!({ "hrv_ms": hrv })).1, "{hrv}");
        }
        let hrv = |hr| DeviceDay {
            day: "2026-10-08".into(),
            hrv_ms: Some(48),
            resting_hr: hr,
            ..DeviceDay::default()
        };
        assert!(checked_day(hrv(None)).is_some());
        assert!(checked_day(hrv(Some(5))).is_none());
    }

    #[test]
    fn device_minutes_round_to_at_least_one() {
        assert_eq!(
            [1, 59, 89, 90, 2700, 200_000].map(activity_minutes),
            [1, 1, 1, 2, 45, ACTIVITY_MINUTES_MAX]
        );
        assert_eq!(hc_type(33), ActivityType::Run);
        assert_eq!(hc_type(45), ActivityType::Workout);
        assert_eq!(hc_type(20), ActivityType::Hiit);
        assert_eq!(hc_type(56), ActivityType::Other);
        // The same routine typed "other workout" or "exercise class" is a
        // workout, at a workout's MET.
        assert_eq!(hc_type(58), ActivityType::Workout);
        assert_eq!(hc_type(11), ActivityType::Workout);
    }

    #[test]
    fn a_hand_naps_day_is_its_wake_day_or_one_either_side() {
        let nap = |day: &str| NapInput {
            uid: None,
            day: day.into(),
            start_at: "2026-10-02T23:40:00+03:00".into(),
            end_at: "2026-10-03T00:20:00+03:00".into(),
        };
        // Ends 2026-10-02T21:20Z: the 1st to the 3rd.
        for day in ["2026-10-01", "2026-10-02", "2026-10-03"] {
            assert!(nap(day).checked().is_ok(), "{day}");
        }
        for day in ["2026-09-30", "2026-10-04", "2025-10-02"] {
            let err = nap(day).checked().unwrap_err();
            assert!(format!("{err:?}").contains("day"), "{day}: {err:?}");
        }
    }

    /// A synced or imported nap keeps the hand's rule.
    #[test]
    fn a_synced_naps_day_is_its_wake_day_or_one_either_side() {
        let nap = |day: &str, start: &str, end: &str| NapIn {
            day: day.into(),
            key: "nap-1".into(),
            start_at: start.into(),
            end_at: end.into(),
            asleep_min: None,
        };
        let far = nap("2026-10-15", "2020-01-01T12:00:00Z", "2020-01-01T12:40:00Z");
        assert_eq!(checked_nap(far), None);
        for day in ["2026-10-01", "2026-10-02", "2026-10-03"] {
            let near = nap(day, "2026-10-02T20:40:00Z", "2026-10-02T21:20:00Z");
            assert!(checked_nap(near).is_some(), "{day}");
        }
    }

    #[test]
    fn hc_types_match_the_shared_table() {
        let table: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/health/exercise-types.json"
        ))
        .unwrap();
        let types = table["types"].as_array().unwrap();
        assert!(types.len() > 60, "{}", types.len());
        for t in types {
            let hc = t["hc"].as_i64().unwrap();
            assert_eq!(
                serde_json::to_value(hc_type(hc)).unwrap(),
                t["type"],
                "{hc} {}",
                t["jar"]
            );
        }
        assert_eq!(hc_type(62), ActivityType::Other);
    }
}
