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
  builtinHabit,
  cellText,
  countText,
  floorsOf,
  goalWords,
  habitAmountText,
  habitSeries,
  hydrationGoal,
  localBuiltin,
  meanTile,
  reachedStep,
  rowsOf,
  stats,
  summaryHabits,
  trackerHabit,
  waterText,
} from "../web/habits.mjs";
import { setRegistry } from "../web/nutrients.mjs";

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

test("stats: total, days, peak (earliest on a tie), per logged day and week, over", () => {
  const rows = [
    { day: "2026-10-09", amount: 4 },
    { day: "2026-10-03", amount: 4 },
    { day: "2026-10-05", amount: 1 },
    { day: "2026-10-06", amount: 0 },
  ];
  const s = stats(rows, { limit: 3 });
  assert.equal(s.total, 9);
  assert.equal(s.days, 3);
  assert.deepEqual(s.peak, { day: "2026-10-03", amount: 4 });
  // Over the logged days, a logged 0 included (4), never the
  // days with any (3, inflated) nor the calendar days (deflated).
  assert.equal(s.logged, 4);
  assert.equal(s.mean, 9 / 4);
  assert.equal(s.perWeek, (9 * 7) / 4);
  assert.equal(s.over, 2);
  // Without a limit nothing is over; without rows nothing at all.
  assert.equal(stats(rows, {}).over, null);
  assert.deepEqual(stats([], {}), {
    total: 0,
    days: 0,
    logged: 0,
    peak: null,
    perWeek: 0,
    mean: 0,
    over: null,
    reached: null,
    partial: false,
  });
});

test("stats: an unknown day is no 0: means over the known days, totals at least the floors (AC2-1)", () => {
  // The owner's Oct 5–11: drinks on known days, and Oct 10 unknown with
  // ≥ 13.1 drinks (a Moscow mule without its alcohol set).
  const rows = [
    { day: "2026-10-05", amount: 2 },
    { day: "2026-10-06", amount: 0 },
  ];
  const floors = [{ day: "2026-10-10", amount: 13.1 }];
  const s = stats(rows, { limit: 5, logged: 2, floors });
  assert.equal(s.mean, 1);
  assert.equal(s.perWeek, 7);
  assert.equal(s.total, 15.1);
  assert.equal(s.days, 2);
  assert.deepEqual(s.peak, { day: "2026-10-10", amount: 13.1 });
  assert.equal(s.over, 1);
  assert.equal(s.partial, true);
});

test("stats: a given count of logged days divides the mean and the week", () => {
  // The owner's September: 22 logged days of 28 elapsed, 67 drinks. The
  // unlogged 6 are missing, not 0: 21.3 a week, not 16.75.
  const rows = [{ day: "2026-09-05", amount: 67 }];
  const s = stats(rows, { logged: 22 });
  assert.equal(s.mean, 67 / 22);
  assert.equal(s.perWeek, (67 * 7) / 22);
  // No logged day: nothing divides, nothing reads Infinity.
  assert.equal(stats(rows, { logged: 0 }).perWeek, 0);
  assert.equal(stats(rows, { logged: 0 }).mean, 0);
});

test("stats: the days a target to reach was reached, null without one", () => {
  const rows = [
    { day: "2026-10-01", amount: 2 },
    { day: "2026-10-02", amount: 1.9 },
    { day: "2026-10-03", amount: 2.4 },
  ];
  assert.equal(stats(rows, { goal: 2 }).reached, 2);
  // A goal of the day (hydration's grows with activity).
  assert.equal(
    stats(rows, { goal: (day) => (day === "2026-10-03" ? 3 : 1.9) }).reached,
    2,
  );
  assert.equal(stats(rows, {}).reached, null);
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
  assert.equal(habitAmountText(water, 0.25), nbsp("250 ml"));
  assert.equal(habitAmountText(water, 1.25), nbsp("1.3 L"));
  const alcohol = builtinHabit(ALCOHOL, []);
  assert.equal(habitAmountText(alcohol, 1), nbsp("1 drink"));
  assert.equal(
    habitAmountText(alcohol, 1.04),
    nbsp("1 drink"),
    "the word follows the number shown",
  );
  assert.equal(habitAmountText(alcohol, 2), nbsp("2 drinks"));
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
  // A built-in's samples are its own days (food logged); a tracker's every
  // logged day.
  assert.deepEqual(s.samples, ["2026-10-01", "2026-10-02"]);
  assert.equal(s.values.get("2026-10-02"), 2);
  assert.deepEqual(habitSeries(habits, days)["habit:7"].samples, [
    "2026-10-01",
    "2026-10-02",
    "2026-10-03",
  ]);
  // Read with its unit.
  assert.equal(s.say(2.2), "2.2\u00A0drinks");
  assert.deepEqual(
    summaryHabits(habits, days).map((x) => x.id),
    ["water", "alcohol", "7"],
  );
  const withGoal = [builtinHabit(WATER, [{ metric: "water", value: 2000 }])];
  assert.equal(summaryHabits(withGoal, []).length, 1);
});

