// Summary Highlights: the few sentences each subtab opens with, and only
// when the data clears its noise rules. No DOM here, so
// `node --test` covers it.
//
// A series is {values: Map<day, number>, samples: [day], label?}: the days
// that count as data (`samples`) and each one's number. A rule is
// `(ctx) => result | [result] | null`; it returns null when a series it
// needs is absent, so a new data source adds a series and a rule, never
// plumbing. A result is one card (ADR 0030, scannable cards): {id, tone
// (`warning`, `tip`, `correlation` or `fact`), headline (≤ 5 words:
// subject and verdict), numbers (one line: the numbers · the period),
// detail (how it was found: sources, n, ρ, caveats), link? (where it
// opens: {to: "sources", key} · {to: "metric", metric} · {to:
// "exercises", q} · {to: "activities"} · {to: "chart", x, y, xs, ys,
// lag}: series keys `x`, `y`, the series `xs`, `ys`, x read `lag` days
// before y),
// margin}.

import { bh, mannWhitney, pairDays, Q } from "./correlate.mjs";
import { daysIn, duration, shift, weekday } from "./dates.mjs";
import { fmt, fmtNum, isNil, NBSP, noun, plural } from "./format.mjs";
import {
  bmiClass,
  bodyFatTrend,
  distanceChange,
  goal,
  loadChange,
  lossRate,
  MEAN_BAR,
  muscleGaps,
  recovery,
  span,
  targetStreak,
  valuesOf,
  wholePct,
} from "./insights-rules.mjs";
import { judge } from "./nutrients.mjs";
import { mean, sum } from "./stats.mjs";

export { TRACKS_WEIGHT, bmi, tracking } from "./insights-rules.mjs";

// Comparisons: samples and coverage per window, the smallest change worth
// a sentence (a mean's relative change, a count, a count per week).
const MIN_SAMPLES = 7;
const MIN_COVERAGE = 0.5;
const COUNT_BAR = 2;
const PER_WEEK_BAR = 0.5;
// Weekdays: samples of the weekday (3 of one weekday span 3 weeks); a
// continuous series' lift and how often the weekday is above the mean; a
// count series' ratio and the share of the total the named days hold.
const MIN_WEEKDAY_SAMPLES = 3;
const HIGH_BAR = 0.15;
const CONSISTENT = 2 / 3;
const RATIO_BAR = 1.5;
const MOSTLY = 0.5;
const MAX_NAMED = 2;
// Gaps, weekend overs.
const GAP_BAR = 7;
const MIN_SESSIONS = 3;
const MIN_OVERS = 3;
const WEEKEND_SHARE = 0.6;
const WEEKEND_LIFT = 0.2;
// A check-in scale (1–5) moves by half a point before it is a change:
// contrast's 10 % alone can be a quarter point.
const SCALE_BAR = 0.5;
// Ranking: margins past the bar are capped.
const MAX_MARGIN = 3;

const WEEKDAYS = [
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
  "Sundays",
];
const isWeekend = (day) => weekday(day) >= 5;
const min = (a, b) => (a < b ? a : b);
const names = (days) =>
  days
    .toSorted((a, b) => a - b)
    .map((d) => WEEKDAYS[d])
    .join(" and ");
// The last day a window counts: `to`, or `last` (yesterday for food and
// habits, still being logged; today for activity) while it runs.
const through = (to, last) => min(to, last);

// `s` within [from, to].
function clip(s, from, to) {
  const inside = (d) => d >= from && d <= to;
  return {
    ...s,
    values: new Map([...s.values].filter(([d]) => inside(d))),
    samples: s.samples.filter(inside),
  };
}

const clipAll = (set, from, to) =>
  set &&
  Object.fromEntries(
    Object.entries(set).map(([k, s]) => [k, clip(s, from, to)]),
  );

// The period a card's numbers cover: "this month so far" while it runs,
// else its days ("Sep 1 – 30"). `through` the last day counted.
export const periodWords = ({ kind, from, to, through: end }) =>
  end < to ? `this ${kind} so far` : span(from, end);

