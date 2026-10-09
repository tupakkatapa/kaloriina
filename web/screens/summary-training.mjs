// Summary → Training: the period's workouts against the weekly target, and
// a calendar of the minutes trained each day with what was planned.

import { get, scoped } from "../api.mjs";
import { calendarView } from "../calendar.mjs";
import { legendWords, step } from "../calendar-grid.mjs";
import { daysIn, duration, pretty, shift, today } from "../dates.mjs";
import { highlights, tileThrough } from "../insights.mjs";
import { href } from "../nav.mjs";
import { NBSP, fmt, isNil, kcal, noun, plural, qty } from "../nutrients.mjs";
import { h, highlightList, tiles } from "../ui.mjs";
import { distanceText, effort, targetWeeks } from "../workouts.mjs";

export const KEY = "training";
export const LABEL = "Training";

// The period's sessions and plans, and the sessions of the period before
// (the Highlights compare them); the weekly target, Health Connect and
// check-ins come shared (web/series.mjs).
export async function load(p) {
  const range = `from=${p.from}&to=${p.to}`;
  const [sessions, plans, before] = await Promise.all([
    get(scoped(`/sessions?${range}`)),
    get(scoped(`/plans?${range}`)),
    get(scoped(`/sessions?from=${p.before.from}&to=${p.before.to}`)),
  ]);
  return { sessions, plans, before };
}

// Workouts a day over every day of [from, to] (web/insights.mjs): a rest
// day is a 0, not missing data.
const workoutSeries = (sessions, from, to) => {
  const values = new Map();
  for (const s of sessions) values.set(s.day, (values.get(s.day) ?? 0) + 1);
  const samples = Array.from({ length: daysIn(from, to) }, (_, i) =>
    shift(from, i),
  );
  return { values, samples };
};

// The first day the sync is seen covering among what is loaded, when any
// watch workout is: a comparison starting before it would count their
// arrival as a change. Undefined without watch workouts.
const syncedFrom = (sessions, days) => {
  const watch = sessions.filter((s) => s.source_key).map((s) => s.day);
  if (!watch.length) return undefined;
  return [...watch, ...days.map((d) => d.day)].toSorted()[0];
};

export function render(p, { sessions, plans, before }, shared) {
  return [
    // A session logged today is whole, so today counts.
    highlightList(
      highlights("training", {
        kind: p.kind,
        from: p.from,
        to: p.to,
        last: today(),
        before: p.before,
        // Training ↔ sleep and mood.
        series: {
          workouts: workoutSeries(sessions, p.from, p.to),
          ...shared.series,
        },
        targets: shared.targets,
        watchFrom: syncedFrom([...before, ...sessions], shared.activity),
        prev: {
          workouts: workoutSeries(before, p.before.from, p.before.to),
        },
      }),
    ),
    workoutSummary(
      p,
      sessions,
      plans,
      shared.activity,
      shared.targets.workouts_per_week?.value ?? null,
    ),
    trainingCalendar(p, sessions, plans),
  ];
}

// Minutes a day: the upper bounds of shades 1–3 (above is 4).
const BOUNDS = [20, 45, 90];

const byDay = (list) => {
  const out = new Map();
  for (const x of list) out.set(x.day, [...(out.get(x.day) ?? []), x]);
  return out;
};

// Each day's minutes (summed over its sessions), shaded by BOUNDS, with a
// mark for a plan: ● today or later, ○ on a past day (done as planned, a plan
// goes; one left on a past day was missed). A rest day isn't missing data,
// so nothing is hatched.
function series(sessions, plans) {
  const done = byDay(sessions);
  const planned = byDay(plans);
  const now = today();
  const minutes = (day) =>
    (done.get(day) ?? []).reduce((t, s) => t + s.minutes, 0);
  return {
    amount: (day) => (minutes(day) > 0 ? fmt(minutes(day)) : ""),
    step: (day) => step(minutes(day), BOUNDS),
    unlogged: () => false,
    over: () => false,
    marks: (day) => (planned.has(day) ? (day < now ? "○" : "●") : null),
    // "Tue, Oct 6: 2 workouts, 75 min (Pull day, Run)", "Thu, Oct 9:
    // planned Legs", "Mon, Oct 5: planned Legs, missed"; both joined by " · ".
    label: (day) => {
      const list = done.get(day) ?? [];
      const plan = planned.get(day) ?? [];
      const parts = [
        list.length
          ? `${plural(list.length, "workout")}, ${qty(minutes(day), "min", 0)} (${list.map((s) => s.name).join(", ")})`
          : null,
        plan.length
          ? `planned ${plan.map((x) => x.name).join(", ")}${day < now ? ", missed" : ""}`
          : null,
      ].filter(Boolean);
      return `${pretty(day)}: ${parts.length ? parts.join(" · ") : "no workout"}`;
    },
  };
}