test("an unknown day is no sample: Highlights never read it as 0 (AC2-2)", () => {
  // The owner's Oct 5–11: Oct 10 unknown (≥ 13.1 drinks) was read a sober day.
  const days = [
    { habit: "alcohol", day: "2026-10-09", amount: 0, known: true },
    { habit: "alcohol", day: "2026-10-10", amount: 157, known: false },
    { habit: "alcohol", day: "2026-10-11", amount: 24, known: true },
  ];
  const s = habitSeries([builtinHabit(ALCOHOL, [])], days)["habit:alcohol"];
  assert.deepEqual(s.samples, ["2026-10-09", "2026-10-11"]);
  assert.equal(s.values.has("2026-10-10"), false);
  assert.deepEqual(floorsOf(builtinHabit(ALCOHOL, []), days), [
    { day: "2026-10-10", amount: 157 * (1 / 12) },
  ]);
});

test("hydration goal: the water target plus 0.5 L an hour of activity", () => {
  assert.equal(hydrationGoal(2000, []), 2000);
  assert.equal(hydrationGoal(2000, [{ minutes: 45 }, { minutes: 45 }]), 2750);
  // No target, no goal: the activity alone isn't one.
  assert.equal(hydrationGoal(null, [{ minutes: 60 }]), null);
});

test("the goal includes the day's activity, for every reader", () => {
  const hydration = { ...WATER, source: "hydration" };
  const targets = [{ metric: "water", value: 2000 }];
  // 90 minutes of activity on the 2nd, none on the 1st.
  const minutes = new Map([["2026-10-02", 90]]);
  const water = builtinHabit(hydration, targets, (d) => minutes.get(d) ?? 0);
  assert.equal(water.goal, 2, "the plain target, in shown units");
  assert.equal(water.goalOn("2026-10-01"), 2);
  assert.equal(water.goalOn("2026-10-02"), 2.75);
  // A day's amount is judged against that day's goal.
  const rows = [
    { day: "2026-10-01", amount: 2.2 },
    { day: "2026-10-02", amount: 2.2 },
  ];
  const range = { from: "2026-10-01", to: "2026-10-07" };
  assert.equal(stats(rows, { ...range, goal: water.goalOn }).reached, 1);
  // Without activity minutes, or for any other habit, the goal is fixed.
  assert.equal(builtinHabit(hydration, targets).goalOn("2026-10-02"), 2);
  assert.equal(
    builtinHabit(ALCOHOL, [{ metric: "alcohol", value: 24 }], () => 600).goalOn(
      "2026-10-02",
    ),
    2,
  );
  const snus = trackerHabit({ id: 7, name: "Snus", unit: "x", goal_value: 5 });
  assert.equal(snus.goalOn("2026-10-02"), 5);
});

test("us_label_salt_is_sodium_mg: a nutrient built-in follows the label", () => {
  const SALT = {
    ...ALCOHOL,
    key: "salt",
    name: "Salt",
    unit: "g",
    one: "g",
    factor: 0.0025,
    bounds: [2, 5, 8],
    metric: "sodium",
    per: "day",
    source: { nutrient: "sodium" },
  };
  const drinks = { ...ALCOHOL, source: { nutrient: "alcohol" } };
  const served = [
    {
      key: "sodium",
      label: "Sodium",
      unit: "mg",
      goal: "at_most",
      category: "Minerals",
      display: { label: "Salt", unit: "g", factor: 0.0025 },
      display_us: { label: "Sodium", unit: "mg", factor: 1 },
    },
    {
      key: "alcohol",
      label: "Alcohol",
      unit: "g",
      goal: "at_most",
      category: "General",
      display: { label: "Alcohol", unit: "g", factor: 1 },
    },
  ];
  setRegistry(served, "kcal", "eu");
  assert.equal(localBuiltin(SALT), SALT, "the EU label is the served one");
  setRegistry(served, "kcal", "us");
  const us = localBuiltin(SALT);
  assert.deepEqual(
    [us.key, us.name, us.unit, us.factor, us.bounds],
    ["salt", "Sodium", "mg", 1, [800, 2000, 3200]],
  );
  assert.equal(habitAmountText(us, 2300), nbsp("2,300 mg"));
  // Drinks aren't a label's unit: they stay drinks.
  assert.equal(localBuiltin(drinks), drinks);
  setRegistry([]);
});