// `ctx` ({kind, from, to, last, before: {from, to}, series, prev, targets,
// say}; and as a subtab has them: `person` (the profile), `trailing` (the 90
// days ending `through`, unclipped: series and `activities`), `exercises` (id →
// exercise), `activities` and `beforeActivities` (the two periods'), `cardio`
// (summary-load.mjs loadCardio), `warnings`
// (food) and `correlations` (the subtab's)) clipped to its elapsed days, with
// `through`, `finished`, `days` (elapsed), `when` (periodWords), `noun` ("the
// month before": the period shown may not be the current one) and the same for
// `before`; null when nothing has elapsed.
export function prepare(ctx) {
  const end = through(ctx.to, ctx.last);
  if (end < ctx.from) return null;
  const before = ctx.before && {
    ...ctx.before,
    through: through(ctx.before.to, ctx.last),
  };
  if (before)
    before.days =
      before.through < before.from ? 0 : daysIn(before.from, before.through);
  return {
    ...ctx,
    through: end,
    finished: end === ctx.to,
    when: periodWords({ ...ctx, through: end }),
    days: daysIn(ctx.from, end),
    noun: `the ${ctx.kind} before`,
    series: clipAll(ctx.series ?? {}, ctx.from, end),
    before,
    prev: before && clipAll(ctx.prev, before.from, before.through),
  };
}

const enough = (s, days) =>
  s.samples.length >= MIN_SAMPLES && s.samples.length >= MIN_COVERAGE * days;

// The mean per sample of the series `name` now ({now, was, change}) against
// the previous period, when both windows clear the comparison gate: enough
// samples and coverage, a finished week, a previous mean above 0. `c` is
// prepared.
export function compare(c, name) {
  const a = c?.series[name];
  const b = c?.prev?.[name];
  if (!a || !b) return null;
  if (c.kind === "week" && !c.finished) return null;
  if (!enough(a, c.days) || !enough(b, c.before.days)) return null;
  const now = mean(valuesOf(a));
  const then = mean(valuesOf(b));
  if (!(then > 0)) return null;
  return {
    now,
    was: then,
    change: (now - then) / then,
    n: [a.samples.length, b.samples.length],
  };
}

// "(12 vs 19 days)": how many samples each side of a comparison holds.
const counts = ([a, b], unit = "days") => `(${fmt(a)} vs ${fmt(b)} ${unit})`;

const byWeekday = (s) => {
  const out = Array.from({ length: 7 }, () => []);
  for (const d of s.samples) out[weekday(d)].push(s.values.get(d) ?? 0);
  return out;
};

// The weekdays a continuous series runs highest on: each ≥ HIGH_BAR over
// the overall mean, above it on ≥ CONSISTENT of its samples; at most
// MAX_NAMED, with their mean and lift. Null when none clears it.
function weekdayHigh(s) {
  if (!s) return null;
  const overall = mean(valuesOf(s));
  if (!(overall > 0)) return null;
  const named = byWeekday(s)
    .map((list, d) => ({ d, list, lift: mean(list) / overall - 1 }))
    .filter(
      ({ list, lift }) =>
        list.length >= MIN_WEEKDAY_SAMPLES &&
        lift >= HIGH_BAR &&
        list.filter((v) => v > overall).length >= CONSISTENT * list.length,
    )
    .toSorted((a, b) => b.lift - a.lift)
    .slice(0, MAX_NAMED);
  if (named.length === 0) return null;
  const m = mean(named.flatMap((x) => x.list));
  return {
    days: named.map((x) => x.d),
    mean: m,
    overall,
    lift: m / overall - 1,
  };
}

// The weekdays a count series mostly falls on: each ≥ RATIO_BAR × the
// overall mean, non-zero on ≥ CONSISTENT of its samples; at most MAX_NAMED,
// holding ≥ MOSTLY of the total. Null otherwise.
function weekdayCounts(s) {
  if (!s) return null;
  const total = sum(valuesOf(s));
  if (!(total > 0)) return null;
  const overall = total / s.samples.length;
  const named = byWeekday(s)
    .map((list, d) => ({ d, list, ratio: mean(list) / overall }))
    .filter(
      ({ list, ratio }) =>
        list.length >= MIN_WEEKDAY_SAMPLES &&
        ratio >= RATIO_BAR &&
        list.filter((v) => v > 0).length >= CONSISTENT * list.length,
    )
    .toSorted((a, b) => b.ratio - a.ratio)
    .slice(0, MAX_NAMED);
  const held = sum(named.flatMap((x) => x.list));
  if (named.length === 0 || held < MOSTLY * total) return null;
  return {
    days: named.map((x) => x.d),
    ratio: mean(named.flatMap((x) => x.list)) / overall,
  };
}

