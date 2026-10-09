// Summary Highlights (web/insights.mjs): each rule at its noise edges, the
// elapsed window, ranking and the rule contract.

import assert from "node:assert/strict";
import test from "node:test";

import { shift } from "../web/dates.mjs";
import {
  RULES,
  contrast,
  compare,
  highlights,
  prepare,
  rank,
  tileThrough,
} from "../web/insights.mjs";

process.env.TZ = "Europe/Helsinki";

const FAR = "2099-01-01";
const say = {
  energy: (v) => `${Math.round(v).toLocaleString("en-US")} kcal`,
};
// `n` days from `from`.
const days = (from, n) => Array.from({ length: n }, (_, i) => shift(from, i));
// A series from [day, value] pairs, every pair a sample.
const series = (pairs, label) => ({
  values: new Map(pairs),
  samples: pairs.map(([d]) => d),
  label,
});
// Every day of [from, from + n) a sample, `value(day, i)` its number.
const daily = (from, n, value, label) =>
  series(
    days(from, n).map((d, i) => [d, value(d, i)]),
    label,
  );
const dow = (day) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;

// September 2025 (Mon 1 – Tue 30) against August, both over.
const SEP = {
  kind: "month",
  from: "2025-09-01",
  to: "2025-09-30",
  last: FAR,
  before: { from: "2025-08-01", to: "2025-08-31" },
  say,
  // The registry defaults /targets serves without a row of your own.
  targets: { steps: { value: 10000 }, sleep_min: { value: 420 } },
};
const texts = (tab, ctx, opts) => highlights(tab, ctx, opts).map((r) => r.text);
// Training's weekday claims alone.
const weekdays = (ctx) =>
  highlights("training", ctx)
    .filter((r) => r.id.startsWith("weekday"))
    .map((r) => r.text);

// ---------------------------------------------------------------- weekdays

// Three full weeks: Saturdays at `sat`, the rest at `other`.
const saturdays = (sat, other = 2000, n = 21, skip = []) =>
  series(
    days("2025-09-01", n)
      .filter((d) => !skip.includes(d))
      .map((d) => [d, dow(d) === 5 ? sat : other]),
    "Energy",
  );

test("weekday (food): three weeks of high Saturdays, with both means", () => {
  const energy = saturdays(2650, 2055);
  assert.deepEqual(texts("food", { ...SEP, series: { energy } }), [
    "Saturdays run highest: 2,650 kcal vs 2,140 kcal on average",
  ]);
});

test("weekday (food): two weeks, or two Saturdays, say nothing", () => {
  assert.deepEqual(
    texts("food", { ...SEP, series: { energy: saturdays(2650, 2055, 14) } }),
    [],
  );
  const twoSats = saturdays(2650, 2055, 21, ["2025-09-13"]);
  assert.deepEqual(texts("food", { ...SEP, series: { energy: twoSats } }), []);
});

test("weekday (food): +14.5 % stays quiet, +15 % is named", () => {
  assert.deepEqual(
    texts("food", { ...SEP, series: { energy: saturdays(2347) } }),
    [],
  );
  assert.equal(
    texts("food", { ...SEP, series: { energy: saturdays(2360) } }).length,
    1,
  );
});

test("weekday (food): above the mean on under ⅔ of its days → none", () => {
  // Four weeks; Saturdays 3000, 3000, 1900, 1900: +19 %, but 2 of 4 above.
  const sat = { "2025-09-06": 3000, "2025-09-13": 3000 };
  const split = daily("2025-09-01", 28, (d) =>
    dow(d) === 5 ? (sat[d] ?? 1900) : 2000,
  );
  assert.deepEqual(texts("food", { ...SEP, series: { energy: split } }), []);
  sat["2025-09-20"] = 3000;
  const three = daily("2025-09-01", 28, (d) =>
    dow(d) === 5 ? (sat[d] ?? 1900) : 2000,
  );
  assert.match(
    texts("food", { ...SEP, series: { energy: three } })[0],
    /^Saturdays run highest/,
  );
});

// Training: every day of September a sample, `on(day)` workouts.
const workouts = (on, from = "2025-09-01", n = 30) =>
  daily(from, n, (d) => on(d));

