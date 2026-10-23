//! Google Health (the Fitbit-backed app) from a Google Takeout export: the
//! few CSV files Kaloriina reads, turned into days and workouts that fill
//! the profile's gaps (`db::device_fill`).
//!
//! - **Workouts:** `UserExercises_*.csv`, UTC with each one's offset; deleted
//!   ones and those under a minute are left out.
//! - **Nights:** `UserSleeps_*.csv` and `UserSleepStages_*.csv`. The export
//!   holds each night once per algorithm version: overlapping sessions keep
//!   the hand-entered one, else the newest version. Then the night rule
//!   (`model::sleep`, ADR 0032) makes nights, naps and stage spans, as it
//!   does of Health Connect's sleep sessions (asleep in no known stage is
//!   `unknown`).
//! - **Steps and active energy:** per-sample UTC series, summed per day in
//!   `tz` once per (timestamp, device), so a file sent twice counts once;
//!   per device, and the device that counted most is the day's (a phone and
//!   a device count the same walk).
//! - **Resting heart rate and HRV:** one row per day.
//! - **Heart rate:** `heart_rate_<date>.csv` samples (UTC), folded as read
//!   into each day's mean, lowest and highest in `tz`, and each night's
//!   mean over its span (the nights are known first: these files are read
//!   last). The browser sends them in batches, each with the sleep files.
//! - **Raw rows:** every row of the files that aren't per-sample series
//!   (workouts, sleeps, stages, resting heart rate, HRV), all its columns,
//!   kept as sent (ADR 0019), keyed by a hash of the file kind and the row;
//!   handed out [`RAW_BATCH`] at a time while the files are read. The
//!   other health files ([`other`]) are kept so too, under `gh_<name>`,
//!   and read no further.
//!
//! Days out of range (a negative year, after [`day_so_far`]) and values
//! that overflow are skipped and counted.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use jiff::Timestamp;
use jiff::civil::Date;
use jiff::tz::TimeZone;
use rusqlite::Connection;
use serde::Deserialize;

use crate::db;
use crate::error::Error;
use crate::model::sleep::{
    Night, Sleep, Sleeps, Span, Stage, local, offset, plausible, sleeps, stages_of,
};
use crate::model::{
    ACTIVITY_NAME_MAX, ActivityType, DISTANCE_M_MAX, DeviceDay, GOOGLE_HEALTH, HealthRecord,
    IMPORT_KEY_PREFIX, ImportCounts, ImportedWorkout, KCAL_MAX, NapIn, ProfileId, RECORD_KIND_MAX,
    SleepStage, StageSource, day_so_far, is_key, kept_data, sneaky,
};

/// Raw rows written per transaction: the database is free between them.
pub const RAW_BATCH: usize = 10_000;

/// One file of the export as the browser sends it: its path in the zip
/// (only the name counts) and its text.
#[derive(Debug, Clone, Deserialize)]
pub struct File {
    pub name: String,
    pub text: String,
}

/// An export's file: sent ([`File`]) or on disk (the CLI's, read when its
/// turn comes, one at a time).
pub trait Source {
    fn name(&self) -> &str;
    /// # Errors
    /// Unreadable: blamed on `files`.
    fn text(&self) -> Result<Cow<'_, str>, Error>;
}

impl Source for File {
    fn name(&self) -> &str {
        &self.name
    }
    fn text(&self) -> Result<Cow<'_, str>, Error> {
        Ok(Cow::Borrowed(&self.text))
    }
}

impl Source for PathBuf {
    fn name(&self) -> &str {
        self.to_str().unwrap_or_default()
    }
    fn text(&self) -> Result<Cow<'_, str>, Error> {
        std::fs::read_to_string(self)
            .map(Cow::Owned)
            .map_err(|e| Error::invalid_field("files", format!("{}: {e}", self.display())))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Exercises,
    Sleeps,
    Stages,
    Steps,
    Energy,
    RestingHr,
    Hrv,
    HeartRate,
    /// Any other health file: kept raw only.
    Other,
}

impl Kind {
    /// The kind its rows are kept raw under, with the columns of their
    /// start and end; `None` for a per-sample series (projected per day
    /// only).
    fn raw(self) -> Option<(&'static str, &'static str, Option<&'static str>)> {
        match self {
            Self::Exercises => Some(("UserExercises", "exercise_start", Some("exercise_end"))),
            Self::Sleeps => Some(("UserSleeps", "sleep_start", Some("sleep_end"))),
            Self::Stages => Some((
                "UserSleepStages",
                "sleep_stage_start",
                Some("sleep_stage_end"),
            )),
            Self::RestingHr => Some(("daily_resting_heart_rate", "timestamp", None)),
            Self::Hrv => Some(("daily_heart_rate_variability", "timestamp", None)),
            Self::Steps | Self::Energy | Self::HeartRate | Self::Other => None,
        }
    }

    /// The columns read, in order.
    fn columns(self) -> &'static [&'static str] {
        match self {
            Self::Exercises => &[
                "exercise_id",
                "exercise_start",
                "exercise_end",
                "utc_offset",
                "activity_name",
                "deletion_reason",
                "manually_logged_total_calories",
                "tracker_total_calories",
                "manually_logged_total_distance_mm",
                "tracker_total_distance_mm",
            ],
            Self::Sleeps => &[
                "sleep_id",
                "sleep_start",
                "sleep_end",
                "start_utc_offset",
                "end_utc_offset",
                "data_source",
                "algorithm_version",
            ],
            Self::Stages => &[
                "sleep_id",
                "sleep_stage_type",
                "sleep_stage_start",
                "sleep_stage_end",
            ],
            Self::Steps => &["timestamp", "steps", "data source"],
            Self::Energy => &["timestamp", "kilocalories", "data source"],
            Self::RestingHr | Self::HeartRate => &["timestamp", "beats per minute"],
            Self::Hrv => &["timestamp", "average heart rate variability milliseconds"],
            Self::Other => &[],
        }
    }
}

/// The file's name without its folders.
fn base(name: &str) -> &str {
    name.rsplit(['/', '\\']).next().unwrap_or(name)
}

fn kind(name: &str) -> Option<Kind> {
    let csv = base(name).strip_suffix(".csv")?;
    let dated = |prefix: &str| csv.starts_with(prefix);
    Some(if dated("UserExercises_") {
        Kind::Exercises
    } else if dated("UserSleeps_") {
        Kind::Sleeps
    } else if dated("UserSleepStages_") {
        Kind::Stages
    } else if dated("steps_") {
        Kind::Steps
    } else if dated("active_energy_burned_") {
        Kind::Energy
    } else if csv
        .strip_prefix("heart_rate_")
        .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()))
    {
        Kind::HeartRate
    } else if csv == "daily_resting_heart_rate" {
        Kind::RestingHr
    } else if csv == "daily_heart_rate_variability" {
        Kind::Hrv
    } else if other(name) {
        Kind::Other
    } else {
        return None;
    })
}

