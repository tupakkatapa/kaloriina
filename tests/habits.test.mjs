// Habit numbers (web/habits.mjs: one shape for every habit, amounts, a
// period's stats) and the calendar grids they draw on
// (web/calendar-grid.mjs: shade steps, quartiles, the Monday-first grids).

import assert from "node:assert/strict";
import test from "node:test";

import {
  monthGrid,
  quartiles,
  step,
  weekRow,
  yearMonths,
} from "../web/calendar-grid.mjs";
import { daysIn } from "../web/dates.mjs";
import {
  amountText,
  builtinHabit,
  habitSeries,
  rowsOf,
  summaryHabits,
  trackerHabit,
  reachedStep,
  stats,
  waterText,
} from "../web/habits.mjs";

// The days are calendar days whatever the zone; Helsinki has DST.
process.env.TZ = "Europe/Helsinki";

test("steps: none, then each bound includes its own amount", () => {
  const alcohol = [1, 3, 5];
  for (const [amount, want] of [
    [0, 0],
    [undefined, 0],
    [0.5, 1],
    [1, 1],
    [1.01, 2],
    [3, 2],
    [5, 3],
    [5.1, 4],
    [40, 4],
  ])
    assert.equal(step(amount, alcohol), want, `${amount}`);
  const caffeine = [100, 250, 400];
  assert.deepEqual(
    [100, 101, 250, 400, 401].map((a) => step(a, caffeine)),
    [1, 2, 2, 3, 4],
  );
});

test("quartiles of the non-zero amounts, by nearest rank", () => {
  assert.deepEqual(quartiles([0, 1, 2, 3, 4, 5, 6, 7, 8]), [2, 4, 6]);
  assert.deepEqual(quartiles([4, 3, 2, 1]), [1, 2, 3]);
  // Repeats count: most days were 1.
  assert.deepEqual(quartiles([1, 1, 1, 1, 1, 1, 2, 3, 4, 5]), [1, 1, 3]);
  const b = quartiles([10, 1, 5, 2]);
  assert.deepEqual(
    [1, 2, 5, 10].map((a) => step(a, b)),
    [1, 2, 3, 4],
  );
});

// Each distinct amount's step, smallest first.
const steps = (amounts) => {
  const b = quartiles(amounts);
  return [...new Set(amounts)].toSorted((x, y) => x - y).map((a) => step(a, b));
};

test("fewer than 4 distinct amounts rank by value, the largest darkest", () => {
  assert.deepEqual(steps([4, 4, 4]), [4]);
  assert.deepEqual(steps([2, 5, 2]), [3, 4]);
  assert.deepEqual(steps([1, 2, 3]), [2, 3, 4]);
  assert.deepEqual(quartiles([]), [0, 0, 0]);
});

test("stats: total, days, peak (earliest on a tie), per week, mean, over", () => {
  const rows = [
    { day: "2026-10-09", amount: 4 },
    { day: "2026-10-03", amount: 4 },
    { day: "2026-10-05", amount: 1 },
    { day: "2026-10-06", amount: 0 },
  ];
  const s = stats(rows, { from: "2026-10-01", to: "2026-10-28", limit: 3 });
  assert.equal(s.total, 9);
  assert.equal(s.days, 3);
  assert.deepEqual(s.peak, { day: "2026-10-03", amount: 4 });
  assert.equal(s.perWeek, 9 / 4);
  assert.equal(s.mean, 3);
  assert.equal(s.over, 2);
  // Without a limit nothing is over; without rows nothing at all.
  assert.equal(
    stats(rows, { from: "2026-10-01", to: "2026-10-07" }).over,
    null,
  );
  assert.deepEqual(stats([], { from: "2026-10-05", to: "2026-10-11" }), {
    total: 0,
    days: 0,
    peak: null,
    perWeek: 0,
    mean: 0,
    over: null,
    reached: null,
  });
});