test("mg reads whole wherever a habit's amount is said (TFA-H15, U3-19)", () => {
  const caffeine = builtinHabit(
    { ...WATER, key: "caffeine", unit: "mg", one: "mg", factor: 1 },
    [],
  );
  assert.equal(habitAmountText(caffeine, 246.4), nbsp("246 mg"));
  assert.equal(cellText(caffeine, 372.8), "373");
  assert.equal(cellText(builtinHabit(WATER, []), 2.688), "2.7");
});

test("a day's mean over known days only from 3 of them; else a floor over the food days (TFA-H4)", () => {
  const caffeine = builtinHabit(
    { ...WATER, key: "caffeine", unit: "mg", one: "mg", factor: 1 },
    [],
  );
  // The owner's October: caffeine known on 1 of 13 food days (Oct 13, the
  // month's peak, 372.8 mg); floors on the rest add to 1,723 mg.
  const rows = [{ day: "2026-10-13", amount: 372.8 }];
  const floors = [{ day: "2026-10-10", amount: 1723.2 }];
  const t = stats(rows, { logged: 1, floors });
  assert.deepEqual(meanTile(caffeine, t, 13), {
    value: nbsp("≥ 161 mg"),
    short: "a day",
    long: "At least this much a day: what was counted over the 13 days with food logged, though it's known on only 1 of them.",
  });
  // Three known days: their mean, said to be over them.
  const three = stats(
    [
      { day: "2026-10-11", amount: 100 },
      { day: "2026-10-12", amount: 200 },
      { day: "2026-10-13", amount: 300 },
    ],
    { logged: 3, floors },
  );
  assert.deepEqual(meanTile(caffeine, three, 13), {
    value: nbsp("200 mg"),
    short: "a day",
    long: "Your average a day over 3 known days of 13 with food logged.",
  });
  // All known: the mean over every food day, however few.
  const all = stats(rows, { logged: 1 });
  assert.deepEqual(meanTile(caffeine, all, 1), {
    value: nbsp("373 mg"),
    short: "a day",
    long: "Your average a day over 1 day with food logged.",
  });
  // A week's habit: a week's floor the same way.
  const alcohol = builtinHabit(ALCOHOL, []);
  const drinks = stats([{ day: "2026-10-05", amount: 2 }], {
    logged: 1,
    floors: [{ day: "2026-10-10", amount: 12 }],
  });
  assert.deepEqual(meanTile(alcohol, drinks, 7), {
    value: nbsp("≥ 14"),
    short: "drinks a week",
    long: "At least this much a week: what was counted over the 7 days with food logged, though it's known on only 1 of them.",
  });
});

test("a count whose floor is 0 is not known, never none (TFA-H7)", () => {
  assert.equal(countText(0, true), "–");
  assert.equal(countText(2, true), nbsp("≥ 2"));
  assert.equal(countText(0, false), "0");
});

test("hydration's calendar key is worded by the day's goal it shades by (TFA-H6)", () => {
  const targets = [{ metric: "water", value: 2500 }];
  const water = builtinHabit({ ...WATER, source: "hydration" }, targets);
  assert.deepEqual(goalWords(water), [
    "under half the day's goal",
    "half to ¾ of it",
    "¾ to the goal",
    "the day's goal met",
  ]);
  // A fixed goal keeps its amounts.
  const fruit = builtinHabit(
    {
      ...WATER,
      key: "fruit_veg",
      metric: "fruit_veg",
      source: { category: "fruit_veg" },
    },
    [{ metric: "fruit_veg", value: 400 }],
  );
  assert.equal(goalWords(fruit), null);
});

test("UX11-15: grams read whole from 10 g, a tenth under it; calendar cells alike", () => {
  const fruit = builtinHabit(
    { ...WATER, key: "fruit", unit: "g", one: "g", factor: 1 },
    [],
  );
  assert.equal(habitAmountText(fruit, 205.7), nbsp("206 g"));
  assert.equal(habitAmountText(fruit, 9.46), nbsp("9.5 g"));
  assert.equal(cellText(fruit, 205.7), "206");
  assert.equal(cellText(fruit, 9.46), "9.5");
});

test("UX11-4: a habit's series carries the day's goal its insight judges by", () => {
  const hydration = { ...WATER, source: "hydration" };
  const minutes = new Map([["2026-10-02", 90]]);
  const water = builtinHabit(
    hydration,
    [{ metric: "water", value: 2000 }],
    (d) => minutes.get(d) ?? 0,
  );
  const s = habitSeries(
    [water],
    [{ day: "2026-10-02", habit: "water", amount: 2000 }],
  )["habit:water"];
  assert.equal(s.goalOn("2026-10-02"), 2.75);
  assert.equal(s.goalOn("2026-10-01"), 2);
});