/// Where a file name's date starts (`_2026-05-31`), if it has one.
fn date_at(name: &str) -> Option<usize> {
    let digit_or_dash = |(j, b): (usize, &u8)| {
        if j == 4 || j == 7 {
            *b == b'-'
        } else {
            b.is_ascii_digit()
        }
    };
    name.as_bytes()
        .windows(11)
        .position(|w| w[0] == b'_' && w[1..].iter().enumerate().all(digit_or_dash))
}

/// Whether the CSV `name` is a health file kept raw only: any under
/// `Health Fitness Data_GoogleData/`, and the undated ones in the other
/// `_GoogleData` folders (a dated one there is a per-sample series). Paired
/// devices and the other Takeout products are in no such folder.
fn other(name: &str) -> bool {
    let mut folders: Vec<&str> = name.split(['/', '\\']).collect();
    let file = folders.pop().unwrap_or_default();
    folders.contains(&"Health Fitness Data_GoogleData")
        || (folders.iter().any(|f| f.ends_with("_GoogleData")) && date_at(file).is_none())
}

/// The kind an [`other`] file's rows are kept under: `gh_` and its name
/// without the date, in letters, digits and `_`.
fn other_kind(name: &str) -> String {
    let file = base(name).strip_suffix(".csv").unwrap_or(name);
    let stem = &file[..date_at(file).unwrap_or(file.len())];
    "gh_"
        .chars()
        .chain(
            stem.chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }),
        )
        .take(RECORD_KIND_MAX)
        .collect()
}

/// Whether an export file is one Kaloriina reads or keeps (the browser
/// sends only these; `tests/fixtures/takeout-names.json` lists both
/// sides).
#[must_use]
pub fn wanted(name: &str) -> bool {
    kind(name).is_some()
}

/// A decimal as thousandths (`"62.343"` → 62343); `None` unless plain
/// digits with an optional fraction.
fn milli(s: &str) -> Option<i64> {
    let (int, frac) = s.split_once('.').unwrap_or((s, ""));
    let digits = |t: &str| t.bytes().all(|b| b.is_ascii_digit());
    if int.is_empty() || !digits(int) || !digits(frac) {
        return None;
    }
    let frac: String = frac.chars().chain("000".chars()).take(3).collect();
    int.parse::<i64>()
        .ok()?
        .checked_mul(1000)?
        .checked_add(frac.parse().ok()?)
}

/// Thousandths rounded to a whole number.
fn rounded(milli: i64) -> i64 {
    milli.saturating_add(500).div_euclid(1000)
}

/// A name as a label: no control characters, trimmed, at most
/// [`ACTIVITY_NAME_MAX`] characters.
fn label(s: &str) -> String {
    let s: String = s.chars().filter(|c| !sneaky(*c)).collect();
    let s: String = s.trim().chars().take(ACTIVITY_NAME_MAX).collect();
    match s.trim_end() {
        "" => "Activity".to_owned(),
        s => s.to_owned(),
    }
}

/// A workout's type from its activity name: a word starting with one of
/// the type's stems ("Crunches" is no run).
fn session_kind(name: &str) -> ActivityType {
    let n = name.to_lowercase();
    let words: Vec<&str> = n.split(|c: char| !c.is_alphanumeric()).collect();
    let has = |stems: &[&str]| words.iter().any(|w| stems.iter().any(|s| w.starts_with(s)));
    if has(&["run", "jog"]) {
        ActivityType::Run
    } else if has(&["walk"]) {
        ActivityType::Walk
    } else if has(&["hike", "hiking", "rucking"]) {
        ActivityType::Hike
    } else if has(&["bike", "biking", "cycl", "spinning"]) {
        ActivityType::Cycling
    } else if has(&["swim"]) {
        ActivityType::Swim
    } else if has(&["strength", "weight", "calisthenics", "workout"]) {
        ActivityType::Workout
    } else if has(&["hiit", "interval"]) {
        ActivityType::Hiit
    } else if has(&["rowing", "rower"]) {
        ActivityType::Rowing
    } else if has(&["elliptical"]) {
        ActivityType::Elliptical
    } else if has(&["yoga"]) {
        ActivityType::Yoga
    } else if words.iter().any(|w| *w == "ski" || w.starts_with("skiing")) {
        ActivityType::Ski
    } else if has(&["climb", "boulder"]) {
        ActivityType::Climb
    } else if has(&["danc"]) {
        ActivityType::Dance
    } else {
        ActivityType::Other
    }
}

/// The first of `values` above zero, rounded.
fn first_positive(values: &[&str]) -> Option<i64> {
    values
        .iter()
        .filter_map(|v| milli(v))
        .find(|&m| m > 0)
        .map(rounded)
}

/// What a row of a file came to.
enum Row<T> {
    Read(T),
    /// Left out on purpose (a deleted or too short workout).
    Left,
    /// Unreadable: counted as skipped.
    Bad,
}

fn workout(v: &[&str], tz: &TimeZone, latest: Date) -> Row<ImportedWorkout> {
    let &[id, start, end, off, name, deleted, mk, tk, md, td] = v else {
        return Row::Bad;
    };
    if !matches!(deleted, "" | "UNSPECIFIED") {
        return Row::Left;
    }
    let key = format!("{IMPORT_KEY_PREFIX}{id}");
    let (Ok(start), Ok(end)) = (start.parse::<Timestamp>(), end.parse::<Timestamp>()) else {
        return Row::Bad;
    };
    let seconds = end.as_second() - start.as_second();
    let day = local(start, offset(off), tz).date();
    if !is_key(&key) || !(0..=86_400).contains(&seconds) || !plausible(day, latest) {
        return Row::Bad;
    }
    if seconds < 60 {
        return Row::Left;
    }
    let name = label(name);
    Row::Read(ImportedWorkout {
        key,
        day: day.to_string(),
        start_at: start.to_string(),
        end_at: end.to_string(),
        kind: session_kind(&name),
        name,
        kcal: first_positive(&[mk, tk])
            .and_then(|k| u32::try_from(k).ok())
            .filter(|&k| k <= KCAL_MAX),
        // Millimetres to metres.
        distance_m: first_positive(&[md, td])
            .map(rounded)
            .and_then(|m| u32::try_from(m).ok())
            .filter(|&m| m <= DISTANCE_M_MAX),
    })
}

