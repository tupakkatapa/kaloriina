// Summary Highlights: the few sentences each subtab opens with, and only
// when the data clears its noise rules. No DOM here, so
// `node --test` covers it.
//
// A series is {values: Map<day, number>, samples: [day], label?}: the days
// that count as data (`samples`) and each one's number. A rule is
// `(ctx) => result | [result] | null`, result = {id, text, margin}; it
// returns null when a series it needs is absent, so a new data source adds
// a series and a rule, never plumbing.

import { daysIn, duration, shift, weekday } from "./dates.mjs";
import { judge } from "./food-calendar.mjs";
import { fmt, isNil, noun, plural } from "./nutrients.mjs";

// Comparisons: samples and coverage per window, the smallest change worth
// a sentence (a mean's relative change, a count, a count per week).
const MIN_SAMPLES = 7;
const MIN_COVERAGE = 0.5;
const MEAN_BAR = 0.1;
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
// Ranking: margins past the bar are capped, and so many are shown.
const MAX_MARGIN = 3;
const SHOWN = 3;

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
const sum = (list) => list.reduce((t, v) => t + v, 0);
const valuesOf = (s, days = s.samples) => days.map((d) => s.values.get(d) ?? 0);
const mean = (list) => (list.length ? sum(list) / list.length : 0);
const names = (days) =>
  days
    .toSorted((a, b) => a - b)
    .map((d) => WEEKDAYS[d])
    .join(" and ");
const pct = (change) => Math.round(Math.abs(change) * 100);

// The last day a window counts: `to`, or `last` (yesterday for food and
// habits, still being logged; today for training) while it runs.
const through = (to, last) => min(to, last);

// The last day a period's tiles count: as `through`, except that a period
// wholly after `last` has nothing elapsed and its tiles count what is
// logged, as its calendar does.
export const tileThrough = (from, to, last) =>
  from > last ? to : through(to, last);

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

// `ctx` ({kind, from, to, last, before: {from, to}, series, prev, targets,
// say}) clipped to its elapsed days, with `through`, `finished`, `days`
// (elapsed), `noun` ("last month") and the same for `before`; null when
// nothing has elapsed.
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
    days: daysIn(ctx.from, end),
    noun: `last ${ctx.kind}`,
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
  return { now, was: then, change: (now - then) / then };
}

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
  if (!named.length) return null;
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
  if (!named.length || held < MOSTLY * total) return null;
  return {
    days: named.map((x) => x.d),
    ratio: mean(named.flatMap((x) => x.list)) / overall,
  };
}

// The most rest days in a row between two training days of [from,
// through]; the period's edges count only once it is finished.
function longestGap(s, { from, through: end, finished }) {
  const trained = s.samples.filter((d) => (s.values.get(d) ?? 0) > 0);
  if (!trained.length) return finished ? daysIn(from, end) : 0;
  const gaps = trained.slice(1).map((d, i) => daysIn(trained[i], d) - 2);
  if (finished)
    gaps.push(daysIn(from, trained[0]) - 1, daysIn(trained.at(-1), end) - 1);
  return Math.max(0, ...gaps);
}

// ------------------------------------------------------------------ rules

const capped = (margin) => min(margin, MAX_MARGIN);

// "Saturdays run highest: 2,650 kcal vs 2,140 kcal on average".
const energyWeekday = (c) => {
  const w = weekdayHigh(c.series.energy);
  return (
    w && {
      id: "weekday:energy",
      text: `${names(w.days)} run highest: ${c.say.energy(w.mean)} vs ${c.say.energy(w.overall)} on average`,
      margin: w.lift / HIGH_BAR,
    }
  );
};

// "Protein up 12 % from last month": the series named in `list`, each as
// its label.
const changes = (list) => (c) =>
  list(c).map((name) => {
    const r = compare(c, name);
    if (!r || Math.abs(r.change) < MEAN_BAR) return null;
    return {
      id: `change:${name}`,
      text: `${c.series[name].label} ${r.change > 0 ? "up" : "down"} ${pct(r.change)} % from ${c.noun}`,
      margin: Math.abs(r.change) / MEAN_BAR,
    };
  });

const FOOD_SERIES = ["energy", "protein", "net_carbs", "fat"];

// "Over your energy target 5 times, 4 on weekends".
const weekendOvers = (c) => {
  const s = c.series.energy;
  const target = c.targets?.energy;
  if (!s || !s.samples.length || target?.max === undefined) return null;
  const overs = s.samples.filter(
    (d) => judge(s.values.get(d) ?? 0, target) === "over",
  );
  if (overs.length < MIN_OVERS) return null;
  const weekend = overs.filter(isWeekend).length;
  const share = weekend / overs.length;
  const base = s.samples.filter(isWeekend).length / s.samples.length;
  if (share < WEEKEND_SHARE || share - base < WEEKEND_LIFT) return null;
  return {
    id: "overs:energy",
    text: `Over your energy target ${overs.length} times, ${weekend} on weekends`,
    margin: (share - base) / WEEKEND_LIFT,
  };
};