test("weekday (counts): Mondays and Thursdays, in weekday order", () => {
  const w = workouts((d) => (dow(d) === 0 || dow(d) === 3 ? 1 : 0));
  assert.ok(
    texts("training", { ...SEP, series: { workouts: w } }).includes(
      "You train most on Mondays and Thursdays",
    ),
  );
});

test("weekday (counts): a lift of 1.4× is no pattern, 1.5× is", () => {
  // Three Fridays at `a`; a Saturday and a Sunday at 1.
  const habit = (a) =>
    series(
      [
        ["2025-09-05", a],
        ["2025-09-12", a],
        ["2025-09-13", 1],
        ["2025-09-14", 1],
        ["2025-09-19", a],
      ],
      "Snus",
    );
  assert.deepEqual(
    texts("habits", { ...SEP, series: { "habit:1": habit(3.5) } }),
    [],
  );
  assert.deepEqual(
    texts("habits", { ...SEP, series: { "habit:1": habit(6) } }),
    ["Snus mostly on Fridays"],
  );
});

test("weekday (counts): on under ⅔ of its days, or under half the total → none", () => {
  const mondays = (list) => {
    let i = 0;
    return workouts((d) => (dow(d) === 0 ? list[i++] : 0), "2025-09-01", 28);
  };
  const ctx = (w) => ({ ...SEP, series: { workouts: w } });
  assert.deepEqual(weekdays(ctx(mondays([4, 4, 0, 0]))), []);
  assert.deepEqual(weekdays(ctx(mondays([4, 4, 4, 0]))), [
    "You train most on Mondays",
  ]);
  // Every day once and Mondays three times: 2.3×, but a third of the total.
  const most = workouts((d) => (dow(d) === 0 ? 3 : 1), "2025-09-01", 28);
  assert.deepEqual(weekdays(ctx(most)), []);
});

test("habits: alcohol mostly on Fridays and Saturdays", () => {
  const alcohol = daily(
    "2025-09-01",
    28,
    (d) => (dow(d) === 4 || dow(d) === 5 ? 2 : 0),
    "Alcohol",
  );
  assert.deepEqual(
    texts("habits", { ...SEP, series: { "habit:alcohol": alcohol } }),
    ["Alcohol mostly on Fridays and Saturdays"],
  );
});

// ------------------------------------------------------------- comparisons

const protein = (from, n, value) => daily(from, n, () => value, "Protein");

test("comparison: +12 % protein shows, +9 % doesn't", () => {
  const ctx = (now) => ({
    ...SEP,
    series: { protein: protein("2025-09-01", 30, now) },
    prev: { protein: protein("2025-08-01", 31, 100) },
  });
  assert.deepEqual(texts("food", ctx(112)), [
    "Protein up 12 % from last month",
  ]);
  assert.deepEqual(texts("food", ctx(109)), []);
  assert.deepEqual(texts("food", ctx(85)), [
    "Protein down 15 % from last month",
  ]);
});

test("comparison: 6 samples a week say nothing, 7 do", () => {
  const week = (n) => ({
    ...SEP,
    kind: "week",
    from: "2025-09-01",
    to: "2025-09-07",
    before: { from: "2025-08-25", to: "2025-08-31" },
    series: { protein: protein("2025-09-01", n, 120) },
    prev: { protein: protein("2025-08-25", 7, 100) },
  });
  assert.deepEqual(texts("food", week(6)), []);
  assert.deepEqual(texts("food", week(7)), ["Protein up 20 % from last week"]);
});

test("comparison: under half the days logged, or a previous 0 → none", () => {
  const ctx = (n, before = 100) => ({
    ...SEP,
    series: { protein: protein("2025-09-01", n, 120) },
    prev: { protein: protein("2025-08-01", 31, before) },
  });
  assert.deepEqual(texts("food", ctx(14)), []);
  assert.equal(texts("food", ctx(15)).length, 1);
  assert.deepEqual(texts("food", ctx(30, 0)), []);
});

