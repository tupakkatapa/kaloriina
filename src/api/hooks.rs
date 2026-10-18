//! Outbound hooks (ADR 0024): a profile's Home Assistant webhook, set in
//! Connections, and the workout events the client reports, forwarded to
//! it. Client-triggered and never queued: a late "started" would be wrong.

use std::time::Duration;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};

use super::prelude::*;
use model::{HookEvent, HookEventInput, HookInput, HookResult, HookSent, now_ms};

/// How long a call may take unless the state says otherwise.
pub const HOOK_TIMEOUT: Duration = Duration::from_secs(5);

/// The hooks' resolver: the system's, without the addresses a hook may not
/// reach ([`model::hook_may_reach`]), checked as the call connects so a
/// name can't turn into one between a check and the call.
struct Reachable;

impl Resolve for Reachable {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addrs: Vec<_> = tokio::net::lookup_host((host.as_str(), 0))
                .await?
                .filter(|a| model::hook_may_reach(a.ip()))
                .collect();
            if addrs.is_empty() {
                return Err(format!("{host}: no address a hook may reach").into());
            }
            Ok(Box::new(addrs.into_iter()) as Addrs)
        })
    }
}

/// The outbound hooks' client: plain HTTP allowed (Home Assistant runs on
/// the LAN), redirects never followed, only reachable addresses. Without
/// TLS roots, one that trusts none: `http://` hooks still go, `https://`
/// ones fail.
pub(crate) fn hook_client() -> reqwest::Client {
    let builder = || {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .dns_resolver(Reachable)
            .user_agent(concat!("kaloriina/", env!("CARGO_PKG_VERSION")))
    };
    builder()
        .build()
        .or_else(|e| {
            tracing::error!(error = %e, "https:// hooks disabled: no TLS roots");
            builder().tls_certs_only([]).build()
        })
        .expect("a client without TLS roots builds")
}

const HA: &str = "/api/profiles/{pid}/hooks/home-assistant";

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route(HA, get(read).put(set).delete(remove))
        .route(&format!("{HA}/events"), post(event))
}

/// The hook, never its webhook id; `null` when none is set.
async fn read(State(s): State<AppState>, Path(pid): Path<ProfileId>) -> Res<Option<model::Hook>> {
    Ok(Json(
        on_profile(&s, pid, move |conn| db::hook_get(conn, pid)).await?,
    ))
}

async fn set(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Json(h): Json<HookInput>,
) -> Res<model::Hook> {
    let h = h.checked()?;
    Ok(Json(
        on_profile(&s, pid, move |conn| db::hook_set(conn, pid, &h)).await?,
    ))
}

async fn remove(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
) -> Result<StatusCode, Error> {
    on_profile(&s, pid, move |conn| db::hook_delete(conn, pid)).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Forward an event the hook was set to send (`test` always), and keep how
/// it went. No hook, or not that event: `{sent: false}`, nothing kept.
async fn event(
    State(s): State<AppState>,
    Path(pid): Path<ProfileId>,
    Json(e): Json<HookEventInput>,
) -> Res<HookSent> {
    let e = e.checked()?;
    let target = on_profile(&s, pid, move |conn| db::hook_target(conn, pid)).await?;
    let Some(t) = target.filter(|t| e.event == HookEvent::Test || t.events.contains(&e.event))
    else {
        return Ok(Json(HookSent {
            sent: false,
            result: None,
        }));
    };
    let body = json!({
        "event": e.event,
        "profile": t.profile,
        "workout": e.workout,
        "at": model::now_utc_second(),
    });
    let url = model::webhook_url(&t.url, &t.webhook_id)?;
    let mut result = HookResult {
        event: e.event,
        at: now_ms(),
        ok: false,
        status: None,
        error: None,
    };
    // The answer's body is never read; errors are told without the address
    // (it holds the secret).
    match s
        .hooks
        .post(url)
        .timeout(s.hook_timeout)
        .json(&body)
        .send()
        .await
    {
        Ok(res) => {
            result.status = Some(res.status().as_u16());
            result.ok = res.status().is_success();
        }
        Err(err) => {
            result.error = Some(if err.is_timeout() {
                format!("timed out after {:?}", s.hook_timeout)
            } else if err.is_connect() {
                "couldn't connect".into()
            } else {
                "the request failed".into()
            });
        }
    }
    if !result.ok {
        tracing::warn!(event = e.event.as_str(), status = ?result.status, error = ?result.error, "hook call failed");
    }
    let kept = result.clone();
    on_db(&s, move |conn| db::hook_result_set(conn, pid, &kept)).await?;
    Ok(Json(HookSent {
        sent: true,
        result: Some(result),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_resolver_drops_what_a_hook_may_not_reach() {
        let resolve = |host: &str| Reachable.resolve(host.parse().unwrap());
        assert!(resolve("169.254.169.254").await.is_err());
        assert!(resolve("0.0.0.0").await.is_err());
        let addrs: Vec<_> = resolve("127.0.0.1").await.unwrap().collect();
        assert_eq!(addrs.len(), 1);
    }
}
