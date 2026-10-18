// Summary → Habits: the Highlights over every habit, the days logged and
// one habit's calendar at a time. Every habit's days (`/habits/days`: the
// built-ins the server reads from food, and the trackers) and the trackers
// load here, and the period before's days for the comparisons; the goals,
// sleep and check-ins come shared (web/series.mjs).

import { get, meta, scoped } from "../api.mjs";
import { touching } from "../correlate.mjs";
import { shift, today } from "../dates.mjs";
import { plural } from "../format.mjs";
import {
  allHabits,
  habitSeries,
  loggedDays,
  summaryHabits,
} from "../habits.mjs";
import { h } from "../ui.mjs";
import { habitsSection } from "./habits.mjs";
import { highlightStack } from "./summary-highlights.mjs";

export const KEY = "habits";
export const LABEL = "Habits";

export async function load(p, sharing) {
  const [list, days, beforeDays, activities] = await Promise.all([
    get(scoped("/habits")),
    get(scoped(`/habits/days?from=${p.from}&to=${p.to}`)),
    get(scoped(`/habits/days?from=${p.before.from}&to=${p.before.to}`)),
    // Each day's activity raises its hydration goal: the period's activities,
    // sliced from the shared read.
    sharing.then((shared) => shared.rows("activities", p.from, p.to)),
  ]);
  return { list, days, beforeDays, activities };
}

export function render(p, { list, days, beforeDays, activities }, shared) {
  const habits = allHabits(
    meta.habits,
    Object.values(shared.targets),
    list,
    activities,
  );
  // Today is still being logged: the numbers end yesterday.
  const end = p.through;
  const logged = [...loggedDays(days)].filter((d) => d <= end).length;
  return [
    highlightStack(
      KEY,
      {
        kind: p.kind,
        from: p.from,
        to: p.to,
        last: shift(today(), -1),
        before: p.before,
        // The nights after each day: alcohol ↔ sleep; the
        // day's own stress: alcohol ↔ stress.
        series: { ...habitSeries(habits, days), ...shared.series },
        prev: habitSeries(habits, beforeDays),
        correlations: touching(shared.correlations, KEY),
      },
      p,
      shared,
    ),
    h(
      "p",
      { class: "muted" },
      // Any habit's day, not the tiles' days with food.
      `${plural(logged, "day")} with a habit logged${end < p.to ? " through yesterday" : ""}`,
    ),
    habitsSection({
      habits: summaryHabits(habits, days),
      days,
      from: p.from,
      to: p.to,
      kind: p.kind,
    }),
  ];
}
