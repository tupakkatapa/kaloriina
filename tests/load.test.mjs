// Cardio load (ADR 0034): Banister's TRIMP of an activity from its average
// heart rate, the resting heart rate near its day and a maximum by age;
// a period's sum. `node --test tests/`.

import assert from "node:assert/strict";
import test from "node:test";

import {
  activityLoad,
  loadText,
  maxHr,
  periodLoad,
  restingOn,
} from "../web/load.mjs";

const man = { sex: "male", birth_date: "1995-09-23" };
const woman = { sex: "female", birth_date: "1995-09-23" };
const session = {
  day: "2026-10-16",
  minutes: 48,
  avg_hr: 131,
  max_hr: 160,
};
const rest = [{ day: "2026-10-16", resting_hr: 55 }];

const close = (a, b, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test("the maximum is Tanaka's by age on the day, raised to the session's own", () => {
  // 31 on Oct 16 2026: 208 − 0.7 × 31.
  close(maxHr("1995-09-23", "2026-10-16", 160), 186.3);
  // Still 30 the day before the birthday.
  close(maxHr("1995-09-23", "2026-09-22", null), 187);
  // A session over the prediction proves the maximum higher.
  assert.equal(maxHr("1995-09-23", "2026-10-16", 192), 192);
});

test("the resting heart rate is the day's, else the latest of the six days before", () => {
  const days = [
    { day: "2026-10-08", resting_hr: 50 },
    { day: "2026-10-10", resting_hr: 57 },
    { day: "2026-10-12", resting_hr: null },
    { day: "2026-10-16", resting_hr: 55 },
  ];
  assert.equal(restingOn("2026-10-16", days), 55);
  assert.equal(restingOn("2026-10-14", days), 57);
  assert.equal(restingOn("2026-10-16", days.slice(0, 3)), 57);
  // Oct 10 is seven days before Oct 17: too far.
  assert.equal(restingOn("2026-10-17", days.slice(0, 3)), null);
  assert.equal(restingOn("2026-10-16", []), null);
});

test("an activity's load is Banister's TRIMP, weighted by sex", () => {
  const hrr = (131 - 55) / (186.3 - 55);
  const m = activityLoad(session, man, rest);
  close(m.load, 48 * hrr * 0.64 * Math.exp(1.92 * hrr));
  assert.equal(Math.round(m.load), 54);
  assert.equal(m.rest, 55);
  close(m.max, 186.3);
  const w = activityLoad(session, woman, rest);
  close(w.load, 48 * hrr * 0.86 * Math.exp(1.67 * hrr));
  assert.equal(Math.round(w.load), 63);
});

test("no heart rate, no load; what's missing is named", () => {
  assert.equal(activityLoad({ ...session, avg_hr: null }, man, rest), null);
  assert.deepEqual(activityLoad(session, man, []), {
    load: null,
    why: "no resting heart rate that week",
  });
  assert.deepEqual(activityLoad(session, { ...man, sex: null }, rest), {
    load: null,
    why: "needs your sex and birth date",
  });
  assert.deepEqual(activityLoad(session, { ...man, birth_date: null }, rest), {
    load: null,
    why: "needs your sex and birth date",
  });
});

test("a resting heart rate at or over the maximum is no reserve to weigh", () => {
  assert.deepEqual(
    activityLoad({ ...session, max_hr: null }, man, [
      { day: "2026-10-16", resting_hr: 190 },
    ]),
    { load: null, why: "resting heart rate at or over the maximum" },
  );
});

test("the reserve is clamped: an average under rest is no load, over the maximum is the maximum's", () => {
  assert.equal(activityLoad({ ...session, avg_hr: 50 }, man, rest).load, 0);
  const top = activityLoad(
    { ...session, avg_hr: 200, max_hr: null },
    man,
    rest,
  );
  close(top.load, 48 * 0.64 * Math.exp(1.92));
});

test("a period's load sums what has one and counts what hasn't", () => {
  const list = [
    session,
    { ...session, day: "2026-10-14" },
    { ...session, avg_hr: null },
    { ...session, day: "2026-09-01" },
  ];
  const days = [...rest, { day: "2026-10-14", resting_hr: 55 }];
  const p = periodLoad(list, man, days);
  close(p.total, 2 * activityLoad(session, man, rest).load);
  assert.equal(p.loaded, 2);
  assert.equal(p.missing, 2);
  assert.deepEqual(periodLoad([], man, days), {
    total: 0,
    loaded: 0,
    missing: 0,
  });
});

test("the activity view's line: an estimate, its inputs, or why not", () => {
  assert.equal(
    loadText(activityLoad(session, man, rest)),
    "≈ 54 · resting 55, max ≈ 186 bpm",
  );
  assert.equal(
    loadText(activityLoad(session, man, [])),
    "– · no resting heart rate that week",
  );
  assert.equal(loadText(null), null);
});
