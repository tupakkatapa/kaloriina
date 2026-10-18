// Summary → Body: weight by day or week (or the scale's body composition,
// the BMI, maintenance, a measurement; or the device's resting heart rate,
// HRV and heart rate), its trend and goal lines, the period's heart,
// sleep, check-ins, measurements and day notes.

import { currentProfile, get, meta, scoped } from "../api.mjs";
import { calendarView } from "../calendar.mjs";
import { legendWords, quartiles, step } from "../calendar-grid.mjs";
import {
  CHECK_IN_SCALES,
  stats as checkInStats,
  tagCounts,
} from "../check-ins.mjs";
import { touching } from "../correlate.mjs";
import { clockOf, duration, pretty, shift, today } from "../dates.mjs";
import {
  GOAL_STEP_MIN,
  goalShade,
  heartDaysOver,
  MIN_NIGHTS,
  nightText,
  ON_SCHEDULE_MIN,
  onSchedule,
  sleepStats,
} from "../device.mjs";
import { MAINTENANCE_BY } from "../energy-text.mjs";
import {
  fmt,
  fmtFixed,
  isNil,
  lower,
  NBSP,
  noun,
  plural,
  qty,
} from "../format.mjs";
import { bmi, seriesOf } from "../insights.mjs";
import { href } from "../nav.mjs";
import { kvList } from "../rows.mjs";
import {
  BALANCE_DAYS,
  bodyLines,
  BUCKET,
  bucketOf,
  keysOf,
  maintenance as maintenanceOver,
  projection,
  seriesMarks,
  trend,
  TREND_DAYS,
  weeklyRate,
  withHidden,
} from "../series.mjs";
import { convert, seriesInfo, shownUnit, source } from "../series-keys.mjs";
import { CHECK, choice, fill, h, icon } from "../ui.mjs";
import { tiles } from "../tiles.mjs";
import { toShown, unitOf, unitQty } from "../units.mjs";
import { seriesChart } from "./summary-charts.mjs";
import { highlightStack } from "./summary-highlights.mjs";

export const KEY = "body";
export const LABEL = "Body";

// The period's weigh-ins (from the trend window before it: the trend at its
// first weigh-in averages the days before), the last weeks' for the goal's
// projection (with a goal weight only), scale readings, maintenance by day
// (web/series.mjs), measurements and notes; the goals, Health Connect days
// (sleep, heart), check-ins, the energy burned and the weigh-in and
// reading rows come `shared` (web/series.mjs, a promise).
export async function load(p, sharing) {
  const range = `from=${p.from}&to=${p.to}`;
  const weighFrom = shift(p.from, 1 - TREND_DAYS);
  // The projection is about today, whatever period is shown.
  const recentFrom = shift(today(), 2 - BALANCE_DAYS - TREND_DAYS);
  const [shared, measured, notes] = await Promise.all([
    sharing,
    get(scoped(`/measurements?${range}`)),
    get(scoped(`/notes?${range}`)),
  ]);
  const [weighed, readings, recent, maintenance] = await Promise.all([
    shared.rows("weights", weighFrom, p.to),
    shared.rows("readings", p.from, p.to),
    isNil(shared.targets.goal_weight?.value)
      ? []
      : shared.rows("weights", recentFrom, today()),
    maintenanceOver(p, shared),
  ]);
  return { weighed, readings, measured, notes, recent, maintenance };
}

