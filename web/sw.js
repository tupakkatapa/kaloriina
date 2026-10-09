// The service worker: opens the app and the days already seen without a
// network. Network first for the page and the API reads; the
// cache answers only when the network fails outright, never for a status
// (a 401/403/407 from a login proxy goes through as is). The app's files
// under /v/<build>/ never change, so the cache answers them first. Writes
// are the outbox's job, not this. A classic script: tests/offline.test.mjs
// and tests/sw.test.mjs read OFFLINE_READS and stale() from it.

const CACHE = "kaloriina";
// The header a cached answer carries (api.mjs reads it).
const CACHED = "x-kaloriina-cached";

// The API reads the diary needs to open: reference data, profiles, a day.
// `ponytail:` days are never pruned; cap near 60 if the cache grows.
const OFFLINE_READS = [
  /^\/api\/meta$/,
  /^\/api\/profiles$/,
  /^\/api\/profiles\/\d+\/day\/\d{4}-\d{2}-\d{2}$/,
  // The trackers the day's Log card counts.
  /^\/api\/profiles\/\d+\/habits$/,
];

// Only the app's own page is ever cached as the app: a proxy's login page
// is HTML too, but without this marker.
const SHELL_MARKER = '<meta name="kaloriina-shell"';

// An app file's build, from its address (/v/<build>/main.mjs), or from the
// page that loads them.
const BUILD = /^\/v\/([^/]+)\//;
const buildOf = (path) => BUILD.exec(path)?.[1];
const shellBuild = (html) => /"\/v\/([^/"]+)\//.exec(html)?.[1];

// A cached path to drop once a page booted on `booted`: another build's
// file, unless the cached page (`shell`) still loads that build, so an
// offline open right after an upgrade still finds its files.
// `ponytail:` app files cached at their plain address before /v/ existed
// (~400 KB) stay, unused; drop them here if the cache size ever matters.
function stale(path, booted, shell) {
  const build = buildOf(path);
  return build !== undefined && build !== booted && build !== shell;
}

const isJson = (res) =>
  (res.headers.get("content-type") ?? "").startsWith("application/json");
const isHtml = (res) =>
  (res.headers.get("content-type") ?? "").startsWith("text/html");

// Pages (clients) that already fell back to the cache: the rest of their
// files come from it too, so a page never mixes two versions of the app.
const fellBack = new Set();

// The network's answer, cached when `keep(res)` holds; on a network error,
// the cached one (if any; else the error stands).
async function networkFirst(request, key, keep, client) {
  const cache = await caches.open(CACHE);
  if (fellBack.has(client)) {
    const hit = await cache.match(key);
    if (hit) return fromCache(hit);
  }
  try {
    const res = await fetch(request);
    if (res.ok && (await keep(res.clone()))) await cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (!hit) throw err;
    if (client) fellBack.add(client);
    return fromCache(hit);
  }
}

// A cached answer says so, so the app can show it's offline.
function fromCache(hit) {
  const headers = new Headers(hit.headers);
  headers.set(CACHED, "1");
  return new Response(hit.body, {
    status: hit.status,
    statusText: hit.statusText,
    headers,
  });
}

// A file that never changes: the cached one, else the network's (kept).
async function cacheFirst(request, key) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && !isHtml(res)) await cache.put(key, res.clone());
  return res;
}

// A page booted on a build (main.mjs posts `{booted}`): its files are
// cached, so other builds' can go (stale()).
async function prune(booted) {
  const cache = await caches.open(CACHE);
  const page = await cache.match("/");
  const shell = page ? shellBuild(await page.text()) : undefined;
  const keys = await cache.keys();
  await Promise.all(
    keys
      .filter((req) => stale(new URL(req.url).pathname, booted, shell))
      .map((req) => cache.delete(req)),
  );
}

self.addEventListener("message", (e) => {
  const { booted } = e.data ?? {};
  if (typeof booted === "string") e.waitUntil(prune(booted));
});

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const { request } = e;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    // Every address is the one page (routes live in the hash).
    if (url.pathname !== "/" && url.pathname !== "/index.html") return;
    e.respondWith(
      networkFirst(
        request,
        "/",
        async (res) => isHtml(res) && (await res.text()).includes(SHELL_MARKER),
        e.resultingClientId,
      ),
    );
  } else if (url.pathname.startsWith("/api/")) {
    if (OFFLINE_READS.some((re) => re.test(url.pathname)))
      e.respondWith(networkFirst(request, request.url, isJson, null));
  } else if (buildOf(url.pathname)) {
    e.respondWith(cacheFirst(request, url.pathname));
  } else if (url.pathname !== "/sw.js") {
    // The app's files: never a page in their place.
    e.respondWith(
      networkFirst(request, url.pathname, (res) => !isHtml(res), e.clientId),
    );
  }
});
