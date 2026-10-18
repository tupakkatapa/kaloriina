// The weight trend and the energy balance behind maintenance: what you ate
// against how your weight moved says what keeps your weight a day; `plan`
// turns it (or the model's fallbacks) into the energy target a goal needs.
// No DOM here, so `node --test` covers it.

import { daysIn, shift } from "./dates.mjs";
import {
  bmrOf,
  burnedDays,
  KCAL_PER_KG,
  maintenanceOf,
  MAX_SPREAD,
  MIN_FOOD_DAYS,
  needed,
} from "./expenditure.mjs";
import { isNil, plural } from "./format.mjs";
import { seriesOf, tracking, TRACKS_WEIGHT } from "./insights.mjs";
import { foodDay, kcal, KCAL_PER_G } from "./nutrients.mjs";
import { leastSquares } from "./stats.mjs";

// The trend: a weigh-in averaged with the others of its last 7 days.
export const TREND_DAYS = 7;
// `sums` ({n, sum}) with `value` (undefined: none) added (`sign` 1) or
// taken away (−1).
const move = (sums, value, sign) => {
  if (value === undefined) return;
  sums.n += sign;
  sums.sum += sign * value;
};

// The balance's window and its sufficiency rule.
export const WINDOW_DAYS = 28;
const MIN_WEIGH_SPAN = 10;
// Body fat and muscle for a goal: the mean of this many days' readings.
const BF_DAYS = 3;
// A scale's share following weight: judged on this many reading days, at
// least, over the last TRACK_DAYS (Targets; Summary → Body on its period).
const TRACK_READINGS = 10;
const TRACK_DAYS = 90;

// Whether a scale estimate (`values` [{day, value}], a day's one) follows
// weight (`weights` [{day, kg}]): |r| over TRACKS_WEIGHT on TRACK_READINGS
// days or more. Bioimpedance reads weight and water, so such a share says
// nothing of its own and a goal from it is unreliable.
export function tracksWeight(values, weights) {
  if (values.length < TRACK_READINGS) return false;
  const r = tracking(seriesOf(values, "value"), seriesOf(weights, "kg"));
  return !isNil(r) && Math.abs(r) > TRACKS_WEIGHT;
}

// Each day's first reading of `key` in `readings` (time order), newest
// first: [{day, value}].
const daily = (readings, key) => [
  ...new Map(
    readings
      .filter((r) => !isNil(r[key]))
      .toReversed()
      .map((r) => [r.day, { day: r.day, value: r[key] }]),
  ).values(),
];

const meanOf = (list) =>
  list.length > 0 ? list.reduce((t, x) => t + x.value, 0) / list.length : null;

// What to fetch for the balance ending `yesterday`: its window plus the
// days before that feed the trend.
export function balanceRange(yesterday) {
  return {
    from: shift(yesterday, -(WINDOW_DAYS + TREND_DAYS - 2)),
    start: shift(yesterday, -(WINDOW_DAYS - 1)),
    to: yesterday,
  };
}

// [{day, kg}] (by day; any series by its `key`, say {day, value}) → the
// 7-day trend at each point: a window sliding over the list, its sum kept
// as it goes.
export function trend(points, key = "kg") {
  const at = points.map((w) => daysIn(points[0].day, w.day));
  let start = 0;
  let sum = 0;
  return points.map((w, i) => {
    sum += w[key];
    while (at[i] - at[start] >= TREND_DAYS) sum -= points[start++][key];
    return { day: w.day, [key]: sum / (i - start + 1) };
  });
}

// A `trend()` per bucket (`bucket(day)` → its key, a week's or a month's):
// the trend at its last day, so a bucket's point is still "the 7-day trend
// as of then", as a day's is (a mean of the daily trend would smooth twice).
export const trendPer = (trended, bucket) =>
  new Map(trended.map((t) => [bucket(t.day), t]));

// Least-squares change of [{day, kg}] in kg a day; null under two days.
export const slope = (weights) =>
  leastSquares(
    weights.map((w) => daysIn(weights[0].day, w.day)),
    weights.map((w) => w.kg),
  );

// The standard error of [{day, kg}]'s least-squares slope (kg a day), from
// their scatter about the line; null under three.
function slopeError(weights) {
  const n = weights.length;
  const b = slope(weights);
  if (n < 3 || b === null) return null;
  const xs = weights.map((w) => daysIn(weights[0].day, w.day));
  const mx = xs.reduce((t, x) => t + x, 0) / n;
  const my = weights.reduce((t, w) => t + w.kg, 0) / n;
  let sxx = 0;
  let sse = 0;
  xs.forEach((x, i) => {
    sxx += (x - mx) ** 2;
    sse += (weights[i].kg - my - b * (x - mx)) ** 2;
  });
  return Math.sqrt(sse / (n - 2) / sxx);
}