test("comparison: a week still running compares nothing", () => {
  const c = prepare({
    ...SEP,
    kind: "week",
    from: "2025-09-01",
    to: "2025-09-07",
    last: "2025-09-06",
    before: { from: "2025-08-25", to: "2025-08-31" },
    series: { protein: protein("2025-09-01", 7, 120) },
    prev: { protein: protein("2025-08-25", 7, 100) },
  });
  assert.equal(c.finished, false);
  assert.equal(compare(c, "protein"), null);
});

// ---------------------------------------------------------------- workouts

const on = (list) => (d) => (list.includes(d.slice(8)) ? 1 : 0);

test("workouts: finished months of one length compare counts", () => {
  // August and July 2025: 31 days each.
  const ctx = (now) => ({
    ...SEP,
    from: "2025-08-01",
    to: "2025-08-31",
    before: { from: "2025-07-01", to: "2025-07-31" },
    series: { workouts: workouts(on(now), "2025-08-01", 31) },
    prev: {
      workouts: workouts(on(["02", "09", "16", "23"]), "2025-07-01", 31),
    },
  });
  assert.ok(
    texts("training", ctx(["01", "05", "10", "15", "20", "25"])).includes(
      "2 more workouts than last month",
    ),
  );
  // One more is no change.
  assert.deepEqual(
    highlights("training", ctx(["01", "08", "15", "22", "29"])).filter(
      (r) => r.id === "change:workouts",
    ),
    [],
  );
});

test("workouts: a month still running compares its first days with last month's", () => {
  // October 2025 through the 15th against September's first 15 days (3);
  // September's later 10 don't count.
  const ctx = {
    ...SEP,
    from: "2025-10-01",
    to: "2025-10-31",
    last: "2025-10-15",
    before: { from: "2025-09-01", to: "2025-09-30" },
    series: {
      workouts: workouts(on(["01", "03", "06", "09", "13"]), "2025-10-01", 31),
    },
    prev: {
      workouts: workouts(
        (d) => (d <= "2025-09-15" ? on(["02", "08", "14"])(d) : 1),
        "2025-09-01",
        30,
      ),
    },
  };
  assert.ok(
    texts("training", ctx).includes(
      "2 more workouts than at this point last month",
    ),
  );
});

test("workouts: day N is clamped to the previous period's length", () => {
  // March 2025 through the 30th against February's 28 days: the 29th and
  // 30th don't count, so 2 against 2 is no change.
  const ctx = {
    ...SEP,
    from: "2025-03-01",
    to: "2025-03-31",
    last: "2025-03-30",
    before: { from: "2025-02-01", to: "2025-02-28" },
    series: {
      workouts: workouts(on(["03", "10", "29", "30"]), "2025-03-01", 31),
    },
    prev: { workouts: workouts(on(["03", "10"]), "2025-02-01", 28) },
  };
  assert.equal(
    highlights("training", ctx).some((r) => r.id === "change:workouts"),
    false,
  );
});

test("workouts: finished months of different lengths compare per week", () => {
  // September (30 days) 9 workouts: 2.1 a week; August (31) 6: 1.35.
  const ctx = {
    ...SEP,
    series: {
      workouts: workouts(
        on(["01", "03", "05", "10", "12", "17", "19", "24", "26"]),
      ),
    },
    prev: {
      workouts: workouts(
        on(["04", "08", "13", "18", "22", "27"]),
        "2025-08-01",
        31,
      ),
    },
  };
  assert.ok(
    texts("training", ctx).includes("0.7 more workouts a week than last month"),
  );
});

// Workouts on the first `k` days of the month.
const firstDays = (k) => (d) => (Number(d.slice(8)) <= k ? 1 : 0);

test("1.046 a week reads 1 more workout", () => {
  // October 2025 (31 days) 16 workouts: 3.61 a week; September (30) 11:
  // 2.57. The difference shows as "1", so the word is singular.
  const ctx = {
    ...SEP,
    from: "2025-10-01",
    to: "2025-10-31",
    before: { from: "2025-09-01", to: "2025-09-30" },
    series: { workouts: workouts(firstDays(16), "2025-10-01", 31) },
    prev: { workouts: workouts(firstDays(11), "2025-09-01", 30) },
  };
  assert.ok(
    texts("training", ctx).includes("1 more workout a week than last month"),
  );
});

