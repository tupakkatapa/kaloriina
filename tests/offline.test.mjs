// The outbox rules (web/outbox.mjs) and the service worker's offline reads
// (web/sw.js), without a browser: `node --test tests/`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  add,
  attempted,
  ATTEMPTS_MAX,
  failed,
  items,
  latest,
  next,
  queueable,
  remove,
  replayFailed,
  retry,
  supersede,
  waiting,
  wake,
} from "../web/outbox.mjs";

// The outbox keeps its items in localStorage; a Map stands in for it.
const store = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
  },
});

test("only replay-safe writes are queueable", () => {
  const uid = "a";
  for (const [method, path, body, ok] of [
    ["POST", "/profiles/1/entries", { uid, day: "2030-01-01" }, true],
    ["POST", "/profiles/1/activities", { uid }, true],
    ["POST", "/profiles/1/sessions", { uid }, false],
    ["POST", "/profiles/1/plans", { uid }, true],
    ["POST", "/profiles/1/naps", { uid, day: "2030-01-01" }, true],
    // nap_delete_queues_offline: a nap's delete is by its uid, so a
    // repeat is a no-op (404, done); its Undo is a create with a uid.
    [
      "DELETE",
      "/profiles/1/naps/0f8fad5b-d9cb-469f-a165-70867728950e",
      undefined,
      true,
    ],
    ["DELETE", "/profiles/1/naps/abcdefgh", undefined, true],
    ["PUT", "/profiles/1/naps/abcdefgh", { day: "2030-01-01" }, false],
    ["DELETE", "/profiles/1/naps/a.b", undefined, false],
    // Photos and feedback are online only.
    [
      "POST",
      "/profiles/1/photos?day=2030-01-01&grp=Lunch&uid=abcdefgh",
      undefined,
      false,
    ],
    ["POST", "/feedback", { kind: "bug", text: "x" }, false],
    ["PUT", "/profiles/1/weights/2030-01-01", { kg: 70 }, true],
    ["DELETE", "/profiles/1/weights/2030-01-01", undefined, true],
    ["PUT", "/profiles/1/notes/2030-01-01", { text: "x" }, true],
    ["DELETE", "/profiles/1/notes/2030-01-01", undefined, true],
    ["PUT", "/profiles/1/measurements/2030-01-01/waist", { cm: 80 }, true],
    ["DELETE", "/profiles/1/measurements/2030-01-01/waist", undefined, true],
    ["PUT", "/profiles/1/habits/4/days/2030-01-01", { amount: 2 }, true],
    ["DELETE", "/profiles/1/habits/4/days/2030-01-01", undefined, true],
    ["PUT", "/profiles/1/check-ins/2026-10-09", { mood: 4, tags: [] }, true],
    ["DELETE", "/profiles/1/check-ins/2026-10-09", undefined, true],
    ["PUT", "/profiles/1/check-ins/2026-10-09", { mood: 4, rev: 1 }, false],
    // A tracker's own edits carry a rev.
    ["PUT", "/profiles/1/habits/4", { name: "x", rev: 1 }, false],
    ["DELETE", "/profiles/1/habits/4", undefined, false],
    // A create without a uid could store twice.
    ["POST", "/profiles/1/entries", { day: "2030-01-01" }, false],
    // Anything carrying a rev, and entry edits.
    ["POST", "/profiles/1/entries", { uid, rev: 1 }, false],
    ["PUT", "/profiles/1/weights/2030-01-01", { kg: 70, rev: 1 }, false],
    ["PATCH", "/profiles/1/entries/5", { group: "Lunch" }, false],
    // An entry or plan removed by its id (an Undo, a plan's ✕): ids are
    // never reused, so a repeat finds it gone (404, done).
    ["DELETE", "/profiles/1/entries/5", undefined, true],
    ["DELETE", "/profiles/1/plans/5", undefined, true],
    ["DELETE", "/profiles/1/entries/5", { x: 1 }, false],
    ["DELETE", "/profiles/1/activities/5", undefined, false],
    ["PUT", "/profiles/1", { name: "x" }, false],
    ["POST", "/foods", { uid }, false],
    ["GET", "/foods/barcode/123", undefined, false],
    ["PUT", "/profiles/1/weights/today", { kg: 70 }, false],
    // Add and Dismiss of a device workout, by key; the mode is
    // a setting, online only.
    ["POST", "/profiles/1/sync/health/workouts/hc-1", undefined, true],
    ["DELETE", "/profiles/1/sync/health/workouts/hc-1", undefined, true],
    ["PUT", "/profiles/1/sync/health/workouts", { mode: "ask" }, false],
    ["POST", "/profiles/1/sync/health/workouts/a.b", undefined, false],
  ])
    assert.equal(queueable(method, path, body), ok, `${method} ${path}`);
});