export function render(
  p,
  { weighed, readings, measured, notes, recent, maintenance },
  shared,
) {
  const { deviceDays: days, checkIns, targets } = shared;
  const goal = targets.goal_weight?.value ?? null;
  const weights = weighed.filter((w) => w.day >= p.from);
  const person = currentProfile() ?? {};
  const fat = chosenReadings(readings).filter((r) => !isNil(r.body_fat));
  return [
    // Sleep ↔ check-ins, BMI, the loss rate, recovery, body fat; the tiles
    // carry the weight trend.
    highlightStack(
      KEY,
      {
        kind: p.kind,
        from: p.from,
        to: p.to,
        last: today(),
        series: {
          ...shared.series,
          weight: seriesOf(weights, "kg"),
          body_fat: seriesOf(fat, "body_fat"),
        },
        targets,
        person,
        trailing: shared.trailing,
        correlations: touching(shared.correlations, KEY),
      },
      p,
      shared,
    ),
    bodySummary(p, {
      weights,
      weighed,
      readings,
      targets,
      measured,
      person,
      maintenance,
    }) ?? h("p", { class: "muted" }, `Nothing logged this ${p.kind}.`),
    goal === null ? null : goalTiles(p, goal, recent),
    heartChart(p, heartDaysOver(days, today())),
    heartTiles(heartDaysOver(days, today())),
    sleepSection(p, days, targets.sleep_min?.value ?? null, {
      bedtime: targets.bedtime?.value ?? null,
      wake: targets.wake_time?.value ?? null,
    }),
    checkInSection(p, checkIns),
    measured.length > 0
      ? null
      : emptySection(
          "measurements",
          "Measurements",
          "Log a measurement from the Diary's Log card.",
        ),
    noteSummary(notes),
  ];
}

// Each day's chosen scale reading, the server's (`chosen`: the first after
// waking, as the day's weight).
const chosenReadings = (readings) => readings.filter((r) => r.chosen);

const PROJECTED = {
  reached: () => "reached",
  away: () => "trend moving away",
  unclear: () => "no clear trend yet",
  flat: () => "trend flat, no date",
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
    {
      value: unitQty(goal, "kg", 1),
      short: `goal${where ? `, ${PROJECTED[where.kind](where)}` : ""}`,
      long: `Your goal weight${where ? ", and where your weight trend of the last weeks takes you at its pace" : ""}.`,
      cls: "goal-projection",
    },
  ]);
};

// kg as shown: a tenth of the device's unit (lb in US units).
const shownKg = (kg) => Math.round(toShown(kg, "kg") * 10) / 10;

// "+0.4 kg", "−1.2 kg", "±0 kg" (lb in US units).
const signedKg = (kg) => {
  const r = shownKg(kg);
  return `${r > 0 ? "+" : r < 0 ? "−" : "±"}${qty(Math.abs(r), unitOf("kg"), 1)}`;
};

// A rate's margin: a tenth, under 0.1 two decimals, under what those show
// "< 0.01 kg", never "± 0".
const marginKg = (kg) => {
  const shown = toShown(kg, "kg");
  return shown < 0.005
    ? `<${NBSP}${qty(0.01, unitOf("kg"), 2)}`
    : unitQty(kg, "kg", shown < 0.1 ? 2 : 1);
};

// What the Body chart can show (web/series-keys.mjs keys): weight, from scale
// readings a body composition share and the lean and bone mass, the BMI,
// maintenance (a moving constant, as BMI is), then each body
// measurement (/api/meta order). The Heart chart: from the device the
// resting heart rate, HRV and the day's average heart rate (its
// lowest–highest a band). Energy eaten and burned is Food's chart (items
// 12, 17).
const READ = ["body_fat", "body_water", "muscle", "lbm_kg", "bone_kg"];
const BODY = [
  "weight",
  "body_fat",
  "muscle",
  "body_water",
  "lbm_kg",
  "bone_kg",
];
const HEART = ["resting_hr", "hrv_ms", "avg_hr"];
// Each as `[key, label, unit (shown), what a point is, unit (stored)]`.
const kindOf = (
  key,
  what,
  label = seriesInfo(key).label,
  unit = seriesInfo(key).unit,
) => [key, label, shownUnit(key, unit), what, unit];
const bodyMetrics = () => [
  ...BODY.map((key) =>
    kindOf(key, key === "weight" ? "weigh-ins" : "readings"),
  ),
  kindOf("bmi", "weigh-ins"),
  kindOf("maintenance", "days"),
  ...meta.measurements.map((m) =>
    kindOf(`m:${m.key}`, "measurements", m.label, m.unit),
  ),
];

