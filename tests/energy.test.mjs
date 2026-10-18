// The adaptive energy target's rules (web/energy.mjs).

import assert from "node:assert/strict";
import test from "node:test";

import { waterOf } from "../web/coverage.mjs";
import { pretty, shift, weekStart } from "../web/dates.mjs";
import {
  balance,
  balanceRange,
  balanceWhy,
  plan,
  projection,
  slope,
  tracksWeight,
  trend,
  trendPer,
  weeklyRate,
  withEnergy,
} from "../web/energy.mjs";
import { needed, sure } from "../web/expenditure.mjs";

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

test("trend takes any series: {day, value} as well as {day, kg}", () => {
  const t = trend(
    [
      { day: "2026-09-01", value: 40 },
      { day: "2026-09-03", value: 50 },
      { day: "2026-09-08", value: 60 },
    ],
    "value",
  );
  assert.deepEqual(t, [
    { day: "2026-09-01", value: 40 },
    { day: "2026-09-03", value: 45 },
    { day: "2026-09-08", value: 55 },
  ]);
});

test("a week's or month's trend is the trend at its last day", () => {
  const t = trend(
    [
      { day: "2026-08-31", value: 10 },
      { day: "2026-09-02", value: 20 },
      { day: "2026-09-07", value: 30 },
      { day: "2026-09-09", value: 40 },
    ],
    "value",
  );
  // Weeks from Monday: Aug 31 holds Sep 2; Sep 7 holds Sep 9.
  assert.deepEqual(
    [...trendPer(t, weekStart)].map(([key, p]) => [key, p.day, p.value]),
    [
      ["2026-08-31", "2026-09-02", 15],
      ["2026-09-07", "2026-09-09", 35],
    ],
  );
  assert.deepEqual(
    [...trendPer(t, (day) => day.slice(0, 7))].map(([key, p]) => [
      key,
      p.value,
    ]),
    [
      ["2026-08", 10],
      ["2026-09", 35],
    ],
  );
});

test("too little data says what is missing", () => {
  const w = weights([
    [9, 80],
    [0, 79],
  ]);
  assert.deepEqual(
    balance({ days: days(20, 2000), weights: w, yesterday: Y }),
    { enough: false, foodDays: 20, span: 9 },
  );
  // Days before the window and days without energy don't count.
  const old = days(40, 2000).slice(0, 12);
  assert.equal(balance({ days: old, weights: [], yesterday: Y }).foodDays, 0);
});

test("maintenance is intake minus the trend's energy; the balance offers nothing", () => {
  // Losing 0.1 kg a day on 2,000 kcal: maintenance is 2,770 a day.
  const w = weights([
    [20, 80],
    [10, 79],
    [0, 78],
  ]);
  const b = balance({ days: days(14, 2000), weights: w, yesterday: Y });
  assert.deepEqual(Object.keys(b).toSorted(), [
    "enough",
    "intake",
    "maintenance",
    "perWeek",
    "spread",
  ]);
  assert.equal(b.enough, true);
  assert.equal(b.intake, 2000);
  assert.ok(Math.abs(b.perWeek - -0.7) < 1e-9);
  assert.ok(Math.abs(b.maintenance - 2770) < 1e-6);
  // Weigh-ins on a line: no scatter, so no range.
  assert.ok(Math.abs(b.spread) < 1e-6);
  // Sure: nothing to explain.
  assert.equal(balanceWhy(b, sure(b, null)), null);
});

test("why the balance isn't maintenance yet is said as its reason (item 18)", () => {
  // Five days of food, two weigh-ins three days apart: 9 more days of
  // food, 7 more of weigh-ins.
  const short = balance({
    days: days(5, 2000),
    weights: weights([
      [3, 80],
      [0, 79.8],
    ]),
    yesterday: Y,
  });
  assert.equal(
    balanceWhy(short, false),
    "Your weight trend is too short to say: about 2 more weeks of food and weigh-ins.",
  );
  // Food enough, weigh-ins too close together.
  const span = balance({
    days: days(20, 2000),
    weights: weights([
      [1, 80],
      [0, 79.8],
    ]),
    yesterday: Y,
  });
  assert.equal(
    balanceWhy(span, false),
    "Your weight trend is too short to say: about 2 more weeks of weigh-ins.",
  );
});

