// Summary → Body: weight by day, week or month (or the scale's body
// composition, or the watch's resting heart rate and HRV), its 7-day
// trend, sleep, check-ins, measurements and day notes.

import { get, meta, scoped } from "../api.mjs";
import { calendarView } from "../calendar.mjs";
import { legendWords, quartiles, step } from "../calendar-grid.mjs";
import {
  METRICS as CHECK_IN_METRICS,
  stats as checkInStats,
  tagCounts,
} from "../check-ins.mjs";
import { duration, pretty, shift, today } from "../dates.mjs";
import {
  TREND_DAYS,
  WINDOW_DAYS,
  projection,
  slope,
  trend,
} from "../energy.mjs";
import { highlights } from "../insights.mjs";
import { href } from "../nav.mjs";
import { NBSP, fmt, isNil, noun, plural, qty } from "../nutrients.mjs";
import { choice, fill, h, highlightList, tiles } from "../ui.mjs";
import { MIN_NIGHTS, sleepStats } from "../activity.mjs";
import {
  BY,
  bucketed,
  chart,
  chartBy,
  chartByPicker,
  chartHead,
  drawCharts,
  pointLinks,
} from "./summary-charts.mjs";

export const KEY = "body";
export const LABEL = "Body";

// The period's weigh-ins (from the trend window before it: the trend at its
// first weigh-in averages the days before), the last weeks' for the goal's
// projection (with a goal weight only), scale readings, measurements and
// notes; the goals, Health Connect days (sleep, heart) and check-ins come
// `shared` (web/series.mjs, a promise).
export async function load(p, shared) {
  const range = `from=${p.from}&to=${p.to}`;
  const weighFrom = shift(p.from, 1 - TREND_DAYS);
  // The projection is about today, whatever period is shown.
  const recentFrom = shift(today(), 2 - WINDOW_DAYS - TREND_DAYS);
  const recent = shared.then(({ targets }) =>
    isNil(targets.goal_weight?.value)
      ? []
      : get(scoped(`/weights?from=${recentFrom}&to=${today()}`)),
  );
  const [weighed, readings, measured, notes] = await Promise.all([
    get(scoped(`/weights?from=${weighFrom}&to=${p.to}`)),
    get(scoped(`/scale?${range}`)),
    get(scoped(`/measurements?${range}`)),
    get(scoped(`/notes?${range}`)),
  ]);
  return { weighed, readings, measured, notes, recent: await recent };
}

export function render(
  p,
  { weighed, readings, measured, notes, recent },
  shared,
) {
  const { activity: days, checkIns, targets } = shared;
  const goal = targets.goal_weight?.value ?? null;
  const weights = weighed.filter((w) => w.day >= p.from);
  return [
    // Sleep ↔ check-ins; the tiles carry the weight trend.
    highlightList(
      highlights("body", {
        kind: p.kind,
        from: p.from,
        to: p.to,
        last: today(),
        series: shared.series,
        targets,
      }),
    ),
    bodySummary(
      p,
      weights,
      trend(weighed).slice(-weights.length),
      readings,
      days,
      goal,
    ) ?? h("p", { class: "muted" }, `No weigh-ins this ${p.kind}.`),
    goal === null ? null : goalTiles(p, goal, recent),
    sleepSection(p, days, targets.sleep_min?.value ?? null),
    checkInSection(p, checkIns),
    measurementSummary(measured),
    noteSummary(notes),
  ];
}

const PROJECTED = {
  reached: () => "reached",
  away: () => "trend moving away",
  unclear: () => "no clear trend yet",
  far: () => "more than 2 years away",
  on: ({ day }) => `around ${pretty(day)}`,
};

// "75 kg goal, around Wed, Dec 3": the goal weight and, in a period
// holding today, where the last weeks' trend takes you (the projection is
// about today, so a past period shows the goal alone).
const goalTiles = (p, goal, recent) => {
  const now = today();
  const where =
    p.from <= now && now <= p.to ? projection(recent, goal, now) : null;
  return tiles("Goal", [
    [
      qty(goal, "kg", 1),
      `goal${where ? `, ${PROJECTED[where.kind](where)}` : ""}`,
      "goal-projection",
    ],
  ]);
};