// The period's Body chart and weight tiles; null when there is nothing to
// chart and no weigh-in. Composition is each day's chosen reading (the
// first after waking, as the day's weight); BMI needs a height; maintenance
// (`maintenance`, web/series.mjs) is each day's through yesterday.
function bodySummary(
  p,
  { weights, weighed, readings, targets, measured, person, maintenance },
) {
  const trended = trend(weighed).slice(-weights.length);
  const chosen = chosenReadings(readings);
  const daily = {
    weight: weights.map((w) => ({ day: w.day, value: w.kg })),
    bmi: person.height_cm
      ? weights.map((w) => ({ day: w.day, value: bmi(w.kg, person.height_cm) }))
      : [],
    maintenance: maintenance.map((m) => ({
      day: m.day,
      value: m.kcal,
      source: m.source,
    })),
  };
  for (const key of READ) daily[key] = source(key, chosen);
  for (const m of meta.measurements)
    daily[`m:${m.key}`] = measured
      .filter((x) => x.kind === m.key)
      .map((x) => ({ day: x.day, value: x.value }));
  const kinds = bodyMetrics();
  // Points in the shown unit: lb from kg, in from cm, kJ from kcal; a
  // tenth (energy whole).
  const shown = (key, stored) => (x) => ({
    ...x,
    value: roundOf(key)(convert(key, x.value, stored)),
  });
  for (const [key, , , , stored] of kinds)
    daily[key] = daily[key].map(shown(key, stored));
  const parts = metricChart(p, {
    name: "Body",
    switchLabel: "Chart",
    kinds,
    daily,
    // The weight trend reads the weigh-ins before the period too.
    lead: {
      weight: weighed
        .filter((w) => w.day < p.from)
        .map((w) => shown("weight", "kg")({ day: w.day, value: w.kg })),
    },
    lines: (key, keys, unit) =>
      bodyLines({
        key,
        keys,
        targets,
        person,
        day: today(),
        table: meta.limits.recommended_bmi,
        unit,
        show: (v) => convert(key, v),
      }),
  });
  if (weights.length === 0 && !parts) return null;
  return h(
    "section",
    { class: "finder-section weight" },
    parts,
    weights.length > 0 ? weightTiles(weights, trended) : null,
  );
}

// A tenth; energy whole.
const roundOf = (key) =>
  seriesInfo(key).energy ? Math.round : (v) => Math.round(v * 10) / 10;

// The period's Heart chart (the device's days): null without a point.
function heartChart(p, days) {
  const daily = Object.fromEntries(
    HEART.map((key) => [key, source(key, days)]),
  );
  // Heart rate by day: each day's lowest and highest, a faint band.
  const band = new Map(
    days
      .filter((d) => !isNil(d.min_hr) && !isNil(d.max_hr))
      .map((d) => [d.day, [d.min_hr, d.max_hr]]),
  );
  const parts = metricChart(p, {
    name: "Heart",
    switchLabel: "Heart chart",
    kinds: HEART.map((key) => kindOf(key, "days")),
    daily,
    band,
  });
  return parts && h("section", { class: "finder-section heart" }, parts);
}