test("stats: the days a target to reach was reached, null without one", () => {
  const rows = [
    { day: "2026-10-01", amount: 2 },
    { day: "2026-10-02", amount: 1.9 },
    { day: "2026-10-03", amount: 2.4 },
  ];
  const range = { from: "2026-10-01", to: "2026-10-07" };
  assert.equal(stats(rows, { ...range, goal: 2 }).reached, 2);
  assert.equal(stats(rows, range).reached, null);
});

test("days in a period count calendar days across DST and leap years", () => {
  assert.equal(daysIn("2026-03-23", "2026-03-29"), 7);
  assert.equal(daysIn("2026-10-19", "2026-10-25"), 7);
  assert.equal(daysIn("2024-01-01", "2024-12-31"), 366);
  assert.equal(daysIn("2026-01-01", "2026-12-31"), 365);
  assert.equal(daysIn("2028-02-01", "2028-02-29"), 29);
});

test("a month grid is Monday-first, padded to whole weeks", () => {
  // October 2026 starts on a Thursday.
  const oct = monthGrid("2026-10");
  assert.equal(oct.length, 5);
  assert.deepEqual(oct[0], [
    null,
    null,
    null,
    "2026-10-01",
    "2026-10-02",
    "2026-10-03",
    "2026-10-04",
  ]);
  assert.deepEqual(oct.at(-1), [
    "2026-10-26",
    "2026-10-27",
    "2026-10-28",
    "2026-10-29",
    "2026-10-30",
    "2026-10-31",
    null,
  ]);
  // February 2027 starts on a Monday and has exactly 4 weeks.
  const feb = monthGrid("2027-02");
  assert.equal(feb.length, 4);
  assert.equal(feb[0][0], "2027-02-01");
  assert.equal(feb[3][6], "2027-02-28");
  // A leap February; a month starting on a Sunday spans 6 weeks.
  assert.equal(
    monthGrid("2028-02").flat().filter(Boolean).at(-1),
    "2028-02-29",
  );
  const mar = monthGrid("2026-03");
  assert.equal(mar.length, 6);
  assert.deepEqual(mar[0].slice(5), [null, "2026-03-01"]);
  // Every week has 7 cells.
  assert.ok(mar.every((w) => w.length === 7));
});

test("a week row runs Monday to Sunday, across DST and year ends", () => {
  // DST starts Sun 29 March 2026 and ends Sun 25 October 2026.
  assert.deepEqual(weekRow("2026-03-29"), [
    "2026-03-23",
    "2026-03-24",
    "2026-03-25",
    "2026-03-26",
    "2026-03-27",
    "2026-03-28",
    "2026-03-29",
  ]);
  assert.deepEqual(weekRow("2026-10-26"), [
    "2026-10-26",
    "2026-10-27",
    "2026-10-28",
    "2026-10-29",
    "2026-10-30",
    "2026-10-31",
    "2026-11-01",
  ]);
  assert.equal(weekRow("2026-10-25")[0], "2026-10-19");
  // 1 Jan 2027 is a Friday: its week starts in 2026.
  assert.deepEqual(
    [weekRow("2027-01-01")[0], weekRow("2027-01-01")[6]],
    ["2026-12-28", "2027-01-03"],
  );
});

test("a year is 12 month grids with every day once", () => {
  const leap = yearMonths(2028);
  assert.deepEqual(
    leap.map((m) => m.month),
    Array.from(
      { length: 12 },
      (_, i) => `2028-${String(i + 1).padStart(2, "0")}`,
    ),
  );
  const days = leap.flatMap((m) => m.weeks.flat().filter(Boolean));
  assert.equal(days.length, 366);
  assert.equal(new Set(days).size, 366);
  assert.equal(
    yearMonths(2026).flatMap((m) => m.weeks.flat().filter(Boolean)).length,
    365,
  );
});

test("steps against a target to reach: under half, ¾, it, then reached", () => {
  for (const [litres, want] of [
    [0, 0],
    [undefined, 0],
    [0.5, 1],
    [1, 2],
    [1.49, 2],
    [1.5, 3],
    [1.99, 3],
    [2, 4],
    [3, 4],
  ])
    assert.equal(reachedStep(litres, 2), want, `${litres}`);
});