// The most rest days in a row between two active days of [from,
// through], as {days, from, to} (the rest days' own span), or null: the
// period's end counts once it is finished, its start only when activity
// was logged `before` it (a period before tracking began isn't rest).
function longestGap(s, { from, through: end, finished }, before) {
  const edges = [
    ...(before ? [shift(from, -1)] : []),
    ...s.samples.filter((d) => (s.values.get(d) ?? 0) > 0),
    ...(finished ? [shift(end, 1)] : []),
  ];
  let best = null;
  for (let i = 1; i < edges.length; i++) {
    const days = daysIn(edges[i - 1], edges[i]) - 2;
    if (days > (best?.days ?? 0))
      best = { days, from: shift(edges[i - 1], 1), to: shift(edges[i], -1) };
  }
  return best;
}

// --------------------------------------------------------------- rules

const capped = (margin) => min(margin, MAX_MARGIN);

// "Sat, Sun": weekdays short, for a headline.
const SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const shortNames = (days) =>
  days
    .toSorted((a, b) => a - b)
    .map((d) => SHORT[d])
    .join(", ");

// How a series' value reads: the context's `say` for it, else the
// series' own (a habit's: "2.2 drinks"), else a number.
const sayOf = (c, name) => c.say?.[name] ?? c.series[name]?.say ?? fmtNum;

// Energy highest on Sat, Sun · 2,650 vs 2,140 kcal average.
const energyWeekday = (c) => {
  const s = c.series.energy;
  const w = weekdayHigh(s);
  const say = sayOf(c, "energy");
  // A mean over a day whose energy leaves some out (`s.partly`) is a floor:
  // "≥" as the Daily averages say it.
  const floor = (days) =>
    days.some((d) => s.partly?.has(d)) ? `≥${NBSP}` : "";
  return (
    w && {
      id: "weekday:energy",
      tone: "fact",
      headline: `Energy highest ${shortNames(w.days)}`,
      numbers: `${floor(s.samples.filter((d) => w.days.includes(weekday(d))))}${say(w.mean)} vs ${floor(s.samples)}${say(w.overall)} average · ${c.when}`,
      detail: `${names(w.days)} ran ${wholePct(w.lift)} above your daily mean, above it on at least two in three of them (${plural(s.samples.length, "day")} logged).`,
      margin: w.lift / HIGH_BAR,
      link: { to: "sources", key: "energy" },
    }
  );
};

// Whether a series' mean is a floor: any of its days leaves some out.
const floored = (s) => s.samples.some((d) => s.partly?.has(d));

// Protein up 12 % · 31 vs 30 days · from the month before: the series
// named in `list`, each as its label, over its days (`sampled`: "known"
// for a built-in habit's, else "logged"); `link` names where one opens.
const changes =
  (list, link = () => null) =>
  (c) =>
    list(c).map((name) => {
      const r = compare(c, name);
      if (!r || Math.abs(r.change) < MEAN_BAR) return null;
      // A mean over a floor day is a floor (the Daily averages' "≥"): a
      // floor against anything is no trend.
      if (floored(c.series[name]) || floored(c.prev[name])) return null;
      const say = sayOf(c, name);
      return {
        id: `change:${name}`,
        tone: "fact",
        headline: `${c.series[name].label} ${r.change > 0 ? "up" : "down"} ${wholePct(r.change)}`,
        numbers: `${say(r.now)} vs ${say(r.was)} a day · ${c.when} vs ${c.noun}`,
        detail: `Mean of the ${c.series[name].sampled ?? "logged"} days ${counts(r.n)}; a change under ${wholePct(MEAN_BAR)} isn't said.`,
        margin: Math.abs(r.change) / MEAN_BAR,
        link: link(name),
      };
    });

const FOOD_SERIES = ["energy", "protein", "net_carbs", "fat"];

// Weekend energy overs · 4 of 5 overs on weekends.
const weekendOvers = (c) => {
  const s = c.series.energy;
  const target = c.targets?.energy;
  if (!s || s.samples.length === 0 || target?.max === undefined) return null;
  const overs = s.samples.filter(
    (d) => judge(s.values.get(d) ?? 0, target) === "over",
  );
  if (overs.length < MIN_OVERS) return null;
  const weekend = overs.filter((x) => isWeekend(x)).length;
  const share = weekend / overs.length;
  const base = s.samples.filter(isWeekend).length / s.samples.length;
  if (share < WEEKEND_SHARE || share - base < WEEKEND_LIFT) return null;
  return {
    id: "overs:energy",
    tone: "fact",
    headline: "Weekend energy overs",
    numbers: `${weekend} of the ${overs.length} days over target were weekends · ${c.when}`,
    detail: `Weekends are ${wholePct(base)} of the ${plural(s.samples.length, "day")} logged but ${wholePct(share)} of the days over your energy target.`,
    margin: (share - base) / WEEKEND_LIFT,
    link: { to: "sources", key: "energy" },
  };
};