// A chart card over `kinds` (`daily` key → [{day, value}], shown units),
// its points by the period's buckets (web/series.mjs bucketOf; points all
// in one bucket by day, so two or more always have their trend): each
// day's value or each week's mean, faint, and the trend (from `lead` key →
// days before the period too; a series series-keys.mjs gives no trend:
// its points alone, in its colour), with `lines(key, keys, unit)` dashed
// (goals, the recommended BMI: web/series.mjs bodyLines; one far from the
// points starts hidden), the goal date and the path to it (goalPlan), and
// heart rate by day over `band`. A switch (`switchLabel`) goes between the
// metrics that have any point; it starts on `p.metric` (an insight's link)
// or the first that charts; one point alone is said in words. Nothing is
// written under the chart: an estimate says "≈" in its legend;
// maintenance names its method there, each method its own points when the
// days differ (never a jump unsaid).
// The heading, switch, card, list and words; null without a point.
function metricChart(
  p,
  { name, switchLabel, kinds, daily, lead = {}, lines = () => [], band },
) {
  const metrics = kinds.filter(([key]) => daily[key].length);
  if (metrics.length === 0) return null;
  // Weight first whenever it has a point (the chart that opens is
  // the one a Body page is about), else the first with a line.
  const charted =
    metrics.find(([key]) => key === "weight") ??
    metrics.find(([key]) => daily[key].length >= 2);
  // An insight's link names its metric (`p.metric`): the chart starts on it.
  const asked = metrics.find(([key]) => key === p.metric);
  let metric = (asked ?? charted ?? metrics[0])[0];
  const node = h("div", { class: "stack" });
  const show = () => {
    const [, label, unit, what] = kinds.find(([k]) => k === metric);
    const points = daily[metric];
    const by =
      keysOf(bucketOf(p.kind), points).length < 2 ? "day" : bucketOf(p.kind);
    const estimate = seriesInfo(metric).estimate
      ? " ≈ (scale)"
      : metric === "maintenance"
        ? " ≈"
        : "";
    const banded = metric === "avg_hr" && by === "day" && band?.size > 0;
    const g = goalPlan({ p, by, points });
    const digits = seriesInfo(metric).energy ? 0 : 1;
    const keys = [...keysOf(by, points), ...g.extra];
    let marks = withHidden([
      ...seriesMarks({
        key: metric,
        label: `${label}${estimate}`,
        daily: points,
        lead: lead[metric] ?? [],
        by,
        keys,
        round: roundOf(metric),
        part:
          metric === "maintenance"
            ? (x) => MAINTENANCE_BY[x.source]
            : undefined,
        trend: seriesInfo(metric).trend,
      }),
      ...(banded ? bandMarks(keys, band) : []),
      ...lines(metric, keys, unit),
    ]);
    // The path to a goal shown, from the trend's last point.
    const goal = marks.find((m) => m.key === "target" && !m.hidden);
    // A series without a trend (series-keys.mjs) has no path to a goal.
    const last = marks
      .find((m) => m.kind === "trend")
      ?.data.findLast((v) => !isNil(v));
    if (goal && g.path && !isNil(last))
      marks = [...marks, g.path(keys, last, goal.value)];
    const each =
      by === "day"
        ? metric === "weight"
          ? "each weigh-in"
          : `each day's ${what === "readings" ? "reading" : "value"}`
        : `each ${by}'s mean`;
    const [head, card, list] = seriesChart({
      p,
      by,
      heading: `${label} by ${by}`,
      label: `${label}${estimate} by ${by}: ${each}${seriesInfo(metric).trend ? ", faint," : ","} ${banded ? "its lowest to highest a band, " : ""}${seriesInfo(metric).trend ? "and the trend, " : ""}in ${unit}.${marks.some((m) => m.kind === "line") ? " Dashed: the lines the list below names." : ""}`,
      keys,
      marks,
      unit,
      digits,
      colors: { [metric]: ["--accent", "--muted"], band: ["--muted"] },
      plugins: g.dateAt === null ? [] : [goalDateLine(g.dateAt)],
    });
    fill(
      node,
      head,
      metrics.length > 1
        ? choice({
            name: `${name.toLowerCase()}-metric`,
            look: "switch",
            label: switchLabel,
            options: metrics.map(([key, l]) => [key, l]),
            value: metric,
            onChange: (key) => {
              metric = key;
              show();
            },
          })
        : null,
      points.length === 1
        ? h(
            "p",
            { class: "muted" },
            `${label}: ${qty(points[0].value, unit, digits)} on ${pretty(points[0].day, false)}`,
          )
        : [card, list],
    );
    head.querySelector(".expand").hidden = points.length < 2;
  };
  show();
  // Opened from an insight: the chart it names comes into view.
  if (asked) requestAnimationFrame(() => node.scrollIntoView());
  return node;
}

