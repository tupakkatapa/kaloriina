// The JSON API client, the reference data every screen reads (`meta`) and
// the current profile (kept in localStorage).

import * as outbox from "./outbox.mjs";

// A request that hasn't answered by then is given up, so buttons come back.
const TIMEOUT_MS = 15_000;

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

// One request, as is: `api()` and the outbox replay (`flush`) both send
// through here, and only `api()` ever queues.
export async function send(method, path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
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
  // The service worker's cached copy (sw.js) means the network is down.
  outbox.setStatus({ offline: res.headers.has("x-kaloriina-cached") });
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
export async function stored(write) {
  try {
    await write();
    return true;
  } catch (err) {
    if (!isQueued(err)) throw err;
    return { queued: err };
  }
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
  const write = async () => {
    const data = await send(method, path, body);
    if (method !== "GET") outbox.supersede(method, path);
    return data;
  };
  let data;
  try {
    data = await (queueable ? inTurn(write) : write());
  } catch (err) {
    if (!queueable || (err.code !== "offline" && err.code !== "not_json"))
      throw err;
    outbox.add({ method, path, body, label: label ?? "Change" });
    if (err.code === "not_json") outbox.setStatus({ signIn: true });
    // The form's next create is a new one, as after a save.
    keys.get(body?.uid)?.();
    throw new ApiError(
      "Saved on this device; it's sent when you're back online",
      { code: "queued" },
    );
  }
  // The server answers: send what waited.
  if (outbox.next()) flush();
  return data;
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
        stopped = null;
        // Another tab sending sends it all: this one skips its turn.
        await inTurn(
          async () => {
            for (let item = outbox.next(); item; item = outbox.next()) {
              try {
                await send(item.method, item.path, item.body ?? undefined);
              } catch (err) {
                if (err.code === "not_json") outbox.setStatus({ signIn: true });
                if (outbox.replayFailed(item, err) === "wait") {
                  stopped = err.code;
                  return;
                }
                continue;
              }
              outbox.remove(item.key);
            }
          },
          { ifAvailable: true },
        );
      } while (again && (stopped === "offline" || stopped === "not_json"));
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

export const get = (path) => api("GET", path);
// Diary, foods ranking, weights, sessions and targets belong to the current
// profile.
export const scoped = (path) => `/profiles/${profileId}${path}`;

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
export let profileId = Number(localStorage.getItem("profile")) || null;

export const currentProfile = () => profiles.find((p) => p.id === profileId);

export function useProfile(id) {
  profileId = id;
  localStorage.setItem("profile", String(id));
}

// Keep the current profile one that exists (another device may delete it);
// a "profiles" event tells the page (main.mjs names it in the tab).
export function setProfiles(list) {
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