/// What the files hold, read (their raw rows went to the `keep` of
/// [`read`]).
#[derive(Debug, Default)]
pub struct Export {
    pub days: Vec<DeviceDay>,
    /// Oldest first.
    pub workouts: Vec<ImportedWorkout>,
    pub naps: Vec<NapIn>,
    /// Each night's stage spans.
    pub stages: Vec<SleepStage>,
    /// Rows that couldn't be read, and days with a value out of bounds.
    pub skipped: u64,
}

/// Hands a batch of raw rows to the store; how many were new.
pub type Keep<'a> = dyn FnMut(&[HealthRecord]) -> Result<u64, Error> + 'a;

/// A day's heart rate samples: sum, count, lowest, highest (thousandths).
type Heart = (i64, i64, i64, i64);

/// The files' rows as read so far.
struct Reader<'a, 'k> {
    tz: &'a TimeZone,
    latest: Date,
    keep: &'a mut Keep<'k>,
    workouts: BTreeMap<String, ImportedWorkout>,
    sleeps: HashMap<String, Sleep>,
    stages: Vec<(String, Span, Stage)>,
    /// The nights, once the sleep files are read (before heart rate).
    nights: Option<Sleeps>,
    /// Thousandths per (timestamp, device): a sample sent twice counts once.
    steps: HashMap<(Timestamp, u32), i64>,
    energy: HashMap<(Timestamp, u32), i64>,
    devices: HashMap<String, u32>,
    resting_hr: BTreeMap<Date, i64>,
    hrv: BTreeMap<Date, i64>,
    heart: BTreeMap<Date, Heart>,
    /// Raw rows not yet handed to `keep`, and how many it found new.
    raw: Vec<HealthRecord>,
    records: u64,
    skipped: u64,
}

/// 128-bit FNV-1a of `parts` (each ended by a 0 byte), as hex: a row's id
/// that stays the same across releases.
fn fnv(parts: &[&str]) -> String {
    let mut h: u128 = 0x6c62_272e_07bb_0142_62b8_2175_6295_c58d;
    for b in parts.iter().flat_map(|p| p.bytes().chain([0])) {
        h ^= u128::from(b);
        h = h.wrapping_mul(0x0000_0000_0100_0000_0000_0000_0000_013b);
    }
    format!("{h:032x}")
}

/// A header cell as compared: no BOM, trimmed.
fn header(h: &str) -> &str {
    h.trim_start_matches('\u{feff}').trim()
}

/// A row of a `kind` file kept raw: every column by its header; `at` are
/// the positions of its start and end columns, and of the one its day is
/// read from when the start is no time (`2026-07-02`).
fn raw_row(
    kind: &str,
    at: (Option<usize>, Option<usize>, Option<usize>),
    head: &csv::StringRecord,
    row: &csv::StringRecord,
    tz: &TimeZone,
) -> HealthRecord {
    let columns: serde_json::Map<String, serde_json::Value> = head
        .iter()
        .map(header)
        .zip(row.iter().chain(std::iter::repeat("")))
        .map(|(h, v)| (h.to_owned(), serde_json::Value::from(v)))
        .collect();
    let time = |i: Option<usize>| i.and_then(|i| row.get(i)?.parse::<Timestamp>().ok());
    let (start, end) = (time(at.0), time(at.1));
    let text: Vec<&str> = row.iter().collect();
    let (data, truncated) = kept_data(&columns);
    HealthRecord {
        kind: kind.to_owned(),
        id: fnv(&[&[kind][..], &text].concat()),
        start_at: start.map(|t| t.to_string()),
        end_at: end.map(|t| t.to_string()),
        day: start
            .map(|t| t.to_zoned(tz.clone()).date())
            .or_else(|| date_of(row.get(at.2?)?))
            .map(|d| d.to_string()),
        data,
        truncated,
    }
}

/// A daily row's day: its timestamp's date (`2026-07-02T00:00:00Z`).
fn date_of(s: &str) -> Option<Date> {
    s.get(..10)?.parse().ok()
}

impl Reader<'_, '_> {
    /// `at`'s day in the zone, if one that may be stored.
    fn day(&self, at: Timestamp) -> Option<Date> {
        let day = at.to_zoned(self.tz.clone()).date();
        plausible(day, self.latest).then_some(day)
    }

    fn device(&mut self, name: &str) -> u32 {
        let next = u32::try_from(self.devices.len()).unwrap_or(u32::MAX);
        *self.devices.entry(name.to_owned()).or_insert(next)
    }

    fn row(&mut self, kind: Kind, v: &[&str]) -> Option<()> {
        let tz = self.tz;
        match kind {
            Kind::Exercises => match workout(v, tz, self.latest) {
                Row::Read(w) => {
                    self.workouts.insert(w.key.clone(), w);
                }
                Row::Left => {}
                Row::Bad => return None,
            },
            Kind::Sleeps => {
                let span = (v[1].parse().ok()?, v[2].parse().ok()?);
                let version = v[6].rsplit('v').next().and_then(|n| n.parse().ok());
                self.sleeps.insert(
                    v[0].to_owned(),
                    Sleep {
                        id: v[0].to_owned(),
                        span,
                        offsets: (offset(v[3]), offset(v[4])),
                        rank: (v[5] == "MANUAL", version.unwrap_or(0)),
                        stages: Vec::new(),
                        bpm: None,
                    },
                );
            }
            Kind::Stages => {
                let stage = match v[1] {
                    "AWAKE" | "RESTLESS" => Stage::Awake,
                    "LIGHT" => Stage::Light,
                    "DEEP" => Stage::Deep,
                    "REM" => Stage::Rem,
                    _ => Stage::Asleep,
                };
                let span = (v[2].parse().ok()?, v[3].parse().ok()?);
                self.stages.push((v[0].to_owned(), span, stage));
            }
            Kind::Steps | Kind::Energy => {
                let at: Timestamp = v[0].parse().ok()?;
                self.day(at)?;
                let value = milli(v[1])?;
                let device = self.device(v[2]);
                let samples = if kind == Kind::Steps {
                    &mut self.steps
                } else {
                    &mut self.energy
                };
                samples.insert((at, device), value);
            }
            Kind::RestingHr | Kind::Hrv => {
                let day = date_of(v[0]).filter(|&d| plausible(d, self.latest))?;
                let value = milli(v[1])?;
                if kind == Kind::RestingHr {
                    self.resting_hr.insert(day, value);
                } else {
                    self.hrv.insert(day, value);
                }
            }
            Kind::HeartRate => self.heart_sample(v[0].parse().ok()?, milli(v[1])?)?,
            Kind::Other => {}
        }
        Some(())
    }