// How far past today a goal date still stretches the axis: two years.
const GOAL_AHEAD_DAYS = 730;

// A metric's goal date on its chart (`points` the chart's by `by`):
// {extra (a bucket key appended for the goal date), dateAt (its label's
// index, or null), path ((keys, from, goal) → the mark from the trend's
// last point at `from` to `goal` at the goal date, or null)}. The goal date
// (`profile.goal_date`) marks the axis inside the period, or past its end
// up to GOAL_AHEAD_DAYS from today in a month or year holding today (a
// week keeps its axis); the path runs only in the period holding today.
function goalPlan({ p, by, points }) {
  const date = currentProfile()?.goal_date ?? null;
  const keys = keysOf(by, points);
  const now = today();
  const current = p.from <= now && now <= p.to;
  // A month or year holding today reaches out to a later goal date.
  const reach =
    current && p.kind !== "week" ? shift(now, GOAL_AHEAD_DAYS) : p.to;
  const key = date && date >= p.from && date <= reach ? BUCKET[by](date) : null;
  const extra = key && key > keys.at(-1) ? [key] : [];
  const all = [...keys, ...extra];
  return {
    extra,
    dateAt: key && all.includes(key) ? all.indexOf(key) : null,
    path:
      extra.length > 0 && current
        ? (ks, from, goal) => pathMark(ks, keys.length - 1, key, from, goal)
        : null,
  };
}

// The path to the goal over `keys`: from `from` at index `at` (the
// trend's last point) to `goal` at the goal date's key.
const pathMark = (keys, at, key, from, goal) => ({
  key: "path",
  kind: "path",
  label: "Path to the goal",
  data: keys.map((k, i) => (i === at ? from : k === key ? goal : null)),
});

// A dashed upright line at label `index`, "Goal date" beside it.
const goalDateLine = (index) => ({
  id: "goalDate",
  afterDatasetsDraw(c) {
    const color = getComputedStyle(document.documentElement)
      .getPropertyValue("--muted")
      .trim();
    const x = c.scales.x.getPixelForValue(index);
    const { top, bottom } = c.chartArea;
    const g = c.ctx;
    g.save();
    g.strokeStyle = color;
    g.fillStyle = color;
    g.setLineDash([4, 4]);
    g.beginPath();
    g.moveTo(x, top);
    g.lineTo(x, bottom);
    g.stroke();
    g.setLineDash([]);
    g.font = `12px ${getComputedStyle(document.documentElement).fontFamily}`;
    g.textAlign = "right";
    g.fillText("Goal date", x - 4, top + 12);
    g.restore();
  },
});

// A day's lowest and highest heart rate behind its points (`band` day →
// [low, high], over `keys`): two unlined marks, the space between them
// filled faint, drawn under the rest.
const bandMarks = (keys, band) =>
  ["Lowest", "Lowest–highest"].map((label, i) => ({
    key: "band",
    kind: i ? "high" : "low",
    label: `${label} (bpm)`,
    data: keys.map((k) => band.get(k)?.[i] ?? null),
  }));

// A heart tile's long text ends with the days it averages.
const OVER_DAYS = "Averaged over the days your device read it.";

