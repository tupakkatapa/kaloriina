//! The domain vocabulary shared by the API, storage and importers: foods,
//! recipes, meals, profiles, diary entries, weights, targets, exercises,
//! workouts and sessions, their limits and checks, and the date helpers. No
//! IO here; `db` persists these types and `api` serves them.

/// What the submodules share: each starts with `use super::prelude::*`.
mod prelude {
    pub(super) use serde::{Deserialize, Serialize};

    pub(super) use crate::error::Error;
    pub(super) use crate::nutrients::{self, Nutrients};

    pub(super) use super::limits::*;
    pub(super) use super::{
        Measure, ProfileId, age_on, bad, checked_day_so_far, either, grams, is_date, opt_multiline,
        opt_text, text,
    };
}

use prelude::*;

/// A closed set of names, the same in storage, on the wire and in messages:
/// serde as the given strings, plus `as_str`, `parse`, `ALL` and
/// `choices` ("a, b or c").
macro_rules! text_enum {
    ($(#[$meta:meta])* $vis:vis enum $name:ident {
        $($(#[$vmeta:meta])* $variant:ident = $text:literal),+ $(,)?
    }) => {
        $(#[$meta])*
        #[derive(
            Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash,
            serde::Serialize, serde::Deserialize,
        )]
        $vis enum $name {
            $($(#[$vmeta])* #[serde(rename = $text)] $variant),+
        }

        impl $name {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];

            #[must_use]
            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text),+
                }
            }

            #[must_use]
            pub fn parse(text: &str) -> Option<Self> {
                Self::ALL.iter().copied().find(|v| v.as_str() == text)
            }

            /// Every value as "a, b or c", for messages.
            #[must_use]
            pub fn choices() -> String {
                $crate::model::either(Self::ALL.iter().map(|v| v.as_str()))
            }
        }
    };
}

mod activity;
mod clock;
mod coverage;
mod device;
mod diary;
mod exercise;
mod feedback;
mod food;
mod habit;
mod health_record;
mod hook;
pub mod import;
mod labels;
mod limits;
mod metric;
mod photo;
mod profile;
mod reports;
mod scale;
mod score;
pub(crate) mod sleep;
mod transfer;
mod workout;
pub use activity::*;
pub use clock::*;
pub use coverage::*;
pub use device::*;
pub use diary::*;
pub use exercise::*;
pub use feedback::*;
pub use food::*;
pub use habit::*;
pub use health_record::*;
pub use hook::*;
pub use labels::*;
pub use limits::*;
pub use metric::*;
pub use photo::*;
pub use profile::*;
pub use reports::*;
pub use scale::*;
pub use score::{REASONS, Reason, Scoring, sweetened};
pub use sleep::{HealthConnectSleeps, health_connect_sleeps};
pub use transfer::*;
pub use workout::*;

/// A profile's id. A distinct type so it can't be mixed up with entry ids.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProfileId(pub i64);

// Validation: every writer (HTTP API, Open Food Facts, Fineli, diary import)
// passes these checks, so stored data looks the same whichever way it came in.

pub fn bad(msg: impl Into<String>) -> Error {
    Error::invalid(msg.into())
}

text_enum! {
    /// Who said it (ADR 0019, D10), in the order a source wins where two
    /// describe the same thing: what you typed, then a device by name (your
    /// scale, then the phone), then an import. `Ord` is that precedence:
    /// the one that wins sorts first. Every entity's own source vocabulary
    /// maps into it (`From`), so one rule ranks them all.
    pub enum Provenance {
        Hand = "hand",
        OpenScale = "openscale",
        HealthConnect = "health_connect",
        Import = "import",
    }
}

impl From<WeightSource> for Provenance {
    fn from(s: WeightSource) -> Self {
        match s {
            WeightSource::Hand => Self::Hand,
            WeightSource::OpenScale => Self::OpenScale,
            WeightSource::HealthConnect => Self::HealthConnect,
        }
    }
}

impl From<ActivitySource> for Provenance {
    fn from(s: ActivitySource) -> Self {
        match s {
            ActivitySource::Hand => Self::Hand,
            ActivitySource::HealthConnect => Self::HealthConnect,
            ActivitySource::Import => Self::Import,
        }
    }
}

impl From<KcalSource> for Provenance {
    fn from(s: KcalSource) -> Self {
        match s {
            KcalSource::Hand => Self::Hand,
            // The device's total is the device's word all the same.
            KcalSource::HealthConnect | KcalSource::HealthConnectTotal => Self::HealthConnect,
            KcalSource::Import => Self::Import,
        }
    }
}