// The calendar of the period and its key, in words as well as colour.
function trainingCalendar(p, sessions, plans) {
  return h(
    "section",
    { class: "finder-section training-summary" },
    calendarView({
      kind: p.kind,
      from: p.from,
      caption: "Minutes by day",
      series: series(sessions, plans),
      monthLink: (month) => href.summary("month", `${month}-01`, KEY),
      className: "training-cal",
    }),
    h(
      "div",
      { class: "cal-legend muted" },
      h(
        "ul",
        { "aria-label": "Shades" },
        ["None", ...legendWords(BOUNDS, "min")].map((w, i) =>
          h(
            "li",
            {},
            h("span", { class: `cal-cell shade-${i}`, "aria-hidden": "true" }),
            w,
          ),
        ),
      ),
      p.kind === "year"
        ? null
        : h(
            "ul",
            { "aria-label": "Marks" },
            h("li", {}, h("span", { "aria-hidden": "true" }, "●"), "planned"),
            h("li", {}, h("span", { "aria-hidden": "true" }, "○"), "missed"),
          ),
    ),
  );
}

const workouts = (k) => noun(k, "workout");

// "2 of 3 workouts this week", "1 h 15 min trained", "≈ 640 kcal burned",
// "1 planned": a week against the target (with a bar); a month or year as
// a weekly average over its elapsed days, with how many of its weeks met
// `target` (workouts a week, or null). Energy not set on a workout is
// estimated (≈, read out as "includes estimates") from its time and the
// weight in effect on its day; without one it isn't.
function workoutSummary(p, sessions, plans, activityDays, target) {
  const end = tileThrough(p.from, p.to, today());
  const done = sessions.filter((s) => s.day <= end);
  const n = done.length;
  const minutes = done.reduce((t, s) => t + s.minutes, 0);
  const efforts = done.map((s) => effort(s, new Map(), s.weight_kg));
  const burned = efforts.reduce((t, e) => t + (e.kcal ?? 0), 0);
  const estimated = efforts.some((e) => e.kcalEstimated && e.kcal !== null);
  const unestimated = efforts.some((e) => e.kcal === null && e.minutes);
  const week = p.kind === "week";
  const judged = week
    ? null
    : targetWeeks(sessions, p.from, p.to, target, today());
  // The unit goes with the caption, so a long total fits a phone's tile.
  const [burnedValue, unit] = kcal(burned).split(NBSP);
  const planned = plans.length ? [fmt(plans.length), "planned"] : null;
  return h(
    "section",
    { class: "finder-section workout-summary" },
    h("h2", {}, "Workouts"),
    tiles("Workouts", [
      week
        ? isNil(target)
          ? [fmt(n), workouts(n)]
          : [`${fmt(n)} of ${fmt(target)}`, `${workouts(target)} this week`]
        : [
            fmt(n),
            `${workouts(n)} · ${fmt(n / (daysIn(p.from, end) / 7), 1)} a week`,
          ],
      n ? [duration(minutes), "trained"] : null,
      burned
        ? [
            [
              estimated
                ? h(
                    "span",
                    {
                      role: "img",
                      "aria-label": "includes estimates",
                      title: "Includes estimates",
                    },
                    "≈",
                  )
                : null,
              estimated ? " " : null,
              burnedValue,
            ],
            `${unit} burned`,
          ]
        : null,
      week || !judged?.total
        ? planned
        : [
            `${judged.met} of ${judged.total}`,
            `weeks at your target of ${fmt(target)}`,
          ],
    ]),
    week && target
      ? h("progress", {
          max: target,
          value: Math.min(n, target),
          "aria-label": `${n} of ${plural(target, "workout")} this week`,
        })
      : null,
    unestimated
      ? h("p", { class: "muted" }, "Log a weight to estimate energy.")
      : null,
    activitySummary(p, activityDays, done),
    n || plans.length
      ? null
      : h("p", { class: "muted" }, `No workouts this ${p.kind}.`),
  );
}

// "≈ 23,940 kcal active energy", "8,743 steps a day": the period's Health
// Connect totals from the Android companion through yesterday (today's are
// still coming in), the steps a day over the days that have them, and
// the distance the workouts done covered ("42.3 km covered"). Shown
// beside the workouts, never added to what they burned.
function activitySummary(p, all, done) {
  const days = all.filter(
    (d) => d.day <= tileThrough(p.from, p.to, shift(today(), -1)),
  );
  const sum = (key) => days.reduce((t, d) => t + (d[key] ?? 0), 0);
  const stepDays = days.filter((d) => !isNil(d.steps)).length;
  const metres = done.reduce((t, s) => t + (s.distance_m ?? 0), 0);
  const [active, unit] = kcal(sum("active_kcal")).split(NBSP);
  const node = tiles("Activity", [
    days.some((d) => !isNil(d.active_kcal))
      ? [`≈ ${active}`, `${unit} active energy`]
      : null,
    stepDays ? [fmt(sum("steps") / stepDays), "steps a day"] : null,
    metres ? [distanceText(metres), "covered"] : null,
  ]);
  node?.classList.add("activity-summary");
  return node;
}