test("the service worker keeps only the diary's reads", () => {
  const ctx = vm.createContext({
    self: { addEventListener: () => {}, location: { origin: "http://x" } },
  });
  vm.runInContext(readFileSync("web/sw.js", "utf8"), ctx);
  const reads = vm.runInContext("OFFLINE_READS", ctx);
  const kept = (p) => reads.some((re) => re.test(p));
  assert.ok(kept("/api/meta"));
  assert.ok(kept("/api/profiles"));
  assert.ok(kept("/api/profiles/3/day/2030-01-01"));
  // The trackers the day's Log card counts; not their days.
  assert.ok(kept("/api/profiles/3/habits"));
  // A saved workout starts offline once seen online (its run screen reads
  // the workout, the workouts and the exercises).
  assert.ok(kept("/api/workouts"));
  assert.ok(kept("/api/workouts/7"));
  assert.ok(kept("/api/exercises"));
  // An activity seen online opens its view offline.
  assert.ok(kept("/api/profiles/3/activities/12"));
  for (const p of [
    "/api/workouts/7/usage",
    "/api/profiles/3/activities",
    "/api/profiles/3/activities/12/x",
    "/api/exercises/3/history",
    "/api/foods",
    "/api/foods/search",
    "/api/profiles/3/summary",
    "/api/profiles/3/day/2030-01-01/x",
    "/api/foods/barcode/123",
    "/api/profiles/3/habits/days",
  ])
    assert.ok(!kept(p), p);
});

test("the outbox: same uid, attempts, failure, supersede, a day's items", () => {
  store.clear();
  const entry = {
    method: "POST",
    path: "/profiles/1/entries",
    body: { uid: "u1", day: "2030-01-01", group: "Lunch" },
    label: "Oats",
  };
  const first = add(entry);
  // The same create again is kept once; with another body it's refused.
  assert.equal(add(entry).key, first.key);
  assert.throws(() => add({ ...entry, body: { ...entry.body, grams: 9 } }));
  assert.equal(items().length, 1);

  // Tries count up to ATTEMPTS_MAX, then the item has failed.
  for (let i = 1; i < ATTEMPTS_MAX; i++) attempted(first.key, "offline");
  assert.equal(items()[0].attempts, ATTEMPTS_MAX - 1);
  attempted(first.key, "offline");
  assert.equal(items()[0].failed, "offline");
  assert.equal(next(), null);

  const weight = add({
    method: "PUT",
    path: "/profiles/1/weights/2030-01-01",
    body: { kg: 70 },
    label: "Weight",
  });
  assert.equal(next().key, weight.key);
  assert.deepEqual(
    waiting(1, "2030-01-01").map((x) => x.label),
    ["Oats", "Weight"],
  );
  assert.deepEqual(waiting(2, "2030-01-01"), []);
  assert.deepEqual(waiting(1, "2030-01-02"), []);

  // A live write to the same day thing drops the waiting one; a live create
  // never drops waiting creates (they share a path).
  supersede("POST", "/profiles/1/entries");
  supersede("DELETE", "/profiles/1/weights/2030-01-01");
  assert.deepEqual(
    items().map((x) => x.label),
    ["Oats"],
  );

  failed(first.key, "refused");
  assert.equal(items()[0].failed, "refused");
  remove(first.key);
  assert.deepEqual(items(), []);
});

test("a live PUT drops a waiting DELETE of its path, and the reverse", () => {
  store.clear();
  const path = "/profiles/1/notes/2030-01-01";
  add({ method: "DELETE", path, body: null, label: "Remove" });
  supersede("PUT", path);
  assert.deepEqual(items(), []);
  add({ method: "PUT", path, body: { text: "x" }, label: "Note" });
  supersede("DELETE", path);
  assert.deepEqual(items(), []);
});

test("the same uid on two paths is two creates", () => {
  store.clear();
  const body = { uid: "u", day: "2030-01-01" };
  add({ method: "POST", path: "/profiles/1/entries", body, label: "Oats" });
  add({
    method: "POST",
    path: "/profiles/1/activities",
    body: { ...body, minutes: 30 },
    label: "Walk",
  });
  assert.deepEqual(
    items().map((x) => x.label),
    ["Oats", "Walk"],
  );
});

