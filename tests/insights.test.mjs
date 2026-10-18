// Summary Highlights (web/insights.mjs): each rule at its noise edges, the
// elapsed window, ranking and the card contract (ADR 0030, scannable
// cards): {id, tone, headline, numbers, detail, link?, margin}. SEP is a
// finished month, so its period words are its days, "Sep 1 – 30".

import assert from "node:assert/strict";
import test from "node:test";

import { shift } from "../web/dates.mjs";
import { tileThrough } from "../web/dates.mjs";
import {
  changeADay,
  compare,
  contrast,
  highlights,
  keptPatterns,
  notHidden,
  periodWords,
  prepare,
  rank,
  RULES,
  sleepSeries,
} from "../web/insights.mjs";

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
// Text with no-break and thin spaces (units, date ranges) plain.
const plain = (t) => t.replaceAll(/[\u00A0\u2009\u202F]/gu, " ");
// A card as one line: "headline: numbers".
const line = (r) => plain(`${r.headline}: ${r.numbers}`);
const texts = (tab, ctx, opts) =>
  highlights(tab, ctx, opts).map((x) => line(x));
// Activity's weekday claims alone.
const weekdays = (ctx) =>
  highlights("activity", ctx)
    .filter((r) => r.id.startsWith("weekday"))
    .map((x) => line(x));

// ------------------------------------------------------------ weekdays

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
    "Energy highest Sat: 2,650 kcal vs 2,140 kcal average · Sep 1 – 30",
  ]);
});

