//! The outbound hooks' client (ADR 0024): what a hook call may reach and
//! how long it may take.

use std::time::Duration;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};

use crate::model;

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
            // Through a proxy (HTTP_PROXY), `Reachable` would vet the
            // proxy's address, not the hook's.
            .no_proxy()
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
