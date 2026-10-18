// The JSON API client, the reference data every screen reads (`meta`) and
// the current profile (kept in localStorage).

import * as outbox from "./outbox.mjs";

// A request that hasn't answered by then is given up, so buttons come back.
// Not one with a body over BIG_BYTES (an import): its upload alone may take
// longer on a slow line; its dialog stays busy until the server answers.
const TIMEOUT_MS = 15_000;
const BIG_BYTES = 1024 * 1024;

// A failed request: the server's message, plus what clients branch on
// (`code`, and `field` or `resource` when the server names one).
class ApiError extends Error {
  constructor(
    message,
    { status = 0, code = null, field = null, resource = null } = {},
  ) {
    super(message);
    Object.assign(this, { status, code, field, resource });
  }
}

// This page's build (/v/<build>/api.mjs). An answer from another build means
// the server was upgraded under the page: it's `stale`, and nav.mjs reloads
// it at the next chance (`reloadIfStale`).
const BUILD = /\/v\/([^/]+)\//u.exec(import.meta.url)?.[1];
export let stale = false;

// A request's body: JSON, or a Blob (a photo) as itself.
const bodyOf = (body) => {
  if (body === undefined) return {};
  if (body instanceof Blob)
    return { headers: { "Content-Type": body.type }, body };
  return {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
};

// One request, as is: `api()` and the outbox replay (`flush`) both send
// through here, and only `api()` ever queues.
export async function send(method, path, body) {
  const init = bodyOf(body);
  // A string's length undercounts its UTF-8 bytes: big enough either way.
  const size = init.body?.size ?? init.body?.length ?? 0;
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      ...(size > BIG_BYTES ? {} : { signal: AbortSignal.timeout(TIMEOUT_MS) }),
      ...init,
    });
  } catch (err) {
    outbox.setStatus({ offline: true });
    throw new ApiError(
      err.name === "TimeoutError"
        ? `The server didn't answer in ${TIMEOUT_MS / 1000} s. Try again.`
        : "Can't reach the server. Check the connection and try again.",
      { code: "offline" },
    );
  }
  // The service worker's cached copy (sw.js) means the network is down; it
  // names the build it was cached from, not the server's.
  const cached = res.headers.has("x-kaloriina-cached");
  outbox.setStatus({ offline: cached });
  const served = res.headers.get("x-kaloriina-build");
  if (BUILD && served && served !== BUILD && !cached) stale = true;
  // A write the server took: what was read before may have moved
  // (summary-highlights.mjs drops its discovered patterns).
  if (method !== "GET" && res.ok)
    globalThis.dispatchEvent?.(new Event("written"));
  if (res.status === 204) return null;
  // An HTTPS proxy whose login expired answers with its own page.
  if (!(res.headers.get("content-type") ?? "").startsWith("application/json"))
    throw new ApiError(
      "The server sent a page instead of data; the login may have expired. Please reload.",
      { status: res.status, code: "not_json" },
    );
  outbox.setStatus({ signIn: false });
  const data = await res.json();
  if (!res.ok)
    throw new ApiError(data.error ?? res.statusText, {
      status: res.status,
      code: data.code,
      field: data.field,
      resource: data.resource,
    });
  return data;
}

// Whether a write was kept on this device to send later (`{queue: true}`).
export const isQueued = (err) => err?.code === "queued";

// A write opted into the outbox: true when stored, `{queued}` (the ApiError)
// when kept on this device; any other error stands.
export async function stored(run) {
  try {
    await run();
    return true;
  } catch (err) {
    if (!isQueued(err)) throw err;
    return { queued: err };
  }
}

// A write, offered to the outbox (`{queue: true}`: outbox.mjs `queueable`
// decides whether it may wait): `{data}`, the answer, when stored;
// `{queued}`, as `stored()`, when kept on this device; any other error
// stands. One idiom for every Diary write, so a tick and its Undo, a move
// and a delete wait or fail alike.
export async function write(method, path, body, label) {
  let data;
  const done = await stored(async () => {
    data = await api(method, path, body, { queue: true, label });
  });
  return done === true ? { data } : done;
}

// The replay and live per-day writes take turns, across this device's tabs:
// a replay held on the wire can't land after a newer live write, and two
// tabs never interleave their sends. `{ifAvailable: true}` skips the
// turn instead of waiting for it (null). Without the Web Locks API (an
// insecure context: plain http on a LAN address) each tab only takes turns
// with itself, as before.
const inTurn = (fn, options = {}) =>
  globalThis.navigator?.locks
    ? navigator.locks.request("outbox", options, (lock) => (lock ? fn() : null))
    : fn();