// The standard error of a least-squares slope, written out.
function slopeSe(points) {
  const xs = points.map(
    (p) => (Date.parse(p.day) - Date.parse(points[0].day)) / 864e5,
  );
  const ys = points.map((p) => p.kg);
  const n = xs.length;
  const mx = xs.reduce((t, x) => t + x, 0) / n;
  const my = ys.reduce((t, y) => t + y, 0) / n;
  const sxx = xs.reduce((t, x) => t + (x - mx) ** 2, 0);
  const b = xs.reduce((t, x, i) => t + (x - mx) * (ys[i] - my), 0) / sxx;
  const sse = xs.reduce((t, x, i) => t + (ys[i] - my - b * (x - mx)) ** 2, 0);
  return Math.sqrt(sse / (n - 2) / sxx);
}

test("maintenance follows the 7-day trend's slope; its range is the weigh-ins' 95 %", () => {
  // Daily weigh-ins losing 0.05 kg a day, the last day's up 1.5 kg (a
  // salty dinner's water): the raw line bends to it, the trend barely.
  const w = weights(
    Array.from({ length: 34 }, (_, ago) => [
      ago,
      80 + 0.05 * ago + (ago ? 0 : 1.5),
    ]),
  );
  const b = balance({ days: days(28, 2000), weights: w, yesterday: Y });
  const { start } = balanceRange(Y);
  const raw = w.filter((x) => x.day >= start);
  const trended = trend(w).filter((x) => x.day >= start);
  assert.ok(Math.abs(b.maintenance - (2000 - slope(trended) * 7700)) < 1e-6);
  assert.ok(
    Math.abs(b.maintenance - (2000 - slope(raw) * 7700)) > 50,
    "not the raw weigh-ins' slope",
  );
  assert.ok(Math.abs(b.spread - 1.96 * slopeSe(raw) * 7700) < 1e-6);
  assert.equal(sure(b, null), b.spread <= 250);
  // Two weigh-ins have no scatter to judge: never sure.
  const two = balance({
    days: days(14, 2000),
    weights: weights([
      [20, 80],
      [0, 78],
    ]),
    yesterday: Y,
  });
  assert.equal(two.spread, Infinity);
  assert.equal(sure(two, null), false);
  assert.equal(
    balanceWhy(two, false),
    "Too few weigh-ins to read your weight trend yet.",
  );
  // Weigh-ins swinging ± 1.5 kg around a flat line: too wide to use.
  const noisy = balance({
    days: days(28, 2000),
    weights: weights(
      Array.from({ length: 28 }, (_, ago) => [
        ago,
        80 + (ago % 2 ? 1.5 : -1.5),
      ]),
    ),
    yesterday: Y,
  });
  assert.ok(noisy.spread > 250, String(noisy.spread));
  assert.equal(sure(noisy, null), false);
  assert.match(
    balanceWhy(noisy, false),
    /^Your weigh-ins vary too much to read your weight trend yet \(±\s[\d,]+\skcal\)\.$/u,
  );
});

// A man of 80 kg, 180 cm, born 1990, moderately active, losing 0.5 kg a
// week; the day after Y.
const MAN = {
  sex: "male",
  birth_date: "1990-10-08",
  height_cm: 180,
  activity: 1.6,
  goal_kg_per_week: -0.5,
  goal_date: null,
  latest_weight_kg: 78,
};
const T = shift(Y, 1);

test("summary offer equals needed(): one target, from maintenance", () => {
  const w = weights([
    [20, 80],
    [10, 79],
    [0, 78],
  ]);
  const p = plan({
    profile: MAN,
    byKey: {},
    days: days(14, 2000),
    weights: w,
    readings: [],
    deviceDays: [],
    activities: [],
    today: T,
  });
  assert.deepEqual(p.maintenance.source, "balance");
  assert.ok(Math.abs(p.maintenance.kcal - 2770) < 1e-6);
  // The same target needed() gives for that maintenance: 2,770 − 550.
  const n = needed({
    today: T,
    weight: 78,
    bf: null,
    goalWeight: null,
    goalBf: null,
    goalDate: null,
    goalKgPerWeek: -0.5,
    maintenance: p.maintenance.kcal,
    bmr: 1730,
    sex: "male",
  });
  assert.equal(p.needed.target, n.target);
  assert.equal(p.needed.target, 2220);
  // Never under the floor: 400 kcal eaten is a 1,170 maintenance, and
  // the offer is the floor, not 620.
  const low = plan({
    profile: MAN,
    byKey: {},
    days: days(14, 400),
    weights: w,
    readings: [],
    deviceDays: [],
    activities: [],
    today: T,
  });
  assert.ok(low.needed.target >= 1500, String(low.needed.target));
});

