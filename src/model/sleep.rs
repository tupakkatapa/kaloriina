//! The night rule (ADR 0032): sleep sessions as nights, naps and stage
//! spans. Sessions ≤ [`SLEEP_JOIN_S`] apart are one block; a block ≥
//! [`NIGHT_MIN_MIN`] in bed is a night filed under its wake day, minutes
//! are interval unions, its stage spans clipped to it. A session under a
//! night long, ≥ [`SLEEP_SPLIT_S`] after a block already a night, starts a
//! block of its own (a nap after waking). A block too short for a night
//! ending before [`NIGHT_PART_END_MIN`] on the wake day of the night after
//! it is that night's start. A second night on a wake day (the shorter) is
//! skipped and counted. Each session of a block too short for a night is
//! a nap on its wake day; a block over [`IN_BED_MAX_MIN`] is neither.
//!
//! One rule, two inputs: a Google Takeout export's sleep files
//! (`google_health`) and Health Connect's raw `SleepSession` records, which
//! the server alone turns into nights (`db::nights_derive`). Pure: no IO.

use std::collections::{BTreeMap, BTreeSet};

use jiff::civil::Date;
use jiff::tz::{Offset, TimeZone};
use jiff::{Timestamp, Zoned};

use super::{
    DeviceDay, IN_BED_MAX_MIN, NIGHT_MIN_MIN, NIGHT_PART_END_MIN, NapIn, SLEEP_JOIN_S,
    SLEEP_SPLIT_S, SleepStage, SleepStageKind, StageSource, checked_nap, day_so_far, is_date,
    mean_rounded,
};

/// `+03:00` (also `+3:0`, `Z`); `None` when it doesn't read or is out of
/// range.
pub(crate) fn offset(s: &str) -> Option<Offset> {
    if s == "Z" {
        return Some(Offset::UTC);
    }
    let (sign, rest) = match s.as_bytes().first()? {
        b'+' => (1, &s[1..]),
        b'-' => (-1, &s[1..]),
        _ => return None,
    };
    let (h, m) = rest.split_once(':').unwrap_or((rest, "0"));
    let seconds = h
        .parse::<i32>()
        .ok()?
        .checked_mul(3600)?
        .checked_add(m.parse::<i32>().ok()?.checked_mul(60)?)?;
    Offset::from_seconds(sign * seconds).ok()
}

/// `at` in its own offset when the export gave one, else in `tz`.
pub(crate) fn local(at: Timestamp, off: Option<Offset>, tz: &TimeZone) -> Zoned {
    at.to_zoned(off.map_or_else(|| tz.clone(), TimeZone::fixed))
}

pub(crate) fn clock(z: &Zoned) -> String {
    format!("{:02}:{:02}", z.hour(), z.minute())
}

