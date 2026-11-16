//! Trends over a range of days, per week or calendar month: the means of
//! what was eaten on the days that count, the weight trend and how the
//! daily items were kept. Pure: `api` reads the days.

use std::collections::BTreeSet;

use jiff::ToSpan;
use jiff::civil::Date;

use super::prelude::*;

text_enum! {
    /// A trend's bucket: a week (Monday to Sunday) or a calendar month.
    pub enum By {
        Week = "week",
        Month = "month",
    }
}

/// Days a weight trend point is the mean over (`TREND_DAYS` in
/// web/energy.mjs).
pub const TREND_DAYS: i64 = 7;

/// A day with food logged, as `/summary` reads it.
pub struct EatenDay {
    pub day: Date,
    /// kcal, g, g.
    pub energy: Option<f64>,
    pub protein: Option<f64>,
    pub alcohol: Option<f64>,
    /// Its food isn't the whole day's.
    pub incomplete: bool,
    /// An eaten entry carries no energy.
    pub energy_unknown: bool,
}

/// A daily item and its days in the range.
pub struct DailyDays {
    pub id: i64,
    pub food_id: i64,
    pub name: String,
    pub start: Date,
    pub skipped: BTreeSet<Date>,
    /// Days with an entry linked to it.
    pub ticked: BTreeSet<Date>,
}

/// What a trend reads, besides its range.
pub struct TrendDays<'a> {
    pub eaten: &'a [EatenDay],
    /// Weigh-ins (day, kg), oldest first, from [`TREND_DAYS`] − 1 days
    /// before the range.
    pub weights: &'a [(Date, f64)],
    pub daily: &'a [DailyDays],
}

/// Days a daily item was due and ticked.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Adherence {
    pub ticked: u32,
    pub due: u32,
}

impl std::ops::AddAssign for Adherence {
    fn add_assign(&mut self, o: Self) {
        self.ticked += o.ticked;
        self.due += o.due;
    }
}

/// One week or month of a trend, cut to the range.
#[derive(Debug, Serialize)]
pub struct Bucket {
    /// Its first and last day inside the range.
    pub start: String,
    pub end: String,
    /// The days the means read: food days, all logged and with energy
    /// known, before the diary's today.
    pub days: u32,
    /// Means over `days`, kcal and g; null when it is 0.
    pub energy: Option<f64>,
    pub protein: Option<f64>,
    pub alcohol: Option<f64>,
    /// The [`TREND_DAYS`]-day weight trend at its last weigh-in, kg.
    pub weight_kg: Option<f64>,
    pub weighed_days: u32,
    /// Every daily item's, summed.
    pub daily: Adherence,
}

/// A daily item's adherence over the whole range.
#[derive(Debug, Serialize)]
pub struct ItemAdherence {
    pub id: i64,
    pub food_id: i64,
    pub name: String,
    #[serde(flatten)]
    pub days: Adherence,
}

#[derive(Debug, Serialize)]
pub struct Trends {
    pub from: String,
    pub to: String,
    pub by: By,
    pub buckets: Vec<Bucket>,
    pub daily_items: Vec<ItemAdherence>,
}

/// The trend over `[from, to]` by `by`; `today` is the diary's, which no
/// mean or due count reads.
#[must_use]
pub fn trends(from: Date, to: Date, by: By, today: Date, read: &TrendDays) -> Trends {
    let points = trend(read.weights);
    let buckets = spans(from, to, by)
        .into_iter()
        .map(|(start, end)| {
            let (mut days, mut energy, mut protein, mut alcohol) = (0, 0.0, 0.0, 0.0);
            for e in read
                .eaten
                .iter()
                .filter(|e| (start..=end).contains(&e.day) && e.day < today && counted(e))
            {
                days += 1;
                energy += e.energy.unwrap_or(0.0);
                protein += e.protein.unwrap_or(0.0);
                alcohol += e.alcohol.unwrap_or(0.0);
            }
            let mean = |sum: f64| (days > 0).then(|| sum / f64::from(days));
            let weighed: Vec<f64> = points
                .iter()
                .filter(|(d, _)| (start..=end).contains(d))
                .map(|&(_, kg)| kg)
                .collect();
            let mut daily = Adherence::default();
            for item in read.daily {
                daily += adherence(item, start, end, today);
            }
            Bucket {
                start: start.to_string(),
                end: end.to_string(),
                days,
                energy: mean(energy),
                protein: mean(protein),
                alcohol: mean(alcohol),
                weight_kg: weighed.last().copied(),
                weighed_days: u32::try_from(weighed.len()).unwrap_or(u32::MAX),
                daily,
            }
        })
        .collect();
    let daily_items = read
        .daily
        .iter()
        .map(|item| ItemAdherence {
            id: item.id,
            food_id: item.food_id,
            name: item.name.clone(),
            days: adherence(item, from, to, today),
        })
        .collect();
    Trends {
        from: from.to_string(),
        to: to.to_string(),
        by,
        buckets,
        daily_items,
    }
}

