//! The web client's static files, with their security headers.
//!
//! - **App files** are served at `/v/<build>/…`, cached for good
//!   (`immutable`): the build hash is in the address, so an upgrade is a
//!   new address and never served stale. Another build's
//!   address is 404.
//! - **`index.html`** loads them from there; it is revalidated on every
//!   open (`no-cache`) against an `ETag` of the build hash: one round trip
//!   decides the whole app's freshness.
//! - **The rest** (`sw.js`, the manifest and its icon, and the app files at
//!   their plain address) are revalidated on every load against an `ETag`
//!   of their bytes.

use std::sync::OnceLock;

use super::prelude::*;

fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("webmanifest") => "application/manifest+json",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

const CSP: &str = "default-src 'self'; img-src 'self' data:; object-src 'none'; \
    base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

const IMMUTABLE: &str = "public, max-age=31536000, immutable";

/// What `index.html` loads; every other app file follows by relative import.
/// (The manifest's icon keeps its plain address: an installed app holds it.)
const ENTRY_POINTS: [&str; 4] = ["/style.css", "/layout.js", "/main.mjs", "/icon.svg"];

/// One hash over every file's path and bytes, in path order.
fn version<'a>(files: impl IntoIterator<Item = (&'a str, &'a [u8])>) -> String {
    let mut files: Vec<_> = files.into_iter().collect();
    files.sort_unstable();
    let mut hasher = DefaultHasher::new();
    files.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn all_files<'a>(dir: &'a Dir<'a>, out: &mut Vec<(&'a str, &'a [u8])>) {
    for f in dir.files() {
        out.push((f.path().to_str().unwrap_or_default(), f.contents()));
    }
    for d in dir.dirs() {
        all_files(d, out);
    }
}

/// This build's hash over the embedded web files.
fn build_hash() -> &'static str {
    static HASH: OnceLock<String> = OnceLock::new();
    HASH.get_or_init(|| {
        let mut files = Vec::new();
        all_files(&WEB, &mut files);
        version(files)
    })
}

/// `index.html`, loading the app files from this build's address.
fn index() -> &'static str {
    static INDEX: OnceLock<String> = OnceLock::new();
    INDEX.get_or_init(|| {
        let html = WEB
            .get_file("index.html")
            .and_then(include_dir::File::contents_utf8)
            .unwrap_or_default();
        ENTRY_POINTS.iter().fold(html.to_owned(), |html, p| {
            html.replace(&format!("\"{p}\""), &format!("\"/v/{}{p}\"", build_hash()))
        })
    })
}

/// `body` as `path`'s type, a 304 when the client holds `etag` already.
fn reply(
    headers: &HeaderMap,
    path: &str,
    etag: String,
    cache: &'static str,
    body: &'static [u8],
) -> Response {
    let fresh = headers
        .get(header::IF_NONE_MATCH)
        .is_some_and(|v| v.as_bytes() == etag.as_bytes());
    let common = [
        (header::ETAG, etag),
        (header::CACHE_CONTROL, cache.to_owned()),
        (header::CONTENT_SECURITY_POLICY, CSP.to_owned()),
    ];
    if fresh {
        return (StatusCode::NOT_MODIFIED, common).into_response();
    }
    (common, [(header::CONTENT_TYPE, mime(path))], body).into_response()
}

pub(super) async fn static_file(uri: Uri, headers: HeaderMap) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path.is_empty() || path == "index.html" {
        let etag = format!("\"{}\"", build_hash());
        return reply(&headers, "index.html", etag, "no-cache", index().as_bytes());
    }
    let (path, cache) = match path.strip_prefix("v/") {
        Some(rest) => match rest.split_once('/') {
            Some((hash, path)) if hash == build_hash() => (path, IMMUTABLE),
            _ => return StatusCode::NOT_FOUND.into_response(),
        },
        None => (path, "no-cache"),
    };
    let Some(f) = WEB.get_file(path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut hasher = DefaultHasher::new();
    f.contents().hash(&mut hasher);
    let etag = format!("\"{:016x}\"", hasher.finish());
    reply(&headers, path, etag, cache, f.contents())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn get(path: &str, etag: Option<&str>) -> (StatusCode, HeaderMap, String) {
        let mut headers = HeaderMap::new();
        if let Some(etag) = etag {
            headers.insert(header::IF_NONE_MATCH, etag.parse().unwrap());
        }
        let res = static_file(path.parse().unwrap(), headers).await;
        let (parts, body) = res.into_parts();
        let body = to_bytes(body, usize::MAX).await.unwrap();
        (
            parts.status,
            parts.headers,
            String::from_utf8_lossy(&body).into_owned(),
        )
    }

    #[tokio::test]
    async fn index_etag_changes_with_the_build() {
        let h = build_hash();
        let (status, headers, body) = get("/", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::ETAG], format!("\"{h}\""));
        assert_eq!(headers[header::CACHE_CONTROL], "no-cache");
        for p in ENTRY_POINTS {
            assert!(body.contains(&format!("\"/v/{h}{p}\"")), "{p} in {body}");
            assert!(!body.contains(&format!("\"{p}\"")), "plain {p}");
        }
        let (status, ..) = get("/index.html", Some(&format!("\"{h}\""))).await;
        assert_eq!(status, StatusCode::NOT_MODIFIED);

        // Any file's path or bytes changing is a new build.
        let build = version([("main.mjs", b"a".as_slice()), ("ui.mjs", b"b")]);
        assert_eq!(
            version([("ui.mjs", b"b".as_slice()), ("main.mjs", b"a")]),
            build
        );
        assert_ne!(
            version([("main.mjs", b"a".as_slice()), ("ui.mjs", b"c")]),
            build
        );
        assert_ne!(
            version([("main.mjs", b"a".as_slice()), ("ux.mjs", b"b")]),
            build
        );
    }

    #[tokio::test]
    async fn an_old_hash_is_404() {
        let h = build_hash();
        let (status, headers, _) = get(&format!("/v/{h}/screens/log.mjs"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CACHE_CONTROL], IMMUTABLE);
        assert_eq!(
            headers[header::CONTENT_TYPE],
            "text/javascript; charset=utf-8"
        );
        for path in [
            "/v/0123456789abcdef/main.mjs".to_owned(),
            format!("/v/{h}/nothing.mjs"),
            format!("/v/{h}"),
            "/v/".to_owned(),
        ] {
            assert_eq!(get(&path, None).await.0, StatusCode::NOT_FOUND, "{path}");
        }
        // The worker and the manifest keep their address and revalidate.
        let (status, headers, _) = get("/sw.js", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CACHE_CONTROL], "no-cache");
    }
}