// --------------------------------------------------------------------- gaps

test("gap: 9 rest days in a row is named, 6 isn't", () => {
  const nine = workouts(on(["01", "11", "20", "30"]));
  assert.ok(
    texts("training", { ...SEP, series: { workouts: nine } }).includes(
      "Longest gap without training: 9 days",
    ),
  );
  const six = workouts(on(["01", "08", "15", "22", "29"]));
  assert.equal(
    highlights("training", { ...SEP, series: { workouts: six } }).some(
      (r) => r.id === "gap",
    ),
    false,
  );
});

test("gap: two sessions are too few", () => {
  const two = workouts(on(["01", "30"]));
  assert.deepEqual(
    texts("training", { ...SEP, series: { workouts: two } }),
    [],
  );
});

test("gap: the period's end counts only once it is over", () => {
  const early = workouts(on(["01", "03", "05"]));
  assert.deepEqual(
    texts("training", {
      ...SEP,
      last: "2025-09-20",
      series: { workouts: early },
    }),
    [],
  );
  assert.ok(
    texts("training", { ...SEP, series: { workouts: early } }).includes(
      "Longest gap without training: 25 days",
    ),
  );
});

// ------------------------------------------------------------ weekend overs

const TARGET = { energy: { value: 2000, min: 2000, max: 2200 } };
const overs = (list, samples = days("2025-09-01", 30)) =>
  series(
    samples.map((d) => [d, list.includes(d.slice(8)) ? 2600 : 2100]),
    "Energy",
  );

test("weekend overs: 4 of 5 on weekends is named; 2 of 5 isn't", () => {
  const ctx = (list) => ({
    ...SEP,
    targets: TARGET,
    series: { energy: overs(list) },
  });
  assert.deepEqual(texts("food", ctx(["06", "07", "10", "13", "14"])), [
    "Over your energy target 5 times, 4 on weekends",
  ]);
  assert.deepEqual(texts("food", ctx(["06", "07", "10", "11", "12"])), []);
  // Half of them: 23 points over the weekends' share of days, still under 60 %.
  assert.deepEqual(
    texts("food", ctx(["06", "07", "10", "11", "12", "13"])),
    [],
  );
  assert.deepEqual(texts("food", ctx(["06", "07"])), []);
});

test("weekend overs: not when you mostly log weekends anyway", () => {
  // 8 weekend days and 2 weekdays logged: weekends are 80 % of the days.
  const logged = days("2025-09-01", 30).filter(
    (d) => dow(d) >= 5 || d === "2025-09-10" || d === "2025-09-17",
  );
  const ctx = {
    ...SEP,
    targets: TARGET,
    series: { energy: overs(["06", "07", "10", "13", "14"], logged) },
  };
  assert.deepEqual(texts("food", ctx), []);
});

test("weekend overs: no target max, no claim", () => {
  const ctx = {
    ...SEP,
    targets: { energy: { value: 2000, min: 2000, max: null } },
    series: { energy: overs(["06", "07", "13", "14", "20"]) },
  };
  assert.deepEqual(texts("food", ctx), []);
});

// ---------------------------------------------------------- steps ↔ energy

// `high` days of 12,000 steps eating `more`, then 14 days of 6,000 at 2000.
const walking = (high, more) => {
  const list = days("2025-09-01", high + 14);
  return {
    energy: series(
      list.map((d, i) => [d, i < high ? more : 2000]),
      "Energy",
    ),
    steps: series(list.map((d, i) => [d, i < high ? 12000 : 6000])),
  };
};

test("steps ↔ energy: 7 walking days eating 15 % more", () => {
  assert.deepEqual(texts("food", { ...SEP, series: walking(7, 2300) }), [
    "On days with 10,000+ steps you eat 300 kcal more",
  ]);
});

test("steps ↔ energy: 6 days on a side, or 9 % more, say nothing", () => {
  assert.deepEqual(texts("food", { ...SEP, series: walking(6, 2300) }), []);
  assert.deepEqual(texts("food", { ...SEP, series: walking(7, 2180) }), []);
});

// ------------------------------------------------------------ the window