    /// Fold a heart rate sample into its day and its night; `None` when
    /// its day can't be stored or a sum would overflow.
    fn heart_sample(&mut self, at: Timestamp, v: i64) -> Option<()> {
        let day = self.day(at)?;
        let e = self.heart.entry(day).or_insert((0, 0, i64::MAX, i64::MIN));
        *e = (e.0.checked_add(v)?, e.1 + 1, e.2.min(v), e.3.max(v));
        let Some(Sleeps { nights, .. }) = self.nights.as_mut() else {
            return Some(());
        };
        let i = nights.partition_point(|(_, n)| n.span.0 <= at);
        if let Some((_, n)) = i.checked_sub(1).map(|i| &mut nights[i])
            && at <= n.span.1
        {
            n.heart = (n.heart.0.checked_add(v)?, n.heart.1 + 1);
        }
        Some(())
    }

    /// Hand the raw rows read so far to `keep`.
    fn flush(&mut self) -> Result<(), Error> {
        if !self.raw.is_empty() {
            self.records += (self.keep)(&self.raw)?;
            self.raw.clear();
        }
        Ok(())
    }

    /// The nights, from the sleep files read so far (once).
    fn settle_nights(&mut self) {
        if self.nights.is_some() {
            return;
        }
        for (id, span, stage) in std::mem::take(&mut self.stages) {
            if let Some(s) = self.sleeps.get_mut(&id) {
                s.stages.push((span, stage));
            }
        }
        let all = std::mem::take(&mut self.sleeps).into_values().collect();
        self.nights = Some(sleeps(all, IMPORT_KEY_PREFIX, self.tz, self.latest));
    }

    /// Every row of `text`, the file `name` of `kind`.
    ///
    /// # Errors
    /// Not CSV, or a column missing: blamed on `files`, naming the file;
    /// or `keep`'s error.
    fn file(&mut self, kind: Kind, name: &str, text: &str) -> Result<(), Error> {
        let bad = |m: &dyn std::fmt::Display| {
            Error::invalid_field("files", format!("{}: {m}", base(name)))
        };
        let mut csv = csv::ReaderBuilder::new()
            .flexible(true)
            .from_reader(text.as_bytes());
        let head = csv.headers().map_err(|e| bad(&e))?.clone();
        let find = |c: &str| head.iter().position(|h| header(h).eq_ignore_ascii_case(c));
        let at = kind
            .columns()
            .iter()
            .map(|c| find(c).ok_or_else(|| bad(&format!("no {c} column"))))
            .collect::<Result<Vec<_>, _>>()?;
        let raw = if kind == Kind::Other {
            let start = find("timestamp").or_else(|| {
                head.iter()
                    .position(|h| header(h).to_ascii_lowercase().contains("start"))
            });
            let day = start.or_else(|| find("date"));
            Some((Cow::Owned(other_kind(name)), (start, None, day)))
        } else {
            kind.raw().map(|(name, start, end)| {
                (Cow::Borrowed(name), (find(start), end.and_then(find), None))
            })
        };
        let mut record = csv::StringRecord::new();
        while csv.read_record(&mut record).map_err(|e| bad(&e))? {
            if let Some((name, columns)) = &raw {
                self.raw
                    .push(raw_row(name, *columns, &head, &record, self.tz));
                if self.raw.len() >= RAW_BATCH {
                    self.flush()?;
                }
            }
            let v: Vec<&str> = at
                .iter()
                .map(|&i| record.get(i).unwrap_or("").trim())
                .collect();
            if self.row(kind, &v).is_none() {
                self.skipped += 1;
            }
        }
        Ok(())
    }

    /// The days the series, the daily rows and the nights make; days whose
    /// sums overflow and values out of bounds are counted skipped.
    fn days(&mut self, nights: &[(Date, Night)]) -> Vec<DeviceDay> {
        let mut days: BTreeMap<Date, DeviceDay> = BTreeMap::new();
        for (d, n) in nights {
            let (sum, count) = n.heart;
            days.insert(
                *d,
                DeviceDay {
                    sleep_avg_hr: (count > 0).then(|| rounded(sum / count)),
                    ..n.day.clone()
                },
            );
        }
        let mut at = |d: Date, set: &dyn Fn(&mut DeviceDay)| {
            set(days.entry(d).or_insert_with(|| DeviceDay {
                day: d.to_string(),
                ..DeviceDay::default()
            }));
        };
        let (steps, bad_steps) = best(&self.steps, self.tz);
        let (energy, bad_energy) = best(&self.energy, self.tz);
        for (d, v) in steps {
            at(d, &|a| a.steps = Some(rounded(v)));
        }
        for (d, v) in energy {
            at(d, &|a| a.active_kcal = Some(rounded(v)));
        }
        for (&d, &v) in &self.resting_hr {
            at(d, &|a| a.resting_hr = Some(rounded(v)));
        }
        for (&d, &v) in &self.hrv {
            at(d, &|a| a.hrv_ms = Some(rounded(v)));
        }
        for (&d, &(sum, n, lo, hi)) in &self.heart {
            at(d, &|a| {
                (a.avg_hr, a.min_hr, a.max_hr) =
                    (Some(rounded(sum / n)), Some(rounded(lo)), Some(rounded(hi)));
            });
        }
        self.skipped += bad_steps + bad_energy;
        days.into_values()
            .filter_map(|d| {
                let (d, dropped) = d.trimmed();
                self.skipped += u64::from(dropped);
                d.has_value().then_some(d)
            })
            .collect()
    }

    fn finish(mut self) -> Result<(Export, u64), Error> {
        self.flush()?;
        self.settle_nights();
        let Sleeps {
            nights,
            naps,
            skipped,
        } = self.nights.take().unwrap_or_default();
        self.skipped += skipped;
        let days = self.days(&nights);
        let mut workouts: Vec<ImportedWorkout> =
            std::mem::take(&mut self.workouts).into_values().collect();
        workouts.sort_by(|a, b| (&a.start_at, &a.key).cmp(&(&b.start_at, &b.key)));
        Ok((
            Export {
                days,
                workouts,
                naps,
                stages: stages_of(&nights, StageSource::Import),
                skipped: self.skipped,
            },
            self.records,
        ))
    }
}

/// Each day's sum of the device that counted most; and how many days
/// overflowed (left out).
fn best(samples: &HashMap<(Timestamp, u32), i64>, tz: &TimeZone) -> (BTreeMap<Date, i64>, u64) {
    let mut sums: HashMap<(Date, u32), Option<i64>> = HashMap::new();
    for (&(at, device), &v) in samples {
        let day = at.to_zoned(tz.clone()).date();
        let e = sums.entry((day, device)).or_insert(Some(0));
        *e = e.and_then(|s| s.checked_add(v));
    }
    let mut out: BTreeMap<Date, Option<i64>> = BTreeMap::new();
    for ((d, _), v) in sums {
        let e = out.entry(d).or_insert(Some(0));
        *e = e.zip(v).map(|(a, b)| a.max(b));
    }
    let overflowed = out.values().filter(|v| v.is_none()).count();
    (
        out.into_iter().filter_map(|(d, v)| Some((d, v?))).collect(),
        u64::try_from(overflowed).unwrap_or(u64::MAX),
    )
}