// The mean of `outcome` on its sample days whose condition holds against
// those where it doesn't: day d's outcome against `cond(d − shift)`
// (true, false, or null when that day doesn't count). Null below
// MIN_SAMPLES a side, with a mean ≤ 0 on the "doesn't" side, or a change
// under MEAN_BAR; else {diff, change, margin, n: [yes, no] sample days,
// p, r: the difference tested (correlate.mjs mannWhitney)}. Whether it is
// said is `highlights`' (CONTRASTS).
export function contrast({ cond, outcome, shift: by = 0 }) {
  const yes = [];
  const no = [];
  for (const [at, d] of pairDays(outcome, by)) {
    const holds = cond(at);
    if (holds === true) yes.push(d);
    else if (holds === false) no.push(d);
  }
  if (yes.length < MIN_SAMPLES || no.length < MIN_SAMPLES) return null;
  const a = valuesOf(outcome, yes);
  const b = valuesOf(outcome, no);
  const hi = mean(a);
  const lo = mean(b);
  if (!(lo > 0)) return null;
  const change = (hi - lo) / lo;
  if (Math.abs(change) < MEAN_BAR) return null;
  return {
    diff: hi - lo,
    change,
    margin: Math.abs(change) / MEAN_BAR,
    n: [yes.length, no.length],
    ...mannWhitney(a, b),
  };
}

// `test` of day d's value of `s` (0 when unset) if d is one of its
// samples, else null.
const sampled = (s, test) => {
  const days = new Set(s.samples);
  return (d) => (days.has(d) ? test(s.values.get(d) ?? 0) : null);
};

const moreLess = (diff) => (diff > 0 ? "more" : "less");

// What every contrast's detail ends on: what it compares and that it is
// no cause.
const SEEN = "Seen together, not shown to cause it.";

// "p 0.012", "p < 0.001".
const pText = (p) => (p < 0.001 ? "p < 0.001" : `p ${fmt(p, 3)}`);

// A contrast's result (tone `correlation`: its test is a rank-biserial
// correlation, `p` kept for `highlights`' false discovery rate): `x` the
// condition's series and `y` the outcome, read `lag` days apart, charted
// from its link.
const contrasted = (c, r, fields) => {
  if (!r) return null;
  const { id, headline, numbers, detail, x, y, lag = 0 } = fields();
  return {
    id,
    tone: "correlation",
    headline,
    numbers: `${numbers} · ${c.when}`,
    detail: `${detail} Mann–Whitney ${pText(r.p)}, rank-biserial r ${fmt(r.r, 2)}; one of ${CONTRASTS} contrasts, Benjamini–Hochberg q ≤ ${Q}. ${SEEN}`,
    margin: r.margin,
    p: r.p,
    link: { to: "chart", x, y, xs: c.series[x], ys: c.series[y], lag },
  };
};

// Steps → energy eaten · On 10,000+ step days you ate ~300 kcal more
// (12 vs 19 days): Health Connect steps against energy eaten, on the days
// that have both; the steps goal splits.
const stepsEnergy = (c) => {
  const { energy, steps } = c.series;
  const target = goal(c, "steps");
  if (!energy || !steps || target === undefined) return null;
  const r = contrast({
    cond: sampled(steps, (v) => v >= target),
    outcome: energy,
  });
  return contrasted(c, r, () => ({
    id: "steps:energy",
    headline: "Steps → energy eaten",
    numbers: `On ${fmt(target)}+ step days you ate ~${sayOf(c, "energy")(Math.abs(r.diff))} ${moreLess(r.diff)} ${counts(r.n)}`,
    detail: `Mean energy eaten on days at your ${fmt(target)} steps goal against days under it.`,
    x: "steps",
    y: "energy",
  }));
};

// Sleep → energy eaten · After nights under 7 h you ate ~320 kcal more
// (8 vs 20 days): day d's energy against the night that ended on d; a
// night under the sleep goal is short.
const sleepEnergy = (c) => {
  const { energy, sleep } = c.series;
  const short = goal(c, "sleep_min");
  if (!energy || !sleep || short === undefined) return null;
  const r = contrast({
    cond: sampled(sleep, (v) => v < short),
    outcome: energy,
  });
  return contrasted(c, r, () => ({
    id: "sleep:energy",
    headline: "Sleep → energy eaten",
    numbers: `After nights under ${duration(short)} you ate ~${sayOf(c, "energy")(Math.abs(r.diff))} ${moreLess(r.diff)} ${counts(r.n)}`,
    detail: `Mean energy eaten on days after a night under your ${duration(short)} sleep goal against the other days.`,
    x: "sleep",
    y: "energy",
  }));
};