test("a malformed item is dropped, not the queue", () => {
  store.clear();
  const good = old("PUT", "/profiles/1/notes/2030-01-01", { text: "x" });
  store.set("outbox", JSON.stringify([good, null, {}, { ...good, body: 3 }]));
  assert.deepEqual(items(), [good]);
  add({ method: "DELETE", path: "/y", body: null, label: "Del" });
  assert.deepEqual(
    items().map((x) => x.path),
    [good.path, "/y"],
  );
  // A store that isn't a list reads as empty.
  store.set("outbox", "{}");
  assert.deepEqual(items(), []);
});

test("a full store says the change couldn't be kept offline", () => {
  store.clear();
  const { setItem } = localStorage;
  localStorage.setItem = () => {
    throw new DOMException("quota", "QuotaExceededError");
  };
  try {
    assert.throws(
      () => add({ method: "PUT", path: "/n", body: {}, label: "Note" }),
      { code: "storage_full", message: /couldn't keep this change offline/iu },
    );
  } finally {
    localStorage.setItem = setItem;
  }
});

test("latest() is the last unfailed write", () => {
  store.clear();
  const path = "/profiles/1/notes/2030-01-01";
  assert.equal(latest(path), null);
  const put = (text) =>
    add({ method: "PUT", path, body: { text }, label: "Note" });
  put("a");
  const b = put("b");
  // Another path, and a create, never answer for it.
  add({ method: "PUT", path: `${path}x`, body: { text: "c" }, label: "x" });
  add({
    method: "POST",
    path: "/profiles/1/entries",
    body: { uid: "u", day: "2030-01-01" },
    label: "Oats",
  });
  assert.deepEqual(latest(path).body, { text: "b" });
  const gone = add({ method: "DELETE", path, body: null, label: "Remove" });
  assert.equal(latest(path).method, "DELETE");
  // A failed write isn't what the day holds.
  failed(gone.key, "refused");
  assert.equal(latest(path).key, b.key);
});

test("offline doesn't count as an attempt", () => {
  store.clear();
  const item = add({
    method: "PUT",
    path: "/profiles/1/notes/2030-01-01",
    body: { text: "gym" },
    label: "Note",
  });
  // No network, or a login page: the server never answered.
  for (let i = 0; i < ATTEMPTS_MAX * 2; i++) {
    assert.equal(replayFailed(item, { code: "offline" }), "wait");
    assert.equal(replayFailed(item, { code: "not_json", status: 200 }), "wait");
  }
  assert.deepEqual([items()[0].attempts, items()[0].failed], [0, null]);
  // The server's own errors count, up to failed.
  for (let i = 1; i <= ATTEMPTS_MAX; i++)
    assert.equal(replayFailed(item, { status: 500, message: "Down" }), "wait");
  assert.deepEqual([items()[0].attempts, items()[0].failed], [5, "Down"]);
  // A refusal fails at once; a DELETE already gone is done.
  const bad = add({ method: "PUT", path: "/x", body: {}, label: "Bad" });
  assert.equal(replayFailed(bad, { status: 400, message: "No" }), "next");
  assert.equal(items().find((x) => x.key === bad.key).failed, "No");
  // A replayed PUT or POST answered 404 fails (its target is gone).
  const put = add({ method: "PUT", path: "/w", body: {}, label: "Put" });
  assert.equal(replayFailed(put, { status: 404, message: "Gone" }), "next");
  assert.equal(items().find((x) => x.key === put.key).failed, "Gone");
  const del = add({ method: "DELETE", path: "/y", body: null, label: "Del" });
  assert.equal(replayFailed(del, { status: 404, message: "Gone" }), "next");
  assert.equal(
    items().find((x) => x.key === del.key),
    undefined,
  );
});

test("outbox_backoff: a restart's 503s wait; 500s back off, then fail", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  store.clear();
  const item = add({ method: "PUT", path: "/n", body: {}, label: "Note" });
  // A proxy answering for a restarting server: six ticks 30 s apart spend
  // no try.
  for (let i = 0; i < 6; i++) {
    assert.equal(replayFailed(item, { status: 503, message: "Down" }), "wait");
    assert.equal(next()?.key, item.key);
    t.mock.timers.tick(30_000);
  }
  assert.deepEqual([items()[0].attempts, items()[0].failed], [0, null]);
  // A busy database (an import) and a full disk wait too, uncounted.
  for (let i = 0; i < ATTEMPTS_MAX * 2; i++) {
    assert.equal(replayFailed(item, { status: 503, code: "busy" }), "wait");
    assert.equal(replayFailed(item, { status: 507, code: "storage" }), "wait");
  }
  assert.deepEqual([items()[0].attempts, items()[0].failed], [0, null]);
  // A 500 is a try, and the next waits 30 s · 2^tries (±20 %): the item
  // isn't offered before then, and holds what's behind it.
  const behind = add({ method: "PUT", path: "/m", body: {}, label: "Later" });
  let wait = 30_000;
  for (let i = 1; i < ATTEMPTS_MAX; i++) {
    assert.equal(replayFailed(item, { status: 500, message: "Bug" }), "wait");
    t.mock.timers.tick(wait * 0.8 - 1);
    assert.equal(next(), null);
    t.mock.timers.tick(wait * 0.4 + 1);
    assert.equal(next().key, item.key);
    wait *= 2;
  }
  // "Send now" skips the wait.
  replayFailed(item, { status: 500, message: "Bug" });
  assert.equal(items()[0].failed, "Bug");
  assert.equal(next().key, behind.key);
  replayFailed(behind, { status: 500, message: "Bug" });
  assert.equal(next(), null);
  wake();
  assert.equal(next().key, behind.key);
  // The wait is capped at an hour.
  for (let i = 0; i < 20; i++) attempted(behind.key, "Bug");
  assert.ok(items()[1].nextAt <= Date.now() + 1.2 * 3_600_000);
});

