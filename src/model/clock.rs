//! The server's clock: one "now" and one rule for "today". The server's
//! own today is [`crate::AppState::today`], in its `--time-zone`.

use jiff::civil::Date;
use jiff::tz::TimeZone;
use jiff::{Timestamp, ToSpan, Unit};

/// Now, in epoch milliseconds.
#[must_use]
pub fn now_ms() -> i64 {
    Timestamp::now().as_millisecond()
}

/// Now, an instant to the second: `2026-10-13T08:30:00Z`.
#[must_use]
pub fn now_utc_second() -> String {
    Timestamp::now()
        .round(Unit::Second)
        .unwrap_or_else(|_| Timestamp::now())
        .to_string()
}

/// A clock time, "HH:MM" from 00:00 to 23:59, as minutes into the day.
#[must_use]
pub fn day_minute(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 5 || b[2] != b':' || ![0, 1, 3, 4].iter().all(|&i| b[i].is_ascii_digit()) {
        return None;
    }
    let (h, m): (i64, i64) = (s[..2].parse().ok()?, s[3..].parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

/// Minutes into the day as a clock time, "HH:MM".
#[must_use]
pub fn hh_mm(minute: i64) -> String {
    format!("{:02}:{:02}", minute / 60, minute % 60)
}

/// Today in `tz`.
#[must_use]
pub fn today_in(tz: &TimeZone) -> Date {
    Timestamp::now().to_zoned(tz.clone()).date()
}

/// The last day a reading may fall on: tomorrow in `tz`.
#[must_use]
pub fn latest_day(tz: &TimeZone) -> Date {
    latest_day_at(tz, Timestamp::now())
}

/// The latest day a client may call today: tomorrow in UTC, as far ahead
/// as any time zone is. Bounds client-named days, which follow the client's
/// zone, not the server's.
#[must_use]
pub fn day_so_far() -> Date {
    latest_day(&TimeZone::UTC)
}

fn latest_day_at(tz: &TimeZone, now: Timestamp) -> Date {
    now.to_zoned(tz.clone()).date().saturating_add(1.day())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(instant: &str) -> Timestamp {
        instant.parse().unwrap()
    }

    #[test]
    fn latest_day_is_tomorrow_exactly() {
        let helsinki = TimeZone::get("Europe/Helsinki").unwrap();
        for (tz, instant, latest) in [
            (&TimeZone::UTC, "2026-12-31T23:59:59Z", "2027-01-01"),
            (&TimeZone::UTC, "2027-01-01T00:00:00Z", "2027-01-02"),
            (&helsinki, "2026-12-31T21:59:59Z", "2027-01-01"),
            (&helsinki, "2026-12-31T22:00:00Z", "2027-01-02"),
        ] {
            assert_eq!(
                latest_day_at(tz, at(instant)).to_string(),
                latest,
                "{instant}"
            );
        }
    }
}