test("a month still running leaves today's partial day out", () => {
  const c = prepare({
    ...SEP,
    from: "2025-10-01",
    to: "2025-10-31",
    last: "2025-10-14",
    before: { from: "2025-09-01", to: "2025-09-30" },
    series: {
      energy: daily("2025-10-01", 15, (d) => (d === "2025-10-15" ? 300 : 2000)),
    },
  });
  assert.equal(c.through, "2025-10-14");
  assert.equal(c.days, 14);
  assert.equal(c.finished, false);
  assert.equal(c.series.energy.samples.at(-1), "2025-10-14");
  assert.equal(c.series.energy.values.has("2025-10-15"), false);
  assert.equal(c.before.days, 30);
  assert.equal(c.noun, "last month");
});

test("a period with no elapsed days has no highlights", () => {
  const future = {
    ...SEP,
    last: "2025-08-31",
    series: { energy: saturdays(2650, 2055) },
  };
  assert.equal(prepare(future), null);
  assert.deepEqual(highlights("food", future), []);
  // Its tiles count what is logged, as its calendar does.
  assert.equal(
    tileThrough("2025-09-01", "2025-09-30", "2025-08-31"),
    "2025-09-30",
  );
  assert.equal(
    tileThrough("2025-09-01", "2025-09-30", "2025-09-10"),
    "2025-09-10",
  );
});

// -------------------------------------------------------------- ranking

test("ranking: by margin, capped at 3, ties in rule order, 3 kept", () => {
  const list = [
    { id: "a", text: "a", margin: 1.2 },
    { id: "b", text: "b", margin: 5 },
    { id: "c", text: "c", margin: 2 },
    { id: "d", text: "d", margin: 3.5 },
    { id: "e", text: "e", margin: 1 },
  ];
  assert.deepEqual(
    rank(list).map((r) => [r.id, r.margin]),
    [
      ["b", 3],
      ["d", 3],
      ["c", 2],
    ],
  );
});

test("ranking: mixed rules, strongest first; omit drops an id", () => {
  // Saturdays +24 % (margin 1.6), protein +12 % (1.2), energy −30 % (3).
  const ctx = {
    ...SEP,
    series: {
      energy: saturdays(2650, 2055, 30),
      protein: protein("2025-09-01", 30, 112),
    },
    prev: {
      energy: daily("2025-08-01", 31, () => 3000, "Energy"),
      protein: protein("2025-08-01", 31, 100),
    },
  };
  const ids = highlights("food", ctx).map((r) => r.id);
  assert.deepEqual(ids, ["change:energy", "weekday:energy", "change:protein"]);
  assert.deepEqual(
    highlights("food", ctx, { omit: ["change:energy"] }).map((r) => r.id),
    ["weekday:energy", "change:protein"],
  );
});

// A later cross-domain rule: null without its series.
const sleep = (c) =>
  c.series.sleep
    ? { id: "sleep:energy", text: "Short nights, more food", margin: 2 }
    : null;

test("a new rule plugs in: skipped without its series, ranked with it", () => {
  RULES.food.push(sleep);
  try {
    const ctx = {
      ...SEP,
      series: { protein: protein("2025-09-01", 30, 112) },
      prev: { protein: protein("2025-08-01", 31, 100) },
    };
    assert.deepEqual(texts("food", ctx), ["Protein up 12 % from last month"]);
    ctx.series.sleep = daily("2025-09-01", 30, () => 7);
    assert.deepEqual(texts("food", ctx), [
      "Short nights, more food",
      "Protein up 12 % from last month",
    ]);
  } finally {
    RULES.food.pop();
  }
});

// ------------------------------------------------ sleep, cross-domain

// Shift 1: day d's outcome against day d − 1's condition.
const firstOnly = (d) =>
  d === "2025-09-01" ? true : d === "2025-09-03" ? null : false;

test("contrast: the outcome's mean where the condition holds against where it doesn't", () => {
  const outcome = series([
    ["2025-09-02", 300],
    ["2025-09-03", 100],
    ["2025-09-04", 100],
  ]);
  // Below MIN_SAMPLES a side: nothing.
  assert.equal(contrast({ cond: firstOnly, outcome, shift: 1 }), null);
  const many = daily("2025-09-01", 14, (d, i) => (i < 7 ? 110 : 100));
  const r = contrast({
    cond: (d) => d < "2025-09-08",
    outcome: many,
  });
  assert.deepEqual([r.diff, Math.round(r.change * 100)], [10, 10]);
});

