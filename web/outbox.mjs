// Writes made offline, kept on this device until the server has them.
// Storage and rules only; api.mjs sends them (`flush`).
// No import of api.mjs, so node tests can load the rules.

const KEY = "outbox";
// Tries before an item is marked failed (kept until discarded).
export const ATTEMPTS_MAX = 5;

// Only writes that are safe to send twice may wait: creates carrying a
// `uid`, the per-day PUTs and DELETEs (last write wins), and Add and
// Dismiss of a watch workout. A per-day write is matched by its shape, not
// a list: every PUT/DELETE addressed by a day (`…/<YYYY-MM-DD>[/<key>]`,
// a tracker's `habits/<id>/days/<day>`) without a `rev` is set-semantic
// by the API contract, so a new per-day record queues with no change here.
const DAY_WRITE =
  /^\/profiles\/\d+\/[a-z-]+\/(?:\d+\/days\/)?\d{4}-\d{2}-\d{2}(?:\/[a-z_]+)?$/;
const CREATE = /^\/profiles\/\d+\/(entries|sessions|plans)$/;
// Add and Dismiss of a watch workout: keyed by its Health Connect id, a
// repeat is a no-op.
const SYNCED_WORKOUT =
  /^\/profiles\/\d+\/sync\/health\/workouts\/[A-Za-z0-9-]+$/;

export function queueable(method, path, body) {
  if ((method === "POST" || method === "DELETE") && SYNCED_WORKOUT.test(path))
    return !body;
  if (method === "POST")
    return (
      CREATE.test(path) && typeof body?.uid === "string" && !("rev" in body)
    );
  if (method === "PUT" || method === "DELETE")
    return DAY_WRITE.test(path) && !(body && "rev" in body);
  return false;
}

// What the sync pill shows besides the items: no network, or a login page
// answering instead of the server.
const status = { offline: false, signIn: false };
export const syncStatus = () => ({ ...status });

const changed = () => globalThis.dispatchEvent?.(new Event("outbox"));

export function setStatus(patch) {
  if (Object.entries(patch).every(([k, v]) => status[k] === v)) return;
  Object.assign(status, patch);
  changed();
}

export function items() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? [];
  } catch {
    // A corrupt store can't be replayed; starting empty beats never loading.
    return [];
  }
}

function save(list) {
  localStorage.setItem(KEY, JSON.stringify(list));
  changed();
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Keep a write for later. The same create (method, path, uid) twice is kept
// once; with a different body it's refused (it would store something else
// than what was shown as saved).
export function add({ method, path, body, label }) {
  const list = items();
  const uid = body?.uid ?? null;
  const twin = uid
    ? list.find((x) => x.method === method && x.path === path && x.uid === uid)
    : null;
  if (twin) {
    if (same(twin.body, body ?? null)) return twin;
    throw new Error(
      "A different change with this id is already waiting to send.",
    );
  }
  const item = {
    key: crypto.randomUUID(),
    method,
    path,
    body: body ?? null,
    uid,
    label,
    queuedAt: new Date().toISOString(),
    attempts: 0,
    failed: null,
  };
  // Ask once that the browser keep this data under storage pressure.
  if (!list.length) navigator.storage?.persist?.().catch(() => false);
  save([...list, item]);
  return item;
}

const update = (key, fn) =>
  save(items().flatMap((x) => (x.key === key ? fn(x) : [x])));

export const remove = (key) => update(key, () => []);

// A server error (5xx) on a replay: it may work later, so it's counted, and
// failed once there have been ATTEMPTS_MAX.
export const attempted = (key, reason) =>
  update(key, (x) => {
    const attempts = x.attempts + 1;
    return [
      {
        ...x,
        attempts,
        failed: attempts >= ATTEMPTS_MAX ? reason : null,
      },
    ];
  });

// The server refused it: it never will take it.
export const failed = (key, reason) =>
  update(key, (x) => [{ ...x, failed: reason }]);

// Try again: a failed item waits as new (attempts 0).
export const retry = (key) =>
  update(key, (x) => [{ ...x, attempts: 0, failed: null }]);

// What a replay's error means for `item`, and for the replay: "wait" stops
// it (try later), "next" goes on. No network or a login page never answered
// for the write: it waits as it was, uncounted. A server error (5xx)
// is an attempt. A DELETE of something already gone is done; any other
// refusal won't change on a retry, so it fails.
export function replayFailed(item, err) {
  if (err.code === "offline" || err.code === "not_json") return "wait";
  if (err.status >= 500) {
    attempted(item.key, err.message);
    return "wait";
  }
  if (item.method === "DELETE" && err.status === 404) remove(item.key);
  else failed(item.key, err.message);
  return "next";
}

// The next item to send: the oldest that hasn't failed.
export const next = () => items().find((x) => !x.failed) ?? null;

// The newest waiting PUT or DELETE of `path` that hasn't failed: what the
// day holds once it's sent (last write wins), or null.
export const latest = (path) =>
  items().findLast(
    (x) =>
      x.path === path &&
      !x.failed &&
      (x.method === "PUT" || x.method === "DELETE"),
  ) ?? null;

// A live PUT or DELETE that succeeded is newer than any waiting PUT or
// DELETE of the same day thing: those would undo it, so they go. Creates
// never supersede each other (they share a path).
export function supersede(method, path) {
  if (method !== "PUT" && method !== "DELETE") return;
  const list = items();
  const kept = list.filter(
    (x) => x.path !== path || (x.method !== "PUT" && x.method !== "DELETE"),
  );
  if (kept.length !== list.length) save(kept);
}

// A profile's items for a day, for the day view ("Waiting to send").
export const waiting = (profileId, day) =>
  items().filter(
    (x) =>
      x.path.startsWith(`/profiles/${profileId}/`) &&
      (x.body?.day === day || x.path.includes(`/${day}`)),
  );
