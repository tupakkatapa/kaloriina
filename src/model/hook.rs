//! Outbound hooks (ADR 0024): a profile's Home Assistant webhook, and the
//! workout events the client asks the server to forward to it.

use std::net::IpAddr;

use reqwest::Url;

use super::prelude::*;
use super::sneaky;

text_enum! {
    /// What a hook is called on. `test` is Connections' "Send test": it
    /// always goes, and isn't one to choose.
    pub enum HookEvent {
        WorkoutStarted = "workout_started",
        WorkoutFinished = "workout_finished",
        Test = "test",
    }
}

impl HookEvent {
    /// The events a hook may be set to send, in order: all but `test`.
    pub const CHOSEN: &'static [Self] = &[Self::WorkoutStarted, Self::WorkoutFinished];

    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::WorkoutStarted => "Workout started",
            Self::WorkoutFinished => "Workout finished",
            Self::Test => "Test",
        }
    }
}

/// Whether a hook may call `ip`: never a link-local (cloud metadata) or
/// unspecified address, where Home Assistant never lives. Loopback and
/// the LAN stay open: they're its homes.
#[must_use]
pub fn hook_may_reach(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(v4) => !(v4.is_link_local() || v4.is_unspecified()),
        IpAddr::V6(v6) => !(v6.is_unicast_link_local() || v6.is_unspecified()),
    }
}

/// Where an event for the hook at `base` goes: `{base}/api/webhook/{id}`.
///
/// # Errors
/// A stored base that no longer parses (it was checked when saved).
pub fn webhook_url(base: &str, webhook_id: &str) -> Result<Url, Error> {
    let mut url = Url::parse(base).map_err(|e| Error::Internal(format!("hook url: {e}")))?;
    url.path_segments_mut()
        .map_err(|()| Error::Internal("hook url has no path".into()))?
        .pop_if_empty()
        .extend(["api", "webhook", webhook_id]);
    Ok(url)
}

/// A hook as saved. `webhook_id` may be left out to keep the saved one,
/// unless the URL changes (the secret never goes to a new address unasked).
#[derive(Debug, Clone, Deserialize)]
pub struct HookInput {
    pub url: String,
    #[serde(default)]
    pub webhook_id: Option<String>,
    #[serde(default)]
    pub events: Vec<String>,
}

/// A hook input checked: the base URL as parsed, without a trailing `/`;
/// a URL-safe id.
#[derive(Debug, Clone)]
pub struct CheckedHook {
    pub url: String,
    pub webhook_id: Option<String>,
    pub events: Vec<HookEvent>,
}

impl HookInput {
    /// # Errors
    /// A URL that isn't plain `http(s)://host[:port][/path]` or is too long;
    /// an id that is empty, too long or not URL-safe; an unknown event.
    pub fn checked(self) -> Result<CheckedHook, Error> {
        let raw = self.url.trim();
        let parsed = Url::parse(raw).ok().filter(|u| {
            matches!(u.scheme(), "http" | "https")
                && u.host_str().is_some_and(|h| !h.is_empty())
                && u.username().is_empty()
                && u.password().is_none()
                && u.query().is_none()
                && u.fragment().is_none()
        });
        let url = parsed
            .as_ref()
            .map(|u| u.as_str().trim_end_matches('/').to_owned())
            .filter(|u| u.chars().count() <= HOOK_URL_MAX && !raw.chars().any(sneaky));
        let Some(url) = url else {
            return Err(Error::invalid_field(
                "url",
                format!(
                    "url must be an http:// or https:// address of up to {HOOK_URL_MAX} characters, without a login, query or fragment"
                ),
            ));
        };
        // A host name is checked as it resolves (the hooks' resolver); an
        // address here.
        let literal = parsed
            .as_ref()
            .and_then(Url::host_str)
            .and_then(|h| h.trim_start_matches('[').trim_end_matches(']').parse().ok());
        if literal.is_some_and(|ip| !hook_may_reach(ip)) {
            return Err(Error::invalid_field(
                "url",
                "url can't be a link-local or unspecified address",
            ));
        }
        let webhook_id = self
            .webhook_id
            .map(|id| {
                let id = id.trim().to_owned();
                if id.is_empty()
                    || id.len() > HOOK_ID_MAX
                    || !id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                {
                    return Err(Error::invalid_field(
                        "webhook_id",
                        format!("webhook_id must be 1–{HOOK_ID_MAX} letters, digits, - or _"),
                    ));
                }
                Ok(id)
            })
            .transpose()?;
        let mut events = Vec::new();
        for e in &self.events {
            let event = HookEvent::parse(e)
                .filter(|e| *e != HookEvent::Test)
                .ok_or_else(|| {
                    Error::invalid_field(
                        "events",
                        "events must be workout_started or workout_finished",
                    )
                })?;
            if !events.contains(&event) {
                events.push(event);
            }
        }
        Ok(CheckedHook {
            url,
            webhook_id,
            events,
        })
    }
}

/// A hook as served: never its webhook id.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Hook {
    pub url: String,
    pub events: Vec<HookEvent>,
    pub last_result: Option<HookResult>,
}

/// How the last call went: Home Assistant's status (any 2xx is `ok`), or
/// why there was none. Never the address (it holds the secret).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HookResult {
    pub event: HookEvent,
    /// Epoch ms.
    pub at: i64,
    pub ok: bool,
    pub status: Option<u16>,
    pub error: Option<String>,
}

/// An event the client reports: `workout` is its name.
#[derive(Debug, Clone, Deserialize)]
pub struct HookEventInput {
    pub event: String,
    #[serde(default)]
    pub workout: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CheckedHookEvent {
    pub event: HookEvent,
    pub workout: Option<String>,
}

impl HookEventInput {
    /// # Errors
    /// An unknown event; a blank-but-present or too long workout name is
    /// none or refused like any name.
    pub fn checked(self) -> Result<CheckedHookEvent, Error> {
        let event = HookEvent::parse(&self.event).ok_or_else(|| {
            Error::invalid_field("event", format!("event must be {}", HookEvent::choices()))
        })?;
        Ok(CheckedHookEvent {
            event,
            workout: opt_text(self.workout.as_deref(), "workout", NAME_MAX)?,
        })
    }
}

/// Did the call `sent`, and how it went.
#[derive(Debug, Clone, Serialize)]
pub struct HookSent {
    pub sent: bool,
    pub result: Option<HookResult>,
}
