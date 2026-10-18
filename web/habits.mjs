// Habits as numbers: every habit, a built-in read from food (the server's
// registry, /api/meta.habits) or a tracker of your own, in one shape; its
// amounts, a period's stats and the series Highlights read. No DOM here, so
// `node --test` covers it.

import { meta, scoped } from "./api.mjs";
import { coverage } from "./coverage.mjs";
import { fmt, NBSP, noun, plural, qty, whole } from "./format.mjs";
import { nutrient } from "./nutrients.mjs";
import { latest } from "./outbox.mjs";
import { localDisplay } from "./units.mjs";

// The one shape: `id` (a built-in's key or a tracker's id, as text),
// `name`, `unit` and `one` (its singular, if it has one), `factor` (shown
// = stored × factor), `bounds` (the shade steps' upper bounds, shown
// units; null: the period's quartiles), `goal` (shown units, null: none),
// `goalOn(day)` (that day's goal: hydration's grows with the day's
// activity; every reader judges a day by it) and `dir` (at_least: a
// target to reach; at_most: a limit), `per` (the
// Summary's numbers: "day" or "week"), `note` (a line under its key) and
// `builtin`.

// A built-in (`meta.habits`) as this device shows it: what's an amount of
// food or drink (hydration, a category's grams) in US units when chosen
// (fl oz, oz); a nutrient shown as its label shows it (salt in g on the EU
// label is sodium in mg on the US one). A count of its own (drinks) stays.
export function localBuiltin(b) {
  const n = b.source?.nutrient ? nutrient(b.source.nutrient) : null;
  if (n) {
    if (n.display?.unit !== b.unit || n.unit === b.unit) return b;
    return scaledTo(b, { name: n.label, unit: n.unit, factor: n.show(1) });
  }
  if (b.source !== "hydration" && !b.source?.category) return b;
  const d = localDisplay(b);
  return d.unit === b.unit ? b : scaledTo(b, d);
}

// `b` shown in `to` ({unit, factor}, maybe a `name`): its bounds follow.
function scaledTo(b, to) {
  const k = to.factor / b.factor;
  return {
    ...b,
    ...(to.name ? { name: to.name } : {}),
    unit: to.unit,
    one: to.unit,
    factor: to.factor,
    bounds: b.bounds?.map((x) => x * k) ?? null,
  };
}

// A built-in (`meta.habits`) with its goal from the profile's `targets`;
// `activeOn(day)`: the day's minutes of activity, which raise the
// hydration goal.
export function builtinHabit(served, targets, activeOn = () => 0) {
  const b = localBuiltin(served);
  const t = targets.find((x) => x.metric === b.metric);
  const goal = t ? t.value * b.factor : null;
  const goalOn =
    b.source === "hydration" && goal !== null
      ? (day) => hydrationGoal(t.value, [{ minutes: activeOn(day) }]) * b.factor
      : () => goal;
  return {
    id: b.key,
    name: b.name,
    unit: b.unit,
    one: b.one,
    factor: b.factor,
    bounds: b.bounds,
    goal,
    goalOn,
    goalVaries: b.source === "hydration" && goal !== null,
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
  goalOn: () => x.goal_value ?? null,
  goalVaries: false,
  dir: x.goal_dir,
  per: "week",
  note: null,
  builtin: false,
});

// The built-ins (`served`: /api/meta.habits) with the profile's goals
// (`/targets`), then its active trackers (`/habits`), oldest first: every
// habit in one shape. `activities` ([{day, minutes}]): the activity behind
// each day's hydration goal.
export const allHabits = (served, targets, trackers, activities = []) => [
  ...served.map((b) => builtinHabit(b, targets, minutesOn(activities))),
  ...trackers
    .filter((x) => !x.archived)
    .toSorted((a, b) => a.id - b.id)
    .map((x) => trackerHabit(x)),
];

// The minutes of activity on a day of `activities` ([{day, minutes}]).
export function minutesOn(activities) {
  const by = new Map();
  for (const x of activities) by.set(x.day, (by.get(x.day) ?? 0) + x.minutes);
  return (day) => by.get(day) ?? 0;
}

// The goal as a limit (not passed) or a target (reached), else null.
export const limitOf = (habit) => (habit.dir === "at_most" ? habit.goal : null);
export const targetOf = (habit) =>
  habit.dir === "at_least" ? habit.goal : null;

// The decimals a habit's amount (`value`) reads to: mg whole, grams whole
// from 10 g ("206 g", "9.5 g"), else a tenth.
const digitsOf = (habit, value) =>
  habit.unit === "mg" || (habit.unit === "g" && value >= 10) ? 0 : 1;