// A rate a week needs weigh-ins this many days apart: a shorter span reads
// a day's water as a rate.
export const RATE_SPAN_DAYS = 14;

// The weigh-ins' ([{day, kg}] by day) change a week, kg, from their
// least-squares line, and its 95 % `margin` (1.96 standard errors):
// `clear` when the margin doesn't reach zero. Null under three weigh-ins
// or RATE_SPAN_DAYS between the first and last.
export function weeklyRate(weights) {
  if (
    weights.length < 3 ||
    daysIn(weights[0].day, weights.at(-1).day) - 1 < RATE_SPAN_DAYS
  )
    return null;
  const perWeek = slope(weights) * 7;
  const margin = 1.96 * slopeError(weights) * 7;
  return { perWeek, margin, clear: Math.abs(perWeek) > margin };
}

// A window's balance from what was eaten a day (`intake` kcal), its
// weigh-ins (`raw`) and their 7-day trend (`trended`, the same days):
// the change is the trend's slope (a day's water and glycogen swings
// averaged out), `spread` the 95 % range of maintenance from the
// weigh-ins' scatter about their line (Infinity under three).
function figures(intake, raw, trended) {
  const perDay = slope(trended);
  const se = slopeError(raw);
  return {
    intake,
    perWeek: perDay * 7,
    maintenance: intake - perDay * KCAL_PER_KG,
    spread: se === null ? Infinity : 1.96 * se * KCAL_PER_KG,
  };
}

// The balance over the window ending `yesterday`, from the summary's
// `days` ([{day, total}]) and the weigh-ins ([{day, kg}], by day, from
// TREND_DAYS before the window on): either what's missing ({enough:
// false, foodDays, span}) or maintenance ({enough: true, intake, perWeek,
// maintenance, spread}); whether it is sure enough to use is
// expenditure.mjs `sure`'s. It offers nothing: a target is `needed()`'s.
export function balance({ days, weights, yesterday }) {
  const { start } = balanceRange(yesterday);
  const inWindow = (d) => d.day >= start && d.day <= yesterday;
  const eaten = days.filter((d) => inWindow(d) && foodDay(d));
  const weighed = weights.filter((x) => inWindow(x));
  const span =
    weighed.length > 0 ? daysIn(weighed[0].day, weighed.at(-1).day) - 1 : 0;
  if (
    eaten.length < MIN_FOOD_DAYS ||
    weighed.length < 2 ||
    span < MIN_WEIGH_SPAN
  )
    return { enough: false, foodDays: eaten.length, span };
  const intake = eaten.reduce((t, d) => t + d.total.energy, 0) / eaten.length;
  const trended = trend(weights.filter((w) => w.day <= yesterday)).filter((x) =>
    inWindow(x),
  );
  return { enough: true, ...figures(intake, weighed, trended) };
}

// The rows of `burned` (burnedDays') that rest on something: the device's
// active energy, or food logged in `days`. A day with neither is resting ×
// 1.1 + TEF, an assumption: a profile without that history plans by its
// activity level instead.
const evidenced = (burned, days) => {
  const fed = new Set(days.filter((x) => foodDay(x)).map((d) => d.day));
  return burned.filter((b) => b.source === "active" || fed.has(b.day));
};

// Each day of [from, to]'s maintenance over the WINDOW_DAYS ending it, by
// maintenanceOf's rule as `plan` takes it (the balance, else the mean of
// burned, else resting × `pal`): a window sliding over the days, its food
// and burned sums kept as it goes, the weigh-ins between two pointers (a
// slope reads only its own window's). `days` ([{day, total}]), `weights`
// ([{day, kg}] by day) and `burned` (burnedDays' rows) from WINDOW_DAYS
// before `from` on (`days` and `burned` from earlier are left out, so the
// sums never take away a day they didn't add); `bmr` a bmrOf; `pal` the
// profile's activity level (or null). [{day, kcal, source}], a day
// without any left out.
export function maintenanceSeries({
  from,
  to,
  days,
  weights,
  burned,
  bmr,
  pal,
}) {
  const start = shift(from, 1 - WINDOW_DAYS);
  const inside = (x) => x.day >= start && x.day <= to;
  const eaten = new Map(
    days
      .filter((d) => inside(d) && foodDay(d))
      .map((d) => [d.day, d.total.energy]),
  );
  const spent = new Map(
    evidenced(burned, days)
      .filter((x) => inside(x))
      .map((b) => [b.day, b.kcal]),
  );
  const trended = weights.length > 0 ? trend(weights) : [];
  const food = { n: 0, sum: 0 };
  const used = { n: 0, sum: 0 };
  let lo = 0;
  let hi = 0;
  const out = [];
  const n = daysIn(start, to);
  for (let i = 0; i < n; i++) {
    const day = shift(start, i);
    const gone = shift(day, -WINDOW_DAYS);
    move(food, eaten.get(day), 1);
    move(food, eaten.get(gone), -1);
    move(used, spent.get(day), 1);
    move(used, spent.get(gone), -1);
    while (hi < weights.length && weights[hi].day <= day) hi++;
    while (lo < hi && weights[lo].day <= gone) lo++;
    if (day < from) continue;
    const enough =
      food.n >= MIN_FOOD_DAYS &&
      hi - lo >= 2 &&
      daysIn(weights[lo].day, weights[hi - 1].day) - 1 >= MIN_WEIGH_SPAN;
    const m = maintenanceOf({
      balance: enough
        ? {
            enough,
            ...figures(
              food.sum / food.n,
              weights.slice(lo, hi),
              trended.slice(lo, hi),
            ),
          }
        : null,
      mean: used.n ? { n: used.n, kcal: used.sum / used.n } : null,
      bmr: bmr(day)?.kcal ?? null,
      activity: pal,
    });
    if (m) out.push({ day, ...m });
  }
  return out;
}