/// Read the export's files Kaloriina knows (others are ignored; [`other`]
/// ones are only kept raw), one at a time, heart rate last; the time series fall on days in `tz`. Raw rows go
/// to `keep` as they are read, [`RAW_BATCH`] at a time. The export read,
/// and how many raw rows `keep` found new.
///
/// # Errors
/// None of the files known (400 `files`), or one not readable as CSV with
/// its columns (400 `files`, naming it; the raw rows of the files before it
/// are kept then), or `keep`'s error.
pub fn read<S: Source>(
    files: &[S],
    tz: &TimeZone,
    keep: &mut Keep<'_>,
) -> Result<(Export, u64), Error> {
    let mut known: Vec<(Kind, &S)> = files
        .iter()
        .filter_map(|f| Some((kind(f.name())?, f)))
        .collect();
    if known.is_empty() {
        return Err(Error::invalid_field(
            "files",
            "no Google Health data found: choose the Google Takeout zip with Google Health in it",
        ));
    }
    known.sort_by_key(|(k, _)| *k == Kind::HeartRate);
    let mut reader = Reader {
        tz,
        latest: day_so_far(),
        keep,
        workouts: BTreeMap::new(),
        sleeps: HashMap::new(),
        stages: Vec::new(),
        nights: None,
        steps: HashMap::new(),
        energy: HashMap::new(),
        devices: HashMap::new(),
        resting_hr: BTreeMap::new(),
        hrv: BTreeMap::new(),
        heart: BTreeMap::new(),
        raw: Vec::new(),
        records: 0,
        skipped: 0,
    };
    for (kind, f) in known {
        if kind == Kind::HeartRate {
            reader.settle_nights();
        }
        reader.file(kind, f.name(), &f.text()?)?;
    }
    reader.finish()
}

/// Fill the profile's gaps with what `export` read, in one transaction.
///
/// # Errors
/// A database error; nothing is written then.
pub fn fill(conn: &mut Connection, pid: ProfileId, export: &Export) -> Result<ImportCounts, Error> {
    db::device_fill(
        conn,
        pid,
        &export.days,
        &export.workouts,
        &export.naps,
        &export.stages,
        export.skipped,
    )
}

/// Keep `rows` raw (one transaction); how many weren't there before.
///
/// # Errors
/// A database error; this batch is not written then.
pub fn keep_raw(
    conn: &mut Connection,
    pid: ProfileId,
    rows: &[HealthRecord],
) -> Result<u64, Error> {
    db::records_add(
        conn,
        pid,
        GOOGLE_HEALTH,
        rows,
        Timestamp::now().as_millisecond(),
    )
}

/// Read `files` keeping their rows raw as they come ([`RAW_BATCH`] a
/// transaction), then fill the profile's gaps with them (one transaction):
/// the CLI's import.
///
/// # Errors
/// As [`read`], or a database error.
pub fn import<S: Source>(
    conn: &mut Connection,
    pid: ProfileId,
    files: &[S],
    tz: &TimeZone,
) -> Result<ImportCounts, Error> {
    let (export, records) = read(files, tz, &mut |rows| keep_raw(conn, pid, rows))?;
    let mut counts = fill(conn, pid, &export)?;
    counts.records = records;
    Ok(counts)
}

