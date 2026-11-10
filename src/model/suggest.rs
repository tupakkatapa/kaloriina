//! Suggestions: the foods a profile likely logs next on a day, scored from
//! what it ate in the [`HISTORY_DAYS`] before: how often (recent days
//! weigh more), around what time, on which weekday or kind of day
//! (weekend or not), whether first in its day, whether the day before,
//! and whether usually with a food already logged on the day. Each factor
//! is in [0, 1]; a share of few logs is shrunk toward 0
//! (`hits / (n + SUPPORT)`), so a one-off never reads as a habit. Pure:
//! `db` reads the history.

use std::collections::{BTreeMap, BTreeSet};

use jiff::civil::Weekday;

use super::Food;
use super::prelude::*;

/// The hour a diary day starts (`DAY_START` in web/dates.mjs): a time
/// before it is the night of the day before, 24:00 + t.
pub const DAY_START: u32 = 3;
/// Days of history read before the day.
pub const HISTORY_DAYS: u32 = 90;
/// Suggestions given at most.
pub const SUGGESTIONS_MAX: usize = 10;

/// Days over which a day's weight in the frequency halves.
const HALF_LIFE: f64 = 14.0;
/// Minutes either side of the time asked that count as around it.
const NEAR_MINUTES: u32 = 90;
/// Logs a share needs before it nears 1.
const SUPPORT: f64 = 3.0;
/// A factor's least weighted part a reason names.
const REASON_MIN: f64 = 0.05;
/// The days the frequency's reason counts over, when it ate it in them.
const REASON_DAYS: u32 = 30;

/// Minutes apart two foods count as logged together.
const NEAR_WITH: u32 = 30;

const FREQUENCY: f64 = 0.25;
const TIME_OF_DAY: f64 = 0.15;
const DAY_KIND: f64 = 0.15;
const FIRST: f64 = 0.1;
const YESTERDAY: f64 = 0.15;
const WITH: f64 = 0.2;

/// A log in the history: its food, how many days before the day (0: on
/// it), its time as a minute of the diary day ([`day_minute`]), and its id
/// (the earlier of two at one time is the one added first).
#[derive(Debug, Clone)]
pub struct Logged {
    pub food_id: i64,
    pub age: u32,
    pub minute: Option<u32>,
    pub id: i64,
}

/// A food scored: highest first, with why, the biggest reason first.
#[derive(Debug, Clone, PartialEq)]
pub struct Scored {
    pub food_id: i64,
    pub score: f64,
    pub reasons: Vec<String>,
}

/// The amount of a profile's own last log of a food: what its next starts
/// from.
#[derive(Debug, Clone, Serialize)]
pub struct LastAmount {
    pub grams: f64,
    pub serving: Option<String>,
    pub quantity: Option<f64>,
}

/// A suggestion as served.
#[derive(Debug, Clone, Serialize)]
pub struct Suggestion {
    pub food: Food,
    pub score: f64,
    pub reasons: Vec<String>,
    pub last: Option<LastAmount>,
}

/// A food hidden from suggestions through `until` (a diary day), or for
/// good without one.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct HideInput {
    #[serde(default)]
    pub until: Option<String>,
}

impl HideInput {
    /// # Errors
    /// `until` not a real date.
    pub fn checked(&self) -> Result<(), Error> {
        match &self.until {
            Some(u) if !is_date(u) => Err(Error::invalid_field(
                "until",
                "until must be a real date (YYYY-MM-DD)",
            )),
            _ => Ok(()),
        }
    }
}

/// "HH:MM" as a minute of the diary day: before [`DAY_START`] past 24:00.
#[must_use]
pub fn day_minute(time: &str) -> Option<u32> {
    let (h, m) = time.split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    Some((if h < DAY_START { h + 24 } else { h }) * 60 + m)
}

/// A minute of the diary day as "HH:MM" on the clock.
fn clock(minute: u32) -> String {
    format!("{:02}:{:02}", minute / 60 % 24, minute % 60)
}

