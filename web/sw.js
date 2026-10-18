// The service worker: opens the app and the days already seen without a
// network. Network first for the page and the API reads; the cache answers
// when the network fails outright or hangs past DEADLINE_MS, never for a
// status (a 401/403/407 from a login proxy goes through as is). The app's
// files under /v/<build>/ never change, so the cache answers them first.
// Writes are the outbox's job, not this. A classic script:
// tests/offline.test.mjs and tests/sw.test.mjs read OFFLINE_READS, stale(),
// overflow(), forgotten() and the fetch handler from it.

const CACHE = "kaloriina";
// The header a cached answer carries (api.mjs reads it).
const CACHED = "x-kaloriina-cached";

// The API reads the diary needs to open: reference data, profiles, a day.
// A profile keeps its DAYS_KEPT latest days (overflow()).
const DAY = /^\/api\/profiles\/(\d+)\/day\/(\d{4}-\d{2}-\d{2})$/u;
const DAYS_KEPT = 60;
const OFFLINE_READS = [
  /^\/api\/meta$/u,
  /^\/api\/profiles$/u,
  DAY,
  // The trackers the day's Log card counts.
  /^\/api\/profiles\/\d+\/habits$/u,
  // A workout seen online starts offline (its run reads these).
  /^\/api\/workouts$/u,
  /^\/api\/workouts\/\d+$/u,
  /^\/api\/exercises$/u,
  // An activity seen online opens its view offline.
  // ponytail: one small answer per activity opened, dropped only with its
  // profile; evict like DAY's if a profile ever opens thousands.
  /^\/api\/profiles\/\d+\/activities\/\d+$/u,
];

// Only the app's own page is ever cached as the app: a proxy's login page
// is HTML too, but without this marker.
const SHELL_MARKER = '<meta name="kaloriina-shell"';

// An app file's build, from its address (/v/<build>/main.mjs), or from the
// page that loads them.
const BUILD = /^\/v\/([^/]+)\//u;
const buildOf = (path) => BUILD.exec(path)?.[1];
const shellBuild = (html) => /"\/v\/([^/"]+)\//u.exec(html)?.[1];

// A cached path to drop once a page booted on `booted`: another build's
// file, unless the cached page (`shell`) still loads that build, so an
// offline open right after an upgrade still finds its files.
// ponytail: app files cached at their plain address before /v/ existed
// (~400 KB) stay, unused; drop them here if the cache size ever matters.
function stale(path, booted, shell) {
  const build = buildOf(path);
  return build !== undefined && build !== booted && build !== shell;
}

const isJson = (res) =>
  (res.headers.get("content-type") ?? "").startsWith("application/json");
const isHtml = (res) =>
  (res.headers.get("content-type") ?? "").startsWith("text/html");

// How long a read waits for the network when the cache could answer: past
// it, the connection hangs (lie-fi, a stuck server) and the cache answers.
const DEADLINE_MS = 3_000;

// Pages (clients) that fell back to the cache: the rest of their reads come
// from it at once (the network still refreshes it), so a page on a hung
// connection opens in one deadline, and never mixes two versions of the app.
const fellBack = new Set();

// The network's answer, cached when `keep(res)` holds. On a network error,
// or past DEADLINE_MS, the cached one (if any; else the network's, however
// late, or its error). The network's late answer still refreshes the cache
// (`e.waitUntil`), and then the page reads from the network again: it is
// told `{fresh: path}`, so a screen showing that read re-reads it.
async function networkFirst(e, key, keep, client) {
  const cache = await caches.open(CACHE);
  const fetched = fetch(e.request).then(async (res) => {
    if (res.ok && (await keep(res.clone()))) await cache.put(key, res.clone());
    return res;
  });
  const hit = await cache.match(key);
  if (!hit) return fetched;
  if (!fellBack.has(client)) {
    const deadline = new Promise((resolve) => {
      setTimeout(resolve, DEADLINE_MS, null);
    });
    const res = await Promise.race([fetched, deadline]).catch(() => null);
    if (res) return res;
    if (client) fellBack.add(client);
  }
  e.waitUntil(
    fetched.then(
      () => landed(client, key),
      () => null,
    ),
  );
  return fromCache(hit);
}

// The network answers again after `client` fell back: it reads from the
// network from now on, and the screen hears its read is fresh.
async function landed(client, key) {
  if (!client) return;
  fellBack.delete(client);
  const fresh = new URL(key, self.location.origin).pathname;
  (await self.clients.get(client))?.postMessage({ fresh });
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

// Cached days past each profile's DAYS_KEPT latest (by date), of `paths`.
function overflow(paths) {
  const byProfile = new Map();
  for (const path of paths) {
    const m = DAY.exec(path);
    if (m) byProfile.set(m[1], [...(byProfile.get(m[1]) ?? []), [m[2], path]]);
  }
  return [...byProfile.values()].flatMap((days) =>
    days
      .toSorted(([a], [b]) => (a < b ? 1 : -1))
      .slice(DAYS_KEPT)
      .map(([, path]) => path),
  );
}

// Drop the cached answers `drop(paths)` names.
async function evict(drop) {
  const cache = await caches.open(CACHE);
  const keys = await cache.keys();
  const gone = new Set(drop(keys.map((req) => new URL(req.url).pathname)));
  await Promise.all(
    keys
      .filter((req) => gone.has(new URL(req.url).pathname))
      .map((req) => cache.delete(req)),
  );
}

// A deleted profile's reads (profile.mjs posts `{forget: id}`).
const forgotten = (id) => (paths) =>
  paths.filter((path) => path.startsWith(`/api/profiles/${id}/`));

self.addEventListener("message", (e) => {
  const { booted, forget } = e.data ?? {};
  if (typeof booted === "string") e.waitUntil(prune(booted));
  if (Number.isInteger(forget)) e.waitUntil(evict(forgotten(forget)));
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
        e,
        "/",
        async (res) => isHtml(res) && (await res.text()).includes(SHELL_MARKER),
        e.resultingClientId,
      ),
    );
  } else if (url.pathname.startsWith("/api/")) {
    if (OFFLINE_READS.some((re) => re.test(url.pathname))) {
      const answer = networkFirst(e, request.url, isJson, e.clientId);
      e.respondWith(answer);
      if (DAY.test(url.pathname))
        e.waitUntil(
          answer.then(
            () => evict(overflow),
            () => null,
          ),
        );
    }
  } else if (buildOf(url.pathname)) {
    e.respondWith(cacheFirst(request, url.pathname));
  } else if (url.pathname !== "/sw.js") {
    // The app's files: never a page in their place.
    e.respondWith(
      networkFirst(e, url.pathname, (res) => !isHtml(res), e.clientId),
    );
  }
});