// A mean over a day whose energy leaves some out is a floor; the
// card says "≥" as the Daily averages do.
test("weekday (food): a partly known day makes its means floors", () => {
  const energy = {
    ...saturdays(2650, 2055),
    partly: new Set(["2025-09-06"]),
  };
  assert.deepEqual(texts("food", { ...SEP, series: { energy } }), [
    "Energy highest Sat: ≥ 2,650 kcal vs ≥ 2,140 kcal average · Sep 1 – 30",
  ]);
  const weekdayOnly = {
    ...saturdays(2650, 2055),
    partly: new Set(["2025-09-02"]),
  };
  assert.deepEqual(texts("food", { ...SEP, series: { energy: weekdayOnly } }), [
    "Energy highest Sat: 2,650 kcal vs ≥ 2,140 kcal average · Sep 1 – 30",
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
    /^Energy highest Sat:/u,
  );
});

// Activity: every day of September a sample, `on(day)` workouts.
const workouts = (on, from = "2025-09-01", n = 30) =>
  daily(from, n, (d) => on(d));

test("weekday (counts): Mondays and Thursdays, in weekday order", () => {
  const w = workouts((d) => (dow(d) === 0 || dow(d) === 3 ? 1 : 0));
  assert.deepEqual(
    highlights("activity", { ...SEP, series: { activities: w } })
      .filter((r) => r.id === "weekday:activities")
      .map((r) => r.headline),
    ["Most active Mon, Thu"],
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
    ["Snus mostly Fri: 1.5× its daily average · Sep 1 – 30"],
  );
});

test("weekday (counts): on under ⅔ of its days, or under half the total → none", () => {
  const mondays = (list) => {
    let i = 0;
    return workouts((d) => (dow(d) === 0 ? list[i++] : 0), "2025-09-01", 28);
  };
  const ctx = (w) => ({ ...SEP, series: { activities: w } });
  assert.deepEqual(weekdays(ctx(mondays([4, 4, 0, 0]))), []);
  assert.deepEqual(weekdays(ctx(mondays([4, 4, 4, 0]))), [
    "Most active Mon: 7× your daily average · Sep 1 – 30",
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
    ["Alcohol mostly Fri, Sat: 3.5× its daily average · Sep 1 – 30"],
  );
});

// --------------------------------------------------------- comparisons

const protein = (from, n, value) => daily(from, n, () => value, "Protein");

test("comparison: +12 % protein shows, +9 % doesn't", () => {
  const ctx = (now) => ({
    ...SEP,
    series: { protein: protein("2025-09-01", 30, now) },
    prev: { protein: protein("2025-08-01", 31, 100) },
  });
  // "the month before", never "last month": the month shown may not be
  // the current one.
  assert.deepEqual(texts("food", ctx(112)), [
    "Protein up 12 %: 112 vs 100 a day · Sep 1 – 30 vs the month before",
  ]);
  assert.deepEqual(texts("food", ctx(109)), []);
  assert.deepEqual(texts("food", ctx(85)), [
    "Protein down 15 %: 85 vs 100 a day · Sep 1 – 30 vs the month before",
  ]);
  // Each side's n is in the detail.
  assert.match(highlights("food", ctx(112))[0].detail, /\(30 vs 31 days\)/u);
});

// A series sampled on its known days (a built-in habit's) says
// so; the food series' days are logged.
test("comparison: a known-days series' detail says known days", () => {
  const ctx = {
    ...SEP,
    series: {
      protein: { ...protein("2025-09-01", 30, 112), sampled: "known" },
    },
    prev: { protein: protein("2025-08-01", 31, 100) },
  };
  assert.match(highlights("food", ctx)[0].detail, /^Mean of the known days/u);
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
  assert.deepEqual(texts("food", week(7)), [
    "Protein up 20 %: 120 vs 100 a day · Sep 1 – 7 vs the week before",
  ]);
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

// ------------------------------------------------------------ workouts

const on = (list) => (d) => (list.includes(d.slice(8)) ? 1 : 0);

test("activities: finished months of one length compare counts", () => {
  // August and July 2025: 31 days each.
  const ctx = (now) => ({
    ...SEP,
    from: "2025-08-01",
    to: "2025-08-31",
    before: { from: "2025-07-01", to: "2025-07-31" },
    series: { activities: workouts(on(now), "2025-08-01", 31) },
    prev: {
      activities: workouts(on(["02", "09", "16", "23"]), "2025-07-01", 31),
    },
  });
  assert.ok(
    texts("activity", ctx(["01", "05", "10", "15", "20", "25"])).includes(
      "More activities: 2 more activities than the month before · Aug 1 – 31",
    ),
  );
  // One more is no change.
  assert.deepEqual(
    highlights("activity", ctx(["01", "08", "15", "22", "29"])).filter(
      (r) => r.id === "change:activities",
    ),
    [],
  );
});

test("activities: a month still running compares its first days with last month's", () => {
  // October 2025 through the 15th against September's first 15 days (3);
  // September's later 10 don't count.
  const ctx = {
    ...SEP,
    from: "2025-10-01",
    to: "2025-10-31",
    last: "2025-10-15",
    before: { from: "2025-09-01", to: "2025-09-30" },
    series: {
      activities: workouts(
        on(["01", "03", "06", "09", "13"]),
        "2025-10-01",
        31,
      ),
    },
    prev: {
      activities: workouts(
        (d) => (d <= "2025-09-15" ? on(["02", "08", "14"])(d) : 1),
        "2025-09-01",
        30,
      ),
    },
  };
  assert.ok(
    texts("activity", ctx).includes(
      "More activities: 2 more activities than at this point the month before · this month so far",
    ),
  );
});

test("activities: day N is clamped to the previous period's length", () => {
  // March 2025 through the 30th against February's 28 days: the 29th and
  // 30th don't count, so 2 against 2 is no change.
  const ctx = {
    ...SEP,
    from: "2025-03-01",
    to: "2025-03-31",
    last: "2025-03-30",
    before: { from: "2025-02-01", to: "2025-02-28" },
    series: {
      activities: workouts(on(["03", "10", "29", "30"]), "2025-03-01", 31),
    },
    prev: { activities: workouts(on(["03", "10"]), "2025-02-01", 28) },
  };
  assert.equal(
    highlights("activity", ctx).some((r) => r.id === "change:activities"),
    false,
  );
});

test("activities: finished months of different lengths compare per week", () => {
  // September (30 days) 9 activities: 2.1 a week; August (31) 6: 1.35.
  const ctx = {
    ...SEP,
    series: {
      activities: workouts(
        on(["01", "03", "05", "10", "12", "17", "19", "24", "26"]),
      ),
    },
    prev: {
      activities: workouts(
        on(["04", "08", "13", "18", "22", "27"]),
        "2025-08-01",
        31,
      ),
    },
  };
  assert.ok(
    texts("activity", ctx).includes(
      "More activities: 0.7 more activities a week than the month before · Sep 1 – 30",
    ),
  );
});

// Workouts on the first `k` days of the month.
const firstDays = (k) => (d) => (Number(d.slice(8)) <= k ? 1 : 0);

test("1.046 a week reads 1 more activity", () => {
  // October 2025 (31 days) 16 activities: 3.61 a week; September (30) 11:
  // 2.57. The difference shows as "1", so the word is singular.
  const ctx = {
    ...SEP,
    from: "2025-10-01",
    to: "2025-10-31",
    before: { from: "2025-09-01", to: "2025-09-30" },
    series: { activities: workouts(firstDays(16), "2025-10-01", 31) },
    prev: { activities: workouts(firstDays(11), "2025-09-01", 30) },
  };
  assert.ok(
    texts("activity", ctx).includes(
      "More activities: 1 more activity a week than the month before · Oct 1 – 31",
    ),
  );
});

// ---------------------------------------------------------------- gaps

test("gap: 9 rest days in a row is named, 6 isn't", () => {
  const nine = workouts(on(["01", "11", "20", "30"]));
  assert.ok(
    texts("activity", { ...SEP, series: { activities: nine } }).includes(
      "Long gap without activity: 9 days in a row · Sep 2 – 10",
    ),
  );
  const six = workouts(on(["01", "08", "15", "22", "29"]));
  assert.equal(
    highlights("activity", { ...SEP, series: { activities: six } }).some(
      (r) => r.id === "gap",
    ),
    false,
  );
});

test("gap: its own days, not the period's (AC2-17); a start before any activity is no gap (AC2-3)", () => {
  // Rest Sep 9–20 between a walk on the 8th and one on the 21st.
  const s = workouts(on(["03", "05", "08", "21", "25"]));
  const gap = (ctx) =>
    highlights("activity", ctx)
      .filter((r) => r.id === "gap")
      .map((x) => line(x));
  assert.deepEqual(gap({ ...SEP, series: { activities: s } }), [
    "Long gap without activity: 12 days in a row · Sep 9 – 20",
  ]);
  // Activity from the 20th on: the 19 days before it are rest only when
  // something was logged in August.
  const late = workouts(on(["20", "22", "24"]));
  assert.deepEqual(gap({ ...SEP, series: { activities: late } }), []);
  assert.deepEqual(
    gap({
      ...SEP,
      series: { activities: late },
      prev: { activities: workouts(on(["30"]), "2025-08-01", 31) },
    }),
    ["Long gap without activity: 19 days in a row · Sep 1 – 19"],
  );
});

test("gap: two activities are too few", () => {
  const two = workouts(on(["01", "30"]));
  assert.deepEqual(
    texts("activity", { ...SEP, series: { activities: two } }),
    [],
  );
});

test("gap: the period's end counts only once it is over", () => {
  const early = workouts(on(["01", "03", "05"]));
  assert.deepEqual(
    texts("activity", {
      ...SEP,
      last: "2025-09-20",
      series: { activities: early },
    }),
    [],
  );
  assert.ok(
    texts("activity", { ...SEP, series: { activities: early } }).includes(
      "Long gap without activity: 25 days in a row · Sep 6 – 30",
    ),
  );
});

// ------------------------------------------------------- weekend overs

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
    "Weekend energy overs: 4 of the 5 days over target were weekends · Sep 1 – 30",
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

// ------------------------------------------------------ steps ↔ energy

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
    "Steps → energy eaten: On 10,000+ step days you ate ~300 kcal more (7 vs 14 days) · Sep 1 – 30",
  ]);
});

test("steps ↔ energy: 6 days on a side, or 9 % more, say nothing", () => {
  assert.deepEqual(texts("food", { ...SEP, series: walking(6, 2300) }), []);
  assert.deepEqual(texts("food", { ...SEP, series: walking(7, 2180) }), []);
});

// ---------------------------------------------------------- the window

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
  assert.equal(c.noun, "the month before");
  assert.equal(c.when, "this month so far");
});

test("period words: 'this month so far' while it runs, else its days", () => {
  const sep = { kind: "month", from: "2025-09-01", to: "2025-09-30" };
  assert.equal(
    periodWords({ ...sep, through: "2025-09-14" }),
    "this month so far",
  );
  assert.equal(
    plain(periodWords({ ...sep, through: "2025-09-30" })),
    "Sep 1 – 30",
  );
  assert.equal(
    plain(
      periodWords({
        kind: "week",
        from: "2025-09-29",
        to: "2025-10-05",
        through: "2025-10-05",
      }),
    ),
    "Sep 29 – Oct 5",
  );
  assert.equal(plain(prepare({ ...SEP, series: {} }).when), "Sep 1 – 30");
});