/// "Mondays" … "Sundays".
fn weekdays(day: Weekday) -> &'static str {
    match day {
        Weekday::Monday => "Mondays",
        Weekday::Tuesday => "Tuesdays",
        Weekday::Wednesday => "Wednesdays",
        Weekday::Thursday => "Thursdays",
        Weekday::Friday => "Fridays",
        Weekday::Saturday => "Saturdays",
        Weekday::Sunday => "Sundays",
    }
}

/// A count as a float: counts here are far below `u32::MAX`.
fn count(n: usize) -> f64 {
    f64::from(u32::try_from(n).unwrap_or(u32::MAX))
}

/// A day's weight in the frequency, `age` days back.
fn decay(age: u32) -> f64 {
    0.5_f64.powf(f64::from(age) / HALF_LIFE)
}

/// The middle of `values`, sorted (the upper of two).
fn middle(values: &mut [u32]) -> u32 {
    values.sort_unstable();
    values[values.len() / 2]
}

/// A food's history.
#[derive(Default)]
struct Stats {
    /// Logs a day, by age.
    per_day: BTreeMap<u32, u32>,
    /// Times logged a day, by age.
    timed: BTreeMap<u32, Vec<u32>>,
    /// Days it was the first timed log.
    firsts: u32,
    /// Logs on the day itself.
    today: u32,
}

impl Stats {
    /// Logs on a day it was eaten, the median: once the day has as many,
    /// it isn't suggested again.
    fn usual(&self) -> f64 {
        let mut counts: Vec<u32> = self.per_day.values().copied().collect();
        counts.sort_unstable();
        let n = counts.len();
        if n % 2 == 1 {
            f64::from(counts[n / 2])
        } else {
            f64::midpoint(f64::from(counts[n / 2 - 1]), f64::from(counts[n / 2]))
        }
    }

    /// Days before the day it was logged within [`NEAR_WITH`] of `other`.
    fn near(&self, other: &Self) -> usize {
        self.timed
            .range(1..)
            .filter(|(age, mine)| {
                other.timed.get(age).is_some_and(|theirs| {
                    mine.iter()
                        .any(|m| theirs.iter().any(|t| m.abs_diff(*t) <= NEAR_WITH))
                })
            })
            .count()
    }
}

/// Saturday or Sunday.
fn weekend(day: Weekday) -> bool {
    matches!(day, Weekday::Saturday | Weekday::Sunday)
}

/// How much more than evenly the days eaten (by age) fall on `weekday`,
/// or on its kind of day (weekend or weekdays), with the reason of the
/// larger. Eaten every day, a seventh of its days fall on any weekday,
/// two sevenths at weekends: only a share above that counts.
fn day_kind(days: &BTreeMap<u32, u32>, weekday: Weekday) -> (f64, String) {
    let lift = |hits: usize, even: f64| {
        let share = count(hits) / (count(days.len()) + SUPPORT);
        ((share - even) / (1.0 - even)).max(0.0)
    };
    let same = lift(days.keys().filter(|&&a| a % 7 == 0).count(), 1.0 / 7.0);
    let kind = days
        .keys()
        .filter(|&&a| weekend(weekday.wrapping_sub(a)) == weekend(weekday))
        .count();
    let (kind, why) = if weekend(weekday) {
        (lift(kind, 2.0 / 7.0), "Often at weekends")
    } else {
        (lift(kind, 5.0 / 7.0), "Often on weekdays")
    };
    if kind > same {
        (kind, why.to_owned())
    } else {
        (same, format!("Often on {}", weekdays(weekday)))
    }
}

/// Each food's strongest pull from a food timed on the day (an anchor):
/// the share of the anchor's timed days it was logged near it, and the
/// anchor.
fn goes_with(foods: &BTreeMap<i64, Stats>) -> BTreeMap<i64, (f64, i64)> {
    let mut best: BTreeMap<i64, (f64, i64)> = BTreeMap::new();
    let anchors = foods.iter().filter(|(_, s)| s.timed.contains_key(&0));
    for (&anchor, a) in anchors {
        let days = count(a.timed.range(1..).count()) + SUPPORT;
        for (&food, s) in foods.iter().filter(|&(&f, _)| f != anchor) {
            let with = count(s.near(a)) / days;
            if with > best.get(&food).map_or(0.0, |b| b.0) {
                best.insert(food, (with, anchor));
            }
        }
    }
    best
}

