// The adaptive energy target's rules (web/energy.mjs).

import assert from "node:assert/strict";
import test from "node:test";

import { shift } from "../web/dates.mjs";
import {
  balance,
  balanceText,
  balanceRange,
  projection,
  slope,
  trend,
  withEnergy,
} from "../web/energy.mjs";

const Y = "2026-10-07";
// `n` days of `kcal` ending yesterday.
const days = (n, kcal) =>
  Array.from({ length: n }, (_, i) => ({
    day: shift(Y, -i),
    total: { energy: kcal },
  })).reverse();
// Weigh-ins `dayAgo → kg`, by day.
const weights = (pairs) =>
  pairs
    .map(([ago, kg]) => ({ day: shift(Y, -ago), kg }))
    .sort((a, b) => a.day.localeCompare(b.day));

test("the window is 28 days, fetched with 6 more for the trend", () => {
  assert.deepEqual(balanceRange(Y), {
    from: "2026-09-04",
    start: "2026-09-10",
    to: Y,
  });
});

test("slope is least squares in kg a day", () => {
  const w = weights([
    [20, 80],
    [10, 79],
    [0, 78],
  ]);
  assert.ok(Math.abs(slope(w) - -0.1) < 1e-12);
  assert.equal(slope(w.slice(0, 1)), null);
});

test("trend averages each weigh-in with those of its last 7 days", () => {
  const t = trend(
    weights([
      [11, 81],
      [4, 80],
      [0, 78],
    ]),
  );
  assert.deepEqual(
    t.map((p) => p.kg),
    [81, 80, 79],
  );
});

test("too little data says what is missing", () => {
  const w = weights([
    [9, 80],
    [0, 79],
  ]);
  assert.deepEqual(
    balance({
      days: days(20, 2000),
      weights: w,
      yesterday: Y,
      goal: 0,
      current: 2000,
    }),
    { enough: false, foodDays: 20, span: 9 },
  );
  // Days before the window and days without energy don't count.
  const old = days(40, 2000).slice(0, 12);
  assert.equal(
    balance({ days: old, weights: [], yesterday: Y, goal: 0, current: null })
      .foodDays,
    0,
  );
});

test("the target is intake minus the trend's energy, plus the goal", () => {
  // Losing 0.1 kg a day on 2,000 kcal: you use 2,770 a day. Aiming to lose
  // 0.5 kg a week: 2,770 − 550 = 2,220.
  const w = weights([
    [20, 80],
    [10, 79],
    [0, 78],
  ]);
  const b = balance({
    days: days(14, 2000),
    weights: w,
    yesterday: Y,
    goal: -0.5,
    current: 2000,
  });
  assert.equal(b.enough, true);
  assert.equal(b.intake, 2000);
  assert.ok(Math.abs(b.perWeek - -0.7) < 1e-9);
  assert.ok(Math.abs(b.tdee - 2770) < 1e-6);
  assert.equal(b.target, 2220);
  assert.equal(b.offer, true);
  // Within 50 kcal of the current target: nothing to change.
  assert.equal(
    balance({
      days: days(14, 2000),
      weights: w,
      yesterday: Y,
      goal: -0.5,
      current: 2200,
    }).offer,
    false,
  );
  // Never below 1,200 kcal.
  assert.equal(
    balance({
      days: days(14, 400),
      weights: w,
      yesterday: Y,
      goal: -1,
      current: null,
    }).offer,
    false,
  );
});

test("the balance's sentence never gives a goal under 1,200 kcal as a plan", () => {
  const w = weights([
    [20, 80],
    [10, 79],
    [0, 78],
  ]);
  // Spaces as read: amounts keep their unit on the line (NBSP).
  const at = (kcal, goal) =>
    balanceText(
      balance({
        days: days(14, kcal),
        weights: w,
        yesterday: Y,
        goal,
        current: null,
      }),
    ).replaceAll("\u00a0", " ");
  assert.equal(
    at(2000, -0.5),
    "You ate 2,000 kcal a day and your trend fell 0.7 kg a week: you use about 2,770 kcal a day. For your goal: 2,220 kcal.",
  );
  // 400 + 770 − 1,100 = 70 kcal: not said, a slower goal is.
  const low = at(400, -1);
  assert.equal(
    low,
    "You ate 400 kcal a day and your trend fell 0.7 kg a week: you use about 1,170 kcal a day. Your goal would need under 1,200 kcal a day: a slower goal is safer.",
  );
});

test("protein stays; carbohydrate and fat scale with the energy", () => {
  const before = [
    { metric: "energy", value: 2000 },
    { metric: "protein", value: 100 },
    { metric: "net_carbs", value: 200 },
    { metric: "fat", value: 70 },
    { metric: "fiber", value: 30 },
  ];
  // After protein's 400 kcal: 1,600 → 2,000, × 1.25.
  assert.deepEqual(withEnergy(before, 2400), [
    { metric: "energy", value: 2400 },
    { metric: "protein", value: 100 },
    { metric: "net_carbs", value: 250 },
    { metric: "fat", value: 88 },
    { metric: "fiber", value: 30 },
  ]);
  // No energy target yet: it's added, the rest stays.
  assert.deepEqual(withEnergy([{ metric: "fat", value: 70 }], 2100), [
    { metric: "fat", value: 70 },
    { metric: "energy", value: 2100 },
  ]);
});

// Daily weigh-ins for 40 days up to Y, moving `perDay` kg a day to `end`:
// every trend point in the window averages 7 days, so the trend is a line
// 3 days behind (at Y: end − 3·perDay).
const line = (end, perDay) =>
  weights(Array.from({ length: 41 }, (_, ago) => [ago, end - perDay * ago]));

test("projection: the day the trend reaches the goal, around", () => {
  // Losing 0.1 kg a day; the trend is at 78.3 on Y.
  const losing = line(78, -0.1);
  assert.deepEqual(projection(losing, 77.3, Y), {
    kind: "on",
    day: shift(Y, 10),
  });
  // Gaining works the same way.
  assert.deepEqual(projection(line(60, 0.2), 61.4, Y), {
    kind: "on",
    day: shift(Y, 10),
  });
});

test("projection: reached, moving away, too slow, flat or too few", () => {
  const losing = line(78, -0.1);
  assert.deepEqual(projection(losing, 78.35, Y), { kind: "reached" });
  assert.deepEqual(projection(losing, 85, Y), { kind: "away" });
  // 0.01 kg a day toward a goal 8 kg off: over 2 years.
  assert.deepEqual(projection(line(78, -0.01), 70, Y), { kind: "far" });
  // Flat: under 0.05 kg a week.
  assert.deepEqual(projection(line(78, -0.005), 70, Y), { kind: "unclear" });
  // Two weigh-ins under 10 days apart, none at all, or only old ones.
  assert.deepEqual(
    projection(
      weights([
        [9, 80],
        [0, 78],
      ]),
      70,
      Y,
    ),
    { kind: "unclear" },
  );
  assert.deepEqual(projection([], 70, Y), { kind: "unclear" });
  assert.deepEqual(
    projection(
      weights([
        [60, 90],
        [30, 85],
      ]),
      70,
      Y,
    ),
    { kind: "unclear" },
  );
  // 10 days apart is enough.
  assert.equal(
    projection(
      weights([
        [10, 80],
        [0, 78],
      ]),
      70,
      Y,
    ).kind,
    "on",
  );
});
