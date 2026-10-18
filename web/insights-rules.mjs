// Summary Highlights' rule families for the body and activity subtabs
// (web/insights.mjs holds the rest, the shapes and the ranking), and the
// words every rule shares. No DOM here, so `node --test` covers it.

import { counted, distanceOf, pace, paceDistance } from "./activities.mjs";
import { ageOn, daysIn, parseDay, pretty, shift, weekStart } from "./dates.mjs";
import { fmt, fmtFixed, isNil, NBSP, pct, plural } from "./format.mjs";
import { periodLoad } from "./load.mjs";
import { leastSquares, mean, sum } from "./stats.mjs";
import { MI_M, unitQty, unitSystem } from "./units.mjs";

// The smallest relative change of a mean worth a sentence.
export const MEAN_BAR = 0.1;

export const valuesOf = (s, days = s.samples) =>
  days.map((d) => s.values.get(d) ?? 0);

// A share or a change, its sign left to the words, as a whole percentage:
// "12 %".
export const wholePct = (change) => pct(Math.round(Math.abs(change) * 100));

// "Jul 25 – 31": a span of days, as the Summary titles read.
const SPAN = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
export const span = (from, to) =>
  SPAN.formatRange(parseDay(from), parseDay(to));

// The profile's goal for `metric` (ctx.targets, registry defaults
// included: web/series.mjs); undefined without one.
export const goal = (c, metric) => {
  const v = c.targets?.[metric]?.value;
  return isNil(v) ? undefined : v;
};

// ----------------------------------------------------- body (ADR 0030)

// WHO adult BMI classes, each up to (not including) its bound.
const BMI_CLASSES = [
  [18.5, "underweight"],
  [25, "a healthy weight"],
  [30, "overweight"],
  [Infinity, "obesity"],
];
const ADULT = 18;

// The latest sample of `s` ({day, value}), or null.
const latest = (s) => {
  const day = s?.samples.at(-1);
  return day === undefined ? null : { day, value: s.values.get(day) };
};

// BMI from kg and cm.
export const bmi = (kg, cm) => kg / (cm / 100) ** 2;

// BMI 24.3 · a healthy weight (WHO, adults): adults with a height only. A
// plain fact, ranked low.
export const bmiClass = (c) => {
  const w = latest(c.series.weight);
  const { height_cm: cm, birth_date: birth } = c.person ?? {};
  if (!w || !cm || !birth || ageOn(birth, w.day) < ADULT) return null;
  // The class of the value shown (24.97 reads "25": overweight).
  const v = Math.round(bmi(w.value, cm) * 10) / 10;
  return {
    id: "bmi",
    tone: "fact",
    // To a tenth always: "25.0", not "25" beside "to 25 a healthy weight".
    headline: `BMI ${fmtFixed(v, 1)}`,
    numbers: `${BMI_CLASSES.find(([bound]) => v < bound)[1]} (WHO, adults) · weigh-in of ${pretty(w.day, false)}`,
    detail:
      "WHO adult classes: under 18.5 underweight, to 25 a healthy weight, to 30 overweight, then obesity. BMI can't tell muscle from fat.",
    margin: 1,
    link: { to: "metric", metric: "bmi" },
  };
};

// Losing faster than this share of body weight a week warns; the
// weigh-ins and span its slope needs.
const LOSS_BAR = 0.01;
const MIN_WEIGH_INS = 4;
const MIN_SPAN = 14;

// The least-squares change of `s` a day over its samples; null under two.
const slopeOf = (s) =>
  leastSquares(
    s.samples.map((d) => daysIn(s.samples[0], d)),
    valuesOf(s),
  );

const spans = (s, n, days) =>
  s &&
  s.samples.length >= n &&
  daysIn(s.samples[0], s.samples.at(-1)) - 1 >= days;

// Losing weight fast · 1.3 % of body weight a week: faster than the 0.5–1
// % a week advised to keep muscle (Helms et al., IJSNEM 2014; Garthe et
// al., IJSNEM 2011: a guide, not a cliff): the period's weigh-ins (≥ 4
// over ≥ 14 days).
export const lossRate = (c) => {
  const s = c.series.weight;
  if (!spans(s, MIN_WEIGH_INS, MIN_SPAN)) return null;
  const rate = (-slopeOf(s) * 7) / latest(s).value;
  if (!(rate > LOSS_BAR)) return null;
  return {
    id: "loss-rate",
    tone: "warning",
    headline: "Losing weight fast",
    numbers: `${fmt(rate * 100, 1)}${NBSP}% of body weight a week · ${c.when}`,
    detail: `The least-squares slope of ${plural(s.samples.length, "weigh-in")}. Faster than the 0.5–1${NBSP}% a week advised to keep muscle (Helms et al. 2014; Garthe et al. 2011): a guide, not a cliff.`,
    margin: rate / LOSS_BAR,
    link: { to: "metric", metric: "weight" },
  };
};