impl From<NapSource> for Provenance {
    fn from(s: NapSource) -> Self {
        match s {
            NapSource::Hand => Self::Hand,
            NapSource::HealthConnect => Self::HealthConnect,
            NapSource::Import => Self::Import,
        }
    }
}

impl From<StageSource> for Provenance {
    fn from(s: StageSource) -> Self {
        match s {
            StageSource::HealthConnect => Self::HealthConnect,
            StageSource::Import => Self::Import,
        }
    }
}

/// `sum / n` rounded half up, `None` when `n` isn't above 0: a mean of
/// whole numbers as a whole number, as the phone's `Math.round` gives.
#[must_use]
pub fn mean_rounded(sum: i64, n: i64) -> Option<i64> {
    (n > 0).then(|| (2 * sum + n).div_euclid(2 * n))
}

/// "a, b or c".
pub fn either<'a>(words: impl Iterator<Item = &'a str>) -> String {
    let words: Vec<&str> = words.collect();
    match words.split_last() {
        None => String::new(),
        Some((last, [])) => (*last).to_owned(),
        Some((last, rest)) => format!("{} or {last}", rest.join(", ")),
    }
}

/// Control characters (terminal escapes, NUL) and bidirectional marks and
/// overrides make text lie about itself on screen and in a terminal; no name
/// needs them.
#[must_use]
pub fn sneaky(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{200e}' | '\u{200f}' | '\u{61c}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
        )
}

/// Trimmed text of 1 to `max` characters.
///
/// # Errors
/// Empty or too long.
pub fn text(s: &str, what: &str, max: usize) -> Result<String, Error> {
    let s = s.trim();
    if s.is_empty() || s.chars().count() > max {
        return Err(Error::invalid_field(
            &what.replace(' ', "_"),
            format!("{what} must be 1–{max} characters"),
        ));
    }
    if s.chars().any(sneaky) {
        return Err(Error::invalid_field(
            &what.replace(' ', "_"),
            format!("{what} can't contain control characters"),
        ));
    }
    Ok(s.to_owned())
}

/// Like [`text`], with blank meaning absent.
///
/// # Errors
/// Too long.
pub fn opt_text(s: Option<&str>, what: &str, max: usize) -> Result<Option<String>, Error> {
    s.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| text(s, what, max))
        .transpose()
}

/// Like [`opt_text`] for text of several lines (recipe notes): line
/// breaks (`\r\n` read as `\n`) and tabs are kept, any other control or
/// bidi character is refused.
///
/// # Errors
/// Too long, or a sneaky character.
pub fn opt_multiline(s: Option<&str>, what: &str, max: usize) -> Result<Option<String>, Error> {
    let Some(s) = s.map(|s| s.replace("\r\n", "\n")) else {
        return Ok(None);
    };
    let s = s.trim();
    if s.is_empty() {
        return Ok(None);
    }
    let field = what.replace(' ', "_");
    if s.chars().count() > max {
        return Err(Error::invalid_field(
            &field,
            format!("{what} must be at most {max} characters"),
        ));
    }
    if s.chars().any(|c| c != '\n' && c != '\t' && sneaky(c)) {
        return Err(Error::invalid_field(
            &field,
            format!("{what} can't contain control characters"),
        ));
    }
    Ok(Some(s.to_owned()))
}

/// A day the client may call today or earlier: none after
/// [`day_so_far`].
///
/// # Errors
/// Not a date, or later than that; blamed on `day`.
pub fn checked_day_so_far(day: &str) -> Result<&str, Error> {
    if !is_date(day) {
        return Err(Error::invalid_field("day", "day must be YYYY-MM-DD"));
    }
    if day > day_so_far().to_string().as_str() {
        return Err(Error::invalid_field("day", "day can't be in the future"));
    }
    Ok(day)
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant).
#[must_use]
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (
        y,
        u32::try_from(m).unwrap_or(1),
        u32::try_from(d).unwrap_or(1),
    )
}

/// Whole years from `birth` to `today` (both `YYYY-MM-DD`); `None` if
/// `birth` is after `today` or either date is malformed.
#[must_use]
pub fn age_on(birth: &str, today: &str) -> Option<u32> {
    let parts = |s: &str| -> Option<(u32, u32, u32)> {
        if !is_date(s) {
            return None;
        }
        Some((
            s[0..4].parse().ok()?,
            s[5..7].parse().ok()?,
            s[8..10].parse().ok()?,
        ))
    };
    let (by, bm, bd) = parts(birth)?;
    let (ty, tm, td) = parts(today)?;
    let years = ty.checked_sub(by)?;
    if (tm, td) < (bm, bd) {
        years.checked_sub(1)
    } else {
        Some(years)
    }
}

