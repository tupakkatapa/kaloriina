// The outbox rules (web/outbox.mjs) and the service worker's offline reads
// (web/sw.js), without a browser: `node --test tests/`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  ATTEMPTS_MAX,
  add,
  attempted,
  failed,
  latest,
  items,
  next,
  queueable,
  remove,
  replayFailed,
  retry,
  supersede,
  waiting,
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
    ["POST", "/profiles/1/sessions", { uid }, true],
    ["POST", "/profiles/1/plans", { uid }, true],
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
    ["DELETE", "/profiles/1/entries/5", undefined, false],
    ["PUT", "/profiles/1", { name: "x" }, false],
    ["POST", "/foods", { uid }, false],
    ["GET", "/foods/barcode/123", undefined, false],
    ["PUT", "/profiles/1/weights/today", { kg: 70 }, false],
    // Add and Dismiss of a watch workout, by key; the mode is
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
  for (const p of [
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
  assert.equal(next().attempts, ATTEMPTS_MAX - 1);
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
    assert.equal(replayFailed(item, { status: 503, message: "Down" }), "wait");
  assert.deepEqual([items()[0].attempts, items()[0].failed], [5, "Down"]);
  // A refusal fails at once; a DELETE already gone is done.
  const bad = add({ method: "PUT", path: "/x", body: {}, label: "Bad" });
  assert.equal(replayFailed(bad, { status: 400, message: "No" }), "next");
  assert.equal(items().find((x) => x.key === bad.key).failed, "No");
  const del = add({ method: "DELETE", path: "/y", body: null, label: "Del" });
  assert.equal(replayFailed(del, { status: 404, message: "Gone" }), "next");
  assert.equal(
    items().find((x) => x.key === del.key),
    undefined,
  );
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
