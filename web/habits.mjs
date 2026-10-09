// Habits as numbers: every habit, a built-in read from food (the server's
// registry, /api/meta.habits) or a tracker of your own, in one shape; its
// amounts, a period's stats and the series Highlights read. No DOM here, so
// `node --test` covers it.

import { daysIn } from "./dates.mjs";
import { noun, qty } from "./nutrients.mjs";

// The one shape: `id` (a built-in's key or a tracker's id, as text),
// `name`, `unit` and `one` (its singular, if it has one), `factor` (shown
// = stored × factor), `bounds` (the shade steps' upper bounds, shown
// units; null: the period's quartiles), `goal` (shown units, null: none)
// and `dir` (at_least: a target to reach; at_most: a limit), `per` (the
// Summary's numbers: "day" or "week"), `note` (a line under its key) and
// `builtin`.

// A built-in (`meta.habits`) with its goal from the profile's `targets`.
export function builtinHabit(b, targets) {
  const t = targets.find((x) => x.metric === b.metric);
  return {
    id: b.key,
    name: b.name,
    unit: b.unit,
    one: b.one,
    factor: b.factor,
    bounds: b.bounds,
    goal: t ? t.value * b.factor : null,
    dir: b.goal_dir,
    per: b.per,
    note: b.note,
    builtin: true,
  };
}

// A tracker of your own (`/habits`): counted as is, a week's numbers.
export const trackerHabit = (x) => ({
  id: String(x.id),
  name: x.name,
  unit: x.unit,
  one: null,
  factor: 1,
  bounds: null,
  goal: x.goal_value ?? null,
  dir: x.goal_dir,
  per: "week",
  note: null,
  builtin: false,
});

// The goal as a limit (not passed) or a target (reached), else null.
export const limitOf = (habit) => (habit.dir === "at_most" ? habit.goal : null);
export const targetOf = (habit) =>
  habit.dir === "at_least" ? habit.goal : null;

// A shown amount as read: "4 pouches", "1 drink", "2.5 drinks"; litres
// under 1 L in ml, then in L to a tenth: "750 ml", "1.2 L". The word
// follows the number shown.
export function amountText(habit, value) {
  if (habit.unit === "L" && value < 1)
    return qty(Math.round(value * 1000), "ml", 0);
  return qty(value, noun(value, habit.one ?? habit.unit, habit.unit, 1), 1);
}

// "330 ml", "1.2 L": grams of water as the Water built-in of `registry`
// (`meta.habits`) shows them, so a water entry reads like the habit.
export function waterText(registry, grams) {
  const water = registry.find((b) => b.key === "water");
  return amountText(water, grams * water.factor);
}

// One habit's `/habits/days` rows in shown units: [{day, amount}].
export const rowsOf = (habit, days) =>
  days
    .filter((d) => d.habit === habit.id)
    .map((d) => ({ day: d.day, amount: d.amount * habit.factor }));

// The days logged at all: any habit's row (a built-in's mark a day with
// food eaten), so a day without any isn't "none" but unlogged.
export const loggedDays = (days) => new Set(days.map((d) => d.day));

// The habits the Summary offers: the built-ins the period has any of, or a
// goal for, then the active trackers.
export const summaryHabits = (habits, days) =>
  habits.filter(
    (habit) =>
      !habit.builtin ||
      habit.goal !== null ||
      days.some((d) => d.habit === habit.id && d.amount > 0),
  );

// Every habit as a series of web/insights.mjs: its amount on each logged day.
export function habitSeries(habits, days) {
  const logged = [...loggedDays(days)].toSorted();
  return Object.fromEntries(
    habits.map((habit) => [
      `habit:${habit.id}`,
      {
        values: new Map(rowsOf(habit, days).map((r) => [r.day, r.amount])),
        samples: logged,
        label: habit.name,
      },
    ]),
  );
}

// The shade step of `amount` against a target to reach: none, under half,
// under ¾, under it, then reached (4).
export const reachedStep = (amount, target) =>
  !(amount > 0)
    ? 0
    : amount >= target
      ? 4
      : amount >= (target * 3) / 4
        ? 3
        : amount >= target / 2
          ? 2
          : 1;

// A period's numbers from its `rows` ([{day, amount}], any order): the
// total, the days with any, the most in a day (the earliest on a tie), the
// total per week, the mean over days with any, the days over `limit` and
// the days at or over `goal`, a target to reach (each null without one).
export function stats(rows, { from, to, limit = null, goal = null }) {
  const some = rows
    .filter((r) => r.amount > 0)
    .toSorted((a, b) => a.day.localeCompare(b.day));
  const total = some.reduce((t, r) => t + r.amount, 0);
  const peak = some.reduce((p, r) => (!p || r.amount > p.amount ? r : p), null);
  return {
    total,
    days: some.length,
    peak,
    perWeek: (total * 7) / daysIn(from, to),
    mean: some.length ? total / some.length : 0,
    over: limit === null ? null : some.filter((r) => r.amount > limit).length,
    reached: goal === null ? null : some.filter((r) => r.amount >= goal).length,
  };
}