/// A day the means read: a food day, all logged, with energy known
/// (`countedDay` in web/nutrients.mjs).
fn counted(e: &EatenDay) -> bool {
    e.energy.is_some_and(|kcal| kcal > 0.0) && !e.incomplete && !e.energy_unknown
}

/// The most buckets a trend answers.
pub const TREND_BUCKETS_MAX: i64 = 600;

/// How many buckets `[from, to]` makes, at most: enough to refuse a range
/// before reading it.
#[must_use]
pub fn trend_buckets(from: Date, to: Date, by: By) -> i64 {
    let days = i64::from((to - from).get_days()).max(0) + 1;
    match by {
        By::Week => days / 7 + 2,
        By::Month => days / 30 + 2,
    }
}

/// `[from, to]` as its buckets' first and last days.
fn spans(from: Date, to: Date, by: By) -> Vec<(Date, Date)> {
    let mut out = Vec::new();
    let mut at = from;
    while at <= to {
        let last = match by {
            By::Week => {
                at.saturating_add((6 - i64::from(at.weekday().to_monday_zero_offset())).days())
            }
            By::Month => at.last_of_month(),
        };
        let end = last.min(to);
        out.push((at, end));
        match end.tomorrow() {
            Ok(next) => at = next,
            Err(_) => break,
        }
    }
    out
}

/// The [`TREND_DAYS`]-day trend at each weigh-in: the mean of the
/// weigh-ins in the days up to it (`trend()` in web/energy.mjs).
fn trend(weights: &[(Date, f64)]) -> Vec<(Date, f64)> {
    let (mut first, mut sum, mut n) = (0, 0.0, 0_u32);
    weights
        .iter()
        .map(|&(day, kg)| {
            sum += kg;
            n += 1;
            while weights[first].0.saturating_add(TREND_DAYS.days()) <= day {
                sum -= weights[first].1;
                n -= 1;
                first += 1;
            }
            (day, sum / f64::from(n))
        })
        .collect()
}