test("compare and contrast carry n: each side's samples", () => {
  const c = prepare({
    ...SEP,
    series: { protein: protein("2025-09-01", 20, 120) },
    prev: { protein: protein("2025-08-01", 31, 100) },
  });
  assert.deepEqual(compare(c, "protein").n, [20, 31]);
  const r = contrast({
    cond: (d) => d < "2025-09-08",
    outcome: daily("2025-09-01", 20, (d, i) => (i < 7 ? 110 : 100)),
  });
  assert.deepEqual(r.n, [7, 13]);
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
    tileThrough("2025-09-01", "2025-09-30", "2025-08-30", "2025-08-31"),
    "2025-09-30",
  );
  assert.equal(
    tileThrough("2025-09-01", "2025-09-30", "2025-09-10", "2025-09-11"),
    "2025-09-10",
  );
});

// ------------------------------------------------------------- ranking

test("ranking: by margin, capped at 3, ties in rule order; every one kept", () => {
  const list = [
    { id: "a", tone: "fact", margin: 1.2 },
    { id: "b", tone: "fact", margin: 5 },
    { id: "c", tone: "fact", margin: 2 },
    { id: "d", tone: "fact", margin: 3.5 },
    { id: "e", tone: "fact", margin: 1 },
  ];
  assert.deepEqual(
    rank(list).map((r) => [r.id, r.margin]),
    [
      ["b", 3],
      ["d", 3],
      ["c", 2],
      ["a", 1.2],
      ["e", 1],
    ],
  );
  // `max` keeps the first few.
  assert.deepEqual(
    rank(list, 3).map((r) => r.id),
    ["b", "d", "c"],
  );
});

test("ranking: warning > tip > correlation > fact, then margin", () => {
  const list = [
    { id: "fact", tone: "fact", margin: 3 },
    { id: "corr", tone: "correlation", margin: 2 },
    { id: "tip", tone: "tip", margin: 1 },
    { id: "warning-weak", tone: "warning", margin: 1 },
    { id: "warning", tone: "warning", margin: 2.5 },
  ];
  assert.deepEqual(
    rank(list).map((r) => r.id),
    ["warning", "warning-weak", "tip", "corr", "fact"],
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
    ? {
        id: "sleep:energy",
        tone: "fact",
        headline: "Short nights, more food",
        numbers: "x",
        detail: "",
        margin: 2,
      }
    : null;

test("a new rule plugs in: skipped without its series, ranked with it", () => {
  RULES.food.push(sleep);
  try {
    const ctx = {
      ...SEP,
      series: { protein: protein("2025-09-01", 30, 112) },
      prev: { protein: protein("2025-08-01", 31, 100) },
    };
    assert.deepEqual(
      highlights("food", ctx).map((r) => r.id),
      ["change:protein"],
    );
    ctx.series.sleep = daily("2025-09-01", 30, () => 7);
    assert.deepEqual(
      highlights("food", ctx).map((r) => r.id),
      ["sleep:energy", "change:protein"],
    );
  } finally {
    RULES.food.pop();
  }
});

// ------------------------------------------------- sleep, cross-domain

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
    "Sleep → energy eaten: After nights under 7 h you ate ~320 kcal more (7 vs 7 days) · Sep 1 – 30",
  ]);
});