const longerShorter = (diff) => (diff > 0 ? "longer" : "shorter");

// Activity → sleep · After active days you slept 25 min longer (10 vs 21
// nights): the night after day d (ending d + 1) against whether d had an
// activity.
const activitySleep = (c) => {
  const { activities, sleep } = c.series;
  if (!activities || !sleep) return null;
  const r = contrast({
    cond: sampled(activities, (v) => v > 0),
    outcome: sleep,
    shift: 1,
  });
  return contrasted(c, r, () => ({
    id: "activity:sleep",
    headline: "Activity → sleep",
    numbers: `After active days you slept ${duration(Math.round(Math.abs(r.diff)))} ${longerShorter(r.diff)} ${counts(r.n, "nights")}`,
    detail:
      "Mean sleep the night after a day with an activity against the night after a rest day.",
    x: "activities",
    y: "sleep",
    lag: 1,
  }));
};

// Alcohol → sleep · After drinking you slept 40 min shorter (9 vs 30
// nights): the night after a logged day against whether it had alcohol.
const alcoholSleep = (c) => {
  const { "habit:alcohol": alcohol, sleep } = c.series;
  if (!alcohol || !sleep) return null;
  const r = contrast({
    cond: sampled(alcohol, (v) => v > 0),
    outcome: sleep,
    shift: 1,
  });
  return contrasted(c, r, () => ({
    id: "alcohol:sleep",
    headline: "Alcohol → sleep",
    numbers: `After drinking you slept ${duration(Math.round(Math.abs(r.diff)))} ${longerShorter(r.diff)} ${counts(r.n, "nights")}`,
    detail:
      "Mean sleep the night after a logged day with alcohol against one without.",
    x: "habit:alcohol",
    y: "sleep",
    lag: 1,
  }));
};

// A contrast whose outcome is a check-in scale: also |diff| ≥ SCALE_BAR,
// its margin in those half points.
const rated = (r) =>
  r && Math.abs(r.diff) >= SCALE_BAR
    ? { ...r, margin: Math.abs(r.diff) / SCALE_BAR }
    : null;

// "0.6 higher": a scale's difference, to a tenth.
const points = (diff) =>
  `${fmt(Math.abs(diff), 1)} ${diff > 0 ? "higher" : "lower"}`;

// The check-in "Energy" is the energy level, told apart from energy eaten.
const SCALE_WORD = { mood: "mood", energy: "energy level", stress: "stress" };

// Sleep → mood · After nights under 7 h mood rated 0.6 lower (8 vs 20
// days): day d's rating against the night that ended on d.
const sleepCheckIn = (metric) => (c) => {
  const { [`checkin:${metric}`]: rating, sleep } = c.series;
  const short = goal(c, "sleep_min");
  if (!rating || !sleep || short === undefined) return null;
  const r = rated(
    contrast({ cond: sampled(sleep, (v) => v < short), outcome: rating }),
  );
  return contrasted(c, r, () => ({
    id: `sleep:checkin-${metric}`,
    headline: `Sleep → ${SCALE_WORD[metric]}`,
    numbers: `After nights under ${duration(short)} ${SCALE_WORD[metric]} rated ${points(r.diff)} ${counts(r.n)}`,
    detail: `Mean ${SCALE_WORD[metric]} check-in (1–5) after a night under your ${duration(short)} sleep goal against the other days; half a point is the bar.`,
    x: "sleep",
    y: `checkin:${metric}`,
  }));
};

// Activity → mood · On active days mood rated 0.5 higher (9 vs 20 days):
// the day itself. Today's rating may come before today's activity, so
// ratings end yesterday.
const activityMood = (c) => {
  const { activities, "checkin:mood": mood } = c.series;
  if (!activities || !mood) return null;
  const r = rated(
    contrast({
      cond: sampled(activities, (v) => v > 0),
      outcome: clip(mood, c.from, shift(c.last, -1)),
    }),
  );
  return contrasted(c, r, () => ({
    id: "activity:checkin-mood",
    headline: "Activity → mood",
    numbers: `On active days mood rated ${points(r.diff)} ${counts(r.n)}`,
    detail:
      "Mean mood check-in (1–5) on days with an activity against rest days; half a point is the bar.",
    x: "activities",
    y: "checkin:mood",
  }));
};