// The mean of `outcome` on its sample days whose condition holds against
// those where it doesn't: day d's outcome against `cond(d − shift)`
// (true, false, or null when that day doesn't count). Null below
// MIN_SAMPLES a side, with a mean ≤ 0 on the "doesn't" side, or a change
// under MEAN_BAR; else {diff, change, margin}.
export function contrast({ cond, outcome, shift: by = 0 }) {
  const yes = [];
  const no = [];
  for (const d of outcome.samples) {
    const holds = cond(by ? shift(d, -by) : d);
    if (holds === true) yes.push(d);
    else if (holds === false) no.push(d);
  }
  if (yes.length < MIN_SAMPLES || no.length < MIN_SAMPLES) return null;
  const hi = mean(valuesOf(outcome, yes));
  const lo = mean(valuesOf(outcome, no));
  if (!(lo > 0)) return null;
  const change = (hi - lo) / lo;
  if (Math.abs(change) < MEAN_BAR) return null;
  return { diff: hi - lo, change, margin: Math.abs(change) / MEAN_BAR };
}

// `test` of day d's value of `s` (0 when unset) if d is one of its
// samples, else null.
const sampled = (s, test) => {
  const days = new Set(s.samples);
  return (d) => (days.has(d) ? test(s.values.get(d) ?? 0) : null);
};

const moreLess = (diff) => (diff > 0 ? "more" : "less");

// The profile's goal for `metric` (ctx.targets, registry defaults
// included: web/series.mjs); undefined without one.
const goal = (c, metric) => {
  const v = c.targets?.[metric]?.value;
  return isNil(v) ? undefined : v;
};

// "On days with 10,000+ steps you eat 300 kcal more": Health Connect steps
// against energy eaten, on the days that have both; the steps goal splits.
const stepsEnergy = (c) => {
  const { energy, steps } = c.series;
  const target = goal(c, "steps");
  if (!energy || !steps || target === undefined) return null;
  const r = contrast({
    cond: sampled(steps, (v) => v >= target),
    outcome: energy,
  });
  return (
    r && {
      id: "steps:energy",
      text: `On days with ${fmt(target)}+ steps you eat ${c.say.energy(Math.abs(r.diff))} ${moreLess(r.diff)}`,
      margin: r.margin,
    }
  );
};

// "After nights under 7 h you eat 320 kcal more": day d's energy against
// the night that ended on d; a night under the sleep goal is
// short.
const sleepEnergy = (c) => {
  const { energy, sleep } = c.series;
  const short = goal(c, "sleep_min");
  if (!energy || !sleep || short === undefined) return null;
  const r = contrast({
    cond: sampled(sleep, (v) => v < short),
    outcome: energy,
  });
  return (
    r && {
      id: "sleep:energy",
      text: `After nights under ${duration(short)} you eat ${c.say.energy(Math.abs(r.diff))} ${moreLess(r.diff)}`,
      margin: r.margin,
    }
  );
};

// "After training days you sleep 25 min more": the night after day d
// (ending d + 1) against whether d had a workout.
const trainingSleep = (c) => {
  const { workouts, sleep } = c.series;
  if (!workouts || !sleep) return null;
  const r = contrast({
    cond: sampled(workouts, (v) => v > 0),
    outcome: sleep,
    shift: 1,
  });
  return (
    r && {
      id: "training:sleep",
      text: `After training days you sleep ${duration(Math.round(Math.abs(r.diff)))} ${moreLess(r.diff)}`,
      margin: r.margin,
    }
  );
};

