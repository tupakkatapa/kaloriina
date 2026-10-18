//! Feedback for the instance's maintainer: a bug or a feature idea, open
//! until `kaloriina feedback --pull` prints it.

use super::opt_multiline;
use std::fmt::Write;

use super::prelude::*;

text_enum! {
    pub enum FeedbackKind {
        Bug = "bug",
        Feature = "feature",
    }
}

text_enum! {
    /// Open until the CLI pulls it.
    pub enum FeedbackStatus {
        Open = "open",
        Pulled = "pulled",
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct FeedbackInput {
    pub kind: String,
    pub text: String,
}

/// Feedback checked: its kind, and its text of several lines.
#[derive(Debug, Clone)]
pub struct CheckedFeedback {
    pub kind: FeedbackKind,
    pub text: String,
}

impl FeedbackInput {
    /// # Errors
    /// An unknown kind; a blank or too long text.
    pub fn checked(self) -> Result<CheckedFeedback, Error> {
        let kind = FeedbackKind::parse(&self.kind).ok_or_else(|| {
            Error::invalid_field("kind", format!("kind must be {}", FeedbackKind::choices()))
        })?;
        let text = opt_multiline(Some(&self.text), "text", FEEDBACK_TEXT_MAX)?
            .ok_or_else(|| Error::invalid_field("text", "text must not be blank"))?;
        Ok(CheckedFeedback { kind, text })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Feedback {
    pub id: i64,
    pub kind: FeedbackKind,
    pub text: String,
    pub status: FeedbackStatus,
    pub created_at: String,
}

/// Feedback as the maintainer reads it: a heading per item, then its text
/// quoted line by line, so a text can't forge an item of its own.
#[must_use]
pub fn feedback_markdown(list: &[Feedback]) -> String {
    list.iter().fold(String::new(), |mut out, f| {
        let kind = match f.kind {
            FeedbackKind::Bug => "Bug",
            FeedbackKind::Feature => "Idea",
        };
        // Writing to a String can't fail.
        let _ = write!(out, "## {kind} #{} · {}\n\n", f.id, f.created_at);
        for line in f.text.lines() {
            let _ = writeln!(out, ">{}{line}", if line.is_empty() { "" } else { " " });
        }
        out.push('\n');
        out
    })
}