// Alcohol → stress · On days with alcohol stress rated 0.7 higher (6 vs
// 25 days): logged days only.
const alcoholStress = (c) => {
  const { "habit:alcohol": alcohol, "checkin:stress": stress } = c.series;
  if (!alcohol || !stress) return null;
  const r = rated(
    contrast({ cond: sampled(alcohol, (v) => v > 0), outcome: stress }),
  );
  return contrasted(c, r, () => ({
    id: "alcohol:checkin-stress",
    headline: "Alcohol → stress",
    numbers: `On days with alcohol stress rated ${points(r.diff)} ${counts(r.n)}`,
    detail:
      "Mean stress check-in (1–5) on logged days with alcohol against those without; half a point is the bar.",
    x: "habit:alcohol",
    y: "checkin:stress",
  }));
};

// The first `k` days of `s`.
const first = (s, k) => s.samples.toSorted().slice(0, k);

// Whether activityChange compares `c`'s periods: both counted, a week
// only once over. Device activities arriving mid-comparison are no change
// in activity: only periods the sync covered from their start compare.
const comparable = (c) =>
  Boolean(c.series.activities && c.prev?.activities) &&
  (c.kind !== "week" || c.finished) &&
  !(c.deviceFrom && c.deviceFrom > c.before.from);

// More activities · 2 more than the month before (finished, equal
// lengths), "… than at this point the month before" (running: the first N
// days of each, N clamped to the previous period's length), "0.5 more a
// week …" (finished, unequal lengths).
const activityChange = (c) => {
  if (!comparable(c)) return null;
  const a = c.series.activities;
  const b = c.prev.activities;
  const n = min(c.days, c.before.days);
  if (n < MIN_SAMPLES) return null;
  const perWeek = c.finished && c.days !== c.before.days;
  const now = sum(valuesOf(a, perWeek ? a.samples : first(a, n)));
  const then = sum(valuesOf(b, perWeek ? b.samples : first(b, n)));
  if (!(then > 0)) return null;
  const diff = perWeek
    ? (now * 7) / c.days - (then * 7) / c.before.days
    : now - then;
  const bar = perWeek ? PER_WEEK_BAR : COUNT_BAR;
  if (Math.abs(diff) < bar) return null;
  // The word follows the number shown: 1.046 a week is "1 more activity".
  const amount = Math.abs(diff);
  return {
    id: "change:activities",
    tone: "fact",
    headline: `${diff > 0 ? "More" : "Fewer"} activities`,
    numbers: `${fmt(amount, 1)} ${diff > 0 ? "more" : "fewer"} ${noun(amount, "activity", "activities", 1)}${perWeek ? " a week" : ""} than ${c.finished ? "" : "at this point "}${c.noun} · ${c.when}`,
    detail: perWeek
      ? `${fmt((now * 7) / c.days, 1)} vs ${fmt((then * 7) / c.before.days, 1)} a week over ${plural(c.days, "day")} vs ${plural(c.before.days, "day")}.`
      : `${fmt(now)} vs ${fmt(then)} over the first ${plural(n, "day")} of each.`,
    margin: Math.abs(diff) / bar,
    link: { to: "activities" },
  };
};

// Most active Mon, Thu · 1.8× your daily average.
const activityWeekday = (c) => {
  const w = weekdayCounts(c.series.activities);
  return (
    w && {
      id: "weekday:activities",
      tone: "fact",
      headline: `Most active ${shortNames(w.days)}`,
      numbers: `${fmt(w.ratio, 1)}× your daily average · ${c.when}`,
      detail: `${names(w.days)} hold most of your activities, with one on at least two in three of them.`,
      margin: w.ratio / RATIO_BAR,
      link: { to: "activities" },
    }
  );
};

// Long gap without activity · 9 days.
const activityGap = (c) => {
  const s = c.series.activities;
  if (!s || sum(valuesOf(s)) < MIN_SESSIONS) return null;
  const was = c.prev?.activities;
  const gap = longestGap(s, c, !!was && sum(valuesOf(was)) > 0);
  return !gap || gap.days < GAP_BAR
    ? null
    : {
        id: "gap",
        tone: "fact",
        headline: "Long gap without activity",
        numbers: `${plural(gap.days, "day")} in a row · ${span(gap.from, gap.to)}`,
        detail: `The most rest days in a row between activities, ${c.when}; ${plural(GAP_BAR, "day")} is the bar.`,
        margin: gap.days / GAP_BAR,
        link: { to: "activities" },
      };
};

const habitKeys = (c) =>
  Object.keys(c.series).filter((k) => k.startsWith("habit:"));