/// Whether `day` may be stored: a four-digit year, not after
/// [`day_so_far`] (`latest`).
pub(crate) fn plausible(day: Date, latest: Date) -> bool {
    day <= latest && is_date(&day.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Stage {
    /// Awake or restless: in bed, not asleep.
    Awake,
    Light,
    Deep,
    Rem,
    Asleep,
}

pub(crate) type Span = (Timestamp, Timestamp);

#[derive(Debug, Clone)]
pub(crate) struct Sleep {
    pub(crate) id: String,
    pub(crate) span: Span,
    pub(crate) offsets: (Option<Offset>, Option<Offset>),
    /// Hand-entered first, then the newest algorithm.
    pub(crate) rank: (bool, u32),
    pub(crate) stages: Vec<(Span, Stage)>,
    /// The mean heart rate over it (whole bpm), when its source measured
    /// one: the phone's aggregate, kept with Health Connect's record
    /// (`avg_bpm`).
    pub(crate) bpm: Option<i64>,
}

/// Whole minutes the union of `spans` covers (overlaps count once).
pub(crate) fn union_minutes(mut spans: Vec<Span>) -> i64 {
    spans.retain(|(a, b)| b > a);
    spans.sort();
    let mut seconds = 0;
    let mut open: Option<Span> = None;
    for (a, b) in spans {
        open = match open {
            Some((from, to)) if a <= to => Some((from, to.max(b))),
            Some((from, to)) => {
                seconds += to.as_second() - from.as_second();
                Some((a, b))
            }
            None => Some((a, b)),
        };
    }
    if let Some((from, to)) = open {
        seconds += to.as_second() - from.as_second();
    }
    (seconds + 30).div_euclid(60)
}

/// A night read from the export: its sleep fields, its span, its stage
/// spans (clipped to it) and its heart rate samples' sum and count.
pub(crate) struct Night {
    pub(crate) day: DeviceDay,
    pub(crate) span: Span,
    pub(crate) stages: Vec<(Span, Stage)>,
    pub(crate) heart: (i64, i64),
}

/// The night a block of sleep sessions (≥ [`NIGHT_MIN_MIN`] in bed) makes:
/// its wake day and the night.
fn night(block: &[Sleep], in_bed: i64, tz: &TimeZone) -> Option<(Date, Night)> {
    let start = block.iter().map(|s| s.span.0).min()?;
    let last = block.iter().max_by_key(|s| s.span.1)?;
    let end = last.span.1;
    let first = block.iter().find(|s| s.span.0 == start)?;
    let stages = || {
        block
            .iter()
            .flat_map(|s| &s.stages)
            .map(|&((a, b), st)| ((a.max(start), b.min(end)), st))
    };
    let union =
        |want: Stage| union_minutes(stages().filter(|s| s.1 == want).map(|s| s.0).collect());
    let has_stages = stages().any(|(_, st)| matches!(st, Stage::Light | Stage::Deep | Stage::Rem));
    let staged_minutes = |want| has_stages.then(|| union(want));
    let bed = local(start, first.offsets.0, tz);
    let wake = local(end, last.offsets.1, tz);
    let day = wake.date();
    // The sessions' heart rate, each weighted by its length.
    let (beats, seconds) = block
        .iter()
        .filter_map(|s| {
            let secs = s.span.1.as_second() - s.span.0.as_second();
            Some((s.bpm? * secs, secs))
        })
        .fold((0, 0), |(b, t), (x, y)| (b + x, t + y));
    let sleep_avg_hr = mean_rounded(beats, seconds);
    Some((
        day,
        Night {
            day: DeviceDay {
                day: day.to_string(),
                in_bed_min: Some(in_bed),
                asleep_min: Some((in_bed - union(Stage::Awake)).max(0)),
                bedtime: Some(clock(&bed)),
                wake_time: Some(clock(&wake)),
                deep_min: staged_minutes(Stage::Deep),
                rem_min: staged_minutes(Stage::Rem),
                light_min: staged_minutes(Stage::Light),
                sleep_avg_hr,
                ..DeviceDay::default()
            },
            span: (start, end),
            stages: stages().filter(|((a, b), _)| b > a).collect(),
            heart: (0, 0),
        },
    ))
}

/// The naps a block too short for a night makes: one a session, sessions
/// that overlap one (keyed by the first, after `prefix`), each on its wake
/// day; and how many fell on a day that can't be stored.
fn naps(block: &[Sleep], prefix: &str, tz: &TimeZone, latest: Date) -> (Vec<NapIn>, u64) {
    // (first, the one ending last, the merged span)
    let mut spans: Vec<(&Sleep, &Sleep, Span)> = Vec::new();
    for s in block {
        match spans.last_mut() {
            Some((_, last, span)) if s.span.0 < span.1 => {
                if s.span.1 > span.1 {
                    (*last, span.1) = (s, s.span.1);
                }
            }
            _ => spans.push((s, s, s.span)),
        }
    }
    let (mut out, mut skipped) = (Vec::new(), 0);
    for (first, last, (start, end)) in spans {
        // The merged sessions' stages: those starting inside the span.
        let stages: Vec<(Span, Stage)> = block
            .iter()
            .filter(|s| s.span.0 >= start && s.span.0 < end)
            .flat_map(|s| s.stages.iter().copied())
            .collect();
        let day = local(end, last.offsets.1, tz).date();
        if !plausible(day, latest) {
            skipped += 1;
            continue;
        }
        // As a night's: the span less its awake stages; without stages
        // only time in bed is known.
        let asleep_min = (!stages.is_empty()).then(|| {
            let awake = stages
                .iter()
                .filter(|(_, st)| *st == Stage::Awake)
                .map(|&((a, b), _)| (a.max(start), b.min(end)))
                .collect();
            (union_minutes(vec![(start, end)]) - union_minutes(awake)).max(0)
        });
        // Under a minute (or none) is no nap.
        out.extend(checked_nap(NapIn {
            day: day.to_string(),
            key: format!("{prefix}{}", first.id),
            start_at: start.to_string(),
            end_at: end.to_string(),
            asleep_min,
        }));
    }
    (out, skipped)
}

/// One version of each sleep: a session overlapping a better ranked one
/// (another algorithm's version of it) is left out; equally ranked ones
/// (two sources) stay, to be merged. Oldest first.
fn versions(mut sleeps: Vec<Sleep>) -> Vec<Sleep> {
    sleeps.sort_by(|a, b| b.rank.cmp(&a.rank).then(a.span.cmp(&b.span)));
    // The better ranks' spans, merged: disjoint, so only the one starting
    // last before a session's end can overlap it.
    let mut better: BTreeMap<Timestamp, Timestamp> = BTreeMap::new();
    let mut kept: Vec<Sleep> = Vec::new();
    let mut rank_from = 0;
    for s in sleeps {
        if kept.get(rank_from).is_some_and(|k| k.rank != s.rank) {
            for k in &kept[rank_from..] {
                merge(&mut better, k.span);
            }
            rank_from = kept.len();
        }
        let overlaps = better
            .range(..s.span.1)
            .next_back()
            .is_some_and(|(_, &end)| end > s.span.0);
        if !overlaps {
            kept.push(s);
        }
    }
    kept.sort_by(|a, b| a.span.cmp(&b.span).then_with(|| a.id.cmp(&b.id)));
    kept
}

/// Add `span` to the disjoint spans `set`, merging what it overlaps.
fn merge(set: &mut BTreeMap<Timestamp, Timestamp>, (mut start, mut end): Span) {
    while let Some((&a, &b)) = set.range(..=end).next_back() {
        if b < start {
            break;
        }
        set.remove(&a);
        (start, end) = (start.min(a), end.max(b));
    }
    set.insert(start, end);
}

/// What the sleep files make: each wake day's night (the longest, when
/// several), oldest first; the naps; and blocks skipped (too long, or a
/// day or nap out of range).
#[derive(Default)]
pub(crate) struct Sleeps {
    pub(crate) nights: Vec<(Date, Night)>,
    pub(crate) naps: Vec<NapIn>,
    pub(crate) skipped: u64,
}

/// A block's minutes in bed: the union of its sessions.
fn in_bed(block: &[Sleep]) -> i64 {
    union_minutes(block.iter().map(|s| s.span).collect())
}

/// Whether `part`, too short for a night, is the start of `night`, the
/// block after it: it ends before [`NIGHT_PART_END_MIN`] on the night's
/// wake day.
fn starts_night(part: &[Sleep], night: &[Sleep], tz: &TimeZone) -> bool {
    let woke = |b: &[Sleep]| {
        b.iter()
            .max_by_key(|s| s.span.1)
            .map(|s| local(s.span.1, s.offsets.1, tz))
    };
    let (Some(a), Some(b)) = (woke(part), woke(night)) else {
        return false;
    };
    in_bed(part) < NIGHT_MIN_MIN
        && (NIGHT_MIN_MIN..=IN_BED_MAX_MIN).contains(&in_bed(night))
        && a.date() == b.date()
        && i64::from(a.hour()) * 60 + i64::from(a.minute()) < NIGHT_PART_END_MIN
}

/// Sleep sessions as nights and naps (the module's rule, the phone's);
/// naps are keyed `prefix` and their first session's id.
pub(crate) fn sleeps(sleeps: Vec<Sleep>, prefix: &str, tz: &TimeZone, latest: Date) -> Sleeps {
    let mut blocks: Vec<Vec<Sleep>> = Vec::new();
    let mut end = i64::MIN;
    for s in versions(sleeps) {
        let gap = s.span.0.as_second().saturating_sub(end);
        // A short sleep a while after a night is a nap, not the night's
        // end (its wake time stays the night's).
        let after_night = |b: &[Sleep]| {
            gap >= SLEEP_SPLIT_S
                && union_minutes(vec![s.span]) < NIGHT_MIN_MIN
                && union_minutes(b.iter().map(|s| s.span).collect()) >= NIGHT_MIN_MIN
        };
        match blocks.last_mut() {
            Some(b) if gap <= SLEEP_JOIN_S && !after_night(b) => {
                end = end.max(s.span.1.as_second());
                b.push(s);
            }
            _ => {
                end = s.span.1.as_second();
                blocks.push(vec![s]);
            }
        }
    }
    let mut i = 0;
    while i + 1 < blocks.len() {
        if starts_night(&blocks[i], &blocks[i + 1], tz) {
            let part = blocks.remove(i);
            blocks[i].splice(0..0, part);
        } else {
            i += 1;
        }
    }
    let mut out = Sleeps::default();
    let mut nights: BTreeMap<Date, Night> = BTreeMap::new();
    for b in &blocks {
        let in_bed = in_bed(b);
        if in_bed > IN_BED_MAX_MIN {
            out.skipped += 1;
        } else if in_bed >= NIGHT_MIN_MIN {
            match night(b, in_bed, tz) {
                Some((day, n)) if plausible(day, latest) => {
                    // Two nights ending one day: the longer is the day's,
                    // the other skipped and counted, never lost unsaid.
                    if nights.contains_key(&day) {
                        out.skipped += 1;
                    }
                    if nights
                        .get(&day)
                        .is_none_or(|o| o.day.in_bed_min < n.day.in_bed_min)
                    {
                        nights.insert(day, n);
                    }
                }
                _ => out.skipped += 1,
            }
        } else {
            let (naps, skipped) = naps(b, prefix, tz, latest);
            out.naps.extend(naps);
            out.skipped += skipped;
        }
    }
    out.nights = nights.into_iter().collect();
    out
}

/// The nights' stage spans from `source`, one per start (overlapping stage
/// rows of one night).
pub(crate) fn stages_of(nights: &[(Date, Night)], source: StageSource) -> Vec<SleepStage> {
    let kind = |st: Stage| match st {
        Stage::Awake => SleepStageKind::Awake,
        Stage::Light => SleepStageKind::Light,
        Stage::Deep => SleepStageKind::Deep,
        Stage::Rem => SleepStageKind::Rem,
        Stage::Asleep => SleepStageKind::Unknown,
    };
    let mut stages: Vec<SleepStage> = nights
        .iter()
        .flat_map(|(d, n)| {
            n.stages.iter().map(move |&((a, b), st)| SleepStage {
                day: d.to_string(),
                start_at: a.to_string(),
                end_at: b.to_string(),
                stage: kind(st),
                source,
            })
        })
        .collect();
    stages.sort_by(|a, b| a.start_at.cmp(&b.start_at));
    stages.dedup_by(|a, b| a.start_at == b.start_at);
    stages
}

/// Health Connect's `SleepSession` record as the phone keeps it raw
/// (`data`: start and end times with their offsets, `stages` with Health
/// Connect's type numbers); `None` when its times don't read. A stage of
/// type 0 (unknown) is no span, as on the phone.
fn health_connect_sleep(id: &str, data: &str) -> Option<Sleep> {
    let v: serde_json::Value = serde_json::from_str(data).ok()?;
    let at = |v: &serde_json::Value, k: &str| v.get(k)?.as_str()?.parse::<Timestamp>().ok();
    let off = |k: &str| v.get(k)?.as_str().and_then(offset);
    let stages = v
        .get("stages")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|s| {
            let stage = match s.get("type")?.as_i64()? {
                0 => return None,
                1 | 3 | 7 => Stage::Awake,
                4 => Stage::Light,
                5 => Stage::Deep,
                6 => Stage::Rem,
                _ => Stage::Asleep,
            };
            Some(((at(s, "start_time")?, at(s, "end_time")?), stage))
        })
        .collect();
    Some(Sleep {
        id: id.to_owned(),
        span: (at(&v, "start_time")?, at(&v, "end_time")?),
        offsets: (off("start_zone_offset"), off("end_zone_offset")),
        rank: (false, 0),
        stages,
        bpm: v.get("avg_bpm").and_then(serde_json::Value::as_i64),
    })
}

/// What Health Connect's raw sleep sessions make by the night rule: the
/// nights (each wake day's sleep fields, with when sleep began and ended),
/// their stage spans and the naps (keyed by record id).
#[derive(Debug, Default)]
pub struct HealthConnectSleeps {
    /// Each session's wake day: the days they decide.
    pub days: BTreeSet<String>,
    /// Each night and its span: from its first session's start to when
    /// sleep ended (an awake tail cut, [`asleep_end`]).
    pub nights: Vec<(DeviceDay, Span)>,
    pub stages: Vec<SleepStage>,
    pub naps: Vec<NapIn>,
}

/// When `n`'s sleep ended: its end, less a tail of awake stages reaching it
/// (awake or out of bed after the last sleep isn't the night).
fn asleep_end(n: &Night) -> Timestamp {
    let (start, mut end) = n.span;
    while let Some(&((a, _), _)) = n
        .stages
        .iter()
        .find(|&&((a, b), st)| st == Stage::Awake && a > start && a < end && b >= end)
    {
        end = a;
    }
    end
}

/// `records` (`(record id, data)` of `SleepSession`s) as nights and naps by
/// the night rule ([`sleeps`]); days in a record's own offset, else `tz`.
#[must_use]
pub fn health_connect_sleeps(records: &[(String, String)], tz: &TimeZone) -> HealthConnectSleeps {
    let all: Vec<Sleep> = records
        .iter()
        .filter_map(|(id, data)| health_connect_sleep(id, data))
        .collect();
    let days = all
        .iter()
        .map(|s| local(s.span.1, s.offsets.1, tz).date().to_string())
        .collect();
    let Sleeps { nights, naps, .. } = sleeps(all, "", tz, day_so_far());
    HealthConnectSleeps {
        days,
        stages: stages_of(&nights, StageSource::HealthConnect),
        nights: nights
            .into_iter()
            .map(|(_, n)| {
                let span = (n.span.0, asleep_end(&n));
                (n.day, span)
            })
            .collect(),
        naps,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `tests/fixtures/health/sleep-blocks.json`: the night rule's cases (the
    /// phone ran them too until the server became the nights' only author).
    #[test]
    fn sleep_blocks_follow_the_shared_fixture() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/health/sleep-blocks.json"
        );
        let f: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(
            (
                &f["sleep_join_s"],
                &f["sleep_split_s"],
                &f["night_min_min"],
                &f["in_bed_max_min"]
            ),
            (
                &serde_json::json!(SLEEP_JOIN_S),
                &serde_json::json!(SLEEP_SPLIT_S),
                &serde_json::json!(NIGHT_MIN_MIN),
                &serde_json::json!(IN_BED_MAX_MIN)
            )
        );
        assert_eq!(
            f["night_part_end"],
            format!(
                "{:02}:{:02}",
                NIGHT_PART_END_MIN / 60,
                NIGHT_PART_END_MIN % 60
            )
        );
        let tz = TimeZone::get(f["zone"].as_str().unwrap()).unwrap();
        let text = |v: &serde_json::Value, k: &str| v[k].as_str().unwrap().to_owned();
        for case in f["cases"].as_array().unwrap() {
            let all = case["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| Sleep {
                    id: text(s, "id"),
                    span: (
                        text(s, "start").parse().unwrap(),
                        text(s, "end").parse().unwrap(),
                    ),
                    offsets: (None, None),
                    rank: (false, 0),
                    stages: Vec::new(),
                    bpm: None,
                })
                .collect();
            let got = sleeps(all, "gh-", &tz, Date::constant(9999, 12, 31));
            let nights: Vec<serde_json::Value> = got
                .nights
                .iter()
                .map(|(d, n)| {
                    serde_json::json!({
                        "day": d.to_string(),
                        "start_at": n.span.0.to_string(),
                        "end_at": n.span.1.to_string(),
                        "in_bed_min": n.day.in_bed_min,
                        "asleep_min": n.day.asleep_min,
                        "bedtime": n.day.bedtime,
                        "wake_time": n.day.wake_time,
                    })
                })
                .collect();
            let naps: Vec<serde_json::Value> = case["naps"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| {
                    let mut n = n.clone();
                    n["key"] = format!("gh-{}", text(&n, "key")).into();
                    n
                })
                .collect();
            let name = &case["name"];
            assert_eq!(serde_json::json!(nights), case["nights"], "{name}");
            let got_naps: Vec<serde_json::Value> = got
                .naps
                .iter()
                .map(|n| {
                    serde_json::json!({ "key": n.key, "day": n.day,
                                        "start_at": n.start_at, "end_at": n.end_at })
                })
                .collect();
            assert_eq!(got_naps, naps, "{name}");
            assert_eq!(serde_json::json!(got.skipped), case["skipped"], "{name}");
        }
    }
}