// The period's heart: the average HRV, resting heart rate and heart rate
// over the days that have each (`days` heartDaysOver: today's heart rate
// left out); null without any.
function heartTiles(days) {
  const mean = (key) => {
    const list = days.map((d) => d[key]).filter((v) => !isNil(v));
    return list.length > 0
      ? Math.round(list.reduce((t, v) => t + v, 0) / list.length)
      : null;
  };
  const tile = (key, unit, caption, words) =>
    isNil(mean(key))
      ? null
      : {
          value: qty(mean(key), unit),
          short: caption,
          long: `${words} ${OVER_DAYS}`,
        };
  return tiles("Heart", [
    tile(
      "hrv_ms",
      "ms",
      "average HRV",
      "Heart rate variability: how much the time between beats varies, read in your sleep. Higher usually means rested.",
    ),
    tile(
      "resting_hr",
      "bpm",
      "average RHR",
      "Resting heart rate: your heart at its calmest in the day. Lower usually means fitter or rested.",
    ),
    tile(
      "avg_hr",
      "bpm",
      "average heart rate",
      "Your heart rate over the whole day, activity included.",
    ),
  ]);
}

// The weigh-ins' change a week with its 95 % margin (weeklyRate: over
// RATE_SPAN_DAYS or more; inside its margin, or reading ±0 as shown, no
// clear change; the margin as marginKg says it), the trend at the last
// weigh-in, and the trend's change from the first weigh-in to the last
// (two single readings swing with water; the trend is what moved).
function weightTiles(weights, trended) {
  const last = weights.at(-1);
  const rate = weeklyRate(weights);
  const margin = rate && `a week, ±${NBSP}${marginKg(rate.margin)}`;
  const rateLong = `Your change a week, from a straight line through the weigh-ins, ± its 95${NBSP}% margin. A change inside the margin is no clear change.`;
  return tiles("Weight", [
    rate === null
      ? null
      : rate.clear && shownKg(rate.perWeek) !== 0
        ? { value: signedKg(rate.perWeek), short: margin, long: rateLong }
        : { value: "No clear change", short: margin, long: rateLong },
    {
      value: unitQty(trended.at(-1).kg, "kg", 1),
      short: `weight trend, ${pretty(last.day, false)}`,
      long: `Your weight trend at the period's last weigh-in: the weigh-ins of the ${TREND_DAYS} days to it, averaged. Steadier than one reading.`,
    },
    weights.length === 1
      ? {
          value: unitQty(last.kg, "kg", 1),
          short: `on ${pretty(last.day, false)}`,
          long: "Your only weigh-in this period.",
        }
      : {
          value: signedKg(trended.at(-1).kg - trended[0].kg),
          short: `change over ${weights.length} weigh-ins`,
          long: "How far your weight trend moved from the period's first weigh-in to its last.",
        },
  ]);
}

// A day's night: its minutes asleep (naps are their own figure).
const slept = (d) => d.asleep_min;

// "7 h 45 min asleep, 23:40–07:05 · 8 h in bed · …": the night's facts,
// which the Diary's static Sleep card leaves to here.
const nightLabel = (d) => {
  const t = nightText(d);
  return t.detail ? `${t.value}, ${t.detail}` : t.value;
};

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