// Recovery: the last RECENT days' mean against the BASELINE days before
// (≥ 5 and ≥ 14 samples): resting HR up ≥ 5 bpm or HRV down ≥ 15 %.
const RECENT = 7;
const BASELINE = 28;
const MIN_RECENT = 5;
const MIN_BASELINE = 14;
const RHR_BAR = 5;
const HRV_BAR = 0.15;

// `s`'s mean over its recent and baseline days ending `end`, when both
// have enough samples.
const recentVsBaseline = (s, end) => {
  if (!s) return null;
  const cut = shift(end, -RECENT);
  const start = shift(cut, -BASELINE);
  const recent = s.samples.filter((d) => d > cut && d <= end);
  const base = s.samples.filter((d) => d > start && d <= cut);
  if (recent.length < MIN_RECENT || base.length < MIN_BASELINE) return null;
  return {
    now: mean(valuesOf(s, recent)),
    was: mean(valuesOf(s, base)),
    n: [recent.length, base.length],
  };
};

// RHR above usual · 6 bpm · last 7 days; HRV below usual · 18 %: from the
// trailing days (`c.trailing`), so a week shown still has its 4 weeks
// before. A period already over names its days ("Jul 25 – 31") and gives
// no advice: a past week's rest is no warning now.
export const recovery = (c) => {
  const end = c.through;
  const hr = recentVsBaseline(c.trailing?.resting_hr, end);
  const hrv = recentVsBaseline(c.trailing?.hrv_ms, end);
  const up = hr && hr.now - hr.was;
  const down = hrv && hrv.was > 0 && (hrv.was - hrv.now) / hrv.was;
  const now = end >= c.last;
  const when = now ? `last ${RECENT} days` : span(shift(end, 1 - RECENT), end);
  const tone = now ? "warning" : "fact";
  const rest = now ? " Your body may need rest." : "";
  const out = [];
  if (up >= RHR_BAR)
    out.push({
      id: "recovery:resting-hr",
      tone,
      headline: "RHR above usual",
      numbers: `${fmt(up)}${NBSP}bpm above · ${when}`,
      detail: `Mean ${fmt(hr.now)}${NBSP}bpm over ${plural(hr.n[0], "day")} against ${fmt(hr.was)}${NBSP}bpm over ${plural(hr.n[1], "day")} in the ${BASELINE} days before; ${RHR_BAR}${NBSP}bpm is the bar.${rest}`,
      margin: up / RHR_BAR,
      link: { to: "metric", metric: "resting_hr" },
    });
  if (down >= HRV_BAR)
    out.push({
      id: "recovery:hrv",
      tone,
      headline: "HRV below usual",
      numbers: `${wholePct(down)} below · ${when}`,
      detail: `Mean ${fmt(hrv.now)}${NBSP}ms over ${plural(hrv.n[0], "day")} against ${fmt(hrv.was)}${NBSP}ms over ${plural(hrv.n[1], "day")} in the ${BASELINE} days before; ${wholePct(HRV_BAR)} is the bar.${rest}`,
      margin: down / HRV_BAR,
      link: { to: "metric", metric: "hrv_ms" },
    });
  return out;
};

// Body fat: ≥ 3 readings (one BIA reading is noise) over ≥ 14 days,
// moving ≥ 0.5 points along their slope.
const MIN_READINGS = 3;
const FAT_BAR = 0.5;

// A scale's estimate following weight this closely (|r|) says nothing of
// its own: bioimpedance reads weight and water.
export const TRACKS_WEIGHT = 0.9;