/// The files Kaloriina reads in the folders a Takeout export was extracted
/// to (searched through; symbolic links to folders aren't followed), in
/// path order.
///
/// # Errors
/// A path that isn't a folder (a zip: extract it), or one unreadable.
pub fn files_at(folders: &[PathBuf]) -> anyhow::Result<Vec<PathBuf>> {
    use anyhow::Context;
    let mut out = Vec::new();
    for folder in folders {
        anyhow::ensure!(
            folder.is_dir(),
            "{} is not a folder: extract the Takeout zip and pass the folder",
            folder.display()
        );
        let mut dirs = vec![folder.clone()];
        while let Some(dir) = dirs.pop() {
            for entry in
                std::fs::read_dir(&dir).with_context(|| format!("reading {}", dir.display()))?
            {
                let entry = entry?;
                let p = entry.path();
                if entry.file_type()?.is_dir() {
                    dirs.push(p);
                } else if p.to_str().is_some_and(wanted) {
                    out.push(p);
                }
            }
        }
    }
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SleepStageKind;
    use jiff::tz::Offset;

    #[test]
    fn a_nameless_session_is_an_activity() {
        // As the phone names one: "Workout" is the set-based type only.
        assert_eq!(label(" \u{7} "), "Activity");
        assert_eq!(label(" Run "), "Run");
    }

    fn file(name: &str, text: &str) -> File {
        File {
            name: format!("Takeout/Google Health/{name}"),
            text: text.to_owned(),
        }
    }

    const EXERCISES: &str = "exercise_id,exercise_start,exercise_end,utc_offset,activity_name,deletion_reason,manually_logged_total_calories,tracker_total_calories,manually_logged_total_distance_mm,tracker_total_distance_mm,activity_type_probabilities\n";

    /// What `files` read in `tz`, and the raw rows handed out.
    fn read_in(files: &[File], tz: &TimeZone) -> (Export, Vec<HealthRecord>) {
        let mut raw = Vec::new();
        let (e, _) = read(files, tz, &mut |rows| {
            raw.extend_from_slice(rows);
            Ok(0)
        })
        .unwrap();
        (e, raw)
    }

    fn read_utc(files: &[File]) -> Export {
        read_in(files, &TimeZone::UTC).0
    }

    #[test]
    fn workouts_take_their_own_offset_and_the_kept_values() {
        let text = format!(
            "{EXERCISES}\
             11,2026-09-04T22:10:00Z,2026-09-04T22:50:00Z,+03:00,Outdoor Walk,UNSPECIFIED,120,90,2400000,0,\"[ActivityName: Hike, Probability: 0.5],[ActivityName: Rucking, Probability: 0.5]\"\n\
             12,2026-09-05T08:00:00Z,2026-09-05T09:00:00Z,+03:00,Calisthenics,,,568,,,\n\
             13,2026-09-05T10:00:00Z,2026-09-05T10:00:30Z,+03:00,Activity,UNSPECIFIED,,,,,\n\
             14,2026-09-05T11:00:00Z,2026-09-05T11:30:00Z,+03:00,Zumba,USER_DELETED,,,,,\n\
             15,yesterday,2026-09-05T11:30:00Z,+03:00,Zumba,,,,,,\n\
             16,2026-09-06T06:00:00Z,2026-09-06T06:45:00Z,,Treadmill Run,,,99999,,,\n"
        );
        let e = read_utc(&[file("UserExercises_2026-05-31.csv", &text)]);
        assert_eq!(e.skipped, 1);
        let got: Vec<_> = e
            .workouts
            .iter()
            .map(|w| (w.key.as_str(), w.day.as_str(), w.kind, w.kcal, w.distance_m))
            .collect();
        assert_eq!(
            got,
            [
                // After 21:00 UTC at +03:00: the next day.
                (
                    "gh-11",
                    "2026-09-05",
                    ActivityType::Walk,
                    Some(120),
                    Some(2400)
                ),
                (
                    "gh-12",
                    "2026-09-05",
                    ActivityType::Workout,
                    Some(568),
                    None
                ),
                // No offset: the time zone's day; energy out of bounds.
                ("gh-16", "2026-09-06", ActivityType::Run, None, None),
            ]
        );
        assert_eq!(e.workouts[0].start_at, "2026-09-04T22:10:00Z");
        assert!(e.days.is_empty());
    }

    const SLEEPS: &str = "sleep_id,sleep_type,sleep_start,sleep_end,start_utc_offset,end_utc_offset,data_source,algorithm_version\n";
    const STAGES: &str = "sleep_id,sleep_stage_type,sleep_stage_start,sleep_stage_end\n";

    #[test]
    fn activity_names_give_their_type() {
        for (name, kind) in [
            ("Running", ActivityType::Run),
            ("Strength training", ActivityType::Workout),
            ("HIIT", ActivityType::Hiit),
            ("Rowing machine", ActivityType::Rowing),
            ("Cross-country skiing", ActivityType::Ski),
            ("Badminton", ActivityType::Other),
            ("Workout", ActivityType::Workout),
            ("Aerobic workout", ActivityType::Workout),
        ] {
            assert_eq!(session_kind(name), kind, "{name}");
        }
    }

    #[test]
    fn a_night_is_its_newest_version_and_later_sleeps_are_naps() {
        let sleeps = format!(
            "{SLEEPS}\
             1,STAGES,2026-09-05T22:00:00Z,2026-09-06T06:00:00Z,+03:00,+03:00,DERIVED,sleep_session_v1\n\
             2,STAGES,2026-09-05T22:10:00Z,2026-09-06T05:40:00Z,+03:00,+03:00,DERIVED,sleep_session_v2\n\
             3,CLASSIC,2026-09-06T07:00:00Z,2026-09-06T08:00:00Z,+03:00,+03:00,DERIVED,sleep_session_v1\n\
             4,CLASSIC,2026-09-06T13:00:00Z,2026-09-06T14:00:00Z,+03:00,+03:00,DERIVED,sleep_session_v1\n"
        );
        let stages = format!(
            "{STAGES}\
             1,DEEP,2026-09-05T22:00:00Z,2026-09-06T06:00:00Z\n\
             2,AWAKE,2026-09-05T22:10:00Z,2026-09-05T22:30:00Z\n\
             2,DEEP,2026-09-05T22:30:00Z,2026-09-06T00:00:00Z\n\
             2,REM,2026-09-06T00:00:00Z,2026-09-06T01:00:00Z\n\
             2,LIGHT,2026-09-06T01:00:00Z,2026-09-06T05:40:00Z\n\
             3,RESTLESS,2026-09-06T07:00:00Z,2026-09-06T07:10:00Z\n\
             3,ASLEEP,2026-09-06T07:10:00Z,2026-09-06T08:00:00Z\n"
        );
        let e = read_utc(&[
            file("UserSleeps_2026-05-31.csv", &sleeps),
            file("UserSleepStages_2026-05-31.csv", &stages),
        ]);
        // v2 (450 min) is the night; the sleep 80 min after it (≥ an hour
        // after a night) and the afternoon one are naps, not its end.
        assert_eq!(
            e.days,
            [DeviceDay {
                day: "2026-09-06".into(),
                in_bed_min: Some(450),
                asleep_min: Some(430),
                bedtime: Some("01:10".into()),
                wake_time: Some("08:40".into()),
                deep_min: Some(90),
                rem_min: Some(60),
                light_min: Some(280),
                ..DeviceDay::default()
            }]
        );
        let naps: Vec<_> = e
            .naps
            .iter()
            .map(|n| (n.key.as_str(), n.asleep_min))
            .collect();
        // The morning nap less its 10 restless (awake) minutes; the other
        // has no stages.
        assert_eq!(naps, [("gh-3", Some(50)), ("gh-4", None)]);
    }

    #[test]
    fn rows_are_kept_raw_whole_and_short_sleeps_are_naps() {
        let text = format!(
            "{EXERCISES}\
             11,2026-09-04T22:10:00Z,2026-09-04T22:50:00Z,+03:00,Outdoor Walk,UNSPECIFIED,120,,,,\"[ActivityName: Hike, Probability: 0.5]\"\n\
             14,2026-09-05T11:00:00Z,2026-09-05T11:30:00Z,+03:00,Zumba,USER_DELETED,,,,,\n"
        );
        let sleeps = format!(
            "{SLEEPS}\
             4,CLASSIC,2026-09-06T13:00:00Z,2026-09-06T14:00:00Z,+03:00,+03:00,DERIVED,sleep_session_v1\n"
        );
        let (e, raw) = read_in(
            &[
                file("UserExercises_2026-05-31.csv", &text),
                file("UserSleeps_2026-05-31.csv", &sleeps),
                file(
                    "steps_2026-09-01.csv",
                    "timestamp,steps,data source\n2026-09-02T10:00:00Z,100,x\n",
                ),
            ],
            &TimeZone::UTC,
        );
        // Every row of the non-series files, deleted ones too; no steps.
        let kinds: Vec<&str> = raw.iter().map(|r| r.kind.as_str()).collect();
        assert_eq!(kinds, ["UserExercises", "UserExercises", "UserSleeps"]);
        let walk: serde_json::Value = serde_json::from_str(&raw[0].data).unwrap();
        assert_eq!(
            walk["activity_type_probabilities"],
            "[ActivityName: Hike, Probability: 0.5]"
        );
        assert_eq!(walk["deletion_reason"], "UNSPECIFIED");
        assert_eq!(
            (
                raw[0].start_at.as_deref(),
                raw[0].end_at.as_deref(),
                raw[0].day.as_deref()
            ),
            (
                Some("2026-09-04T22:10:00Z"),
                Some("2026-09-04T22:50:00Z"),
                Some("2026-09-04")
            )
        );
        // Ids: the same row, the same id; another row, another.
        let (_, again) = read_in(
            &[file("UserExercises_2026-05-31.csv", &text)],
            &TimeZone::UTC,
        );
        assert_eq!(again[0].id, raw[0].id);
        assert_ne!(raw[0].id, raw[1].id);
        assert_eq!(raw[0].id.len(), 32);
        // An hour's sleep alone: a nap of its wake day, not a night.
        assert!(e.days.iter().all(|d| d.in_bed_min.is_none()));
        assert_eq!(
            e.naps,
            [NapIn {
                day: "2026-09-06".into(),
                key: "gh-4".into(),
                start_at: "2026-09-06T13:00:00Z".into(),
                end_at: "2026-09-06T14:00:00Z".into(),
                asleep_min: None,
            }]
        );
    }

    #[test]
    fn a_nights_stages_and_the_heart_rate_are_projected() {
        let sleeps = format!(
            "{SLEEPS}\
             1,STAGES,2026-09-05T22:00:00Z,2026-09-06T06:00:00Z,+03:00,+03:00,DERIVED,sleep_session_v1\n\
             2,STAGES,2026-09-05T22:10:00Z,2026-09-06T05:40:00Z,+03:00,+03:00,DERIVED,sleep_session_v2\n"
        );
        let stages = format!(
            "{STAGES}\
             1,DEEP,2026-09-05T22:00:00Z,2026-09-06T06:00:00Z\n\
             2,RESTLESS,2026-09-05T22:00:00Z,2026-09-05T22:30:00Z\n\
             2,DEEP,2026-09-05T22:30:00Z,2026-09-06T00:00:00Z\n\
             2,ASLEEP,2026-09-06T00:00:00Z,2026-09-06T05:40:00Z\n"
        );
        let heart = "timestamp,beats per minute,data source\n\
            2026-09-05T23:00:00Z,50,Google Fitbit Air\n\
            2026-09-06T03:00:00Z,60.4,Google Fitbit Air\n\
            2026-09-06T12:00:00Z,100,Google Fitbit Air\n\
            2026-09-06T15:00:00Z,90,Google Fitbit Air\n";
        let e = read_utc(&[
            file("UserSleeps_2026-05-31.csv", &sleeps),
            file("UserSleepStages_2026-05-31.csv", &stages),
            file("Heart Rate/heart_rate_2026-09-01.csv", heart),
        ]);
        // The kept version's stages only, clipped to its night (the restless
        // span began before it), on the wake day.
        let spans: Vec<_> = e
            .stages
            .iter()
            .map(|s| {
                (
                    s.day.as_str(),
                    s.start_at.as_str(),
                    s.end_at.as_str(),
                    s.stage,
                )
            })
            .collect();
        assert_eq!(
            spans,
            [
                (
                    "2026-09-06",
                    "2026-09-05T22:10:00Z",
                    "2026-09-05T22:30:00Z",
                    SleepStageKind::Awake
                ),
                (
                    "2026-09-06",
                    "2026-09-05T22:30:00Z",
                    "2026-09-06T00:00:00Z",
                    SleepStageKind::Deep
                ),
                (
                    "2026-09-06",
                    "2026-09-06T00:00:00Z",
                    "2026-09-06T05:40:00Z",
                    SleepStageKind::Unknown
                ),
            ]
        );
        assert!(e.stages.iter().all(|s| s.source == StageSource::Import));
        // The day's samples in the zone; the night's over its span.
        let heart: Vec<_> = e
            .days
            .iter()
            .map(|d| (d.day.as_str(), d.avg_hr, d.min_hr, d.max_hr, d.sleep_avg_hr))
            .collect();
        assert_eq!(
            heart,
            [
                ("2026-09-05", Some(50), Some(50), Some(50), None),
                ("2026-09-06", Some(83), Some(60), Some(100), Some(55)),
            ]
        );
        // `heart_rate_variability_…` is another file.
        assert!(wanted("a/heart_rate_2026-09-01.csv"));
        assert!(!wanted("a/heart_rate_variability_2026-09-01.csv"));
        // Kept raw instead, under a kind that may be stored.
        let long = format!("x_GoogleData/{}.csv", "Sleep Score ".repeat(9));
        assert!(crate::model::is_kind(&other_kind(&long)));
        assert_eq!(
            other_kind("Health Fitness Data_GoogleData/User-Sleep Scores_2026-05-31_2.csv"),
            "gh_User_Sleep_Scores"
        );
    }

    #[test]
    fn days_take_the_device_that_counted_most() {
        let steps = "timestamp,steps,data source\n\
            2026-09-02T10:00:00Z,100,Phone Health Connect\n\
            2026-09-02T10:00:30.5Z,250,Phone Health Connect\n\
            2026-09-02T10:01:00Z,300,Google Fitbit Air\n\
            2026-09-02T23:30:00Z,7,Google Fitbit Air\n\
            nonsense,1,Google Fitbit Air\n";
        let energy = "timestamp,Kilocalories,data source\n\
            2026-09-02T10:00:00Z,1.5,Google Health App\n\
            2026-09-02T10:01:00Z,0.7192140000000001,Google Health App\n";
        let rhr = "timestamp,beats per minute,data source\n2026-09-02T00:00:00Z,56.5,Google Health App\n2026-09-03T00:00:00Z,7,x\n";
        let hrv = "timestamp,average heart rate variability milliseconds,non rem heart rate beats per minute\n2026-09-02T00:00:00Z,64.7,56.6\n";
        let helsinki = TimeZone::posix("EET-2EEST,M3.5.0/3,M10.5.0/4").unwrap();
        let (e, _) = read_in(
            &[
                file(
                    "Physical Activity_GoogleData/Steps/steps_2026-09-01.csv",
                    steps,
                ),
                file("x/active_energy_burned_2026-09-01.csv", energy),
                file("daily_resting_heart_rate.csv", rhr),
                file("daily_heart_rate_variability.csv", hrv),
                file("Global Export Data/steps-2026-09-01.json", "[]"),
            ],
            &helsinki,
        );
        let day = |d: &str, kcal, steps, rhr, hrv| DeviceDay {
            day: d.into(),
            active_kcal: kcal,
            steps,
            resting_hr: rhr,
            hrv_ms: hrv,
            ..DeviceDay::default()
        };
        assert_eq!(
            e.days,
            [
                // Phone 350 against the device's 300.
                day("2026-09-02", Some(2), Some(350), Some(57), Some(65)),
                // 23:30 UTC is the next day in Helsinki; a resting heart rate
                // of 7 is dropped.
                day("2026-09-03", None, Some(7), None, None),
            ]
        );
        // The bad timestamp and the dropped value.
        assert_eq!(e.skipped, 2);
    }

    /// The 25-hour day daylight saving time ends on. 00:30 EEST
    /// and 23:30 EET are both 2025-10-26 in Helsinki.
    #[test]
    fn a_days_samples_follow_the_zone_across_the_clock_change() {
        let steps = "timestamp,steps,data source\n\
            2025-10-25T21:30:00Z,10,Phone\n\
            2025-10-26T21:30:00Z,20,Phone\n";
        let helsinki = TimeZone::get("Europe/Helsinki").unwrap();
        let (e, _) = read_in(
            &[file(
                "Physical Activity_GoogleData/Steps/steps_2025-10-25.csv",
                steps,
            )],
            &helsinki,
        );
        let days: Vec<_> = e.days.iter().map(|d| (d.day.as_str(), d.steps)).collect();
        assert_eq!(days, [("2025-10-26", Some(30))]);
    }

    #[test]
    fn folders_give_the_wanted_files_and_a_link_loop_ends() {
        let tmp = std::env::temp_dir().join(format!("kaloriina-gh-{}", std::process::id()));
        let folder = tmp.join("Takeout/Google Health/Steps");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("steps_2026-10-01.csv"), "timestamp,steps\n").unwrap();
        std::fs::write(folder.join("readme.txt"), "x").unwrap();
        // A link back up: followed, it never ends.
        std::os::unix::fs::symlink(&tmp, folder.join("loop")).unwrap();
        let second = tmp.join("part-2");
        std::fs::create_dir_all(&second).unwrap();
        std::fs::write(second.join("daily_resting_heart_rate.csv"), "timestamp\n").unwrap();
        let found = files_at(&[tmp.join("Takeout"), second.clone()]).unwrap();
        let not_folder = files_at(&[folder.join("readme.txt")])
            .unwrap_err()
            .to_string();
        std::fs::remove_dir_all(&tmp).unwrap();
        let names: Vec<&str> = found.iter().map(|p| base(p.name())).collect();
        assert_eq!(
            names,
            ["steps_2026-10-01.csv", "daily_resting_heart_rate.csv"]
        );
        assert!(not_folder.contains("not a folder"), "{not_folder}");
    }

    #[test]
    fn crunches_is_not_a_run() {
        for (name, kind) in [
            ("Crunches", ActivityType::Other),
            ("Skipping rope", ActivityType::Other),
            ("Treadmill Run", ActivityType::Run),
            ("Mountain biking", ActivityType::Cycling),
            ("Ski", ActivityType::Ski),
        ] {
            assert_eq!(session_kind(name), kind, "{name}");
        }
    }

    #[test]
    fn naps_are_per_session_and_long_blocks_are_skipped() {
        // 13:00–14:00 and 15:30–16:30 are one block (≤ 2 h apart) of 120 min
        // in bed: two naps, not one of 210 min. A 25 h session is no sleep.
        let sleeps = format!(
            "{SLEEPS}\
             1,CLASSIC,2026-09-06T13:00:00Z,2026-09-06T14:00:00Z,+00:00,+00:00,DERIVED,sleep_session_v1\n\
             2,CLASSIC,2026-09-06T15:30:00Z,2026-09-06T16:30:00Z,+00:00,+00:00,DERIVED,sleep_session_v1\n\
             3,CLASSIC,2026-09-01T00:00:00Z,2026-09-02T01:00:00Z,+00:00,+00:00,DERIVED,sleep_session_v1\n"
        );
        let e = read_utc(&[file("UserSleeps_2026-05-31.csv", &sleeps)]);
        let naps: Vec<_> = e
            .naps
            .iter()
            .map(|n| (n.key.as_str(), n.start_at.as_str(), n.end_at.as_str()))
            .collect();
        assert_eq!(
            naps,
            [
                ("gh-1", "2026-09-06T13:00:00Z", "2026-09-06T14:00:00Z"),
                ("gh-2", "2026-09-06T15:30:00Z", "2026-09-06T16:30:00Z"),
            ]
        );
        assert!(e.days.is_empty());
        assert_eq!(e.skipped, 1);
    }

    #[test]
    fn overlapping_naps_merge_unless_another_version() {
        // Two sources of one nap, partly overlapping: one nap over both,
        // keyed by the first. Another algorithm's version: the newest only.
        let sleeps = format!(
            "{SLEEPS}\
             a,CLASSIC,2026-09-06T11:00:00Z,2026-09-06T11:40:00Z,+00:00,+00:00,DERIVED,sleep_session_v1\n\
             b,CLASSIC,2026-09-06T11:20:00Z,2026-09-06T12:00:00Z,+00:00,+00:00,DERIVED,sleep_session_v1\n\
             c,CLASSIC,2026-09-07T11:00:00Z,2026-09-07T11:40:00Z,+00:00,+00:00,DERIVED,sleep_session_v1\n\
             d,CLASSIC,2026-09-07T11:20:00Z,2026-09-07T12:00:00Z,+00:00,+00:00,DERIVED,sleep_session_v2\n"
        );
        let e = read_utc(&[file("UserSleeps_2026-05-31.csv", &sleeps)]);
        let naps: Vec<_> = e
            .naps
            .iter()
            .map(|n| (n.key.as_str(), n.start_at.as_str(), n.end_at.as_str()))
            .collect();
        assert_eq!(
            naps,
            [
                ("gh-a", "2026-09-06T11:00:00Z", "2026-09-06T12:00:00Z"),
                ("gh-d", "2026-09-07T11:20:00Z", "2026-09-07T12:00:00Z"),
            ]
        );
    }

    #[test]
    fn a_workout_ending_before_it_starts_is_skipped() {
        let text = format!(
            "{EXERCISES}\
             1,2026-09-05T11:00:00Z,2026-09-05T10:00:00Z,+03:00,Walk,,,,,,\n"
        );
        let e = read_utc(&[file("UserExercises_2026-05-31.csv", &text)]);
        assert_eq!((e.workouts.len(), e.skipped), (0, 1));
    }

    #[test]
    fn files_are_checked() {
        let err = |files: &[File]| {
            read(files, &TimeZone::UTC, &mut |_| Ok(0))
                .unwrap_err()
                .to_string()
        };
        assert!(
            err(&[file("Global Export Data/exercise-0.json", "[]")])
                .contains("no Google Health data")
        );
        assert!(
            err(&[file(
                "UserExercises_2026-05-31.csv",
                "exercise_id,exercise_start\n1,2\n"
            )])
            .contains("UserExercises_2026-05-31.csv: no exercise_end column")
        );
        assert_eq!(
            [
                milli("62.343"),
                milli("7"),
                milli("1.5"),
                milli("-1"),
                milli("1e3"),
                milli(".5")
            ],
            [Some(62343), Some(7000), Some(1500), None, None, None]
        );
        assert_eq!(offset("+3:0"), Offset::from_seconds(10_800).ok());
        assert_eq!(offset("-05:30"), Offset::from_seconds(-19_800).ok());
        assert_eq!(offset("+999999999:00"), None);
    }
}