// The period's nights (each filed under the day it ended): tiles of the
// minutes asleep a night (the night's alone) and, with MIN_NIGHTS or more,
// the average bedtime, its spread and the average wake-up, and the naps'
// time asleep (≥ when some were only time in bed); a calendar of each night
// shaded around the sleep `goal` (goalShade: from an hour under, the goal,
// an hour over), a night at the goal or more marked ✓, a day without a
// night hatched (its naps in its label). Without a goal the nights shade by
// their quartiles. With a bedtime or wake-up target (`schedule`, minutes),
// a night that kept it (ON_SCHEDULE_MIN either way) is marked ◷ and counted
// in a tile.
function sleepSection(p, days, goal, schedule) {
  const nights = days.filter((d) => !isNil(slept(d)));
  const stats = sleepStats(days);
  if (!stats)
    return emptySection("sleep-summary", "Sleep", [
      "Sleep comes from the Android app: set it up in ",
      h("a", { href: href.connections() }, "Connections"),
      ".",
    ]);
  const bounds =
    goal === null
      ? quartiles(nights.map((x) => slept(x)))
      : [goal - GOAL_STEP_MIN, goal, goal + GOAL_STEP_MIN];
  const byDay = new Map(nights.map((d) => [d.day, d]));
  const napDays = new Map(
    days.filter((d) => isNil(slept(d)) && nightText(d)).map((d) => [d.day, d]),
  );
  const reached = (day) =>
    goal !== null && byDay.has(day) && slept(byDay.get(day)) >= goal;
  const kept = (day) =>
    byDay.has(day)
      ? onSchedule(byDay.get(day), schedule.bedtime, schedule.wake)
      : null;
  const judged = nights.filter((d) => kept(d.day) !== null);
  const series = {
    amount: (day) => {
      const d = byDay.get(day);
      if (!d) return "";
      return `${Math.floor(slept(d) / 60)}:${String(slept(d) % 60).padStart(2, "0")}`;
    },
    step: (day) => {
      const min = byDay.has(day) ? slept(byDay.get(day)) : 0;
      return goal === null ? step(min, bounds) : goalShade(min, goal);
    },
    unlogged: (day) => !byDay.has(day),
    over: () => false,
    // A night is filed under the day it ended: today's is over.
    final: (day) => byDay.has(day),
    marks: (day) =>
      reached(day) || kept(day)
        ? [reached(day) ? icon(CHECK) : null, kept(day) ? "◷" : null]
        : null,
    label: (day) =>
      `${pretty(day)}: ${byDay.has(day) ? nightLabel(byDay.get(day)) : napDays.has(day) ? `no night, ${nightLabel(napDays.get(day))}` : "nothing logged"}${reached(day) ? ", goal reached" : ""}${kept(day) === null ? "" : kept(day) ? ", on schedule" : ", off schedule"}`,
  };
  return h(
    "section",
    { class: "finder-section sleep-summary" },
    h("h2", {}, "Sleep"),
    tiles("Sleep", [
      {
        value: duration(Math.round(stats.asleep)),
        short: "asleep a night",
        long: `Your average time asleep a night, over the ${plural(stats.nights, "night")} your device recorded; naps not counted.`,
      },
      stats.bedtime
        ? {
            value: clockOf(stats.bedtime),
            short: "average bedtime",
            long: "When you fell asleep, on average.",
          }
        : null,
      stats.bedtime
        ? {
            value: `±${NBSP}${duration(Math.round(stats.spread))}`,
            short: "bedtime spread",
            long: "How far your bedtime typically strays from its average (its standard deviation). Smaller is a steadier rhythm.",
          }
        : null,
      stats.wake
        ? {
            value: clockOf(stats.wake),
            short: "average wake-up",
            long: "When you woke up, on average.",
          }
        : null,
      stats.naps.count
        ? {
            value: `${stats.naps.partial ? `≥${NBSP}` : ""}${duration(stats.naps.asleep)}`,
            short: `asleep in ${plural(stats.naps.count, "nap")}`,
            long: `Your time asleep in naps, added up.${stats.naps.partial ? " At least: some naps have only their time in bed." : ""}`,
          }
        : null,
      judged.length > 0
        ? {
            value: `${judged.filter((d) => kept(d.day)).length} of ${judged.length}`,
            short: "nights on schedule",
            long: `Nights you went to bed and woke up within ${ON_SCHEDULE_MIN}${NBSP}min of your bedtime and wake-up targets.`,
          }
        : null,
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
        [
          "Nothing logged",
          ...(goal === null
            ? legendWords(bounds, "h", { num: hours })
            : [
                `<${NBSP}${hours(bounds[0])}${NBSP}h`,
                `${hours(bounds[0])}–${hours(bounds[1])}${NBSP}h`,
                `${hours(bounds[1])}–${hours(bounds[2])}${NBSP}h`,
                `≥${NBSP}${hours(bounds[2])}${NBSP}h`,
              ]),
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
      (goal === null && judged.length === 0) || p.kind === "year"
        ? null
        : h(
            "ul",
            { "aria-label": "Marks" },
            goal === null
              ? null
              : h(
                  "li",
                  {},
                  h("span", { "aria-hidden": "true" }, icon(CHECK)),
                  `${duration(goal)} or more asleep in the night: your goal`,
                ),
            judged.length > 0
              ? h(
                  "li",
                  {},
                  h("span", { "aria-hidden": "true" }, "◷"),
                  `On schedule: within ${ON_SCHEDULE_MIN}${NBSP}min of your bedtime and wake-up`,
                )
              : null,
          ),
    ),
  );
}

// The calendar's metric, kept per device.
const CHECK_IN_KEY = "checkin-metric";

// The period's check-ins: a tile per scale (its mean, its
// highest and lowest under it) and the count; a quiet switch between the
// scales that have data (the pick kept per device, or the first with
// data) with its calendar, each day shaded and numbered by its value
// (stress the other way round: a calm day is the dark one), a day without
// a check-in hatched, its legend under it; and the tags as chips under
// their heading, most used first. Without a check-in, the heading and
// where they come from.
function checkInSection(p, list) {
  if (list.length === 0)
    return emptySection(
      "check-ins",
      "Check-ins",
      "Log a check-in from the Diary's Log card.",
    );
  const rated = CHECK_IN_SCALES.map(([key, label]) => [
    key,
    label,
    checkInStats(list, key),
  ]).filter(([, , st]) => st);
  const kept = localStorage.getItem(CHECK_IN_KEY);
  let metric = (rated.find(([key]) => key === kept) ?? rated[0])?.[0];
  const byDay = new Map(list.map((c) => [c.day, c]));
  const shown = h("div", { class: "check-in-metric" });
  const show = () => {
    const [, label] = rated.find(([key]) => key === metric);
    const said = lower(label);
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
          // A check-in made is today's.
          final: (day) => byDay.has(day),
          marks: () => null,
          label: (day) =>
            `${pretty(day)}: ${
              isNil(value(day))
                ? byDay.has(day)
                  ? `no ${said}`
                  : "nothing logged"
                : `${said} ${value(day)}`
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
            "Nothing logged",
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
    );
  };
  if (metric) show();
  const tags = tagCounts(list);
  return h(
    "section",
    { class: "finder-section check-ins" },
    h("h2", {}, "Check-ins"),
    tiles("Check-ins", [
      ...rated.map(([key, label, st]) => ({
        // "3.6": a mean to a tenth, always with one.
        value: fmtFixed(st.mean, 1),
        short: [
          `average ${key}`,
          h(
            "span",
            { class: "tile-sub" },
            st.lowest.value === st.highest.value
              ? `always ${st.highest.value}`
              : `highest ${st.highest.value} · lowest ${st.lowest.value}`,
          ),
        ],
        long: `Your average ${lower(label)} rating, 1 to 5, over the check-ins that rated it; under it the highest and lowest.`,
      })),
      {
        value: fmt(list.length),
        short: noun(list.length, "check-in"),
        long: "Days you checked in.",
      },
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
    tags.length > 0
      ? [
          h("h3", {}, "Tags"),
          h(
            "ul",
            { class: "tag-counts", "aria-label": "Tags" },
            tags.map(([tag, n]) => h("li", {}, `${tag} ${fmt(n)}`)),
          ),
        ]
      : null,
  );
}

// The period's day notes, each linking to its day.
function noteSummary(notes) {
  if (notes.length === 0)
    return emptySection(
      "notes",
      "Notes",
      "Write a note from the Diary's Log card.",
    );
  return h(
    "section",
    { class: "finder-section notes" },
    h("h2", {}, "Notes"),
    kvList(
      notes.map((n) => [
        h("a", { href: href.day(n.day) }, pretty(n.day)),
        h("span", { class: "note-text" }, n.text),
      ]),
      { cls: "notes" },
    ),
  );
}