// Why the balance `b` (balance()'s) doesn't stand for maintenance, in
// words (`isSure`: expenditure.mjs `sure`, then null): the weigh-ins or
// food it still needs, as about how long; too few weigh-ins to judge
// their scatter; a scatter too wide (its ± kcal); or a maintenance too
// far from resting energy to be a body's.
export function balanceWhy(b, isSure) {
  if (isSure) return null;
  if (!b.enough) {
    const food = Math.max(0, MIN_FOOD_DAYS - b.foodDays);
    const weighs = Math.max(0, MIN_WEIGH_SPAN - b.span);
    const days = Math.max(food, weighs);
    const what =
      food && weighs
        ? "food and weigh-ins"
        : food
          ? "food logged"
          : "weigh-ins";
    const time =
      days < 7
        ? plural(days, "more day")
        : plural(Math.ceil(days / 7), "more week");
    return `Your weight trend is too short to say: about ${time} of ${what}.`;
  }
  if (!Number.isFinite(b.spread))
    return "Too few weigh-ins to read your weight trend yet.";
  return b.spread > MAX_SPREAD
    ? `Your weigh-ins vary too much to read your weight trend yet (± ${kcal(b.spread)}).`
    : "What you ate and how your weight moved don't add up yet: is every meal logged?";
}

// plan's goals by `byKey` ({goalWeight, goalBf, goalMuscle}, null unset),
// and `weightOnly`: two goals, one a share that follows weight (`fat`,
// `muscle`: {tracked}), so weight alone is planned from.
function goalsOf(byKey, fat, muscle) {
  const goals = {
    goalWeight: byKey.goal_weight?.value ?? null,
    goalBf: byKey.goal_body_fat?.value ?? null,
    goalMuscle: byKey.goal_muscle?.value ?? null,
  };
  const set = Object.values(goals).filter((v) => !isNil(v)).length;
  const weightOnly =
    set >= 2 &&
    ((!isNil(goals.goalBf) && fat.tracked) ||
      (!isNil(goals.goalMuscle) && muscle.tracked));
  return { goals, weightOnly };
}