test("Try again resends", () => {
  store.clear();
  const item = add({ method: "PUT", path: "/z", body: {}, label: "Note" });
  for (let i = 0; i < ATTEMPTS_MAX; i++) attempted(item.key, "Down");
  assert.equal(next(), null);
  retry(item.key);
  assert.deepEqual(
    [next().key, next().attempts, next().failed],
    [item.key, 0, null],
  );
});

test("every per-day route shape is queueable", () => {
  const d = "2030-01-01";
  // A day-addressed PUT/DELETE without a rev is set-semantic:
  // today's records and any later one of the same shape.
  for (const path of [
    `/profiles/1/weights/${d}`,
    `/profiles/1/notes/${d}`,
    `/profiles/1/check-ins/${d}`,
    `/profiles/1/measurements/${d}/waist`,
    `/profiles/1/habits/4/days/${d}`,
    `/profiles/12/blood-pressure/${d}`,
    `/profiles/1/stretches/${d}/hip_flexor`,
  ]) {
    assert.ok(queueable("PUT", path, { x: 1 }), path);
    assert.ok(queueable("DELETE", path), path);
    assert.ok(!queueable("PUT", path, { x: 1, rev: 2 }), `${path} rev`);
    assert.ok(!queueable("POST", path, { uid: "u" }), `${path} POST`);
  }
  for (const path of [
    `/profiles/1/weights/${d}/x/y`,
    `/profiles/1/${d}`,
    `/profiles/1/Weights/${d}`,
    `/profiles/1/habits/x/days/${d}`,
    `/profiles/1/weights/2030-1-1`,
    `/foods/${d}`,
  ])
    assert.ok(!queueable("PUT", path, { x: 1 }), path);
});

test("a series' tick and skip queue, starting, editing and stopping it don't", () => {
  const day = "2030-01-01";
  const key = `daily-3-${day}`;
  for (const [method, path, body, ok] of [
    // A tick is an entry create with a uid (the day's key); a skip and its
    // restore are per-day writes at the due day's address.
    [
      "POST",
      "/profiles/1/entries",
      { uid: key, day, group: "Eaten", repeat_of: 3 },
      true,
    ],
    ["DELETE", `/profiles/1/entries/${key}`, undefined, true],
    ["PUT", `/profiles/1/entries/${key}`, undefined, true],
    // Starting, editing and stopping one is online only; deleting an
    // entry by its id waits (an Undo).
    ["PATCH", "/profiles/1/entries/5", { repeat: { start: day } }, false],
    ["PATCH", `/profiles/1/entries/${key}`, { grams: 5 }, false],
    ["PATCH", `/profiles/1/entries/${key}`, { repeat: null }, false],
    ["DELETE", "/profiles/1/entries/5", undefined, true],
    ["DELETE", "/profiles/1/entries/daily-3-2030-1-1", undefined, false],
  ])
    assert.equal(queueable(method, path, body), ok, `${method} ${path}`);
});

// An item as the outbox stored it before.
const old = (method, path, body = null, uid = null) => ({
  key: crypto.randomUUID(),
  method,
  path,
  body,
  uid,
  label: "Creatine",
  queuedAt: "2030-01-01T08:00:00.000Z",
  attempts: 0,
  failed: null,
});