/// The foods of `history` (the day's and the [`HISTORY_DAYS`] before),
/// scored for a log on a `weekday` at `time` (a [`day_minute`]; none: no
/// time of day), highest first, ties by food id. A food the day already
/// has its usual count of is left out. `names` names the foods timed on
/// the day.
#[must_use]
pub fn score(
    history: &[Logged],
    weekday: Weekday,
    time: Option<u32>,
    names: &BTreeMap<i64, String>,
) -> Vec<Scored> {
    let mut foods: BTreeMap<i64, Stats> = BTreeMap::new();
    // Each day's first timed log: (minute, id, food).
    let mut firsts: BTreeMap<u32, (u32, i64, i64)> = BTreeMap::new();
    let mut started = false;
    for l in history {
        let s = foods.entry(l.food_id).or_default();
        if let Some(m) = l.minute {
            s.timed.entry(l.age).or_default().push(m);
        }
        if l.age == 0 {
            s.today += 1;
            started = true;
            continue;
        }
        *s.per_day.entry(l.age).or_default() += 1;
        if let Some(m) = l.minute {
            let first = (m, l.id, l.food_id);
            firsts
                .entry(l.age)
                .and_modify(|f| *f = (*f).min(first))
                .or_insert(first);
        }
    }
    for (_, _, food) in firsts.values() {
        if let Some(s) = foods.get_mut(food) {
            s.firsts += 1;
        }
    }
    let with = goes_with(&foods);
    let all_days: f64 = (1..=HISTORY_DAYS).map(decay).sum();
    let mut scored: Vec<Scored> = foods
        .into_iter()
        .filter(|(_, s)| !s.per_day.is_empty() && f64::from(s.today) < s.usual())
        .map(|(food_id, s)| {
            let frequency = s.per_day.keys().map(|&a| decay(a)).sum::<f64>() / all_days;
            let recent = s.per_day.range(..=REASON_DAYS).count();
            let often = if recent > 0 {
                format!("On {recent} of the last {REASON_DAYS} days")
            } else {
                format!("On {} of the last {HISTORY_DAYS} days", s.per_day.len())
            };
            let minutes: Vec<u32> = s.timed.range(1..).flat_map(|(_, m)| m).copied().collect();
            let mut near: Vec<u32> = time.map_or_else(Vec::new, |t| {
                minutes
                    .iter()
                    .copied()
                    .filter(|m| m.abs_diff(t) <= NEAR_MINUTES)
                    .collect()
            });
            let around = count(near.len()) / (count(minutes.len()) + SUPPORT);
            let usually = if near.is_empty() {
                String::new()
            } else {
                format!("Usually around {}", clock(middle(&mut near)))
            };
            let first = if started {
                0.0
            } else {
                f64::from(s.firsts) / (count(s.timed.range(1..).count()) + SUPPORT)
            };
            let (on_day, day) = day_kind(&s.per_day, weekday);
            let yesterday = if s.per_day.contains_key(&1) { 1.0 } else { 0.0 };
            let (with, anchor) = with.get(&food_id).copied().unwrap_or_default();
            let anchor = names.get(&anchor).map_or("", String::as_str);
            let mut parts = [
                (FREQUENCY * frequency, often),
                (TIME_OF_DAY * around, usually),
                (DAY_KIND * on_day, day),
                (FIRST * first, "Often your first food".to_owned()),
                (YESTERDAY * yesterday, "You had it yesterday".to_owned()),
                (WITH * with, format!("Usually with {anchor}")),
            ];
            let score = parts.iter().map(|(p, _)| p).sum();
            parts.sort_by(|a, b| b.0.total_cmp(&a.0));
            Scored {
                food_id,
                score,
                reasons: parts
                    .into_iter()
                    .filter(|(p, _)| *p >= REASON_MIN)
                    .map(|(_, why)| why)
                    .collect(),
            }
        })
        .collect();
    scored.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.food_id.cmp(&b.food_id)));
    scored
}