// A shown amount as read: "4 pouches", "1 drink", "2.5 drinks", "246 mg";
// litres under 1 L in ml, then in L to a tenth: "750 ml", "1.2 L". The
// word follows the number shown.
export function habitAmountText(habit, value) {
  if (habit.unit === "L" && value < 1)
    return qty(Math.round(value * 1000), "ml", 0);
  const d = digitsOf(habit, value);
  return qty(value, noun(value, habit.one ?? habit.unit, habit.unit, d), d);
}

// A calendar cell's amount, as `habitAmountText` rounds it, unit aside.
export const cellText = (habit, value) => fmt(value, digitsOf(habit, value));

// The fewest known days whose mean is said: which days are known
// isn't chance (an imported day, a drink without its value), so one or two
// of them are no sample of the period.
const MIN_KNOWN_DAYS = 3;

// A period's mean of `t` (`stats`) as a tile ({value, short, long},
// ui.mjs tiles): a day's habit a day, a week's a week. Over the known days
// when every food day is known or MIN_KNOWN_DAYS are; else a floor over the
// `food` days (days with food logged), what was counted on all of them; the
// long text says which days. null without either.
export function meanTile(habit, t, food) {
  const perDay = habit.per === "day";
  const say = (v) => (perDay ? habitAmountText(habit, v) : fmt(v, 1));
  const per = (v) =>
    perDay
      ? "a day"
      : `${noun(v, habit.one ?? habit.unit, habit.unit, 1)} a week`;
  const each = perDay ? "a day" : "a week";
  const scale = perDay ? 1 : 7;
  if (t.partial && t.logged < MIN_KNOWN_DAYS) {
    if (!food) return null;
    const v = (t.total * scale) / food;
    return {
      value: `≥${NBSP}${say(v)}`,
      short: per(v),
      long: `At least this much ${each}: what was counted over the ${plural(food, "day")} with food logged, though it's known on only ${fmt(t.logged)} of them.`,
    };
  }
  if (!t.logged) return null;
  const v = perDay ? t.mean : t.perWeek;
  const over = habit.builtin
    ? t.partial
      ? `over ${plural(t.logged, "known day")} of ${fmt(food)} with food logged`
      : `over ${plural(t.logged, "day")} with food logged`
    : `over ${plural(t.logged, "logged day")}`;
  return {
    value: say(v),
    short: per(v),
    long: `Your average ${each} ${over}.`,
  };
}

// A count of days as a tile's value: while any day isn't known a floor,
// "≥ 2", and one of 0 proves nothing: "–", not known.
export const countText = (n, partial) =>
  partial ? (n > 0 ? `≥${NBSP}${fmt(n)}` : "–") : fmt(n);

// The calendar key's words for a goal that changes by the day (hydration
// grows with activity, `goalVaries`): each day is shaded against its own
// goal (`reachedStep`), so the key says how far toward it, not the plain
// goal's litres. null for a fixed goal (its amounts read as they are).
export const goalWords = (habit) =>
  habit.goalVaries
    ? [
        "under half the day's goal",
        "half to ¾ of it",
        "¾ to the goal",
        "the day's goal met",
      ]
    : null;

// Water an hour of logged activity adds to the day's hydration goal (ml):
// sweat losses run 0.3–2.4 L an hour (ACSM, Sawka et al., Med Sci Sports
// Exerc 2007); about 0.5 L is a middle for recreational exercise.
const ML_PER_ACTIVE_HOUR = 500;

// The day's hydration goal (ml): the `water` target plus
// ML_PER_ACTIVE_HOUR per hour of the day's `activities` ([{minutes}]); null
// without a target. Derived, never stored: `goalOn` of the built-in.
export const hydrationGoal = (target, activities) =>
  target === null || target === undefined
    ? null
    : target +
      (ML_PER_ACTIVE_HOUR * activities.reduce((t, s) => t + s.minutes, 0)) / 60;

// "330 ml", "1.2 L": grams of water as the Hydration built-in (key `water`) of
// `registry` (`meta.habits`) shows them, so a water entry reads like the habit.
export function waterText(registry, grams) {
  const water = localBuiltin(registry.find((b) => b.key === "water"));
  return habitAmountText(water, grams * water.factor);
}

// One habit's `/habits/days` rows in shown units: [{day, amount}]. A
// built-in's day whose amount isn't known (`known: false`, ADR 0030: the
// foods carrying its nutrient gave under 80 % of the day's energy, or it
// came from an import that can't say) is left out: unknown isn't 0, so
// series, calendars, stats and Highlights skip it.
export const rowsOf = (habit, days, known = true) =>
  days
    .filter((d) => d.habit === habit.id && (d.known !== false) === known)
    .map((d) => ({ day: d.day, amount: d.amount * habit.factor }));

// Its days whose amount isn't known (`rowsOf`'s left out), each amount a
// floor: what the foods that carry it gave.
export const floorsOf = (habit, days) => rowsOf(habit, days, false);

