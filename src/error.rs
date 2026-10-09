//! Crate error type. The HTTP mapping (status and stable `code`) lives in
//! `api`, the only transport.

/// Why a request is refused when it conflicts with stored data. Each has a
/// stable `code` on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Conflict {
    /// Another food already has this barcode.
    BarcodeTaken,
    /// Another profile already has this name.
    NameTaken,
    /// The only profile can't be deleted.
    LastProfile,
    /// Imported entries can move but not change.
    ImportedReadOnly,
    /// A workout uses the exercise, so it can't go or change how it's done.
    ExerciseInUse,
    /// Base-set exercises are reference data: make your own to change one.
    BaseReadOnly,
    /// The row changed since the client read it (its `rev` moved on).
    Stale,
    /// The day's weight is the scale's: it goes with its reading.
    ScaleWeight,
    /// Watch-measured fields of a synced session are the watch's.
    WatchReadOnly,
    /// A session holds the watch workout: delete the session, not dismiss.
    HeldBySession,
    /// The watch workout was dismissed or deleted: it is never added.
    Dismissed,
}

impl Conflict {
    #[must_use]
    pub fn code(self) -> &'static str {
        match self {
            Self::BarcodeTaken => "barcode_taken",
            Self::NameTaken => "name_taken",
            Self::LastProfile => "last_profile",
            Self::ImportedReadOnly => "imported_read_only",
            Self::ExerciseInUse => "exercise_in_use",
            Self::BaseReadOnly => "base_read_only",
            Self::Stale => "stale",
            Self::ScaleWeight => "scale_weight",
            Self::WatchReadOnly => "watch_read_only",
            Self::HeldBySession => "held_by_session",
            Self::Dismissed => "dismissed",
        }
    }

    /// The field on the wire that holds the taken value, if one does.
    #[must_use]
    pub fn field(self) -> Option<&'static str> {
        match self {
            Self::BarcodeTaken => Some("barcode"),
            Self::NameTaken => Some("name"),
            _ => None,
        }
    }
}

/// Errors from the library.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Bad input; the message names the field in the user's words, and
    /// `field` names it on the wire when one field is to blame.
    #[error("{message}")]
    Invalid {
        message: String,
        field: Option<String>,
    },
    /// What is missing: a resource ("food") and its id.
    #[error("{}", not_found_text(resource, id))]
    NotFound { resource: &'static str, id: String },
    #[error("{message}")]
    Conflict { kind: Conflict, message: String },
    /// An outside service (Open Food Facts) failed.
    #[error("{0}")]
    Upstream(String),
    #[error("database schema v{found} is newer than this binary (v{supported}); upgrade kaloriina")]
    SchemaTooNew { found: u32, supported: usize },
    /// A migration failed, or would leave rows pointing at missing ones;
    /// nothing was changed. Names the migration or the rows.
    #[error("{0}")]
    Migration(String),
    /// A bug or a failed task; logged, never shown in detail.
    #[error("{0}")]
    Internal(String),
    #[error(transparent)]
    Db(#[from] rusqlite::Error),
    #[error(transparent)]
    Csv(#[from] csv::Error),
}

impl Error {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid {
            message: message.into(),
            field: None,
        }
    }

    /// Bad input blamed on one field.
    pub fn invalid_field(field: &str, message: impl Into<String>) -> Self {
        Self::Invalid {
            message: message.into(),
            field: Some(field.to_owned()),
        }
    }

    pub fn not_found(resource: &'static str, id: impl std::fmt::Display) -> Self {
        Self::NotFound {
            resource,
            id: id.to_string(),
        }
    }

    pub fn conflict(kind: Conflict, message: impl Into<String>) -> Self {
        Self::Conflict {
            kind,
            message: message.into(),
        }
    }
}

fn not_found_text(resource: &str, id: &str) -> String {
    if id.is_empty() {
        format!("{resource} not found")
    } else {
        format!("{resource} {id} not found")
    }
}
