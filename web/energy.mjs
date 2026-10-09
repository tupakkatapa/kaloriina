// The weight trend and the energy balance behind an adaptive energy target:
// what you ate against how your weight moved says what you really use a day.
// No DOM here, so `node --test` covers it.

import { daysIn, shift } from "./dates.mjs";
import { KCAL_PER_G, kcal, qty } from "./nutrients.mjs";

// Body weight as energy: about 7,700 kcal a kg.
const KCAL_PER_KG = 7700;
// The trend: a weigh-in averaged with the others of its last 7 days.
export const TREND_DAYS = 7;
// The balance's window, its sufficiency rule and when a change is offered.
export const WINDOW_DAYS = 28;
export const MIN_FOOD_DAYS = 14;
export const MIN_WEIGH_SPAN = 10;
const MIN_CHANGE = 50;
const MIN_TARGET = 1200;

// What to fetch for the balance ending `yesterday`: its window plus the
// days before that feed the trend.
export function balanceRange(yesterday) {
  return {
    from: shift(yesterday, -(WINDOW_DAYS + TREND_DAYS - 2)),
    start: shift(yesterday, -(WINDOW_DAYS - 1)),
    to: yesterday,
  };
}

// [{day, kg}] (by day) → the 7-day trend at each weigh-in: a window
// sliding over the list, its sum kept as it goes.
export function trend(weights) {
  const at = weights.map((w) => daysIn(weights[0].day, w.day));
  let start = 0;
  let sum = 0;
  return weights.map((w, i) => {
    sum += w.kg;
    while (at[i] - at[start] >= TREND_DAYS) sum -= weights[start++].kg;
    return { day: w.day, kg: sum / (i - start + 1) };
  });
}

// Least-squares change of [{day, kg}] in kg a day; null under two days.
export function slope(weights) {
  const xs = weights.map((w) => daysIn(weights[0].day, w.day));
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = weights.reduce((a, w) => a + w.kg, 0) / n;
  let num = 0;
  let den = 0;
  weights.forEach((w, i) => {
    num += (xs[i] - mx) * (w.kg - my);
    den += (xs[i] - mx) ** 2;
  });
  return den ? num / den : null;
}

// The balance over the window ending `yesterday`, from the summary's
// `days` ([{day, total}]) and the weigh-ins ([{day, kg}]): either what's
// missing ({enough: false, foodDays, span}) or what you use ({enough: true,
// intake, perWeek, tdee, target, offer}). `goal` is kg a week; `current`
// the energy target (or null).
export function balance({ days, weights, yesterday, goal, current }) {
  const { start } = balanceRange(yesterday);
  const inWindow = (d) => d.day >= start && d.day <= yesterday;
  const eaten = days.filter((d) => inWindow(d) && (d.total.energy ?? 0) > 0);
  const weighed = weights.filter(inWindow);
  const span = weighed.length
    ? daysIn(weighed[0].day, weighed.at(-1).day) - 1
    : 0;
  if (
    eaten.length < MIN_FOOD_DAYS ||
    weighed.length < 2 ||
    span < MIN_WEIGH_SPAN
  )
    return { enough: false, foodDays: eaten.length, span };
  const intake = eaten.reduce((t, d) => t + d.total.energy, 0) / eaten.length;
  const perDay = slope(weighed);
  const tdee = intake - perDay * KCAL_PER_KG;
  const target = Math.round((tdee + (goal * KCAL_PER_KG) / 7) / 10) * 10;
  const offer =
    target >= MIN_TARGET &&
    (current === null || Math.abs(target - current) >= MIN_CHANGE);
  return { enough: true, intake, perWeek: perDay * 7, tdee, target, offer };
}

// The balance (`enough`) in words. A target under MIN_TARGET isn't given
// as a plan: the goal is too fast to be safe.
export function balanceText(b) {
  const said = `You ate ${kcal(b.intake)} a day and your trend ${b.perWeek < 0 ? "fell" : "rose"} ${qty(Math.abs(b.perWeek), "kg", 1)} a week: you use about ${kcal(b.tdee)} a day.`;
  return b.target < MIN_TARGET
    ? `${said} Your goal would need under ${kcal(MIN_TARGET)} a day: a slower goal is safer.`
    : `${said} For your goal: ${kcal(b.target)}.`;
}

// Targets ([{metric, value}]) with energy set to `energy`: protein stays,
// carbohydrate and fat scale with the energy left after protein. Without an
// old energy (or nothing left after protein) they stay as they are.
export function withEnergy(targets, energy) {
  const value = (key) => targets.find((t) => t.metric === key)?.value;
  const old = value("energy");
  const fromProtein = KCAL_PER_G.protein * (value("protein") ?? 0);
  const factor =
    old && old - fromProtein > 0 && energy - fromProtein > 0
      ? (energy - fromProtein) / (old - fromProtein)
      : 1;
  const list = targets.map(({ metric, value: v }) => ({
    metric,
    value:
      metric === "energy"
        ? energy
        : metric === "net_carbs" || metric === "fat"
          ? Math.round(v * factor)
          : v,
  }));
  if (old === undefined) list.push({ metric: "energy", value: energy });
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
// apart, or flat), `away`, `far` (past PROJECTION_DAYS_MAX), else `on`
// with the `day` it gets there.
export function projection(weights, goal, today) {
  const start = shift(today, -(WINDOW_DAYS - 1));
  const trended = trend(weights).filter(
    (t) => t.day >= start && t.day <= today,
  );
  if (!trended.length) return { kind: "unclear" };
  const last = trended.at(-1);
  const gap = goal - last.kg;
  if (Math.abs(gap) <= AT_GOAL_KG) return { kind: "reached" };
  const span = daysIn(trended[0].day, last.day) - 1;
  const perDay =
    trended.length < 2 || span < MIN_WEIGH_SPAN ? 0 : slope(trended);
  if (Math.abs(perDay * 7) < FLAT_KG_PER_WEEK) return { kind: "unclear" };
  if (Math.sign(perDay) !== Math.sign(gap)) return { kind: "away" };
  const day = shift(last.day, Math.round(gap / perDay));
  return day > shift(today, PROJECTION_DAYS_MAX)
    ? { kind: "far" }
    : { kind: "on", day };
}