// Alcohol mostly Fri, Sat · 2.4× its daily average, per habit.
const habitWeekdays = (c) =>
  habitKeys(c).map((k) => {
    const w = weekdayCounts(c.series[k]);
    return (
      w && {
        id: `weekday:${k}`,
        tone: "fact",
        headline: `${c.series[k].label} mostly ${shortNames(w.days)}`,
        numbers: `${fmt(w.ratio, 1)}× its daily average · ${c.when}`,
        detail: `${names(w.days)} hold most of it, logged on at least two in three of them.`,
        margin: w.ratio / RATIO_BAR,
      }
    );
  });

// Under this share of the day's goal, on average, hydration is low.
const HYDRATION_LOW = 0.7;

// Hydration low · 1.6 L of 2.8 L a day: the built-in's known days against
// each one's goal, the one the Diary and the calendar judge it by (the
// water target, more on a day with activity: habits.mjs goalOn), in its
// own unit.
const hydrationLow = (c) => {
  const s = c.series["habit:water"];
  if (!s?.goalOn || !enough(s, c.days)) return null;
  const goals = s.samples.map((d) => s.goalOn(d));
  if (goals.some((x) => isNil(x))) return null;
  const now = mean(valuesOf(s));
  const target = mean(goals);
  if (!(now < HYDRATION_LOW * target)) return null;
  const say = sayOf(c, "habit:water");
  return {
    id: "low:hydration",
    tone: "warning",
    headline: "Hydration low",
    numbers: `${say(now)} of ${say(target)} a day · ${c.when}`,
    detail: `Under ${wholePct(HYDRATION_LOW)} of the day's goal on average, over ${plural(s.samples.length, "day")} whose hydration is known. A day's goal is your water target, more on a day with activity, as the Diary's.`,
    margin: now > 0 ? (HYDRATION_LOW * target) / now : MAX_MARGIN,
  };
};

// ----------------------------------------------------- food (ADR 0030)

// Low and high nutrients and the vitamin D tip (web/nutrient-warnings.mjs),
// as the screen worked them out (`c.warnings`, with their sources).
const foodWarnings = (c) => c.warnings ?? null;

export const RULES = {
  food: [
    energyWeekday,
    changes(
      () => FOOD_SERIES,
      (key) => ({ to: "sources", key }),
    ),
    weekendOvers,
    stepsEnergy,
    sleepEnergy,
    foodWarnings,
  ],
  body: [
    sleepCheckIn("mood"),
    sleepCheckIn("energy"),
    bmiClass,
    lossRate,
    recovery,
    bodyFatTrend,
  ],
  activity: [
    activityChange,
    activityWeekday,
    activityGap,
    activitySleep,
    activityMood,
    muscleGaps,
    targetStreak,
    distanceChange,
    loadChange,
  ],
  habits: [
    hydrationLow,
    habitWeekdays,
    changes(habitKeys),
    alcoholSleep,
    alcoholStress,
  ],
};

// The tones in the order a stack reads them: what needs acting on first,
// a plain fact last.
const TONE_ORDER = ["warning", "tip", "correlation", "fact"];

// By tone (TONE_ORDER), then the strongest (margins capped), ties in rule
// order; `max` of them.
export const rank = (list, max = Infinity) =>
  list
    .map((r) => ({ ...r, margin: capped(r.margin) }))
    .toSorted(
      (a, b) =>
        TONE_ORDER.indexOf(a.tone) - TONE_ORDER.indexOf(b.tone) ||
        b.margin - a.margin,
    )
    .slice(0, max);

// A card's pair of series (`x`, `y`, read `lag` days apart) either way
// round, or null. A built-in habit's series is its food series
// ("habit:alcohol" is "alcohol"): one finding, whichever tier read it.
const PAIR_SAME = /^habit:(?=\D)/u;
const pairOf = (r) =>
  r.x && r.y
    ? `${[r.x, r.y]
        .map((k) => k.replace(PAIR_SAME, ""))
        .toSorted()
        .join("~")}@${r.lag ?? 0}`
    : null;

// The contrast rules (`contrasted`) across every tab: steps and sleep →
// energy eaten, sleep → mood and energy level, activity → sleep and mood,
// alcohol → sleep and stress. One family of tests, whichever tab runs: a
// contrast is said only when it clears Benjamini–Hochberg at the
// correlations' Q among CONTRASTS p-values, those not tested here counted
// as 1 (never more lenient than the whole family).
const CONTRASTS = 8;