/// `YYYY-MM-DD` naming a real calendar day.
#[must_use]
pub fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    if b.len() != 10
        || b[4] != b'-'
        || b[7] != b'-'
        || !digits(0..4)
        || !digits(5..7)
        || !digits(8..10)
    {
        return false;
    }
    let year: u32 = s[0..4].parse().unwrap_or(0);
    let (m, d): (u8, u8) = (s[5..7].parse().unwrap_or(0), s[8..10].parse().unwrap_or(0));
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&d)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One order ranks every source; each entity's vocabulary
    /// maps word for word into it, the device's total named apart.
    #[test]
    fn every_provenance_variant_is_ranked() {
        assert_eq!(
            Provenance::ALL
                .iter()
                .map(|p| p.as_str())
                .collect::<Vec<_>>(),
            ["hand", "openscale", "health_connect", "import"]
        );
        assert!(Provenance::ALL.is_sorted());
        let words = |all: Vec<(&'static str, Provenance)>| {
            for (word, p) in all {
                let expected = match word {
                    "health_connect_total" => Provenance::HealthConnect,
                    w => Provenance::parse(w).unwrap_or_else(|| panic!("{w} is unranked")),
                };
                assert_eq!(p, expected, "{word}");
            }
        };
        words(
            WeightSource::ALL
                .iter()
                .map(|&s| (s.as_str(), s.into()))
                .collect(),
        );
        words(
            ActivitySource::ALL
                .iter()
                .map(|&s| (s.as_str(), s.into()))
                .collect(),
        );
        words(
            KcalSource::ALL
                .iter()
                .map(|&s| (s.as_str(), s.into()))
                .collect(),
        );
        words(
            NapSource::ALL
                .iter()
                .map(|&s| (s.as_str(), s.into()))
                .collect(),
        );
        words(
            StageSource::ALL
                .iter()
                .map(|&s| (s.as_str(), s.into()))
                .collect(),
        );
        assert_eq!(
            Provenance::from(KcalSource::HealthConnectTotal),
            Provenance::HealthConnect
        );
    }

    #[test]
    fn civil_dates_and_ages() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_732), (2026, 10, 6));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        assert_eq!(age_on("1990-10-06", "2026-10-06"), Some(36));
        assert_eq!(age_on("1990-10-07", "2026-10-06"), Some(35));
        assert_eq!(age_on("2026-10-07", "2026-10-06"), None);
        assert_eq!(age_on("nope", "2026-10-06"), None);
    }

    #[test]
    fn multiline_text_keeps_lines_and_refuses_the_rest() {
        let ok = opt_multiline(Some("  1. Boil\r\n\t2. Eat \n"), "notes", 20).unwrap();
        assert_eq!(ok.as_deref(), Some("1. Boil\n\t2. Eat"));
        assert_eq!(opt_multiline(Some(" \n "), "notes", 20).unwrap(), None);
        assert_eq!(opt_multiline(None, "notes", 20).unwrap(), None);
        for bad in ["a\u{1b}[2J", "a\u{202e}b", "a\rb", "a\0"] {
            assert!(opt_multiline(Some(bad), "notes", 20).is_err(), "{bad:?}");
        }
        let long = "é".repeat(21);
        assert!(opt_multiline(Some(&long), "notes", 20).is_err());
        assert!(opt_multiline(Some(&long[..40]), "notes", 20).is_ok());
    }

    #[test]
    fn bidi_and_control_marks_are_sneaky() {
        for c in [
            '\u{1b}', '\0', '\u{202e}', '\u{2066}', '\u{200e}', '\u{200f}', '\u{61c}',
        ] {
            assert!(sneaky(c), "{:04x}", u32::from(c));
        }
        for c in ['a', 'ä', '–', 'ß', '\u{5d0}'] {
            assert!(!sneaky(c), "{c}");
        }
    }

    #[test]
    fn dates() {
        assert!(is_date("2026-10-06"));
        for bad in [
            "2026-13-01",
            "2026-00-10",
            "2026-1-01",
            "20261006",
            "2026-10-32",
            "abcd-ef-gh",
            "",
        ] {
            assert!(!is_date(bad), "{bad}");
        }
    }
}