// Pearson's r of series `a` and `b` over the days both have; null under
// three such days or with either flat.
export function tracking(a, b) {
  const days = a.samples.filter((d) => b.values.has(d));
  if (days.length < 3) return null;
  const xs = days.map((d) => a.values.get(d));
  const ys = days.map((d) => b.values.get(d));
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  xs.forEach((x, i) => {
    sxy += (x - mx) * (ys[i] - my);
    sxx += (x - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  });
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

// Body fat down · 1.2 points over 4 weeks: never when it only tracks
// weight (TRACKS_WEIGHT).
export const bodyFatTrend = (c) => {
  const s = c.series.body_fat;
  if (!spans(s, MIN_READINGS, MIN_SPAN)) return null;
  const r = c.series.weight ? tracking(s, c.series.weight) : null;
  if (!isNil(r) && Math.abs(r) > TRACKS_WEIGHT) return null;
  const days = daysIn(s.samples[0], s.samples.at(-1)) - 1;
  const change = slopeOf(s) * days;
  if (Math.abs(change) < FAT_BAR) return null;
  return {
    id: "trend:body-fat",
    tone: "fact",
    headline: `Body fat ${change > 0 ? "up" : "down"}`,
    numbers: `${fmt(Math.abs(change), 1)} points over ${days < 21 ? plural(days, "day") : plural(Math.round(days / 7), "week")} · ${c.when}`,
    detail: `A scale estimate (bioimpedance), the least-squares slope of ${plural(s.samples.length, "reading")}; not said when it only tracks your weight.`,
    margin: Math.abs(change) / FAT_BAR,
    link: { to: "metric", metric: "body_fat" },
  };
};

// ------------------------------------------------- activity (ADR 0030)

// A muscle group not worked in this many days, while this many set
// activities were done, gets a tip; only groups worked before in the
// trailing window (one never worked is a choice, not a gap).
const MUSCLE_GAP = 21;
const MIN_WORKOUTS = 4;

// Calves not trained · last set 3 weeks ago: from `c.trailing.activities`
// (sets name exercises) and `c.exercises` (id → exercise, `primary`
// muscles).
export const muscleGaps = (c) => {
  const activities = c.trailing?.activities;
  if (!activities || !c.exercises) return null;
  const cut = shift(c.through, -MUSCLE_GAP);
  const recent = activities.filter(
    (s) => s.day > cut && s.day <= c.through && s.sets?.length,
  );
  if (recent.length < MIN_WORKOUTS) return null;
  const last = new Map();
  for (const s of activities.filter((x) => x.day <= c.through))
    for (const set of s.sets ?? [])
      for (const m of c.exercises.get(set.exercise_id)?.primary ?? [])
        if (!(last.get(m) >= s.day)) last.set(m, s.day);
  return [...last]
    .filter(([, day]) => day <= cut)
    .map(([muscle, day]) => {
      const weeks = Math.floor((daysIn(day, c.through) - 1) / 7);
      return {
        id: `muscle:${muscle}`,
        tone: "tip",
        headline: `${muscle.charAt(0).toUpperCase()}${muscle.slice(1)} not trained`,
        numbers: `no sets in ${plural(weeks, "week")} · ${plural(recent.length, "activity", "activities")} since ${pretty(shift(cut, 1), false)}`,
        detail: `Worked in your last 90 days, last on ${pretty(day, false)}: try an exercise for it.`,
        margin: weeks / (MUSCLE_GAP / 7),
        link: { to: "exercises", q: muscle },
      };
    });
};

// Weeks in a row at the weekly target worth a sentence.
const MIN_STREAK = 3;

// Weekly target streak · 5 weeks in a row: finished Monday weeks ending
// at the last one before `c.through`'s, from the trailing activities.
export const targetStreak = (c) => {
  const activities = c.trailing?.activities;
  const target = goal(c, "workouts_per_week");
  if (!activities || !(target > 0)) return null;
  // The last Monday week over by `c.through`.
  let monday = weekStart(shift(c.through, -6));
  const lastSunday = shift(monday, 6);
  let weeks = 0;
  const earliest = activities[0]?.day;
  if (!earliest) return null;
  const doneIn = (from, to) =>
    activities.filter((s) => counted(s) && s.day >= from && s.day <= to).length;
  while (shift(monday, 6) >= earliest) {
    if (doneIn(monday, shift(monday, 6)) < target) break;
    weeks += 1;
    monday = shift(monday, -7);
  }
  return weeks < MIN_STREAK
    ? null
    : {
        id: "streak:activities",
        tone: "fact",
        headline: "Weekly target streak",
        numbers: `${plural(weeks, "week")} in a row · to ${pretty(lastSunday, false)}`,
        detail: `Each Monday-to-Sunday week held at least your target of ${plural(target, "activity", "activities")}.`,
        margin: weeks / MIN_STREAK,
        link: { to: "activities" },
      };
};

// Distance and pace against the period before: finished periods, ≥ 3
// activities with a distance (runs, for pace) on each side; distance a week
// moves ≥ 10 %, pace ≥ 3 %.
const MIN_DISTANCE_ACTIVITIES = 3;
const PACE_BAR = 0.03;

const withDistance = (list) => list.filter((s) => distanceOf(s) !== null);
// Runs with a pace (paceDistance): a phone's leftover, slower than a run
// moves, has none here as on every row and record.
const runs = (list) =>
  list.filter((s) => s.type === "run" && paceDistance(s) !== null);
const total = (list, key) => sum(list.map((s) => s[key] ?? 0));

// Distance up 24 % · 9.5 km a week; Running pace faster · 5:12 /km, 9 s
// faster.
export const distanceChange = (c) => {
  const now = withDistance(c.activities ?? []);
  const was = withDistance(c.beforeActivities ?? []);
  if (!c.finished || !c.before) return null;
  if (
    now.length < MIN_DISTANCE_ACTIVITIES ||
    was.length < MIN_DISTANCE_ACTIVITIES
  )
    return null;
  const out = [];
  const perWeek = (list, days) => (total(list, "distance_m") * 7) / days;
  const a = perWeek(now, c.days);
  const b = perWeek(was, c.before.days);
  const change = (a - b) / b;
  if (Math.abs(change) >= MEAN_BAR)
    out.push({
      id: "change:distance",
      tone: "fact",
      headline: `Distance ${change > 0 ? "up" : "down"} ${wholePct(change)}`,
      numbers: `${unitQty(a / 1000, "km", 1)} a week · ${c.when} vs ${c.noun}`,
      detail: `${unitQty(a / 1000, "km", 1)} vs ${unitQty(b / 1000, "km", 1)} a week, over ${plural(now.length, "activity", "activities")} vs ${plural(was.length, "activity", "activities")} with a distance.`,
      margin: Math.abs(change) / MEAN_BAR,
      link: { to: "activities" },
    });
  const [rNow, rWas] = [runs(now), runs(was)];
  if (
    rNow.length >= MIN_DISTANCE_ACTIVITIES &&
    rWas.length >= MIN_DISTANCE_ACTIVITIES
  ) {
    // Seconds a kilometre, pooled over the runs.
    const secPerKm = (list) =>
      (total(list, "minutes") * 60 * 1000) / total(list, "distance_m");
    const p = secPerKm(rNow);
    const q = secPerKm(rWas);
    const by = (q - p) / q;
    // The gap per mile under US units, as the pace reads.
    const perUnit = unitSystem() === "us" ? MI_M / 1000 : 1;
    const faster = by > 0 ? "faster" : "slower";
    if (Math.abs(by) >= PACE_BAR)
      out.push({
        id: "change:pace",
        tone: "fact",
        headline: `Running pace ${faster}`,
        numbers: `${pace("per_km", total(rNow, "distance_m"), total(rNow, "minutes"))}, ${fmt(Math.abs(Math.round((q - p) * perUnit)))} s ${faster} · ${c.when} vs ${c.noun}`,
        detail: `Pooled over ${plural(rNow.length, "run")} vs ${plural(rWas.length, "run")}; ${wholePct(PACE_BAR)} is the bar.`,
        margin: Math.abs(by) / PACE_BAR,
        link: { to: "activities" },
      });
  }
  return out;
};

// Cardio load (ADR 0034) a week against the 4 weeks before the period
// (uncoupled, as its tile): finished weeks and months, ≥ 3 activities
// with a load each side, a change of at least LOAD_BAR (TRIMP from an
// average and a predicted maximum moves that much between like activities).
// A side with an activity without a load is a floor: it is said only the
// way the floor proves (more now, or less than a floor before). `c.cardio`
// ({profile, activities, deviceDays}: summary-load.mjs loadCardio).
const LOAD_BAR = 0.25;
const LOAD_BEFORE_DAYS = 28;
const MIN_LOADED = 3;
// "≥" a floor (an activity without a load), else "≈" (an estimate).
const loadMark = (x) => (x.missing > 0 ? "≥" : "≈");

// Cardio load up 40 % · ≈ 95 vs 68 a week · Sep 1 – 30 vs the 4 weeks before.
export const loadChange = (c) => {
  if (!c.cardio || !c.finished || c.kind === "year") return null;
  const { profile, activities, deviceDays } = c.cardio;
  const start = shift(c.from, -LOAD_BEFORE_DAYS);
  const of = (from, to) =>
    periodLoad(
      activities.filter((s) => s.day >= from && s.day <= to),
      profile,
      deviceDays,
    );
  const now = of(c.from, c.through);
  const was = of(start, shift(c.from, -1));
  if (now.loaded < MIN_LOADED || was.loaded < MIN_LOADED) return null;
  const a = (now.total * 7) / c.days;
  const b = was.total / (LOAD_BEFORE_DAYS / 7);
  const change = (a - b) / b;
  if (Math.abs(change) < LOAD_BAR) return null;
  // A floor proves only more than it: up from a whole week, down to a whole one.
  if (change > 0 ? was.missing > 0 : now.missing > 0) return null;
  return {
    id: "change:load",
    tone: "fact",
    headline: `Cardio load ${change > 0 ? "up" : "down"} ${wholePct(change)}`,
    numbers: `${loadMark(now)}${NBSP}${fmt(a)} vs ${fmt(b)} a week · ${c.when} vs the 4 weeks before`,
    detail: `Banister's TRIMP from average heart rate, an estimate: ${plural(now.loaded, "activity", "activities")} vs ${plural(was.loaded, "activity", "activities")} with one${now.missing + was.missing ? `; ${plural(now.missing + was.missing, "activity", "activities")} without a heart rate left out` : ""}. A change under ${wholePct(LOAD_BAR)} isn't said.`,
    margin: Math.abs(change) / LOAD_BAR,
    link: { to: "activities" },
  };
};