// "+0.4 kg", "−1.2 kg", "±0 kg".
const signedKg = (kg) => {
  const r = Math.round(kg * 10) / 10;
  return `${r > 0 ? "+" : r < 0 ? "−" : "±"}${qty(Math.abs(r), "kg", 1)}`;
};

// What the body chart can show, each `[key, label, unit, what a point is]`:
// weight (kg), from scale readings a body composition share (%), from the
// watch the resting heart rate (bpm) and HRV (ms).
const METRICS = [
  ["weight", "Weight", "kg", "weigh-ins"],
  ["body_fat", "Body fat", "%", "readings"],
  ["water", "Water", "%", "readings"],
  ["muscle", "Muscle", "%", "readings"],
  ["resting_hr", "Resting HR", "bpm", "days"],
  ["hrv_ms", "HRV", "ms", "days"],
];

// The period's body chart and weight tiles; null when there is neither a
// weigh-in nor a metric to chart. The chart (two or more points) is by
// day or, as picked, by week or month: the mean of each one's points
// (weight's daily view adds the 7-day trend; the means already smooth the
// days). A choice switches between the metrics that have any point; it
// starts on the first that charts. Composition is each day's chosen
// reading (its earliest, as the day's weight).
function bodySummary(p, weights, trended, readings, days, goal) {
  const chosen = [
    ...new Map(readings.toReversed().map((r) => [r.day, r])).values(),
  ].toReversed();
  const daily = {
    weight: weights.map((w) => ({ day: w.day, value: w.kg })),
    resting_hr: days
      .filter((d) => !isNil(d.resting_hr))
      .map((d) => ({ day: d.day, value: d.resting_hr })),
    hrv_ms: days
      .filter((d) => !isNil(d.hrv_ms))
      .map((d) => ({ day: d.day, value: d.hrv_ms })),
  };
  for (const key of ["body_fat", "water", "muscle"])
    daily[key] = chosen
      .filter((r) => !isNil(r[key]))
      .map((r) => ({ day: r.day, value: r[key] }));
  const metrics = METRICS.filter(([key]) => daily[key].length);
  const charted = metrics.find(([key]) => daily[key].length >= 2);
  if (!weights.length && !charted) return null;
  let metric = (charted ?? metrics[0])[0];
  const heading = h("h2");
  const box = h("div", { class: "chart-box" });
  const card = h("div", { class: "chart-card card" }, box);
  let by = chartBy(p.kind);
  const show = () => {
    const [, label, unit, what] = METRICS.find(([k]) => k === metric);
    const weight = metric === "weight";
    heading.textContent = `${label} by ${by}`;
    const points =
      by === "day"
        ? daily[metric].map((x) => ({ key: x.day, value: x.value }))
        : [...bucketed(by, daily[metric])].map(([key, list]) => ({
            key,
            value:
              Math.round(
                (list.reduce((sum, x) => sum + x.value, 0) / list.length) * 10,
              ) / 10,
          }));
    card.hidden = points.length < 2;
    const canvas = h("canvas", {
      role: "img",
      "aria-label": `${
        by !== "day"
          ? `${label} by ${by}: the mean of each ${by}'s ${weight ? what : `${what}, in ${unit}`}.`
          : weight
            ? "Weight by day: each weigh-in and the 7-day trend."
            : `${label} by day: each day's ${what === "readings" ? "reading" : "value"}, in ${unit}.`
      }${weight && goal !== null ? ` Dashed: your goal, ${qty(goal, "kg", 1)}.` : ""}`,
    });
    fill(box, canvas);
    if (card.hidden) return;
    drawCharts(() => {
      const css = getComputedStyle(document.documentElement);
      const color = (name) => css.getPropertyValue(name).trim();
      chart(canvas, {
        type: "line",
        data: {
          labels: points.map((x) => BY[by].short(x.key)),
          datasets: [
            {
              label: `${by !== "day" ? `${label}, mean` : weight ? "Weigh-in" : label} (${unit})`,
              data: points.map((x) => x.value),
              // Means are a line; a day's points stand alone (by the trend).
              showLine: by !== "day",
              borderColor: color("--muted"),
              backgroundColor: color("--muted"),
              borderWidth: 2,
              pointRadius: 3,
            },
            ...(weight && by === "day"
              ? [
                  {
                    label: "7-day trend (kg)",
                    data: trended.map((t) => Math.round(t.kg * 10) / 10),
                    borderColor: color("--accent"),
                    backgroundColor: color("--accent"),
                    borderWidth: 2,
                    pointRadius: 0,
                  },
                ]
              : []),
            ...(weight && goal !== null
              ? [
                  {
                    label: "Goal (kg)",
                    data: points.map(() => goal),
                    borderColor: color("--muted"),
                    backgroundColor: color("--muted"),
                    borderDash: [6, 4],
                    borderWidth: 1.5,
                    pointRadius: 0,
                  },
                ]
              : []),
          ],
        },
        // Not from zero: a 0.5 kg change must show, unlike energy's.
        options: {
          ...pointLinks(points.map((x) => BY[by].link(x.key, p.tab))),
          scales: { y: { beginAtZero: false } },
        },
      });
    });
  };
  const pick = chartByPicker(p.kind, (next) => {
    by = next;
    show();
  });
  show();
  return h(
    "section",
    { class: "finder-section weight" },
    chartHead(heading, pick(METRICS.find(([k]) => k === metric)[1])),
    metrics.length > 1
      ? choice({
          name: "metric",
          look: "switch",
          label: "Chart",
          options: metrics.map(([key, label]) => [key, label]),
          value: metric,
          onChange: (key) => {
            metric = key;
            show();
          },
        })
      : null,
    card,
    weights.length ? weightTiles(weights, trended) : null,
  );
}

// The slope over the period's weigh-ins a week, the 7-day trend at the
// last, the change first to last.
function weightTiles(weights, trended) {
  const first = weights[0];
  const last = weights.at(-1);
  const perDay = slope(weights);
  return tiles("Weight", [
    perDay === null ? null : [signedKg(perDay * 7), "a week"],
    [qty(trended.at(-1).kg, "kg", 1), `trend on ${pretty(last.day, false)}`],
    weights.length === 1
      ? [qty(last.kg, "kg", 1), `on ${pretty(last.day, false)}`]
      : [signedKg(last.kg - first.kg), `over ${weights.length} weigh-ins`],
  ]);
}

// "7 h 20 min asleep, 23:40–07:05".
const nightText = (d) =>
  `${duration(d.asleep_min)} asleep, ${d.bedtime}–${d.wake_time}`;

// A section's heading and, without data, where its data comes from.
const emptySection = (className, heading, hint) =>
  h(
    "section",
    { class: `finder-section ${className}` },
    h("h2", {}, heading),
    h("p", { class: "muted" }, hint),
  );

// Hours, as a legend writes minutes: "6", "7.5".
const hours = (min) => fmt(min / 60, 1);

// The period's nights (each filed under the day it ended):
// tiles of the minutes asleep a night and, with MIN_NIGHTS or more, the
// average bedtime, its spread and the average wake-up; a calendar of each
// night shaded around the sleep `goal` (minutes: an hour under, the goal,
// an hour over), a night at the goal or more marked ✓, a night without
// data hatched. Without a goal the nights shade by their quartiles.
function sleepSection(p, days, goal) {
  const nights = days.filter((d) => !isNil(d.asleep_min));
  const stats = sleepStats(nights);
  if (!stats)
    return emptySection("sleep-summary", "Sleep", [
      "Sleep comes from the Android app: set it up in ",
      h("a", { href: href.connections() }, "Connections"),
      ".",
    ]);
  const bounds =
    goal === null
      ? quartiles(nights.map((d) => d.asleep_min))
      : [goal - 60, goal, goal + 60];
  const byDay = new Map(nights.map((d) => [d.day, d]));
  const reached = (day) => goal !== null && byDay.get(day)?.asleep_min >= goal;
  const series = {
    amount: (day) => {
      const d = byDay.get(day);
      if (!d) return "";
      return `${Math.floor(d.asleep_min / 60)}:${String(d.asleep_min % 60).padStart(2, "0")}`;
    },
    step: (day) => step(byDay.get(day)?.asleep_min ?? 0, bounds),
    unlogged: (day) => !byDay.has(day),
    over: () => false,
    marks: (day) => (reached(day) ? "✓" : null),
    label: (day) =>
      `${pretty(day)}: ${byDay.has(day) ? nightText(byDay.get(day)) : "no data"}${reached(day) ? ", goal reached" : ""}`,
  };
  return h(
    "section",
    { class: "finder-section sleep-summary" },
    h("h2", {}, "Sleep"),
    tiles("Sleep", [
      [duration(Math.round(stats.asleep)), "asleep a night"],
      stats.bedtime ? [stats.bedtime, "average bedtime"] : null,
      stats.bedtime
        ? [`±${NBSP}${duration(Math.round(stats.spread))}`, "bedtime spread"]
        : null,
      stats.wake ? [stats.wake, "average wake-up"] : null,
    ]),
    stats.nights < MIN_NIGHTS
      ? h(
          "p",
          { class: "muted" },
          `Bedtimes average from ${MIN_NIGHTS} nights.`,
        )
      : null,
    calendarView({
      kind: p.kind,
      from: p.from,
      caption: "Asleep by night",
      series,
      monthLink: (month) => href.summary("month", `${month}-01`, KEY),
      className: "sleep-cal",
    }),
    h(
      "div",
      { class: "cal-legend muted" },
      h(
        "ul",
        { "aria-label": "Shades" },
        ["No data", ...legendWords(bounds, "h", { num: hours })].map((w, i) =>
          h(
            "li",
            {},
            h("span", {
              class: `cal-cell shade-${i}${i === 0 ? " none" : ""}`,
              "aria-hidden": "true",
            }),
            w,
          ),
        ),
      ),
      goal === null || p.kind === "year"
        ? null
        : h(
            "ul",
            { "aria-label": "Marks" },
            h(
              "li",
              {},
              h("span", { "aria-hidden": "true" }, "✓"),
              `${duration(goal)} or more: your goal`,
            ),
          ),
    ),
  );
}

// The calendar's metric, kept per device.
const CHECK_IN_KEY = "checkin-metric";

// "3.6": a mean to a tenth, always with one.
const TENTH = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const tenth = (v) => TENTH.format(v);

// "5" "highest mood, on 4 days, latest Oct 3": a scale's extreme, the
// latest such day a link.
const extremeTile = (x, word) => [
  String(x.value),
  [
    `${word}, on ${plural(x.days, "day")}, latest `,
    h("a", { href: href.day(x.day) }, pretty(x.day, false)),
  ],
];

// The period's check-ins: the mean of each scale and the count; a quiet
// switch between the scales that have data (the pick kept per device, or
// the first with data) with its calendar, each day shaded and numbered by
// its value (stress the other way round: a calm day is the dark one), a
// day without a check-in hatched; the picked scale's highest and lowest
// value with how many days had it, linking to the latest; and the tags,
// most used first. Without a check-in, the heading and where they come
// from.
function checkInSection(p, list) {
  if (!list.length)
    return emptySection(
      "check-ins",
      "Check-ins",
      "Log a check-in from the Diary's + Log.",
    );
  const rated = CHECK_IN_METRICS.map(([key, label]) => [
    key,
    label,
    checkInStats(list, key),
  ]).filter(([, , st]) => st);
  const kept = localStorage.getItem(CHECK_IN_KEY);
  let metric = (rated.find(([key]) => key === kept) ?? rated[0])?.[0];
  const byDay = new Map(list.map((c) => [c.day, c]));
  const shown = h("div", { class: "check-in-metric" });
  const show = () => {
    const [, label, st] = rated.find(([key]) => key === metric);
    const lower = label.toLowerCase();
    const value = (day) => byDay.get(day)?.[metric] ?? null;
    const calm = metric === "stress";
    fill(
      shown,
      calendarView({
        kind: p.kind,
        from: p.from,
        caption: `${label} by day`,
        series: {
          amount: (day) => String(value(day) ?? ""),
          step: (day) =>
            isNil(value(day))
              ? 0
              : step(calm ? 6 - value(day) : value(day), [2, 3, 4]),
          unlogged: (day) => !byDay.has(day),
          over: () => false,
          marks: () => null,
          label: (day) =>
            `${pretty(day)}: ${
              isNil(value(day))
                ? byDay.has(day)
                  ? `no ${lower}`
                  : "no check-in"
                : `${lower} ${value(day)}`
            }`,
        },
        monthLink: (month) => href.summary("month", `${month}-01`, KEY),
        className: "check-in-cal",
      }),
      h(
        "div",
        { class: "cal-legend muted" },
        h(
          "ul",
          { "aria-label": "Shades" },
          [
            "No check-in",
            ...(calm
              ? ["4–5 stressed", "3", "2", "1 calm"]
              : ["1–2", "3", "4", "5"]),
          ].map((w, i) =>
            h(
              "li",
              {},
              h("span", {
                class: `cal-cell shade-${i}${i === 0 ? " none" : ""}`,
                "aria-hidden": "true",
              }),
              w,
            ),
          ),
        ),
      ),
      tiles(`${label}, highest and lowest`, [
        extremeTile(st.highest, `highest ${lower}`),
        st.lowest.value === st.highest.value
          ? null
          : extremeTile(st.lowest, `lowest ${lower}`),
      ]),
    );
  };
  if (metric) show();
  const tags = tagCounts(list);
  return h(
    "section",
    { class: "finder-section check-ins" },
    h("h2", {}, "Check-ins"),
    tiles("Check-ins", [
      ...rated.map(([key, , st]) => [tenth(st.mean), key]),
      [fmt(list.length), noun(list.length, "check-in")],
    ]),
    rated.length > 1
      ? choice({
          name: "checkin-metric",
          look: "switch",
          label: "Check-in calendar",
          options: rated.map(([key, label]) => [key, label]),
          value: metric,
          onChange: (key) => {
            metric = key;
            localStorage.setItem(CHECK_IN_KEY, key);
            show();
          },
        })
      : null,
    metric ? shown : null,
    tags.length
      ? h(
          "ul",
          { class: "days check-in-tags", "aria-label": "Tags" },
          tags.map(([tag, n]) =>
            h("li", {}, h("span", {}, tag), h("span", {}, fmt(n))),
          ),
        )
      : null,
  );
}

// The period's body measurements, first → last per kind (in /api/meta order);
// without one, where they come from.
function measurementSummary(measured) {
  const rows = meta.measurements
    .map((m) => [m, measured.filter((x) => x.kind === m.key)])
    .filter(([, list]) => list.length);
  if (!rows.length)
    return emptySection(
      "measurements",
      "Measurements",
      "Log a measurement from the Diary's + Log.",
    );
  return h(
    "section",
    { class: "finder-section measurements" },
    h("h2", {}, "Measurements"),
    h(
      "ul",
      { class: "days measurements" },
      rows.map(([m, list]) => {
        const first = list[0];
        const last = list.at(-1);
        const change = last.value - first.value;
        return h(
          "li",
          {},
          h("span", {}, m.label),
          h(
            "span",
            {},
            list.length === 1
              ? `${qty(last.value, m.unit, 1)} on ${pretty(last.day, false)}`
              : `${qty(first.value, m.unit, 1)} → ${qty(last.value, m.unit, 1)} (${change > 0 ? "+" : change < 0 ? "−" : "±"}${qty(Math.abs(change), m.unit, 1)})`,
          ),
        );
      }),
    ),
  );
}

// The period's day notes, each linking to its day.
function noteSummary(notes) {
  if (!notes.length)
    return emptySection(
      "notes",
      "Notes",
      "Write a note from the Diary's + Log.",
    );
  return h(
    "section",
    { class: "finder-section notes" },
    h("h2", {}, "Notes"),
    h(
      "ul",
      { class: "days notes" },
      notes.map((n) =>
        h(
          "li",
          {},
          h("a", { href: href.day(n.day) }, pretty(n.day)),
          h("span", { class: "note-text" }, n.text),
        ),
      ),
    ),
  );
}