test("sleep ↔ energy: 6 nights on a side, or 9.9 % more, say nothing", () => {
  assert.deepEqual(texts("food", { ...SEP, series: sleepy(6, 7, 2320) }), []);
  assert.deepEqual(texts("food", { ...SEP, series: sleepy(7, 7, 2198) }), []);
  assert.deepEqual(texts("food", { ...SEP, series: sleepy(7, 7, 2200) }), [
    "Sleep → energy eaten: After nights under 7 h you ate ~200 kcal more (7 vs 7 days) · Sep 1 – 30",
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
    [
      "Steps → energy eaten: On 12,000+ step days you ate ~300 kcal more (7 vs 14 days) · Sep 1 – 30",
    ],
  );
  // 12,000 a day on the walking days: a goal above it splits nothing.
  assert.deepEqual(
    texts("food", { ...goals(12001, 420), series: walking(7, 2300) }),
    [],
  );
  assert.deepEqual(
    texts("food", { ...goals(10000, 450), series: sleepy(7, 7, 2320) }),
    [
      "Sleep → energy eaten: After nights under 7 h 30 min you ate ~320 kcal more (7 vs 7 days) · Sep 1 – 30",
    ],
  );
  // No goal (no target and no default): no split, no sentence.
  assert.deepEqual(
    texts("food", { ...SEP, targets: {}, series: walking(7, 2300) }),
    [],
  );
});

// 14 days of September, active on the first `trained` (1 each); each
// night after a active day `after` minutes asleep, others 400.
const trainedSleep = (trained, after, nights = 15) => {
  const list = days("2025-09-01", 14);
  return {
    activities: series(list.map((d, i) => [d, i < trained ? 1 : 0])),
    sleep: series(
      days("2025-09-02", nights).map((d, i) => [d, i < trained ? after : 400]),
    ),
  };
};

test("activity ↔ sleep: the night after activity, one day on", () => {
  const read = (s) =>
    highlights("activity", { ...SEP, series: s })
      .filter((r) => r.id === "activity:sleep")
      .map((x) => line(x));

  assert.deepEqual(read(trainedSleep(7, 440)), [
    "Activity → sleep: After active days you slept 40 min longer (7 vs 7 nights) · Sep 1 – 30",
  ]);
  // 6 active days, or 9.75 % more: nothing.
  assert.deepEqual(read(trainedSleep(6, 440)), []);
  assert.deepEqual(read(trainedSleep(7, 439)), []);
  assert.deepEqual(read(trainedSleep(7, 440)), read(trainedSleep(7, 440, 14)));
  // Sleep stamped on the active days themselves is read a day on: the
  // night after the last active day is a short one, and the rest days
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
    highlights("habits", { ...SEP, series: s })
      .filter((r) => r.id === "alcohol:sleep")
      .map((x) => line(x));
  assert.deepEqual(read({ "habit:alcohol": drank(7), sleep: nights(7, 48) }), [
    "Alcohol → sleep: After drinking you slept 48 min shorter (7 vs 7 nights) · Sep 1 – 30",
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
  highlights("activity", c).some((r) => r.id === "change:activities");

test("activities: no change while the comparison starts before the device synced", () => {
  const ctx = (deviceFrom) => ({
    ...SEP,
    from: "2025-08-01",
    to: "2025-08-31",
    before: { from: "2025-07-01", to: "2025-07-31" },
    deviceFrom,
    series: {
      activities: workouts(
        on(["01", "05", "10", "15", "20", "25"]),
        "2025-08-01",
        31,
      ),
    },
    prev: {
      activities: workouts(on(["02", "09", "16", "23"]), "2025-07-01", 31),
    },
  });
  assert.equal(changesWorkouts(ctx()), true);
  assert.equal(changesWorkouts(ctx("2025-07-01")), true);
  assert.equal(changesWorkouts(ctx("2025-07-02")), false);
});

// ----------------------------------------------------------- check-ins

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
  const r = highlights("body", { ...SEP, series: rested(7, 20, 3, MEAN_36) });
  assert.deepEqual(
    r.map((x) => [x.id, line(x), Math.round(x.margin * 10) / 10]),
    [
      [
        "sleep:checkin-mood",
        "Sleep → mood: After nights under 7 h mood rated 0.6 lower (7 vs 20 days) · Sep 1 – 30",
        1.2,
      ],
    ],
  );
  // Against 10 nights the same 0.6 is p 0.016, over the family's
  // Benjamini–Hochberg bar (0.1 / 8): not said.
  assert.deepEqual(
    texts("body", { ...SEP, series: rested(7, 10, 3, MEAN_36) }),
    [],
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
  const s = rested(7, 20, 3, MEAN_36, "checkin:energy");
  assert.deepEqual(texts("body", { ...SEP, series: s }), [
    "Sleep → energy level: After nights under 7 h energy level rated 0.6 lower (7 vs 20 days) · Sep 1 – 30",
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

// 17 days of September: rest on the first 10 (mood 3), active on the
// last 7 (1 each, mood 4).
const trainedMood = () => {
  const list = days("2025-09-01", 17);
  return {
    activities: series(list.map((d, i) => [d, i < 10 ? 0 : 1])),
    "checkin:mood": series(list.map((d, i) => [d, i < 10 ? 3 : 4])),
  };
};
// A card's numbers without the counts and period.
const said = (r) => r.numbers.replace(/ \(.*/u, "");
const moods = (ctx) =>
  highlights("activity", ctx)
    .filter((r) => r.id === "activity:checkin-mood")
    .map((x) => said(x));

test("activity ↔ mood: the active day itself, not the day after", () => {
  // 16 days active every other day (mood 4), resting between (mood 3).
  const list = days("2025-09-01", 16);
  const alternate = (by) => ({
    activities: series(list.map((d, i) => [d, i % 2 ? 0 : 1])),
    "checkin:mood": series(list.map((d, i) => [shift(d, by), i % 2 ? 3 : 4])),
  });
  assert.deepEqual(moods({ ...SEP, series: alternate(0) }), [
    "On active days mood rated 1 higher",
  ]);
  // Were the day after read, these ratings (each a day late) would say so.
  assert.deepEqual(moods({ ...SEP, series: alternate(1) }), [
    "On active days mood rated 1 lower",
  ]);
});

test("activity ↔ mood: today's rating is left out", () => {
  // Today is the last active day: 6 rated active days, nothing.
  assert.deepEqual(
    moods({ ...SEP, last: "2025-09-17", series: trainedMood() }),
    [],
  );
  assert.deepEqual(
    moods({ ...SEP, last: "2025-09-18", series: trainedMood() }),
    ["On active days mood rated 1 higher"],
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
      .map((x) => said(x)),
    ["On days with alcohol stress rated 1 higher"],
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

test("check-in series below the gates leave Activity and Habits unchanged", () => {
  const few = series(days("2025-09-01", 3).map((d) => [d, 2]));
  const active = { ...SEP, series: trainedSleep(7, 440) };
  assert.deepEqual(
    highlights("activity", {
      ...active,
      series: { ...active.series, "checkin:mood": few },
    }),
    highlights("activity", active),
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

// ---------------------------------------------------- tones (ADR 0030)

const TONES = ["fact", "correlation", "tip", "warning"];

// ----------------------------------------------------- body (ADR 0030)

const ADULT = { height_cm: 180, birth_date: "1990-05-01" };
// Weigh-ins on `n` days from Sep 1, every `step` days, `kg(i)`.
const weighIns = (n, kg, step = 1) =>
  series(
    days("2025-09-01", n * step)
      .filter((_, i) => i % step === 0)
      .map((d, i) => [d, kg(i)]),
  );

test("BMI: the last weigh-in's WHO class, adults with a height only", () => {
  const weight = weighIns(2, (i) => 80 + i);
  const bmi = (person) =>
    highlights("body", { ...SEP, person, series: { weight } }).filter(
      (r) => r.id === "bmi",
    );
  assert.deepEqual(
    bmi(ADULT).map((r) => [line(r), r.tone]),
    [["BMI 25.0: overweight (WHO, adults) · weigh-in of Sep 2", "fact"]],
  );
  assert.deepEqual(
    bmi({ ...ADULT, height_cm: 190 }).map((x) => line(x)),
    ["BMI 22.4: a healthy weight (WHO, adults) · weigh-in of Sep 2"],
  );
  assert.deepEqual(bmi({ ...ADULT, birth_date: "2010-01-01" }), []);
  assert.deepEqual(bmi({ birth_date: "1990-05-01" }), []);
});

test("BMI classifies the shown value: 24.97 reads 25.0 (TFA-H13: one decimal always), overweight", () => {
  // 81.8 kg at 181 cm is 24.968: shown "25", so not "healthy".
  const weight = weighIns(1, () => 81.8);
  const [r] = highlights("body", {
    ...SEP,
    person: { ...ADULT, height_cm: 181 },
    series: { weight },
  }).filter((x) => x.id === "bmi");
  assert.equal(r.headline, "BMI 25.0");
  assert.match(r.numbers, /^overweight /u);
});

test("loss rate: over 1 % a week warns; 4 weigh-ins over 14 days needed", () => {
  // 80 kg losing 0.15 kg a day: 1.05 kg a week, 1.4 % of 75.5 kg.
  const fast = weighIns(31, (i) => 80 - 0.15 * i);
  const [r] = highlights("body", { ...SEP, series: { weight: fast } }).filter(
    (x) => x.id === "loss-rate",
  );
  assert.equal(r.tone, "warning");
  assert.equal(
    line(r),
    "Losing weight fast: 1.4 % of body weight a week · Sep 1 – 30",
  );
  // A guide, not a cliff.
  assert.match(
    r.detail,
    /Faster than the 0\.5–1\u00A0% a week advised to keep muscle/u,
  );
  // 0.1 kg a day of 77 kg is 0.9 %: fine.
  const slow = weighIns(31, (i) => 80 - 0.1 * i);
  assert.deepEqual(
    highlights("body", { ...SEP, series: { weight: slow } }),
    [],
  );
  // Three weigh-ins, or a span under 14 days, say nothing.
  assert.deepEqual(
    highlights("body", {
      ...SEP,
      series: { weight: weighIns(3, (i) => 80 - 2 * i, 7) },
    }),
    [],
  );
  assert.deepEqual(
    highlights("body", {
      ...SEP,
      series: { weight: weighIns(14, (i) => 80 - 0.3 * i) },
    }),
    [],
  );
});

// 35 days ending Sep 30: the 28 before at `was`, the last 7 at `now`.
const lastWeek = (was, now) =>
  series(days("2025-08-27", 35).map((d, i) => [d, i < 28 ? was : now]));

test("recovery: resting HR 5 bpm up, or HRV 15 % down, against the 4 weeks before", () => {
  // Today is Sep 30: the last 7 days are now, a warning with advice.
  const ids = (trailing, last = "2025-09-30") =>
    highlights("body", { ...SEP, last, series: {}, trailing }).map((r) => [
      r.id,
      r.tone,
      line(r),
    ]);
  assert.deepEqual(ids({ resting_hr: lastWeek(55, 60) }), [
    [
      "recovery:resting-hr",
      "warning",
      "RHR above usual: 5 bpm above · last 7 days",
    ],
  ]);
  assert.deepEqual(ids({ resting_hr: lastWeek(55, 59.9) }), []);
  assert.deepEqual(ids({ hrv_ms: lastWeek(60, 51) }), [
    ["recovery:hrv", "warning", "HRV below usual: 15 % below · last 7 days"],
  ]);
  assert.deepEqual(ids({ hrv_ms: lastWeek(60, 51.1) }), []);
  // Four recent days are too few.
  const sparse = lastWeek(55, 65);
  sparse.samples = sparse.samples.slice(0, 32);
  assert.deepEqual(ids({ resting_hr: sparse }), []);
});

test("recovery: a period already over names its days, a fact without advice", () => {
  // A past month's recovery isn't "this week", and gives no advice.
  const [r] = highlights("body", {
    ...SEP,
    series: {},
    trailing: { resting_hr: lastWeek(55, 60) },
  });
  assert.deepEqual(
    [r.tone, line(r)],
    ["fact", "RHR above usual: 5 bpm above · Sep 24 – 30"],
  );
  assert.doesNotMatch(r.detail, /rest\./u);
  const [now] = highlights("body", {
    ...SEP,
    last: "2025-09-30",
    series: {},
    trailing: { resting_hr: lastWeek(55, 60) },
  });
  assert.match(now.detail, /Your body may need rest\.$/u);
});

test("body fat: ≥ 3 readings over 14 days moving 0.5 points", () => {
  const fat = (n, step, per) => weighIns(n, (i) => 25 - per * i, step);
  const r = (s) =>
    highlights("body", { ...SEP, series: { body_fat: s } }).map((x) => [
      line(x),
      x.tone,
    ]);
  assert.deepEqual(r(fat(4, 7, 0.4)), [
    ["Body fat down: 1.2 points over 3 weeks · Sep 1 – 30", "fact"],
  ]);
  assert.deepEqual(r(fat(4, 7, 0.1)), []);
  assert.deepEqual(r(fat(2, 14, 1)), []);
});

test("body fat: a reading that only follows weight (|r| > 0.9) says nothing", () => {
  const body_fat = weighIns(4, (i) => 25 - 0.4 * i, 7);
  const ids = (weight) =>
    highlights("body", { ...SEP, series: { body_fat, weight } }).map(
      (x) => x.id,
    );
  // Weighed on the same days, moving in step: bioimpedance reading weight.
  assert.deepEqual(ids(weighIns(4, (i) => 80 - 0.5 * i, 7)), []);
  // Weight flat around the readings: the trend stands.
  assert.deepEqual(ids(weighIns(4, (i) => [80, 80.4, 79.8, 80.2][i], 7)), [
    "trend:body-fat",
  ]);
});

// ------------------------------------------------- activity (ADR 0030)

const EXERCISES = new Map([
  [1, { id: 1, primary: ["quadriceps", "glutes"] }],
  [2, { id: 2, primary: ["calves"] }],
  [3, { id: 3, primary: ["pectorals"] }],
]);
const lift = (day, ids) => ({
  day,
  type: "workout",
  minutes: 45,
  sets: ids.map((id) => ({ exercise_id: id })),
});

test("muscle gap: a group worked before, not in 3 weeks of ≥ 4 workouts, tips", () => {
  const activities = [
    lift("2025-08-20", [1, 2, 3]),
    ...["2025-09-10", "2025-09-15", "2025-09-20", "2025-09-25"].map((d) =>
      lift(d, [1, 3]),
    ),
  ];
  const ctx = {
    ...SEP,
    kind: "month",
    series: {},
    exercises: EXERCISES,
    trailing: { activities: activities },
  };
  assert.deepEqual(
    highlights("activity", ctx).map((r) => [r.id, r.tone, line(r)]),
    [
      [
        "muscle:calves",
        "tip",
        "Calves not trained: no sets in 5 weeks · 4 activities since Sep 10",
      ],
    ],
  );
  // Three workouts in the 3 weeks: too few to say.
  ctx.trailing = { activities: activities.slice(0, 4) };
  assert.deepEqual(highlights("activity", ctx), []);
});

test("weekly-target streak: 3 finished weeks in a row at the target", () => {
  // Two workouts in each of the weeks of Sep 8, 15, 22 (Sep 29's still going).
  const activities = [
    "2025-09-01",
    "2025-09-08",
    "2025-09-10",
    "2025-09-15",
    "2025-09-17",
    "2025-09-22",
    "2025-09-24",
  ].map((d) => lift(d, []));
  const ctx = {
    ...SEP,
    series: {},
    targets: { workouts_per_week: { value: 2 } },
    trailing: { activities: activities },
  };
  assert.deepEqual(
    highlights("activity", ctx).map((r) => [line(r), r.tone]),
    [["Weekly target streak: 3 weeks in a row · to Sep 28", "fact"]],
  );
  ctx.trailing = {
    activities: activities.filter((s) => s.day !== "2025-09-17"),
  };
  assert.deepEqual(highlights("activity", ctx), []);
});

const ride = (day, km, minutes = 30, type = "run") => ({
  day,
  type,
  minutes,
  distance_m: km * 1000,
  sets: [],
});

// Activity's results as [id, tone, line].
const activityWords = (c) =>
  highlights("activity", c).map((x) => [x.id, x.tone, line(x)]);

test("distance and pace against last month, 3 activities a side", () => {
  const ctx = (now, was) => ({
    ...SEP,
    series: {},
    activities: now,
    beforeActivities: was,
  });
  // September: 3 runs of 6 km in 30 min (5:00 /km); August 3 of 5 km in 30
  // (6:00).
  const sep = ["2025-09-02", "2025-09-09", "2025-09-16"].map((d) => ride(d, 6));
  const aug = ["2025-08-02", "2025-08-09", "2025-08-16"].map((d) => ride(d, 5));
  assert.deepEqual(activityWords(ctx(sep, aug)), [
    [
      "change:pace",
      "fact",
      "Running pace faster: 5:00 /km, 60 s faster · Sep 1 – 30 vs the month before",
    ],
    [
      "change:distance",
      "fact",
      "Distance up 24 %: 4.2 km a week · Sep 1 – 30 vs the month before",
    ],
  ]);
  assert.deepEqual(activityWords(ctx(sep.slice(0, 2), aug)), []);
});

// Cardio load (ADR 0034): a man born 1990, resting 55 on each activity's
// day; `hr` null is an activity without a heart rate.
const PERSON = { sex: "male", birth_date: "1990-05-01" };
const hrSession = (day, minutes, hr) => ({
  day,
  minutes,
  avg_hr: hr,
  max_hr: null,
  type: "run",
  sets: [],
});
const cardio = (list) => ({
  profile: PERSON,
  activities: list,
  deviceDays: list.map((s) => ({ day: s.day, resting_hr: 55 })),
});
const SEP_LOADS = [
  "2025-09-02",
  "2025-09-06",
  "2025-09-10",
  "2025-09-16",
  "2025-09-20",
  "2025-09-25",
].map((d) => hrSession(d, 45, 140));
const AUG_LOADS = ["2025-08-10", "2025-08-17", "2025-08-24"].map((d) =>
  hrSession(d, 40, 130),
);
const loadWords = (list, more = {}) =>
  highlights("activity", { ...SEP, series: {}, cardio: cardio(list), ...more })
    .filter((x) => x.id === "change:load")
    .map((x) => [x.tone, line(x)]);

test("cardio load against the 4 weeks before: finished periods, 3 activities a side, a quarter's change", () => {
  // 95 a week (6 × 45 min at 140 over 30 days) vs 34 (3 × 40 at 130 over 4
  // weeks).
  assert.deepEqual(loadWords([...SEP_LOADS, ...AUG_LOADS]), [
    [
      "fact",
      "Cardio load up 176 %: ≈ 95 vs 34 a week · Sep 1 – 30 vs the 4 weeks before",
    ],
  ]);
  assert.deepEqual(
    loadWords([...AUG_LOADS, ...SEP_LOADS.slice(0, 3)]).length,
    1,
  );
  // Two with a heart rate on a side: too few.
  assert.deepEqual(loadWords([...SEP_LOADS, ...AUG_LOADS.slice(0, 2)]), []);
  // Under a quarter: 6 × 45 at 140 vs 6 × 45 at 140 a month earlier.
  const same = SEP_LOADS.map((s) => ({ ...s, day: shift(s.day, -28) }));
  assert.deepEqual(
    loadWords([...SEP_LOADS, ...same.filter((s) => s.day >= "2025-08-04")]),
    [],
  );
  // A period still running, and a year, say nothing.
  assert.deepEqual(
    loadWords([...SEP_LOADS, ...AUG_LOADS], { last: "2025-09-26" }),
    [],
  );
  assert.deepEqual(
    loadWords([...SEP_LOADS, ...AUG_LOADS], {
      kind: "year",
      from: "2025-01-01",
      to: "2025-12-31",
      before: { from: "2024-01-01", to: "2024-12-31" },
    }),
    [],
  );
});

test("cardio load: a floor says only the way it proves", () => {
  const noHr = (day) => hrSession(day, 60, null);
  // Up with a floor now (≥): still up.
  assert.deepEqual(
    loadWords([...SEP_LOADS, noHr("2025-09-28"), ...AUG_LOADS]).map(
      ([, l]) => l,
    ),
    [
      "Cardio load up 176 %: ≥ 95 vs 34 a week · Sep 1 – 30 vs the 4 weeks before",
    ],
  );
  // Down from a floor before: still down.
  const lighter = SEP_LOADS.slice(0, 3).map((s) => ({ ...s, avg_hr: 110 }));
  const heavy = AUG_LOADS.map((s) => ({ ...s, minutes: 90, avg_hr: 150 }));
  assert.equal(loadWords([...lighter, ...heavy, noHr("2025-08-12")]).length, 1);
  // A floor now going down, or a floor before going up: unproven.
  assert.deepEqual(loadWords([...lighter, noHr("2025-09-28"), ...heavy]), []);
  assert.deepEqual(
    loadWords([...SEP_LOADS, ...AUG_LOADS, noHr("2025-08-12")]),
    [],
  );
});

// ----------------------------------------------- food and correlations

test("food warnings enter as given; a warning outranks a correlation", () => {
  const warning = {
    id: "low:iron",
    headline: "Iron intake low",
    margin: 2,
    tone: "warning",
  };
  const corr = {
    id: "corr:steps:sleep:1",
    headline: "Steps → sleep",
    margin: 3,
    tone: "correlation",
  };
  assert.deepEqual(
    highlights("food", {
      ...SEP,
      series: {},
      warnings: [warning],
      correlations: [corr],
    }).map((r) => r.id),
    ["low:iron", "corr:steps:sleep:1"],
  );
});

const lowWarning = (i) => ({
  id: `low:${i}`,
  headline: `Low ${i}`,
  margin: 0.5 + i,
  tone: "warning",
});
const weakCorrelation = (i) => ({
  id: `corr:${i}`,
  headline: `c${i}`,
  margin: 1.1 - i / 10,
  tone: "correlation",
});

test("one stack: every result kept and ranked, the stack folds past 3", () => {
  // Correlations (pre-registered and discovered) rank with the rules: none
  // is dropped here, the stack shows 3 and folds the rest.
  const ids = highlights("food", {
    ...SEP,
    series: {},
    warnings: [0, 1, 2, 3].map((x) => lowWarning(x)),
    correlations: [0, 1].map((x) => weakCorrelation(x)),
    discovered: [2].map((x) => weakCorrelation(x)),
  }).map((r) => r.id);
  assert.deepEqual(ids, [
    "low:3",
    "low:2",
    "low:1",
    "low:0",
    "corr:0",
    "corr:1",
    "corr:2",
  ]);
});

test("omit drops an id, a discovered pattern's too", () => {
  const ids = highlights(
    "food",
    {
      ...SEP,
      series: {},
      warnings: [lowWarning(0)],
      discovered: [{ ...weakCorrelation(0), id: "pattern:a~b" }],
    },
    { omit: ["pattern:a~b"] },
  ).map((r) => r.id);
  assert.deepEqual(ids, ["low:0"]);
});

test("a pinned pattern (margin ∞) ranks first of its tone, capped at 3", () => {
  const [first] = highlights("food", {
    ...SEP,
    series: {},
    correlations: [weakCorrelation(0)],
    discovered: [
      { ...weakCorrelation(1), id: "pattern:a~b", margin: Infinity },
    ],
  });
  assert.deepEqual([first.id, first.margin], ["pattern:a~b", 3]);
});

test("a contrast a tested correlation already states stays out (AC2-7)", () => {
  const nights = daily("2025-09-01", 30, (d, i) => (i < 10 ? 380 : 480));
  const energy = daily("2025-09-01", 30, (d, i) => (i < 10 ? 2400 : 2000));
  const corr = {
    id: "corr:sleep:energy:0",
    headline: "x",
    margin: 3,
    tone: "correlation",
    covers: "sleep:energy",
  };
  assert.deepEqual(
    highlights("food", {
      ...SEP,
      series: { sleep: nights, energy },
      correlations: [corr],
    }).map((r) => r.id),
    ["corr:sleep:energy:0"],
  );
});

test("a contrast is said only past its test (AC2-7)", () => {
  // The owner's September: "After drinking you slept 48 min shorter (12 vs 9
  // nights)", noisy nights: Mann–Whitney p ≈ 0.12. A 10 % gap in means is
  // no finding on its own.
  const list = days("2025-09-01", 22);
  const drank = series(
    list.slice(0, 21).map((d, i) => [d, i < 12 ? 2 : 0]),
    "Alcohol",
  );
  const noisy = [400, 520, 380, 470, 300, 510, 420, 360, 490, 330, 450, 410];
  const sober = [460, 500, 430, 520, 390, 480, 470, 440, 510];
  const nights = series(
    list.slice(1).map((d, i) => [d, i < 12 ? noisy[i] : sober[i - 12]]),
  );
  const cards = (s) =>
    highlights("habits", { ...SEP, series: s }).filter(
      (r) => r.id === "alcohol:sleep",
    );
  assert.deepEqual(cards({ "habit:alcohol": drank, sleep: nights }), []);
  // Apart on every night: said, its test in the detail.
  const apart = series(list.slice(1).map((d, i) => [d, i < 12 ? 400 : 480]));
  const [r] = cards({ "habit:alcohol": drank, sleep: apart });
  assert.match(r.detail, /Mann–Whitney p < 0\.001, rank-biserial r -1/u);
});

// Owner (2026-10-14): "Alcohol → HRV" and "Possible pattern: higher
// alcohol … lower HRV the night after" are one finding: a discovered pair
// a shown card already states (the same series, a built-in habit's the
// same as its food series, either way round, at the same lag) stays out.
const pairCard = (id, x, y, lag, extra = {}) => ({
  id,
  headline: id,
  margin: 2,
  tone: "correlation",
  x,
  y,
  lag,
  ...extra,
});

test("a discovered pattern a shown card already states stays out", () => {
  const ids = highlights("body", {
    ...SEP,
    series: {},
    correlations: [pairCard("corr:alcohol:hrv_ms:1", "alcohol", "hrv_ms", 1)],
    discovered: [
      pairCard("pattern:habit:alcohol~hrv_ms", "habit:alcohol", "hrv_ms", 1, {
        discovered: true,
      }),
      pairCard("pattern:hrv_ms~steps", "hrv_ms", "steps", 1, {
        discovered: true,
      }),
      // Another lag is another finding.
      pairCard("pattern:alcohol~hrv_ms", "hrv_ms", "alcohol", 2, {
        discovered: true,
      }),
    ],
  }).map((r) => r.id);
  assert.deepEqual(ids, [
    "corr:alcohol:hrv_ms:1",
    "pattern:hrv_ms~steps",
    "pattern:alcohol~hrv_ms",
  ]);
});

test("every rule's result is one card: {id, tone, headline, numbers, detail, link?, margin}", () => {
  // Each rule against the contexts above that fire it.
  const nights = daily("2025-09-01", 30, (d, i) => (i < 10 ? 380 : 480));
  const contexts = [
    {
      ...SEP,
      series: {
        energy: saturdays(2650, 2055, 30),
        sleep: nights,
        protein: protein("2025-09-01", 30, 112),
        steps: daily("2025-09-01", 30, (d) => (dow(d) >= 5 ? 12000 : 5000)),
      },
      prev: { protein: protein("2025-08-01", 31, 100) },
    },
    {
      ...SEP,
      person: ADULT,
      series: { weight: weighIns(31, (i) => 80 - 0.15 * i) },
      trailing: { resting_hr: lastWeek(55, 62), hrv_ms: lastWeek(60, 40) },
    },
    // Body fat on its own: a reading that only tracks weight says nothing.
    { ...SEP, series: { body_fat: weighIns(4, (i) => 25 - 0.4 * i, 7) } },
    {
      ...SEP,
      series: {
        activities: workouts(on(["01", "11", "20", "30"])),
      },
      exercises: EXERCISES,
      trailing: {
        activities: [
          lift("2025-08-20", [1, 2, 3]),
          ...["2025-09-10", "2025-09-15", "2025-09-20", "2025-09-25"].map((d) =>
            lift(d, [1, 3]),
          ),
        ],
      },
    },
    { ...SEP, series: {}, cardio: cardio([...SEP_LOADS, ...AUG_LOADS]) },
    {
      ...SEP,
      series: {},
      warnings: [
        {
          id: "w",
          tone: "warning",
          headline: "Iron intake low",
          numbers: "≥ 9 of 16 mg a day · Sep 1 – 30",
          detail: "w",
          margin: 1,
          link: { to: "sources", key: "iron" },
        },
      ],
    },
  ];
  const results = Object.values(RULES).flatMap((rules) =>
    rules.flatMap((rule) =>
      contexts.flatMap((ctx) => [rule(prepare(ctx))].flat().filter(Boolean)),
    ),
  );
  // Correlations aren't a rule: web/correlate.mjs builds their cards.
  assert.ok(results.length >= 11, `${results.length} results`);
  const KEYS = [
    "id",
    "tone",
    "headline",
    "numbers",
    "detail",
    "link",
    "margin",
    // A contrast's test, for the family's false discovery rate.
    "p",
  ];
  const LINKS = ["sources", "metric", "exercises", "activities", "chart"];
  for (const r of results) {
    const at = `${r.id}: ${r.headline}`;
    assert.deepEqual(
      Object.keys(r).filter((k) => !KEYS.includes(k)),
      [],
      at,
    );
    assert.ok(TONES.includes(r.tone), `${at}: ${r.tone}`);
    for (const k of ["id", "headline", "numbers", "detail"])
      assert.equal(typeof r[k], "string", `${at}: ${k}`);
    // Subject and verdict, ≤ 5 words; the numbers on one line.
    assert.ok(r.headline.split(/\s+/u).length <= 5, at);
    assert.ok(!r.numbers.includes("\n"), at);
    assert.ok(Number.isFinite(r.margin) && r.margin > 0, at);
    if (r.link != null)
      assert.ok(LINKS.includes(r.link?.to), `${at}: ${r.link?.to}`);
  }
});

test("Highlights prefs: hidden through its day, marked ones first, 2 in all", () => {
  const list = [
    { id: "a", margin: 3 },
    { id: "b", margin: 2 },
    { id: "c", margin: 1 },
    { id: "d", margin: 0.5 },
  ];
  const prefs = new Map([
    ["a", { state: "hidden", until: "2045-06-15" }],
    ["d", { state: "pinned" }],
  ]);
  // Hidden through `until`, back the day after.
  assert.equal(notHidden(list[0], prefs, "2045-06-15"), false);
  assert.equal(notHidden(list[0], prefs, "2045-06-16"), true);
  // The marked one leads (margin ∞), the strongest of the rest fills to 2.
  assert.deepEqual(
    keptPatterns(list, prefs, "2045-06-15").map((r) => [r.id, r.margin]),
    [
      ["d", Infinity],
      ["b", 2],
    ],
  );
  // Marked ones are never cut: 3 marked show 3, nothing else.
  const all = new Map(list.map((r) => [r.id, { state: "pinned" }]));
  all.delete("a");
  assert.deepEqual(
    keptPatterns(list, all, "2045-06-15").map((r) => r.id),
    ["b", "c", "d"],
  );
  assert.deepEqual(keptPatterns(list, new Map(), "2045-06-15").length, 2);
});

test("sleepSeries: a night's time asleep, naps not added (B-3)", () => {
  const s = sleepSeries([
    { day: "2045-06-01", asleep_min: 400, total_asleep_min: 450 },
    { day: "2045-06-02", asleep_min: null, total_asleep_min: 60 },
  ]);
  // A day of naps only has no night.
  assert.deepEqual([...s.values], [["2045-06-01", 400]]);
});

// A series with one floor day.
const floor = (s) => ({ ...s, partly: new Set([s.samples[3]]) });

// A mean over a floor day ("≥", foods without the value) is a
// floor; two floors, or a floor and a number, are no trend.
test("comparison: a floor on either side is no change (UX11-9)", () => {
  const now = protein("2025-09-01", 30, 85);
  const was = protein("2025-08-01", 31, 100);
  const ctx = (a, b) => ({
    ...SEP,
    series: { protein: a },
    prev: { protein: b },
  });
  assert.equal(texts("food", ctx(now, was)).length, 1);
  assert.deepEqual(texts("food", ctx(floor(now), was)), []);
  assert.deepEqual(texts("food", ctx(now, floor(was))), []);
  // An empty floor set is no floor.
  assert.equal(
    texts("food", ctx({ ...now, partly: new Set() }, was)).length,
    1,
  );
});

// A phone's leftover (1 km in 30 min, under a run's 5 km/h)
// has no pace anywhere else, so none in the pooled pace either.
test("pace pools only runs with a pace: a leftover is left out (QUAL11-12)", () => {
  const five = (d) => ride(d, 5, 25);
  const sep = ["2025-09-02", "2025-09-09", "2025-09-16"].map((x) => five(x));
  const aug = ["2025-08-02", "2025-08-09", "2025-08-16"].map((x) => five(x));
  const ctx = {
    ...SEP,
    series: {},
    activities: [...sep, ride("2025-09-20", 1, 30)],
    beforeActivities: aug,
  };
  assert.deepEqual(
    activityWords(ctx).filter(([id]) => id === "change:pace"),
    [],
  );
});

// Consecutive trend points a gap apart: the change a day, so a
// steady loss reads the same over 3 weeks as over one day.
test("changeADay: a delta over its day gap (QUAL11-13)", () => {
  const out = changeADay(
    [
      { day: "2026-08-15", kg: 80 },
      { day: "2026-09-05", kg: 78.53 },
      { day: "2026-09-06", kg: 78.46 },
    ],
    "kg",
  );
  assert.deepEqual(
    out.map((x) => x.day),
    ["2026-09-05", "2026-09-06"],
  );
  for (const x of out) assert.ok(Math.abs(x.kg + 0.07) < 1e-9, String(x.kg));
});

// Half the days 2.5 L, half 3.1 L (activity): 2.8 L a day on average.
const goalOn = (d) => (Number(d.slice(8)) % 2 ? 2.5 : 3.1);

// Hydration is judged against each day's goal (the water target
// plus activity), as the Diary and the Habits calendar judge it, in its
// own unit.
test("hydration low: against the day's goal, not the plain target (UX11-4)", () => {
  const water = (amount) => ({
    ...daily("2025-09-01", 30, () => amount, "Hydration"),
    sampled: "known",
    goalOn,
    say: (v) => `${v.toFixed(1)} L`,
  });
  const ctx = (amount) => ({
    ...SEP,
    series: { "habit:water": water(amount) },
  });
  // 1.8 L clears 70 % of the plain 2.5 L (1.75), not of the day's 2.8 L.
  const low = highlights("habits", ctx(1.8)).filter((r) =>
    r.id.startsWith("low:"),
  );
  assert.deepEqual(
    low.map((x) => line(x)),
    ["Hydration low: 1.8 L of 2.8 L a day · Sep 1 – 30"],
  );
  assert.equal(low[0].tone, "warning");
  assert.deepEqual(
    highlights("habits", ctx(2)).filter((r) => r.id.startsWith("low:")),
    [],
  );
});