// "After drinking you sleep 40 min less": the night after a logged day
// against whether it had alcohol.
const alcoholSleep = (c) => {
  const { "habit:alcohol": alcohol, sleep } = c.series;
  if (!alcohol || !sleep) return null;
  const r = contrast({
    cond: sampled(alcohol, (v) => v > 0),
    outcome: sleep,
    shift: 1,
  });
  return (
    r && {
      id: "alcohol:sleep",
      text: `After drinking you sleep ${duration(Math.round(Math.abs(r.diff)))} ${moreLess(r.diff)}`,
      margin: r.margin,
    }
  );
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

// "After nights under 7 h you rate your mood 0.6 lower": day d's rating
// against the night that ended on d.
const sleepCheckIn = (metric) => (c) => {
  const { [`checkin:${metric}`]: rating, sleep } = c.series;
  const short = goal(c, "sleep_min");
  if (!rating || !sleep || short === undefined) return null;
  const r = rated(
    contrast({ cond: sampled(sleep, (v) => v < short), outcome: rating }),
  );
  return (
    r && {
      id: `sleep:checkin-${metric}`,
      text: `After nights under ${duration(short)} you rate your ${metric} ${points(r.diff)}`,
      margin: r.margin,
    }
  );
};

// "On training days you rate your mood 0.5 higher": the day itself. Today's
// rating may come before today's workout, so ratings end yesterday.
const trainingMood = (c) => {
  const { workouts, "checkin:mood": mood } = c.series;
  if (!workouts || !mood) return null;
  const r = rated(
    contrast({
      cond: sampled(workouts, (v) => v > 0),
      outcome: clip(mood, c.from, shift(c.last, -1)),
    }),
  );
  return (
    r && {
      id: "training:checkin-mood",
      text: `On training days you rate your mood ${points(r.diff)}`,
      margin: r.margin,
    }
  );
};

// "On days you drink you rate your stress 0.7 higher": logged days only.
const alcoholStress = (c) => {
  const { "habit:alcohol": alcohol, "checkin:stress": stress } = c.series;
  if (!alcohol || !stress) return null;
  const r = rated(
    contrast({ cond: sampled(alcohol, (v) => v > 0), outcome: stress }),
  );
  return (
    r && {
      id: "alcohol:checkin-stress",
      text: `On days you drink you rate your stress ${points(r.diff)}`,
      margin: r.margin,
    }
  );
};

// "2 more workouts than last month" (finished, equal lengths), "… than at
// this point last month" (running: the first N days of each, N clamped to
// the previous period's length), "0.5 more workouts a week than last
// month" (finished, unequal lengths).
// The first `k` days of `s`.
const first = (s, k) => s.samples.toSorted().slice(0, k);

const workoutChange = (c) => {
  const a = c.series.workouts;
  const b = c.prev?.workouts;
  if (!a || !b || (c.kind === "week" && !c.finished)) return null;
  // Watch workouts arriving mid-comparison are no change in training:
  // only periods the sync covered from their start compare.
  if (c.watchFrom && c.watchFrom > c.before.from) return null;
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
  // The word follows the number shown: 1.046 a week is "1 more workout".
  const amount = Math.abs(diff);
  return {
    id: "change:workouts",
    text: `${fmt(amount, 1)} ${diff > 0 ? "more" : "fewer"} ${noun(amount, "workout", "workouts", 1)}${perWeek ? " a week" : ""} than ${c.finished ? "" : "at this point "}${c.noun}`,
    margin: Math.abs(diff) / bar,
  };
};

// "You train most on Mondays and Thursdays".
const trainingWeekday = (c) => {
  const w = weekdayCounts(c.series.workouts);
  return (
    w && {
      id: "weekday:workouts",
      text: `You train most on ${names(w.days)}`,
      margin: w.ratio / RATIO_BAR,
    }
  );
};

// "Longest gap without training: 9 days".
const trainingGap = (c) => {
  const s = c.series.workouts;
  if (!s || sum(valuesOf(s)) < MIN_SESSIONS) return null;
  const gap = longestGap(s, c);
  return gap < GAP_BAR
    ? null
    : {
        id: "gap",
        text: `Longest gap without training: ${plural(gap, "day")}`,
        margin: gap / GAP_BAR,
      };
};

const habitKeys = (c) =>
  Object.keys(c.series).filter((k) => k.startsWith("habit:"));

// "Alcohol mostly on Fridays and Saturdays", per habit.
const habitWeekdays = (c) =>
  habitKeys(c).map((k) => {
    const w = weekdayCounts(c.series[k]);
    return (
      w && {
        id: `weekday:${k}`,
        text: `${c.series[k].label} mostly on ${names(w.days)}`,
        margin: w.ratio / RATIO_BAR,
      }
    );
  });

export const RULES = {
  food: [
    energyWeekday,
    changes(() => FOOD_SERIES),
    weekendOvers,
    stepsEnergy,
    sleepEnergy,
  ],
  body: [sleepCheckIn("mood"), sleepCheckIn("energy")],
  training: [
    workoutChange,
    trainingWeekday,
    trainingGap,
    trainingSleep,
    trainingMood,
  ],
  habits: [habitWeekdays, changes(habitKeys), alcoholSleep, alcoholStress],
};

// The strongest results first (margins capped), ties in rule order;
// SHOWN of them.
export const rank = (list, max = SHOWN) =>
  list
    .map((r) => ({ ...r, margin: capped(r.margin) }))
    .toSorted((a, b) => b.margin - a.margin)
    .slice(0, max);

// The tab's Highlights for `ctx` (see `prepare`), but none of `omit`'s ids.
export function highlights(tab, ctx, { omit = [] } = {}) {
  const c = prepare(ctx);
  if (!c) return [];
  return rank(
    RULES[tab]
      .flatMap((rule) => [rule(c)].flat())
      .filter((r) => r && !omit.includes(r.id)),
  );
}

// The nights among Health Connect `days` as a series: each night's minutes
// asleep, on the day it ended.
export function sleepSeries(days) {
  const nights = days.filter(
    (d) => d.asleep_min !== null && d.asleep_min !== undefined,
  );
  return {
    values: new Map(nights.map((d) => [d.day, d.asleep_min])),
    samples: nights.map((d) => d.day),
  };
}