// The app writes a no-break space between a number and its unit.
const nbsp = (s) => s.replaceAll(" ", " ");

// As /api/meta.habits serves them (src/model/habit.rs).
const WATER = {
  key: "water",
  name: "Water",
  unit: "L",
  one: "L",
  factor: 0.001,
  bounds: [1, 1.5, 2],
  metric: "water",
  goal_dir: "at_least",
  per: "day",
  note: null,
};
const ALCOHOL = {
  ...WATER,
  key: "alcohol",
  name: "Alcohol",
  unit: "drinks",
  one: "drink",
  factor: 1 / 12,
  bounds: [1, 3, 5],
  metric: "alcohol",
  goal_dir: "at_most",
  per: "week",
};

test("built-ins and trackers share one shape; goals in shown units", () => {
  const targets = [{ metric: "water", value: 2500 }];
  const water = builtinHabit(WATER, targets);
  assert.equal(water.id, "water");
  assert.equal(water.goal, 2.5);
  assert.equal(water.dir, "at_least");
  assert.equal(builtinHabit(ALCOHOL, targets).goal, null);
  const snus = trackerHabit({
    id: 7,
    name: "Snus",
    unit: "pouches",
    goal_value: 5,
    goal_dir: "at_most",
  });
  assert.deepEqual(
    [snus.id, snus.factor, snus.goal, snus.dir, snus.bounds],
    ["7", 1, 5, "at_most", null],
  );
});

test("amounts read in the shown unit; water under 1 L in ml", () => {
  const water = builtinHabit(WATER, []);
  assert.equal(amountText(water, 0.25), nbsp("250 ml"));
  assert.equal(amountText(water, 1.25), nbsp("1.3 L"));
  const alcohol = builtinHabit(ALCOHOL, []);
  assert.equal(amountText(alcohol, 1), nbsp("1 drink"));
  assert.equal(
    amountText(alcohol, 1.04),
    nbsp("1 drink"),
    "the word follows the number shown",
  );
  assert.equal(amountText(alcohol, 2), nbsp("2 drinks"));
});

test("water entries read like the Water habit: grams as ml, from 1 L in L", () => {
  assert.equal(waterText([ALCOHOL, WATER], 330), nbsp("330 ml"));
  assert.equal(waterText([ALCOHOL, WATER], 1000), nbsp("1 L"));
  assert.equal(waterText([ALCOHOL, WATER], 1250), nbsp("1.3 L"));
});

test("rows in shown units; series over every logged day; built-ins in the Summary only with data or a goal", () => {
  const days = [
    { habit: "water", day: "2026-10-01", amount: 1500 },
    { habit: "alcohol", day: "2026-10-01", amount: 0 },
    { habit: "water", day: "2026-10-02", amount: 500 },
    { habit: "alcohol", day: "2026-10-02", amount: 24 },
    { habit: "7", day: "2026-10-03", amount: 3 },
  ];
  const habits = [
    builtinHabit(WATER, []),
    builtinHabit(ALCOHOL, []),
    builtinHabit({ ...ALCOHOL, key: "caffeine", name: "Caffeine" }, []),
    trackerHabit({ id: 7, name: "Snus", unit: "x", goal_value: null }),
  ];
  assert.deepEqual(rowsOf(habits[1], days), [
    { day: "2026-10-01", amount: 0 },
    { day: "2026-10-02", amount: 2 },
  ]);
  const s = habitSeries(habits, days)["habit:alcohol"];
  assert.deepEqual(s.samples, ["2026-10-01", "2026-10-02", "2026-10-03"]);
  assert.equal(s.values.get("2026-10-02"), 2);
  assert.deepEqual(
    summaryHabits(habits, days).map((x) => x.id),
    ["water", "alcohol", "7"],
  );
  const withGoal = [builtinHabit(WATER, [{ metric: "water", value: 2000 }])];
  assert.equal(summaryHabits(withGoal, []).length, 1);
});