test("plan: without history, maintenance is resting × activity level", () => {
  const p = plan({
    profile: MAN,
    byKey: {},
    days: [],
    weights: [{ day: T, kg: 78 }],
    readings: [],
    deviceDays: [],
    activities: [],
    today: T,
  });
  assert.equal(p.maintenance.source, "pal");
  // Mifflin at 36: 10·78 + 6.25·180 − 5·36 + 5 = 1,730; × 1.6.
  assert.ok(Math.abs(p.maintenance.kcal - 1730 * 1.6) < 1e-6);
  assert.equal(p.needed.target, Math.round((1730 * 1.6 - 550) / 10) * 10);
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
  // A protein floor (recomposition) raises protein; carbohydrate and fat
  // share what's left: 2,000 − 4·150 = 1,400 of 1,600, × 0.875.
  assert.deepEqual(withEnergy(before, 2000, 150), [
    { metric: "energy", value: 2000 },
    { metric: "protein", value: 150 },
    { metric: "net_carbs", value: 175 },
    { metric: "fat", value: 61 },
    { metric: "fiber", value: 30 },
  ]);
  // Never lowered by it.
  assert.equal(
    withEnergy(before, 2000, 80).find((t) => t.metric === "protein").value,
    100,
  );
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
  // Flat: under 0.05 kg a week, told apart from too few.
  assert.deepEqual(projection(line(78, -0.005), 70, Y), { kind: "flat" });
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

// `n` days up to Y, `kg(i)` the weight on the i-th (0 the oldest).
const span = (n, kg) =>
  Array.from({ length: n }, (_, i) => ({
    day: shift(Y, i - n + 1),
    kg: kg(i),
  }));

test("tracksWeight: |r| > 0.9 on 10 reading days or more", () => {
  const w = span(12, (i) => 80 - 0.2 * i + (i % 3) * 0.3);
  // A share moving with weight (a scale's estimate from weight and water).
  const follows = w.map((x) => ({ day: x.day, value: x.kg * 0.5 }));
  assert.equal(tracksWeight(follows, w), true);
  assert.equal(
    tracksWeight(
      follows.map((x) => ({ ...x, value: -x.value })),
      w,
    ),
    true,
    "negative r tracks too",
  );
  // 9 reading days aren't enough to judge.
  assert.equal(tracksWeight(follows.slice(3), w), false);
  // A share of its own: no.
  const own = w.map((x, i) => ({ day: x.day, value: 30 + (i % 2) }));
  assert.equal(tracksWeight(own, w), false);
});

// The man of 80 kg on 2,500 kcal, resting 1,750, at 40 % muscle.
const BODY = {
  today: T,
  weight: 80,
  bf: 20,
  muscle: 40,
  goalWeight: null,
  goalBf: null,
  goalMuscle: null,
  goalDate: null,
  goalKgPerWeek: 0,
  maintenance: 2500,
  bmr: 1750,
  sex: "male",
};
const close = (got, want, tol = 1e-6) =>
  assert.ok(Math.abs(got - want) <= tol, `${got} ≠ ${want}`);

test("needed: goal weight + muscle, at a realistic gain without a date", () => {
  // 80 kg → 80 kg at 42.5 %: muscle +2 kg, fat −2 kg.
  const n = needed({ ...BODY, goalWeight: 80, goalMuscle: 42.5 });
  close(n.split.lean, 2);
  close(n.split.fat, -2);
  // 2 kg at 0.5 kg a month (men) is 122 days.
  const gainDays = Math.ceil((2 / 0.5) * 30.44);
  assert.equal(gainDays, 122);
  assert.deepEqual(n.muscle, { kg: n.split.lean, day: shift(T, gainDays) });
  // Fat × 9440 + muscle × 1816 × 1.5 (synthesis), over those days.
  close(n.perDay, (-2 * 9440 + 2 * 1816 * 1.5) / gainDays);
  assert.equal(n.target, Math.round((2500 + n.perDay) / 10) * 10);
  // In a deficit, protein at 2.2 g a kg of goal weight.
  close(n.protein, 2.2 * 80);
  assert.deepEqual(n.clamps, []);
  // A woman's realistic gain is half: twice the days.
  const her = needed({
    ...BODY,
    sex: "female",
    goalWeight: 80,
    goalMuscle: 42.5,
  });
  assert.equal(her.muscle.day, shift(T, Math.ceil((2 / 0.25) * 30.44)));
});

test("needed: a muscle goal date too soon plans at the realistic pace and names its date", () => {
  const n = needed({
    ...BODY,
    goalWeight: 80,
    goalMuscle: 42.5,
    goalDate: shift(T, 30),
  });
  assert.equal(n.muscle.day, shift(T, 122));
  assert.equal(n.clamps.length, 1);
  assert.match(n.clamps[0], /faster than realistic/u);
  assert.ok(n.clamps[0].includes(pretty(shift(T, 122))), n.clamps[0]);
});

test("needed: muscle by the weight pace; a surplus asks 1.6 g protein a kg", () => {
  // 80 → 82 kg at 40 %: muscle +0.8, fat +1.2; 0.25 kg a week is 56 days,
  // past the realistic 49.
  const n = needed({
    ...BODY,
    goalWeight: 82,
    goalMuscle: 40,
    goalKgPerWeek: 0.25,
  });
  close(n.split.lean, 0.8);
  close(n.split.fat, 1.2);
  assert.equal(n.muscle.day, shift(T, 56));
  close(n.weeklyKg, 0.25);
  close(n.perDay, (1.2 * 9440 + 0.8 * 1816 * 1.5) / 56);
  close(n.protein, 1.6 * 82);
  assert.deepEqual(n.clamps, []);
});

test("needed: body fat + muscle keeps the rest's mass; muscle alone or all three isn't planned by it", () => {
  // Rest 80 × (1 − 0.6) = 32 kg; at 15 % fat and 42 % muscle it is 43 %.
  const n = needed({ ...BODY, goalBf: 15, goalMuscle: 42 });
  close(n.goalKg, 32 / 0.43);
  close(n.split.fat, (n.goalKg * 15) / 100 - 16);
  close(n.split.lean, (n.goalKg * 42) / 100 - 32);
  // Muscle to lose, no date, no pace: maintenance.
  assert.equal(n.target, 2500);
  assert.match(n.clamps.at(-1), /No goal date or pace/u);
  // Without a muscle reading (or body fat without a goal weight): none.
  assert.equal(
    needed({ ...BODY, muscle: null, goalBf: 15, goalMuscle: 42 }),
    null,
  );
  assert.equal(needed({ ...BODY, bf: null, goalBf: 15, goalMuscle: 42 }), null);
  // Muscle alone, and all three: by weight, muscle said unplanned.
  const alone = needed({ ...BODY, goalMuscle: 42 });
  assert.equal(alone.muscle, null);
  assert.match(alone.clamps[0], /plans with a goal weight or a body-fat goal/u);
  const three = needed({
    ...BODY,
    goalWeight: 78,
    goalBf: 18,
    goalMuscle: 42,
    goalDate: shift(T, 120),
  });
  assert.equal(three.muscle, null);
  assert.match(three.clamps[0], /Three goals/u);
});

// A target `metric` at `value`, as byKey holds it.
const goal = (metric, value) => ({ [metric]: { metric, value } });

test("plan: a scale share following weight plans from goal weight alone", () => {
  // 30 days of weigh-ins and scale readings; muscle % rises and falls
  // with weight (|r| = 1), body fat doesn't.
  const w = span(30, (i) => 80 + (i % 5) * 0.4);
  const readings = w.map((x, i) => ({
    day: x.day,
    muscle: x.kg / 2,
    body_fat: 20 + (i % 2) * 0.5,
  }));
  const at = (byKey) =>
    plan({
      profile: MAN,
      byKey,
      days: days(28, 2500),
      weights: w,
      readings,
      deviceDays: [],
      activities: [],
      today: T,
    });
  const both = at({ ...goal("goal_weight", 82), ...goal("goal_muscle", 45) });
  assert.deepEqual(both.tracked, { body_fat: false, muscle: true });
  assert.equal(both.weightOnly, true);
  assert.equal(both.needed.muscle, null, "planned from goal weight alone");
  assert.equal(both.needed.split, null);
  // Body fat + a tracked muscle, no goal weight: nothing to plan from.
  const noWeight = at({
    ...goal("goal_body_fat", 18),
    ...goal("goal_muscle", 45),
  });
  assert.equal(noWeight.weightOnly, true);
  assert.equal(noWeight.needed, null);
  // One goal: never weight-only.
  assert.equal(at(goal("goal_muscle", 45)).weightOnly, false);
  // An untracked share plans by composition.
  const own = readings.map((r, i) => ({ ...r, muscle: 40 + (i % 2) }));
  const p = plan({
    profile: MAN,
    byKey: { ...goal("goal_weight", 82), ...goal("goal_muscle", 45) },
    days: days(28, 2500),
    weights: w,
    readings: own,
    deviceDays: [],
    activities: [],
    today: T,
  });
  assert.deepEqual(p.tracked, { body_fat: false, muscle: false });
  assert.equal(p.weightOnly, false);
  assert.ok(p.needed.muscle, "composition");
  // Weight the 7-day trend's; muscle the mean of the last 3 reading days.
  const m = own.slice(-3).reduce((t, r) => t + r.muscle, 0) / 3;
  close(p.needed.split.lean, (82 * 45 - trend(w).at(-1).kg * m) / 100);
});

test("weeklyRate: a rate only over two weeks, clear only past its margin (B-6)", () => {
  // Oct 1–13: 12 days apart, too short for a rate whatever the scatter.
  const short = weights(
    [77.2, 77.6, 76.9, 77.5, 77.0, 77.8, 77.1, 77.6, 77.3, 77.4].map(
      (kg, i) => [12 - Math.round((i * 12) / 9), kg],
    ),
  );
  assert.equal(weeklyRate(short), null);
  // 20 days of water swings around a flat line: no clear change.
  const swings = weights(
    Array.from({ length: 21 }, (_, ago) => [ago, 77 + (ago % 2 ? 0.6 : -0.6)]),
  );
  const flat = weeklyRate(swings);
  assert.equal(flat.clear, false);
  assert.ok(flat.margin > Math.abs(flat.perWeek));
  // A steady loss of 0.1 kg a day with a little scatter: clear.
  const losing = weights(
    Array.from({ length: 21 }, (_, ago) => [
      ago,
      77 + 0.1 * ago + (ago % 2) * 0.1,
    ]),
  );
  const rate = weeklyRate(losing);
  assert.equal(rate.clear, true);
  assert.ok(Math.abs(rate.perWeek + 0.7) < 0.05, `${rate.perWeek}`);
});

// ------------------------------------------------------ decision edges

test("needed: composition's branches, a loss, a share past 100 %, a pace away (TEST11-5)", () => {
  // Muscle to lose by a date 90 days out: 80 → 78 kg at 38 % muscle,
  // muscle −1.36 kg, fat the rest; a loss costs no synthesis (no × 1.5).
  const n = needed({
    ...BODY,
    goalWeight: 78,
    goalMuscle: 38,
    goalDate: shift(T, 90),
  });
  const muscle = (78 * 38 - 80 * 40) / 100;
  close(n.split.lean, muscle);
  close(n.perDay, ((-2 - muscle) * 9440 + muscle * 1816) / 90);
  close(n.protein, 2.2 * 78);
  // Goal body fat and muscle leaving no room for the rest: none.
  assert.equal(needed({ ...BODY, goalBf: 60, goalMuscle: 45 }), null);
  // A pace away from the goal weight, no date, no muscle to gain: at
  // maintenance, its protein not a deficit's.
  const away = needed({
    ...BODY,
    goalWeight: 75,
    goalMuscle: 40,
    goalKgPerWeek: 0.5,
  });
  assert.equal(away.perDay, 0);
  assert.equal(away.target, BODY.maintenance);
  assert.deepEqual(away.clamps, [
    "No goal date or pace: planned at maintenance.",
  ]);
  close(away.protein, 1.6 * 75);
});

test("withEnergy: never a negative macro; a protein floor adds protein (TEST11-5)", () => {
  // 500 kcal leaves nothing after 150 g of protein: carbs and fat stay.
  const list = withEnergy(
    [
      { metric: "energy", value: 2000 },
      { metric: "protein", value: 150 },
      { metric: "net_carbs", value: 200 },
      { metric: "fat", value: 60 },
    ],
    500,
  );
  assert.ok(
    list.every((t) => t.value >= 0),
    JSON.stringify(list),
  );
  assert.equal(list.find((t) => t.metric === "net_carbs").value, 200);
  // Without a protein target, the floor adds one.
  assert.deepEqual(withEnergy([{ metric: "energy", value: 2000 }], 1800, 144), [
    { metric: "energy", value: 1800 },
    { metric: "protein", value: 144 },
  ]);
});

test("balance: a water-only day is no food day (TEST11-5)", () => {
  const w = weights([
    [20, 80],
    [10, 79],
    [0, 78],
  ]);
  // 14 food days at 2,000 and 6 days of water alone inside the window.
  const water = Array.from({ length: 6 }, (_, i) => ({
    day: shift(Y, -14 - i),
    total: { energy: 0, water: 500 },
  }));
  const b = balance({
    days: [...water.toReversed(), ...days(14, 2000)],
    weights: w,
    yesterday: Y,
  });
  assert.equal(b.intake, 2000);
  assert.ok(Math.abs(b.maintenance - 2770) < 1e-6);
});

test("energy.mjs edges, each on both sides (TEST11-13)", () => {
  // Weigh-ins exactly 10 days apart are enough; 9 aren't.
  const enoughAt = (ago) =>
    balance({
      days: days(14, 2000),
      weights: weights([
        [ago, 80],
        [0, 79],
      ]),
      yesterday: Y,
    }).enough;
  assert.equal(enoughAt(10), true);
  assert.equal(enoughAt(9), false);
  // Why: 7 days short reads as a week; food alone names food; a balance
  // that doesn't add up asks about meals.
  assert.equal(
    balanceWhy({ enough: false, foodDays: 7, span: 10 }, false),
    "Your weight trend is too short to say: about 1 more week of food logged.",
  );
  assert.equal(
    balanceWhy({ enough: false, foodDays: 8, span: 10 }, false),
    "Your weight trend is too short to say: about 6 more days of food logged.",
  );
  assert.equal(
    balanceWhy({ enough: true, spread: 100 }, false),
    "What you ate and how your weight moved don't add up yet: is every meal logged?",
  );
  // A rate needs weigh-ins 14 days apart; 13 aren't.
  const rate = (ago) =>
    weeklyRate(
      weights([
        [ago, 80],
        [5, 79.5],
        [0, 79],
      ]),
    );
  assert.notEqual(rate(14), null);
  assert.equal(rate(13), null);
  // r exactly 0.9 doesn't track (over it does): deviations with Σx² =
  // Σy² = 10 and Σxy = 9, so r = 9 / 10.
  const dx = [2, -2, 1, -1, 0, 0, 0, 0, 0, 0];
  const dy = [2, -2, 1, 0, -1, 0, 0, 0, 0, 0];
  const at = (i) => shift(Y, i - 9);
  assert.equal(
    tracksWeight(
      dx.map((d, i) => ({ day: at(i), value: 30 + d })),
      dy.map((d, i) => ({ day: at(i), kg: 80 + d })),
    ),
    false,
  );
  // A goal exactly 0.1 kg from the trend is reached (0 and 0.1: exact in
  // binary, which 78.3 and 78.4 aren't).
  assert.deepEqual(projection([{ day: Y, kg: 0 }], 0.1, Y), {
    kind: "reached",
  });
  assert.notDeepEqual(projection([{ day: Y, kg: 0 }], 0.11, Y), {
    kind: "reached",
  });
  // A drink's water: its grams less total carbohydrate, which net carbs
  // plus fibre make when it isn't given.
  assert.equal(waterOf({ net_carbs: 10, fiber: 2 }, 100, true), 88);
  assert.equal(waterOf({ carbs: 12, net_carbs: 10 }, 100, true), 88);
});

test("plan: resting from Health Connect when served, its source and origin said", () => {
  const resting = [
    { day: T, kcal: 1900, origin: "com.sec.android.app.shealth" },
  ];
  const p = plan({
    profile: MAN,
    byKey: {},
    days: [],
    weights: [{ day: T, kg: 78 }],
    readings: [],
    deviceDays: [],
    resting,
    activities: [],
    today: T,
  });
  assert.equal(p.bmr, 1900);
  assert.deepEqual(p.resting, {
    kcal: 1900,
    source: "health_connect",
    origin: "com.sec.android.app.shealth",
  });
  // The energy target follows it: × activity level, less the pace.
  assert.ok(Math.abs(p.maintenance.kcal - 1900 * 1.6) < 1e-6);
  assert.equal(p.needed.target, Math.round((1900 * 1.6 - 550) / 10) * 10);
});