// The energy target a profile's goal needs today (ADR 0020), the one plan
// Targets and Recalculate share. `profile` the profile (its
// body, goal pace and date, latest weight), `byKey` its targets by metric,
// `days` (`/summary` days), `weights` and `readings` (scale) from
// balanceRange's `from` back by the model's carry, `deviceDays` (Health
// Connect days), `resting` (its resting energy served, [{day, kcal,
// origin}]) and `activities` over the balance window, `today`.
// {balance, maintenance: {kcal, source} | null, resting (bmrOf's today,
// or null) and `bmr` its kcal, tracked: {body_fat,
// muscle} (tracksWeight), weightOnly (two goals, one a tracked share:
// planned from goal weight alone, none without it), needed: needed()'s |
// null}.
export function plan({
  profile,
  byKey,
  days,
  weights,
  readings,
  deviceDays,
  resting = [],
  activities,
  today,
}) {
  const yesterday = shift(today, -1);
  const { start } = balanceRange(yesterday);
  const bmr = bmrOf({ person: profile, weights, resting });
  const b = balance({ days, weights, yesterday });
  const restingOf = bmr(today);
  const restingToday = restingOf?.kcal ?? null;
  const maintenance = maintenanceOf({
    balance: b,
    burned: evidenced(
      burnedDays({
        from: start,
        to: yesterday,
        days,
        deviceDays,
        activities,
        bmr,
      }),
      days,
    ),
    bmr: restingToday,
    activity: profile.activity ?? null,
  });
  // The 7-day trend's weight, not one weigh-in's swing; body fat the mean
  // of its last BF_DAYS days' first readings (one BIA reading is noise).
  const upTo = weights.filter((w) => w.day <= today);
  const weight =
    upTo.length > 0
      ? trend(upTo).at(-1).kg
      : (profile.latest_weight_kg ?? null);
  // A share following weight (tracksWeight, last TRACK_DAYS) isn't
  // planned from when two goals are: weight alone is.
  const since = shift(today, -TRACK_DAYS);
  const recent = weights.filter((w) => w.day > since && w.day <= today);
  const read = (key) => {
    const list = daily(readings, key).filter((x) => x.day <= today);
    return {
      value: meanOf(list.slice(0, BF_DAYS)),
      tracked: tracksWeight(
        list.filter((x) => x.day > since),
        recent,
      ),
    };
  };
  const fat = read("body_fat");
  const muscle = read("muscle");
  const { goals, weightOnly } = goalsOf(byKey, fat, muscle);
  return {
    balance: b,
    maintenance,
    tracked: { body_fat: fat.tracked, muscle: muscle.tracked },
    weightOnly,
    resting: restingOf,
    bmr: restingToday,
    needed:
      maintenance && !isNil(weight) && !(weightOnly && isNil(goals.goalWeight))
        ? needed({
            today,
            weight,
            bf: fat.value,
            muscle: muscle.value,
            ...(weightOnly
              ? { goalWeight: goals.goalWeight, goalBf: null, goalMuscle: null }
              : goals),
            goalDate: profile.goal_date ?? null,
            goalKgPerWeek: profile.goal_kg_per_week ?? 0,
            maintenance: maintenance.kcal,
            bmr: restingToday,
            sex: profile.sex,
          })
        : null,
  };
}

// Targets ([{metric, value}]) with energy set to `energy`: protein stays
// (raised to `protein` g when that's more), carbohydrate and fat scale with
// the energy left after protein. Without an old energy (or nothing left
// after protein) they stay as they are.
export function withEnergy(targets, energy, protein = 0) {
  const value = (key) => targets.find((t) => t.metric === key)?.value;
  const old = value("energy");
  const oldProtein = value("protein") ?? 0;
  const newProtein = Math.max(oldProtein, Math.round(protein));
  const before = old - KCAL_PER_G.protein * oldProtein;
  const after = energy - KCAL_PER_G.protein * newProtein;
  const factor = old && before > 0 && after > 0 ? after / before : 1;
  const list = targets.map(({ metric, value: v }) => ({
    metric,
    value:
      metric === "energy"
        ? energy
        : metric === "protein"
          ? newProtein
          : metric === "net_carbs" || metric === "fat"
            ? Math.round(v * factor)
            : v,
  }));
  if (old === undefined) list.push({ metric: "energy", value: energy });
  if (newProtein > oldProtein && value("protein") === undefined)
    list.push({ metric: "protein", value: newProtein });
  return list;
}

// A goal weight against the trend: within this it's reached; a trend
// moving less than this a week is flat; further off than this, no date.
const AT_GOAL_KG = 0.1;
const FLAT_KG_PER_WEEK = 0.05;
const PROJECTION_DAYS_MAX = 730;

// Where the 7-day trend over the last WINDOW_DAYS up to `today` takes you
// against `goal` (kg), from the weigh-ins ([{day, kg}] by day, from
// TREND_DAYS before the window on): `reached` (the trend is within
// AT_GOAL_KG of it), `unclear` (under 2 weigh-ins MIN_WEIGH_SPAN days
// apart), `flat` (moving under FLAT_KG_PER_WEEK), `away`, `far` (past
// PROJECTION_DAYS_MAX), else `on` with the `day` it gets there.
export function projection(weights, goal, today) {
  const start = shift(today, -(WINDOW_DAYS - 1));
  const trended = trend(weights).filter(
    (t) => t.day >= start && t.day <= today,
  );
  if (trended.length === 0) return { kind: "unclear" };
  const last = trended.at(-1);
  const gap = goal - last.kg;
  if (Math.abs(gap) <= AT_GOAL_KG) return { kind: "reached" };
  const span = daysIn(trended[0].day, last.day) - 1;
  if (trended.length < 2 || span < MIN_WEIGH_SPAN) return { kind: "unclear" };
  const perDay = slope(trended);
  if (Math.abs(perDay * 7) < FLAT_KG_PER_WEEK) return { kind: "flat" };
  if (Math.sign(perDay) !== Math.sign(gap)) return { kind: "away" };
  const day = shift(last.day, Math.round(gap / perDay));
  return day > shift(today, PROJECTION_DAYS_MAX)
    ? { kind: "far" }
    : { kind: "on", day };
}