// `short` nights under 7 h, then `long` nights of 8 h, each day's energy
// `more` after a short night and 2000 after a long one.
const sleepy = (short, long, more) => {
  const list = days("2025-09-01", short + long);
  return {
    energy: series(
      list.map((d, i) => [d, i < short ? more : 2000]),
      "Energy",
    ),
    sleep: series(list.map((d, i) => [d, i < short ? 380 : 480])),
  };
};

test("sleep ↔ energy: 7 short nights eating 16 % more", () => {
  assert.deepEqual(texts("food", { ...SEP, series: sleepy(7, 7, 2320) }), [
    "After nights under 7\u00a0h you eat 320 kcal more",
  ]);
});

test("sleep ↔ energy: 6 nights on a side, or 9.9 % more, say nothing", () => {
  assert.deepEqual(texts("food", { ...SEP, series: sleepy(6, 7, 2320) }), []);
  assert.deepEqual(texts("food", { ...SEP, series: sleepy(7, 7, 2198) }), []);
  assert.deepEqual(texts("food", { ...SEP, series: sleepy(7, 7, 2200) }), [
    "After nights under 7\u00a0h you eat 200 kcal more",
  ]);
});

test("rules read ctx.targets", () => {
  // The steps goal splits the days; the sleep goal makes a night short.
  const goals = (steps, sleepMin) => ({
    ...SEP,
    targets: { steps: { value: steps }, sleep_min: { value: sleepMin } },
  });
  assert.deepEqual(
    texts("food", { ...goals(12000, 420), series: walking(7, 2300) }),
    ["On days with 12,000+ steps you eat 300 kcal more"],
  );
  // 12,000 a day on the walking days: a goal above it splits nothing.
  assert.deepEqual(
    texts("food", { ...goals(12001, 420), series: walking(7, 2300) }),
    [],
  );
  assert.deepEqual(
    texts("food", { ...goals(10000, 450), series: sleepy(7, 7, 2320) }),
    ["After nights under 7\u00a0h 30\u00a0min you eat 320 kcal more"],
  );
  // No goal (no target and no default): no split, no sentence.
  assert.deepEqual(
    texts("food", { ...SEP, targets: {}, series: walking(7, 2300) }),
    [],
  );
});

// 14 days of September, training on the first `trained` (1 each); each
// night after a training day `after` minutes asleep, others 400.
const trainedSleep = (trained, after, nights = 15) => {
  const list = days("2025-09-01", 14);
  return {
    workouts: series(list.map((d, i) => [d, i < trained ? 1 : 0])),
    sleep: series(
      days("2025-09-02", nights).map((d, i) => [d, i < trained ? after : 400]),
    ),
  };
};

test("training ↔ sleep: the night after training, one day on", () => {
  const read = (s) =>
    texts("training", { ...SEP, series: s })
      .filter((t) => t.startsWith("After"))
      .map((t) => t.replaceAll("\u00a0", " "));

  assert.deepEqual(read(trainedSleep(7, 440)), [
    "After training days you sleep 40 min more",
  ]);
  // 6 training days, or 9.75 % more: nothing.
  assert.deepEqual(read(trainedSleep(6, 440)), []);
  assert.deepEqual(read(trainedSleep(7, 439)), []);
  assert.deepEqual(read(trainedSleep(7, 440)), read(trainedSleep(7, 440, 14)));
  // Sleep stamped on the training days themselves is read a day on: the
  // night after the last training day is a short one, and the rest days
  // left are 6, so nothing.
  const same = trainedSleep(7, 440);
  same.sleep = series(
    days("2025-09-01", 14).map((d, i) => [d, i < 7 ? 440 : 400]),
  );
  assert.deepEqual(read(same), []);
});

