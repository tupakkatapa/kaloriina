// Summary → Habits: the Highlights over every habit, the days logged and
// one habit's calendar at a time. Every habit's days (`/habits/days`: the
// built-ins the server reads from food, and the trackers) and the trackers
// load here, and the period before's days for the comparisons; the goals,
// sleep and check-ins come shared (web/series.mjs).

import { get, scoped } from "../api.mjs";
import { shift, today } from "../dates.mjs";
import { habitSeries, loggedDays, summaryHabits } from "../habits.mjs";
import { highlights } from "../insights.mjs";
import { plural } from "../nutrients.mjs";
import { h, highlightList } from "../ui.mjs";
import { allHabits, habitsSection } from "./habits.mjs";

export const KEY = "habits";
export const LABEL = "Habits";

export async function load(p) {
  const [list, days, beforeDays] = await Promise.all([
    get(scoped("/habits")),
    get(scoped(`/habits/days?from=${p.from}&to=${p.to}`)),
    get(scoped(`/habits/days?from=${p.before.from}&to=${p.before.to}`)),
  ]);
  return { list, days, beforeDays };
}

export function render(p, { list, days, beforeDays }, shared) {
  const habits = allHabits(Object.values(shared.targets), list);
  // Today is still being logged: the numbers end yesterday.
  const end = p.end ?? p.to;
  const logged = [...loggedDays(days)].filter((d) => d <= end).length;
  return [
    highlightList(
      highlights("habits", {
        kind: p.kind,
        from: p.from,
        to: p.to,
        last: shift(today(), -1),
        before: p.before,
        // The nights after each day: alcohol ↔ sleep; the
        // day's own stress: alcohol ↔ stress.
        series: { ...habitSeries(habits, days), ...shared.series },
        prev: habitSeries(habits, beforeDays),
      }),
    ),
    h(
      "p",
      { class: "muted" },
      `${plural(logged, "day")} logged${end < p.to ? " through yesterday" : ""}`,
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