// A request. With `{queue: true}`, a write that is safe to send twice
// (outbox.mjs `queueable`) and can't reach the server, or gets a login page,
// waits in the outbox under `label` and throws ApiError "queued".
export async function api(method, path, body, { queue = false, label } = {}) {
  const queueable = queue && outbox.queueable(method, path, body);
  // A live write that succeeded is newer than what waits for its path.
  const sent = async () => {
    const data = await send(method, path, body);
    if (method !== "GET") outbox.supersede(method, path);
    return data;
  };
  let data;
  try {
    data = await (queueable ? inTurn(sent) : sent());
  } catch (err) {
    if (!queueable || (err.code !== "offline" && err.code !== "not_json"))
      throw err;
    outbox.add({ method, path, body, label: label ?? "Change" });
    if (err.code === "not_json") outbox.setStatus({ signIn: true });
    // The form's next create is a new one, as after a save.
    keys.get(body?.uid)?.();
    throw new ApiError(
      "Saved in this browser; it's sent when you're back online",
      { code: "queued" },
    );
  }
  // The server answers: send what waited.
  if (outbox.next()) flush();
  return data;
}

// Send what waits, in order: null when all went, else the code of the
// error it stopped on.
async function sendWaiting() {
  for (let item = outbox.next(); item; item = outbox.next()) {
    try {
      await send(item.method, item.path, item.body ?? undefined);
    } catch (err) {
      if (err.code === "not_json") outbox.setStatus({ signIn: true });
      if (outbox.replayFailed(item, err) === "wait") return err.code;
      continue;
    }
    outbox.remove(item.key);
  }
  return null;
}

// Send the outbox, oldest first, one at a time; never queues. A call while
// a pass runs waits for it, and gets one more pass if that one stopped on
// no connection (the network may be back: "Send now", `online`); not after
// a server error, which would count a second try.
let flushing = null;
let again = false;
export function flush() {
  if (flushing) {
    again = true;
    return flushing;
  }
  flushing = (async () => {
    try {
      let stopped;
      do {
        again = false;
        // Another tab sending sends it all: this one skips its turn.
        stopped = await inTurn(sendWaiting, { ifAvailable: true });
      } while (again && (stopped === "offline" || stopped === "not_json"));
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

export const get = (path) => api("GET", path);

// Reads started before their screen asks (nav.mjs: the Diary's while meta
// and profiles load), each taken once by its path; `prefetch` drops any
// left from before. A path not started is read now.
let early = new Map();
export function prefetch(paths) {
  early = new Map(paths.map((p) => [p, get(p)]));
  // Its screen sees a failure; not taken, it's no one's.
  for (const read of early.values()) read.catch(() => {});
}
export function take(path) {
  const read = early.get(path);
  early.delete(path);
  return read ?? get(path);
}
// Diary, foods ranking, weights, activities and targets belong to the current
// profile.
export const scoped = (path) => `/profiles/${profileId}${path}`;

// A workout event for this profile's Home Assistant hook (ADR 0024):
// `details` names the workout. Sent now or never,
// never queued (a late "started" would be wrong), and never in the way: the
// server forwards it only when the hook wants it.
export const hookEvent = (event, details) => {
  api("POST", scoped("/hooks/home-assistant/events"), {
    event,
    ...details,
  }).catch(() => {});
};

// An id for a create, so a retried request saves once.
export const uid = () => crypto.randomUUID();

// A form's create id: kept across retries (a retry of a create whose answer
// was lost saves nothing more), a new one after each success. A queued
// create rotates it too: `api()` finds the form's key by its uid.
const keys = new Map();
export function createId() {
  let id = null;
  const done = () => {
    keys.delete(id);
    id = uid();
    keys.set(id, done);
  };
  done();
  return { get: () => id, done };
}

// Reference data from /api/meta: nutrients, diary groups, exercise traits
// and every input limit. Loaded once per page.
export let meta = null;
export async function loadMeta() {
  meta = await get("/meta");
  return meta;
}

export let profiles = [];
// None outside a browser (node tests import the modules that read it).
export let profileId =
  Number(globalThis.localStorage?.getItem("profile")) || null;

export const currentProfile = () => profiles.find((p) => p.id === profileId);

export function useProfile(id) {
  profileId = id;
  localStorage.setItem("profile", String(id));
}

// Keep the current profile one that exists (another device may delete it);
// a "profiles" event tells the page (main.mjs names it in the tab).
function setProfiles(list) {
  profiles = list;
  if (!profiles.some((p) => p.id === profileId)) useProfile(profiles[0].id);
  globalThis.dispatchEvent?.(new Event("profiles"));
}

export async function loadProfiles() {
  setProfiles(await get("/profiles"));
}

// The current profile's weight, for energy estimates.
export const weightKg = () => currentProfile()?.latest_weight_kg ?? null;

// Groups new entries can go to, as the server lists them; imported history
// may show others.
export const groups = () => meta.groups;

// An activity type as the server lists it (`{key, label, distance, pace,
// met}`), or undefined for a key it doesn't.
export const activityType = (key) =>
  meta.activity_types.find((t) => t.key === key);