// The tab's Highlights for `ctx` (see `prepare`), ranked (`rank`), but
// none of `omit`'s ids: the rules' (a contrast only past its test), the
// subtab's correlations (`ctx.correlations`) and discovered patterns
// (`ctx.discovered`, web/correlate.mjs `discover`). A contrast whose pair
// a correlation shown already tests (`covers`) stays out, the
// pre-registered test the stronger; so does a discovered pattern whose
// pair a card shown states (`pairOf`).
// ponytail: a pattern dropped here still took one of the DISCOVERED_SHOWN
// picked across Summary; pick per tab after this if one goes missing.
export function highlights(tab, ctx, { omit = [] } = {}) {
  const c = prepare(ctx);
  if (!c) return [];
  const kept = (r) => r && !omit.includes(r.id);
  const ruled = RULES[tab]
    .flatMap((rule) => [rule(c)].flat())
    .filter((x) => kept(x));
  const tested = ruled.filter((r) => r.p !== undefined);
  const passed = bh(
    [
      ...tested.map((r) => r.p),
      ...Array.from({ length: CONTRASTS }, () => 1),
    ].slice(0, Math.max(CONTRASTS, tested.length)),
    Q,
  );
  const correlated = (c.correlations ?? []).filter((x) => kept(x));
  const covered = new Set(correlated.map((r) => r.covers));
  const said = [
    ...ruled.filter(
      (r) =>
        r.p === undefined || (passed[tested.indexOf(r)] && !covered.has(r.id)),
    ),
    ...correlated,
  ];
  const pairs = new Set(said.map((x) => pairOf(x)).filter(Boolean));
  const found = (c.discovered ?? []).filter(
    (r) => kept(r) && !pairs.has(pairOf(r)),
  );
  return rank([...said, ...found]);
}

// A series (`{values: Map day → value, samples: [day]}`, the shape every
// rule here reads) of `list` ([{day, …}]): each item's `valueOf` (a key,
// or a function of it) on its day.
export function seriesOf(list, valueOf) {
  const of = typeof valueOf === "function" ? valueOf : (x) => x[valueOf];
  return {
    values: new Map(list.map((x) => [x.day, of(x)])),
    samples: list.map((x) => x.day),
  };
}

// A series over every day of [from, to] (a day without any is a 0, not
// missing): what `add` makes of each of `list` ([{day, …}]), summed by day.
export function everyDay(from, to, list, add) {
  const values = new Map();
  for (const x of list) values.set(x.day, (values.get(x.day) ?? 0) + add(x));
  return {
    values,
    samples: Array.from({ length: daysIn(from, to) }, (_, i) => shift(from, i)),
  };
}

// `key`'s change a day between consecutive points of `list` ([{day, key}],
// by day), on the later one's day: a 3-week gap's delta over 21 days, so
// a steady change reads the same whatever the gap.
export const changeADay = (list, key) =>
  list.slice(1).map((t, i) => ({
    day: t.day,
    [key]: (t[key] - list[i][key]) / (daysIn(list[i].day, t.day) - 1),
  }));

// The days of `list` that have `key`, as a series of it.
export const present = (list, key) =>
  seriesOf(
    list.filter((x) => !isNil(x[key])),
    key,
  );

// The nights among Health Connect `days` as a series: each night's
// minutes asleep (`asleep_min`, naps not added, as Summary → Body's
// "asleep a night" reads it), on the day it ended.
export const sleepSeries = (days) => present(days, "asleep_min");

// ---------------------------------------------------- Highlights prefs

// Discovered patterns shown across Summary, those marked "Interesting"
// aside.
export const DISCOVERED_SHOWN = 2;

// Whether card `r` is shown on `day`: not hidden (`prefs`, web/series.mjs:
// id → {state, until}) through it.
export const notHidden = (r, prefs, day) => {
  const x = prefs.get(r.id);
  return !(x?.state === "hidden" && x.until >= day);
};

// The discovered patterns shown of `list` on `day`: not hidden, those
// marked "Interesting" first (leading their tone), then the strongest up
// to DISCOVERED_SHOWN in all.
export function keptPatterns(list, prefs, day) {
  const visible = list.filter((r) => notHidden(r, prefs, day));
  const marked = visible.filter((r) => prefs.get(r.id)?.state === "pinned");
  const rest = visible.filter((r) => !marked.includes(r));
  return [
    ...marked.map((r) => ({ ...r, margin: Infinity, pinned: true })),
    ...rest.slice(0, Math.max(0, DISCOVERED_SHOWN - marked.length)),
  ];
}