test("alcohol ↔ sleep: the night after drinking, on logged days only", () => {
  const list = days("2025-09-01", 15);
  const drank = (n) =>
    series(
      list.slice(0, 14).map((d, i) => [d, i < n ? 2 : 0]),
      "Alcohol",
    );
  const nights = (n, less) =>
    series(list.slice(1).map((d, i) => [d, i < n ? 480 - less : 480]));
  const read = (s) =>
    texts("habits", { ...SEP, series: s })
      .filter((t) => t.startsWith("After"))
      .map((t) => t.replaceAll("\u00a0", " "));
  assert.deepEqual(read({ "habit:alcohol": drank(7), sleep: nights(7, 48) }), [
    "After drinking you sleep 48 min less",
  ]);
  assert.deepEqual(
    read({ "habit:alcohol": drank(6), sleep: nights(6, 48) }),
    [],
  );
  assert.deepEqual(
    read({ "habit:alcohol": drank(7), sleep: nights(7, 47) }),
    [],
  );
});

test("steps ↔ energy reads the same through contrast", () => {
  const r = highlights("food", { ...SEP, series: walking(7, 2300) });
  assert.deepEqual(
    r.map((x) => [x.id, Math.round(x.margin * 100) / 100]),
    [["steps:energy", 1.5]],
  );
});

const changesWorkouts = (c) =>
  highlights("training", c).some((r) => r.id === "change:workouts");

test("workouts: no change while the comparison starts before the watch synced", () => {
  const ctx = (watchFrom) => ({
    ...SEP,
    from: "2025-08-01",
    to: "2025-08-31",
    before: { from: "2025-07-01", to: "2025-07-31" },
    watchFrom,
    series: {
      workouts: workouts(
        on(["01", "05", "10", "15", "20", "25"]),
        "2025-08-01",
        31,
      ),
    },
    prev: {
      workouts: workouts(on(["02", "09", "16", "23"]), "2025-07-01", 31),
    },
  });
  assert.equal(changesWorkouts(ctx(undefined)), true);
  assert.equal(changesWorkouts(ctx("2025-07-01")), true);
  assert.equal(changesWorkouts(ctx("2025-07-02")), false);
});

// ---------------------------------------------------------------- check-ins

// `short` nights under 7\u00a0h rated `low`, then `long` nights of 8 h rated as
// `high` (a list, cycled), the ratings as the check-in series `key`.
const rested = (short, long, low, high, key = "checkin:mood") => {
  const list = days("2025-09-01", short + long);
  return {
    sleep: series(list.map((d, i) => [d, i < short ? 380 : 480])),
    [key]: series(
      list.map((d, i) => [
        d,
        i < short ? low : high[(i - short) % high.length],
      ]),
    ),
  };
};
// Ten long nights averaging 3.6 (six 4s, four 3s) or 3.4 (four 4s).
const MEAN_36 = [4, 4, 4, 4, 4, 4, 3, 3, 3, 3];
const MEAN_34 = [4, 4, 4, 4, 3, 3, 3, 3, 3, 3];

test("sleep ↔ mood: 7 short nights rated 0.6 lower", () => {
  const r = highlights("body", { ...SEP, series: rested(7, 10, 3, MEAN_36) });
  assert.deepEqual(
    r.map((x) => [x.id, x.text, Math.round(x.margin * 10) / 10]),
    [
      [
        "sleep:checkin-mood",
        "After nights under 7\u00a0h you rate your mood 0.6 lower",
        1.2,
      ],
    ],
  );
});

test("sleep ↔ mood: 6 nights a side, or 0.4 points, say nothing", () => {
  assert.deepEqual(
    texts("body", { ...SEP, series: rested(6, 10, 3, MEAN_36) }),
    [],
  );
  assert.deepEqual(texts("body", { ...SEP, series: rested(7, 6, 3, [4]) }), []);
  // 0.4 points is 11.8 %: past contrast's bar, not the scale's.
  assert.deepEqual(
    texts("body", { ...SEP, series: rested(7, 10, 3, MEAN_34) }),
    [],
  );
});