// The days logged at all: any habit's row (a built-in's mark a day with
// food eaten), so a day without any isn't "none" but unlogged. With
// `habits` (a Set of habit keys/ids), only their rows: the built-ins' keys
// give the days with food logged.
export const loggedDays = (days, habits = null) =>
  new Set(days.filter((d) => !habits || habits.has(d.habit)).map((d) => d.day));

// The habits the Summary offers: the built-ins the period has any of (a
// floor too: an unknown day's amount is at least some), or a goal for,
// then the active trackers.
export const summaryHabits = (habits, days) =>
  habits.filter(
    (habit) =>
      !habit.builtin ||
      habit.goal !== null ||
      days.some((d) => d.habit === habit.id && d.amount > 0),
  );

// Every habit as a series of web/insights.mjs: its amount on each day it
// is known (a built-in's: its rows known; a tracker's: every logged day,
// one without a count a 0), read with its unit.
export function habitSeries(habits, days) {
  const logged = [...loggedDays(days)].toSorted();
  return Object.fromEntries(
    habits.map((habit) => {
      const rows = rowsOf(habit, days);
      return [
        `habit:${habit.id}`,
        {
          values: new Map(rows.map((r) => [r.day, r.amount])),
          samples: habit.builtin ? rows.map((r) => r.day).toSorted() : logged,
          sampled: habit.builtin ? "known" : "logged",
          label: habit.name,
          say: (v) => habitAmountText(habit, v),
          // The day's goal its Highlights judge by.
          goalOn: habit.goalOn,
        },
      ];
    }),
  );
}

// The shade step of `amount` against a target to reach: none, under half,
// under ¾, under it, then reached (4).
export const reachedStep = (amount, target) =>
  amount > 0
    ? amount >= target
      ? 4
      : amount >= (target * 3) / 4
        ? 3
        : amount >= target / 2
          ? 2
          : 1
    : 0;

const sumOf = (list) => list.reduce((t, r) => t + r.amount, 0);

// A period's numbers from its `rows` ([{day, amount}], any order, each
// known) and `floors` (the days whose amount isn't known, each a floor):
// the mean a day and a week over the `logged` days (the count given, else
// the days with a row, 0 or not; an unlogged or unknown day is missing,
// never 0); the total, the days with any, the most in a day (the earliest
// on a tie), the days over `limit` and the days at or over `goal` (a
// target to reach; each null without one, a function of the day where the
// goal is the day's) over both, a floor counting where it proves it.
// `partial`: any floor, so each of those is at least what's said.
export function stats(
  rows,
  { limit = null, goal = null, logged = null, floors = [] },
) {
  const both = [...rows, ...floors];
  const some = both
    .filter((r) => r.amount > 0)
    .toSorted((a, b) => a.day.localeCompare(b.day));
  const known = sumOf(rows.filter((r) => r.amount > 0));
  const peak = some.reduce((p, r) => (!p || r.amount > p.amount ? r : p), null);
  const n = logged ?? new Set(rows.map((r) => r.day)).size;
  const goalOn = typeof goal === "function" ? goal : () => goal;
  return {
    total: sumOf(some),
    days: some.length,
    logged: n,
    peak,
    perWeek: n ? (known * 7) / n : 0,
    mean: n ? known / n : 0,
    over: limit === null ? null : some.filter((r) => r.amount > limit).length,
    reached:
      goal === null
        ? null
        : some.filter((r) => r.amount >= goalOn(r.day)).length,
    partial: floors.length > 0,
  };
}

// A tracker's count on a day, as a path.
export const habitDayPath = (id, day) => scoped(`/habits/${id}/days/${day}`);

// What the day's tracker count is: the last write still waiting on this
// device, else the server's.
export function counted(id, day, saved) {
  const last = latest(habitDayPath(id, day));
  if (!last) return saved;
  return last.method === "DELETE" ? 0 : last.body.amount;
}

// "Water 1.2 L · Alcohol 2 drinks · Fruit and vegetables 320 g": the
// built-ins the day's food held (the Day view's `builtins`, stored units),
// in the registry's order; null when none. `day` ({eaten, known}, the Day
// view's) reads a nutrient's "≥" as the Diary's card does: whenever its
// food didn't all carry it, not only under KNOWN.
export function builtinText(builtins, day = null) {
  const parts = meta.habits.map(localBuiltin).flatMap((b) => {
    const x = builtins.find((y) => y.habit === b.key);
    const amount = x?.amount;
    const key = b.source?.nutrient;
    // Not known (ADR 0030): what's counted is a floor.
    const partly =
      key && day
        ? coverage([{ total: day.eaten ?? {}, known: day.known }], key) < 1
        : x?.known === false;
    const floor = partly ? "≥ " : "";
    // Each part moves whole: the line wraps between parts only.
    return amount > 0
      ? [whole(`${b.name} ${floor}${habitAmountText(b, amount * b.factor)}`)]
      : [];
  });
  return parts.length > 0 ? parts.join(" · ") : null;
}