/// `scored` without the foods a recipe ranked above them holds as an
/// item (`items`: a recipe's item foods).
#[must_use]
pub fn without_ingredients(
    scored: Vec<Scored>,
    items: &BTreeMap<i64, BTreeSet<i64>>,
) -> Vec<Scored> {
    let mut held: BTreeSet<i64> = BTreeSet::new();
    scored
        .into_iter()
        .filter(|s| {
            if held.contains(&s.food_id) {
                return false;
            }
            held.extend(items.get(&s.food_id).into_iter().flatten());
            true
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NO_NAMES: BTreeMap<i64, String> = BTreeMap::new();

    fn log(food_id: i64, age: u32, time: Option<&str>) -> Logged {
        Logged {
            food_id,
            age,
            minute: time.and_then(day_minute),
            id: i64::from(age) * 100 + food_id,
        }
    }

    fn only(history: &[Logged], time: Option<&str>) -> Scored {
        let mut s = score(
            history,
            Weekday::Friday,
            time.and_then(day_minute),
            &NO_NAMES,
        );
        assert_eq!(s.len(), 1, "{s:?}");
        s.remove(0)
    }

    fn close(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-9, "{a} ≠ {b}");
    }

    #[test]
    fn frequency_alone_weighs_recent_days_more() {
        // Every day of the 90, untimed, never yesterday's only: all of it.
        let every: Vec<Logged> = (2..=HISTORY_DAYS).map(|a| log(1, a, None)).collect();
        let all: f64 = (1..=HISTORY_DAYS).map(decay).sum();
        let s = only(&every, None);
        close(s.score, FREQUENCY * (all - decay(1)) / all);
        assert_eq!(s.reasons, ["On 29 of the last 30 days"]);
        // Two logs a day count the day once.
        let twice: Vec<Logged> = every
            .iter()
            .flat_map(|l| {
                [
                    l.clone(),
                    Logged {
                        id: l.id + 1,
                        ..l.clone()
                    },
                ]
            })
            .collect();
        close(only(&twice, None).score, s.score);
        // A day two weeks further back weighs half as much.
        let near = only(&[log(1, 15, None)], None).score;
        let far = only(&[log(1, 29, None)], None).score;
        close(far * 2.0, near);
        assert_eq!(
            only(&[log(1, 60, None)], None).reasons,
            Vec::<String>::new(),
            "too little to say why"
        );
    }

    #[test]
    fn time_of_day_alone_is_a_shrunk_share() {
        let history = [
            log(1, 40, Some("08:00")),
            log(1, 50, Some("08:20")),
            log(1, 55, Some("08:40")),
            log(1, 60, Some("12:00")),
        ];
        // Started: no first-of-day; no time asked: no time of day.
        let today = log(2, 0, None);
        let mut with_day: Vec<Logged> = history.to_vec();
        with_day.push(today);
        let base = score(&with_day, Weekday::Friday, None, &NO_NAMES)[0].score;
        let at = score(&with_day, Weekday::Friday, day_minute("08:30"), &NO_NAMES)[0].clone();
        close(at.score - base, TIME_OF_DAY * 3.0 / (4.0 + SUPPORT));
        assert_eq!(at.reasons, ["Usually around 08:20"]);
    }

    #[test]
    fn first_of_the_day_counts_only_before_the_day_starts() {
        // Coffee first on each of its four days, bread after it.
        let history: Vec<Logged> = (2..=5)
            .flat_map(|a| [log(1, a, Some("07:00")), log(2, a, Some("09:00"))])
            .collect();
        let fresh = score(&history, Weekday::Friday, None, &NO_NAMES);
        let first = |s: &[Scored], id: i64| s.iter().find(|x| x.food_id == id).unwrap().score;
        close(
            first(&fresh, 1) - first(&fresh, 2),
            FIRST * 4.0 / (4.0 + SUPPORT),
        );
        assert!(
            fresh[0]
                .reasons
                .contains(&"Often your first food".to_owned())
        );
        let mut started = history;
        started.push(log(3, 0, Some("06:00")));
        let later = score(&started, Weekday::Friday, None, &NO_NAMES);
        close(first(&later, 1), first(&later, 2));
    }

    #[test]
    fn yesterday_alone() {
        let s = only(&[log(1, 1, None)], None);
        close(
            s.score,
            FREQUENCY * decay(1) / (1..=HISTORY_DAYS).map(decay).sum::<f64>() + YESTERDAY,
        );
        assert_eq!(s.reasons, ["You had it yesterday"]);
    }

    #[test]
    fn a_one_off_from_yesterday_never_outranks_a_staple() {
        // The staple on every other day at 08:00, never yesterday; the
        // one-off yesterday at 08:00, the time asked.
        let mut history: Vec<Logged> = (1..=HISTORY_DAYS / 2)
            .map(|d| log(1, d * 2, Some("08:00")))
            .collect();
        history.push(log(2, 1, Some("08:00")));
        let s = score(&history, Weekday::Friday, day_minute("08:00"), &NO_NAMES);
        assert_eq!(s.iter().map(|x| x.food_id).collect::<Vec<_>>(), [1, 2]);
    }

    #[test]
    fn the_night_belongs_to_the_day_before() {
        assert_eq!(day_minute("01:30"), Some(25 * 60 + 30));
        assert_eq!(day_minute("03:00"), Some(3 * 60));
        assert_eq!(clock(25 * 60 + 30), "01:30");
        // 23:50 is 40 minutes before 00:30, not 23 h after it.
        let s = only(
            &[log(1, 3, Some("23:50")), log(1, 4, Some("23:50"))],
            Some("00:30"),
        );
        assert_eq!(s.reasons[0], "Usually around 23:50");
        // 03:00 starts the day: 02:50 is a day's length from it.
        let s = only(
            &[log(1, 3, Some("02:50")), log(1, 4, Some("02:50"))],
            Some("03:00"),
        );
        assert!(s.reasons.is_empty(), "{s:?}");
    }

    #[test]
    fn a_food_the_day_has_its_usual_count_of_is_left_out() {
        // Twice a day on two days, once on a third: usually twice.
        let mut history = vec![
            log(1, 2, None),
            Logged {
                id: 1,
                ..log(1, 2, None)
            },
            log(1, 3, None),
            Logged {
                id: 2,
                ..log(1, 3, None)
            },
            log(1, 4, None),
        ];
        history.push(Logged {
            id: 3,
            ..log(1, 0, None)
        });
        assert_eq!(
            score(&history, Weekday::Friday, None, &NO_NAMES).len(),
            1,
            "once so far"
        );
        history.push(Logged {
            id: 4,
            ..log(1, 0, None)
        });
        assert!(
            score(&history, Weekday::Friday, None, &NO_NAMES).is_empty(),
            "twice: done"
        );
        // Only on the day, never before: not a suggestion.
        assert!(score(&[log(5, 0, None)], Weekday::Friday, None, &NO_NAMES).is_empty());
    }

    #[test]
    fn a_food_of_one_weekday_is_suggested_on_it() {
        // Pizza on each of the last 12 Fridays; oats every day but those.
        let mut history: Vec<Logged> = (1..=12).map(|w| log(1, w * 7, None)).collect();
        history.extend(
            (1..=HISTORY_DAYS)
                .filter(|a| a % 7 != 0)
                .map(|a| log(2, a, None)),
        );
        let s = score(&history, Weekday::Friday, None, &NO_NAMES);
        let pizza = s.iter().find(|x| x.food_id == 1).unwrap();
        // Untimed, never yesterday: how often and the weekday alone.
        let all: f64 = (1..=HISTORY_DAYS).map(decay).sum();
        let often = (1..=12).map(|w| decay(w * 7)).sum::<f64>() / all;
        close(
            pizza.score,
            FREQUENCY * often + DAY_KIND * (12.0 / 15.0 - 1.0 / 7.0) / (6.0 / 7.0),
        );
        assert_eq!(pizza.reasons[0], "Often on Fridays");
        let oats = s.iter().find(|x| x.food_id == 2).unwrap();
        assert!(!oats.reasons.iter().any(|r| r.starts_with("Often on")));
    }

    #[test]
    fn ties_go_by_food_id() {
        let s = score(
            &[log(9, 5, None), log(3, 5, None), log(6, 5, None)],
            Weekday::Friday,
            None,
            &NO_NAMES,
        );
        assert_eq!(s.iter().map(|x| x.food_id).collect::<Vec<_>>(), [3, 6, 9]);
    }
    #[test]
    fn a_food_usually_with_one_logged_today_ranks_up() {
        // Coffee at 07:00 on five days; a bun just after it on four, cheese
        // in the evening.
        let mut history: Vec<Logged> = (1..=5).map(|a| log(1, a, Some("07:00"))).collect();
        history.extend((2..=5).flat_map(|a| [log(2, a, Some("07:20")), log(3, a, Some("19:00"))]));
        let names = BTreeMap::from([(1, "Coffee".to_owned())]);
        let of = |s: &[Scored], id: i64| s.iter().find(|x| x.food_id == id).unwrap().clone();
        let before = score(&history, Weekday::Friday, None, &names);
        history.push(log(1, 0, Some("08:10")));
        let after = score(&history, Weekday::Friday, None, &names);
        let bun = of(&after, 2);
        close(
            bun.score - of(&before, 2).score,
            WITH * 4.0 / (5.0 + SUPPORT),
        );
        assert_eq!(bun.reasons[0], "Usually with Coffee");
        close(of(&after, 3).score, of(&before, 3).score);
        // Coffee today twice: never its own reason.
        history.push(log(1, 6, Some("07:25")));
        history.push(log(1, 0, Some("07:10")));
        assert!(
            score(&history, Weekday::Friday, None, &names)
                .iter()
                .all(|x| x.food_id != 1 || x.reasons.iter().all(|r| !r.contains("with"))),
        );
    }

    #[test]
    fn a_food_of_weekends_or_weekdays_is_suggested_on_that_kind_of_day() {
        let all: f64 = (1..=HISTORY_DAYS).map(decay).sum();
        // Untimed, never yesterday: how often and the day alone. Each
        // history is days back from the day asked.
        let on = |weekday, days: &dyn Fn(u32) -> bool| {
            let history: Vec<Logged> = (1..=84)
                .filter(|&a| days(a))
                .map(|a| log(1, a, None))
                .collect();
            let often = (1..=84).filter(|&a| days(a)).map(decay).sum::<f64>() / all;
            let s = score(&history, weekday, None, &NO_NAMES).remove(0);
            (s.score - FREQUENCY * often, s.reasons)
        };
        // Brunch on each Saturday and Sunday of the last 12 weeks.
        let (day, reasons) = on(Weekday::Saturday, &|a| matches!(a % 7, 0 | 6));
        close(day, DAY_KIND * (24.0 / 27.0 - 2.0 / 7.0) / (5.0 / 7.0));
        assert_eq!(reasons[0], "Often at weekends");
        let (day, reasons) = on(Weekday::Wednesday, &|a| matches!(a % 7, 3 | 4));
        close(day, 0.0);
        assert!(
            !reasons.iter().any(|r| r.starts_with("Often")),
            "{reasons:?}"
        );
        // Lunch on each weekday.
        let (day, reasons) = on(Weekday::Monday, &|a| !matches!(a % 7, 1 | 2));
        close(day, DAY_KIND * (60.0 / 63.0 - 5.0 / 7.0) / (2.0 / 7.0));
        assert!(
            reasons.contains(&"Often on weekdays".to_owned()),
            "{reasons:?}"
        );
    }

    #[test]
    fn a_recipe_ranked_above_its_ingredient_leaves_it_out() {
        let at = |food_id| Scored {
            food_id,
            score: 0.0,
            reasons: Vec::new(),
        };
        // Porridge (5) holds oats (1) and jam (2); jam ranks above it.
        let items = BTreeMap::from([(5, BTreeSet::from([1, 2]))]);
        let kept = without_ingredients(vec![at(2), at(5), at(1), at(3)], &items);
        assert_eq!(
            kept.iter().map(|x| x.food_id).collect::<Vec<_>>(),
            [2, 5, 3]
        );
    }
}