test("sleep ↔ check-in energy: same night, same day", () => {
  const s = rested(7, 10, 3, MEAN_36, "checkin:energy");
  assert.deepEqual(texts("body", { ...SEP, series: s }), [
    "After nights under 7\u00a0h you rate your energy 0.6 lower",
  ]);
  // Read a day on, the short nights meet the long nights' ratings: nothing.
  const later = {
    ...s,
    "checkin:energy": series(
      [...s["checkin:energy"].values].map(([d, v]) => [shift(d, 1), v]),
    ),
  };
  assert.deepEqual(texts("body", { ...SEP, series: later }), []);
});

// 17 days of September: rest on the first 10 (mood 3), training on the
// last 7 (1 each, mood 4).
const trainedMood = () => {
  const list = days("2025-09-01", 17);
  return {
    workouts: series(list.map((d, i) => [d, i < 10 ? 0 : 1])),
    "checkin:mood": series(list.map((d, i) => [d, i < 10 ? 3 : 4])),
  };
};
const moods = (ctx) =>
  highlights("training", ctx)
    .filter((r) => r.id === "training:checkin-mood")
    .map((r) => r.text);

test("training ↔ mood: the training day itself, not the day after", () => {
  // 16 days training every other day (mood 4), resting between (mood 3).
  const list = days("2025-09-01", 16);
  const alternate = (by) => ({
    workouts: series(list.map((d, i) => [d, i % 2 ? 0 : 1])),
    "checkin:mood": series(list.map((d, i) => [shift(d, by), i % 2 ? 3 : 4])),
  });
  assert.deepEqual(moods({ ...SEP, series: alternate(0) }), [
    "On training days you rate your mood 1 higher",
  ]);
  // Were the day after read, these ratings (each a day late) would say so.
  assert.deepEqual(moods({ ...SEP, series: alternate(1) }), [
    "On training days you rate your mood 1 lower",
  ]);
});

test("training ↔ mood: today's rating is left out", () => {
  // Today is the last training day: 6 rated training days, nothing.
  assert.deepEqual(
    moods({ ...SEP, last: "2025-09-17", series: trainedMood() }),
    [],
  );
  assert.deepEqual(
    moods({ ...SEP, last: "2025-09-18", series: trainedMood() }),
    ["On training days you rate your mood 1 higher"],
  );
});

test("alcohol ↔ stress: on logged days only", () => {
  const list = days("2025-09-01", 20);
  // 14 logged days, drinking on 7 (stress 4) and not on 7 (stress 3); 6
  // days without food logged, rated 5, which would sink the difference.
  const s = {
    "habit:alcohol": series(
      list.slice(0, 14).map((d, i) => [d, i < 7 ? 2 : 0]),
      "Alcohol",
    ),
    "checkin:stress": series(
      list.map((d, i) => [d, i < 7 ? 4 : i < 14 ? 3 : 5]),
    ),
  };
  assert.deepEqual(
    highlights("habits", { ...SEP, series: s })
      .filter((r) => r.id === "alcohol:checkin-stress")
      .map((r) => r.text),
    ["On days you drink you rate your stress 1 higher"],
  );
});

test("body: rules skip without check-ins", () => {
  const nights = rested(7, 10, 3, MEAN_36).sleep;
  assert.deepEqual(
    highlights("body", { ...SEP, series: { sleep: nights } }),
    [],
  );
  assert.deepEqual(highlights("body", { ...SEP, series: {} }), []);
});

test("check-in series below the gates leave Training and Habits unchanged", () => {
  const few = series(days("2025-09-01", 3).map((d) => [d, 2]));
  const training = { ...SEP, series: trainedSleep(7, 440) };
  assert.deepEqual(
    highlights("training", {
      ...training,
      series: { ...training.series, "checkin:mood": few },
    }),
    highlights("training", training),
  );
  const list = days("2025-09-01", 15);
  const habits = {
    ...SEP,
    series: {
      "habit:alcohol": series(
        list.slice(0, 14).map((d, i) => [d, i < 7 ? 2 : 0]),
        "Alcohol",
      ),
      sleep: series(list.slice(1).map((d, i) => [d, i < 7 ? 432 : 480])),
    },
  };
  assert.deepEqual(
    highlights("habits", {
      ...habits,
      series: { ...habits.series, "checkin:stress": few },
    }),
    highlights("habits", habits),
  );
  assert.notDeepEqual(highlights("habits", habits), []);
});