/// `item`'s days due and ticked in `[from, to]` before `today`: due from
/// its start unless skipped, and on every day ticked.
fn adherence(item: &DailyDays, from: Date, to: Date, today: Date) -> Adherence {
    let mut a = Adherence::default();
    for day in from.series(1.day()).take_while(|d| *d <= to && *d < today) {
        let ticked = item.ticked.contains(&day);
        if ticked {
            a.ticked += 1;
        }
        if ticked || (day >= item.start && !item.skipped.contains(&day)) {
            a.due += 1;
        }
    }
    a
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> Date {
        s.parse().unwrap()
    }

    fn eaten(day: &str, energy: f64, protein: f64, alcohol: Option<f64>) -> EatenDay {
        EatenDay {
            day: d(day),
            energy: Some(energy),
            protein: Some(protein),
            alcohol,
            incomplete: false,
            energy_unknown: false,
        }
    }

    fn none() -> TrendDays<'static> {
        TrendDays {
            eaten: &[],
            weights: &[],
            daily: &[],
        }
    }

    fn spans(t: &Trends) -> Vec<(&str, &str)> {
        t.buckets
            .iter()
            .map(|b| (b.start.as_str(), b.end.as_str()))
            .collect()
    }

    const TODAY: &str = "2027-01-01";

    #[test]
    fn weeks_run_monday_to_sunday_cut_to_the_range() {
        let t = trends(
            d("2026-11-04"),
            d("2026-11-17"),
            By::Week,
            d(TODAY),
            &none(),
        );
        assert_eq!(
            spans(&t),
            [
                ("2026-11-04", "2026-11-08"),
                ("2026-11-09", "2026-11-15"),
                ("2026-11-16", "2026-11-17"),
            ]
        );
        assert!(t.buckets.iter().all(|b| b.days == 0 && b.energy.is_none()));
    }

    #[test]
    fn months_are_calendar_months_cut_to_the_range() {
        let t = trends(
            d("2026-10-20"),
            d("2026-12-03"),
            By::Month,
            d(TODAY),
            &none(),
        );
        assert_eq!(
            spans(&t),
            [
                ("2026-10-20", "2026-10-31"),
                ("2026-11-01", "2026-11-30"),
                ("2026-12-01", "2026-12-03"),
            ]
        );
    }

    #[test]
    fn means_read_the_counted_days_and_alcohol_is_zero_without() {
        let mut days = vec![
            eaten("2026-11-09", 2000.0, 100.0, Some(20.0)),
            eaten("2026-11-10", 3000.0, 150.0, None),
            eaten("2026-11-11", 9000.0, 900.0, Some(90.0)),
            eaten("2026-11-12", 9000.0, 900.0, Some(90.0)),
            eaten("2026-11-13", 0.0, 0.0, None),
            // The diary's today: not over yet.
            eaten("2026-11-15", 9000.0, 900.0, Some(90.0)),
        ];
        days[2].incomplete = true;
        days[3].energy_unknown = true;
        let read = TrendDays {
            eaten: &days,
            ..none()
        };
        let t = trends(
            d("2026-11-09"),
            d("2026-11-15"),
            By::Week,
            d("2026-11-15"),
            &read,
        );
        let b = &t.buckets[0];
        assert_eq!(b.days, 2, "no incomplete, unknown, empty or today's day");
        assert_close!(b.energy.unwrap(), 2500.0);
        assert_close!(b.protein.unwrap(), 125.0);
        assert_close!(b.alcohol.unwrap(), 10.0);
    }

    #[test]
    fn weight_is_the_trend_at_a_buckets_last_weigh_in() {
        let weights = [
            // Before the range: in the first point's window.
            (d("2026-11-03"), 82.0),
            (d("2026-11-09"), 80.0),
            (d("2026-11-11"), 81.0),
            // A gap of over a week: the trend restarts.
            (d("2026-11-24"), 78.0),
        ];
        let read = TrendDays {
            weights: &weights,
            ..none()
        };
        let t = trends(d("2026-11-09"), d("2026-11-29"), By::Week, d(TODAY), &read);
        let w: Vec<_> = t
            .buckets
            .iter()
            .map(|b| (b.weight_kg, b.weighed_days))
            .collect();
        // 11-11: 11-09 and 11-11 (11-03 is 8 days back).
        assert_eq!(w, [(Some(80.5), 2), (None, 0), (Some(78.0), 1)]);
        let t = trends(d("2026-11-09"), d("2026-11-09"), By::Week, d(TODAY), &read);
        assert_eq!(t.buckets[0].weight_kg, Some(81.0), "11-03 within 7 days");
    }

    #[test]
    fn a_daily_item_is_due_from_its_start_before_today_unless_skipped() {
        let daily = [
            DailyDays {
                id: 3,
                food_id: 812,
                name: "Creatine".into(),
                start: d("2026-11-01"),
                skipped: [d("2026-11-10")].into(),
                ticked: [d("2026-11-09"), d("2026-11-11"), d("2026-11-16")].into(),
            },
            DailyDays {
                id: 4,
                food_id: 900,
                name: "Fish oil".into(),
                start: d("2026-11-14"),
                skipped: BTreeSet::new(),
                ticked: [d("2026-11-14")].into(),
            },
        ];
        let read = TrendDays {
            daily: &daily,
            ..none()
        };
        let t = trends(
            d("2026-11-09"),
            d("2026-11-16"),
            By::Week,
            d("2026-11-16"),
            &read,
        );
        // Creatine: 11-09 … 11-15 but 11-10, 6 due, 2 ticked; today not.
        // Fish oil: 11-14 and 11-15, 1 ticked.
        assert_eq!(t.buckets[0].daily, Adherence { ticked: 3, due: 8 });
        assert_eq!(t.buckets[1].daily, Adherence::default());
        let items: Vec<_> = t
            .daily_items
            .iter()
            .map(|i| (i.id, i.name.as_str(), i.days))
            .collect();
        assert_eq!(
            items,
            [
                (3, "Creatine", Adherence { ticked: 2, due: 6 }),
                (4, "Fish oil", Adherence { ticked: 1, due: 2 }),
            ]
        );
    }

    #[test]
    fn a_ticked_day_is_a_due_day() {
        let daily = [DailyDays {
            id: 1,
            food_id: 1,
            name: "Vitamin D".into(),
            start: d("2026-11-10"),
            skipped: [d("2026-11-10")].into(),
            ticked: [d("2026-11-09"), d("2026-11-10")].into(),
        }];
        let read = TrendDays {
            daily: &daily,
            ..none()
        };
        let t = trends(d("2026-11-09"), d("2026-11-10"), By::Week, d(TODAY), &read);
        assert_eq!(t.daily_items[0].days, Adherence { ticked: 2, due: 2 });
    }
}
