// Summary → Food: one chart, its tabs energy (eaten against burned and the
// target) and each macro, the period's daily averages as the Diary's
// nutrient card, a calendar of the days against a key target, and the
// energy balance: what was eaten, burned and the gap a day, burned in its
// parts.

import { currentProfile, get, scoped } from "../api.mjs";
import { bar, nutrientCard } from "../bars.mjs";
import { calendarView } from "../calendar.mjs";
import { cellAmount, quartiles } from "../calendar-grid.mjs";
import { touching } from "../correlate.mjs";
import { coverage } from "../coverage.mjs";
import { daysIn, pretty, shift, tileThrough, today } from "../dates.mjs";
import {
  BURNED_FROM,
  maintenanceFrom,
  maintenanceText,
} from "../energy-text.mjs";
import { shade, standing, tally, verdictWords } from "../food-calendar.mjs";
import { fmt, isNil, lower, NBSP, noun, plural, whole } from "../format.mjs";
import { compare, periodWords, prepare, seriesOf } from "../insights.mjs";
import { href } from "../nav.mjs";
import { goodSourceMin, nutrientWarnings } from "../nutrient-warnings.mjs";
import {
  carbsFloor,
  dailyMean,
  fmtUnit,
  foodDay,
  kcal,
  kcalParts,
  KEY_TARGETS,
  KNOWN,
  nutrient,
} from "../nutrients.mjs";
import {
  appOf,
  bucketOf,
  energyPartly,
  energySeries,
  estimateKcal,
  gapOf,
  gapText,
  macroSeries,
  maintenance as maintenanceOver,
  periodNumbers,
} from "../series.mjs";
import { choice, fill, h } from "../ui.mjs";
import { tiles } from "../tiles.mjs";
import { seriesChart } from "./summary-charts.mjs";
import { highlightStack } from "./summary-highlights.mjs";

export const KEY = "food";
export const LABEL = "Food";

// ", and your target dashed" when series `s` draws its target as a line,
// ", and your target range shaded" as a field (an "about" target's min to
// max), nothing without one.
const dashed = (s, what) => {
  const target = s.marks.filter((m) => m.target);
  if (target.length === 0) return "";
  return target.some((m) => m.kind === "line")
    ? `, and your ${what} dashed`
    : `, and your ${what} range shaded`;
};

// The period's chart, its days by the period's buckets (a week's and a
// month's by day, a year's by week), one card showing the key target the
// page's one switch picks: Energy (what was eaten on the food days and
// what each day burned, each its points and trend) or a macro (its grams
// a food day), and the target dashed in what it is a target for:
// eaten's colour, the macro's.
// `burned` [{day, kcal}] (web/series.mjs). {node, show(key)}.
function foodCharts(p, days, targets, burned) {
  const by = bucketOf(p.kind);
  const each = by === "day" ? "each day's" : "each week's mean";
  const chartOf = (key) => {
    const n = nutrient(key);
    if (key === "energy") {
      const s = energySeries({
        days,
        burned,
        target: targets.energy,
        by,
        show: n.show,
        say: kcal,
      });
      return {
        s,
        label: `Energy by ${by}, ${n.unit}: what you ate and an estimate of what you burned, ${each}, faint, and each one's trend${dashed(s, "eaten target")}. The list below has the numbers.`,
        colors: {
          eaten: ["--energy"],
          burned: ["--fg"],
          target: ["--energy"],
        },
      };
    }
    const s = macroSeries({
      days,
      key,
      label: n.short,
      target: targets[key],
      by,
      say: (v) => fmtUnit(key, v),
    });
    const c = `--${key === "net_carbs" ? "carbs" : key}`;
    return {
      s,
      label: `${n.short} by ${by}, ${n.unit}: ${each}, faint, and the trend${dashed(s, "target")}. The list below has the numbers.`,
      colors: { [key]: [c], target: [c] },
    };
  };
  const node = h("section", { class: "chart-section" });
  const show = (key) => {
    const n = nutrient(key);
    const { s, label, colors } = chartOf(key);
    const [head, card, list] = seriesChart({
      p,
      by,
      heading: `${n.short} by ${by}`,
      label,
      ...s,
      unit: n.unit,
      colors,
    });
    fill(node, head, card, list);
  };
  return { node, show };
}

// The period's food and the period before's (for the Highlights), read
// from the shared rows (web/series.mjs: one union fetch), maintenance at
// the period's last day over (the balance's note), and the nutrient
// warnings, which start as soon as the period's food is in.
export async function load(p, sharing) {
  const shared = await sharing;
  const summarised = (from, to) =>
    shared.rows("days", from, to).then((days) => ({ days }));
  const data = await summarised(p.from, p.to);
  const [before, warnings, maintenance] = await Promise.all([
    summarised(p.before.from, p.before.to),
    foodWarnings(p, data, shared.targets),
    maintenanceOver({ from: p.through, to: p.through }, shared),
  ]);
  return { data, before, warnings, maintenance: maintenance.at(-1) ?? null };
}

// The warnings shown at most: those that may reach the Highlights.
const WARNINGS_SOURCED = 3;

// The period's nutrient warnings and tips (web/nutrient-warnings.mjs)
// through `p.through`, the strongest few with foods named: a high nutrient's
// top sources in the period, a low one's good sources (eaten before
// first, `/foods/rich`).
async function foodWarnings(p, all, targets) {
  const data = through(all, p.through);
  const input = {
    days: data.days,
    elapsed: daysIn(p.from, p.through),
    targets,
    through: p.through,
    period: periodWords(p),
    latitude: currentProfile()?.latitude ?? null,
  };
  const first = nutrientWarnings(input);
  const named = first
    .filter((w) => w.tone === "warning")
    .toSorted((a, b) => b.margin - a.margin)
    .slice(0, WARNINGS_SOURCED);
  if (named.length === 0) return first;
  const found = await Promise.all(
    named.map(({ id }) => {
      const [kind, key] = id.split(":");
      return kind === "high"
        ? get(
            scoped(
              `/summary/foods?from=${p.from}&to=${p.through}&nutrient=${key}`,
            ),
          ).then((r) => [key, r.foods.map((f) => f.name)])
        : get(
            scoped(
              `/foods/rich?nutrient=${key}&min=${goodSourceMin(key, targets)}`,
            ),
          ).then((r) => [key, r.map((f) => f.name)]);
    }),
  );
  return nutrientWarnings({ ...input, sources: Object.fromEntries(found) });
}

// `/summary`'s food days through `end` and their mean of each key
// (dailyMean: the warnings' too): a water-only day is no food day.
function through(data, end) {
  const days = data.days.filter((d) => d.day <= end && foodDay(d));
  const keys = new Set(days.flatMap((d) => Object.keys(d.total)));
  const average = carbsFloor(
    Object.fromEntries([...keys].map((k) => [k, dailyMean(days, k)])),
  );
  return { average, days };
}

// Whether food day `d`'s total of `key` leaves some out (a floor, "≥"):
// energy by the day's one rule (energyPartly), any key by its coverage.
const partlyOf = (d, key) =>
  (key === "energy" && energyPartly(d)) || coverage([d], key) < 1;

// Food days as web/insights.mjs reads them: each key target a series over
// the food days, with the days that are floors (`partly`).
const foodSeries = (days) => {
  const eaten = days.filter((x) => foodDay(x));
  return Object.fromEntries(
    calendarMetrics().map(([key, label]) => [
      key,
      {
        ...seriesOf(eaten, (d) => d.total[key] ?? 0),
        label,
        partly: new Set(
          eaten.filter((d) => partlyOf(d, key)).map((d) => d.day),
        ),
      },
    ]),
  );
};

// What the Highlights and the calendar's tiles read: the period's food,
// the shared series (steps, sleep, check-ins), the period before, the
// targets. Today is still being logged, so the window ends yesterday.
const insightsContext = (p, data, before, shared, warnings) => ({
  kind: p.kind,
  from: p.from,
  to: p.to,
  last: shift(today(), -1),
  before: p.before,
  series: { ...foodSeries(data.days), ...shared.series },
  prev: foodSeries(before.days),
  targets: shared.targets,
  // How each food series' value reads: energy in this device's unit, the
  // rest in their nutrient's.
  say: Object.fromEntries(
    calendarMetrics().map(([key]) => [
      key,
      key === "energy" ? kcal : (v) => fmtUnit(key, v),
    ]),
  ),
  warnings,
  correlations: touching(shared.correlations, KEY),
});

export function render(
  p,
  { data: all, before, warnings, maintenance },
  shared,
) {
  // The averages' days: through yesterday in a running period.
  const sourcesOf = (key) =>
    href.sources(key, p.from, p.through, href.summary(p.kind, p.day, p.tab));
  const data = through(all, p.through);
  const byMetric = shared.targets;
  // What each day of the period burned, through yesterday (web/series.mjs).
  const { days: burned, bmr } = shared.burned;
  const numbers = periodNumbers({ days: data.days, burned, bmr });
  const ctx = insightsContext(p, all, before, shared, warnings);
  // The picked metric's comparison is its calendar tile, not a Highlight.
  const slot = highlightStack(KEY, ctx, p, shared);
  const eaten = all.days.some(foodDay);
  // One switch picks the key target the chart, the calendar and its
  // tiles, and the Highlights' comparison all show; kept on this device.
  const charts =
    data.days.length > 0 ? foodCharts(p, data.days, byMetric, burned) : null;
  const calendar = eaten ? foodCalendar(p, all.days, byMetric, ctx) : null;
  const pick = (key) => {
    charts?.show(key);
    calendar?.paint(key);
    slot.paint([`change:${key}`]);
  };
  pick(picked());
  return [
    slot,
    charts || calendar
      ? choice({
          name: METRIC_KEY,
          label: "Chart and calendar",
          look: "switch",
          options: calendarMetrics(),
          value: picked(),
          onChange: (k) => {
            localStorage.setItem(METRIC_KEY, k);
            pick(k);
          },
        })
      : null,
    charts?.node,
    data.days.length > 0
      ? dailyAverages(p, data, byMetric, sourcesOf)
      : h(
          "p",
          { class: "muted food-nothing" },
          p.through < p.to
            ? "Nothing logged through yesterday."
            : "Nothing logged in this period.",
        ),
    calendar?.node,
    energyBalance(numbers, maintenance),
  ];
}

// "Daily averages" (through yesterday in a running period): the
// Diary's nutrient card with each nutrient's mean a food day (bar()'s
// average: one verdict path; "≥" where foods without it made up some of
// the food, energy's where a day's leaves some out, "–" when none carried
// it), each opening where it came from.
function dailyAverages(p, data, byMetric, sourcesOf) {
  const carried = (key) => data.days.some((d) => !isNil(d.total[key]));
  const barOf = (key, compact) => {
    const m = carried(key) ? (data.average[key] ?? 0) : null;
    return bar(key, byMetric[key], m, m, {
      average: true,
      compact,
      href: m ? sourcesOf(key) : null,
      share: coverage(data.days, key),
      // A mean over a day whose energy leaves some out is a floor, by the
      // day's one rule (energyPartly: the Diary's and the balance line's).
      lower: key === "energy" ? data.days.some(energyPartly) : null,
    });
  };
  return h(
    "div",
    { class: "stack daily-averages" },
    nutrientCard(barOf, {
      headline: h(
        "h2",
        {},
        `Daily averages${p.through < p.to ? " through yesterday" : ""}`,
      ),
      tracked: (key) => carried(key) || Boolean(byMetric[key]),
    }),
  );
}

// Burned and maintenance this far apart (a share of maintenance) are
// both named.
const APART = 0.15;

// A number of kcal (or kJ) without its unit.
const v = (x) => kcalParts(x).value;

// "Energy balance" over the period's food days with a burned estimate
// (`numbers`, periodNumbers'). Its line leads with the gap a day against
// what most says what keeps your weight: a `maintenance` (at the period's
// end) measured from the weight trend when there is one ("Eaten
// 1,874 · Maintenance ≈ 2,100 · Deficit ≈ 230 kcal a day, from your
// weight trend"), the energy model's burned then second, named, with its
// own gap; else burned's ("Eaten 1,297 · Burned ≈ 2,520 · Deficit ≈ 1,220
// kcal a day", web/series.mjs gapText), and where burned and maintenance
// are more than APART apart, a line naming both. "Eaten ≥ …" and a bound
// when a day's energy leaves some out. Estimates to 10 kcal or 50 kJ.
// Burned in its parts. Without such a day, nothing (no heading on
// its own).
function energyBalance(numbers, maintenance) {
  const n = numbers;
  if (!n) return null;
  // Each part whole: a phone's line wraps between parts only.
  const eaten = whole(`Eaten ${n.partly ? "≥ " : ""}${v(n.eaten)}`);
  const burned = `≈ ${kcal(estimateKcal(n.burned))} a day`;
  const measured = maintenance?.source === "balance";
  const gap = measured ? gapOf(n.eaten - maintenance.kcal, n.partly) : n;
  return h(
    "section",
    { class: "finder-section energy-balance" },
    h("h2", {}, "Energy balance"),
    h(
      "p",
      { class: `balance-line balance-${gap.word}` },
      measured
        ? `${eaten} · ${whole(`Maintenance ≈ ${v(estimateKcal(maintenance.kcal))}`)} · ${gapText(gap)}, ${whole("from your weight trend")}`
        : `${eaten} · ${whole(`Burned ≈ ${v(estimateKcal(n.burned))}`)} · ${gapText(n)}`,
    ),
    tiles(`Energy balance over ${plural(n.n, "food-logged day")}`, [
      {
        value: `≈ ${kcal(n.resting)}`,
        short: "resting (BMR) a day",
        long: `What your body burns at complete rest (BMR, basal metabolic rate), a day: ${restingWords(n)}.`,
      },
      {
        value: `≈ ${kcal(n.tef)}`,
        short: "digesting (TEF) a day",
        long: "Energy spent digesting what you ate (TEF, thermic effect of food): about a tenth of it.",
      },
      {
        value: `≈ ${kcal(n.everyday)}`,
        short: "everyday movement a day",
        long: "Ordinary moving about, not workouts: estimated as a tenth of your resting energy, every day.",
      },
      {
        value: `≈ ${kcal(n.active)}`,
        short: "more active a day",
        long: "Movement beyond everyday: your device's active energy or your activities, whichever is larger, less everyday movement.",
      },
    ]),
    measured
      ? h(
          "p",
          { class: "muted energy-sources" },
          `Burned by the energy model ${burned} (from ${BURNED_FROM[n.source]}): ${lower(gapText(n))}.`,
        )
      : maintenance &&
          Math.abs(n.burned - maintenance.kcal) > APART * maintenance.kcal
        ? h(
            "p",
            { class: "muted energy-sources" },
            `Burned ${burned} (from ${BURNED_FROM[n.source]}) against maintenance of ${maintenanceText(maintenance)} (from ${maintenanceFrom(maintenance)}).`,
          )
        : null,
  );
}

// Where the balance's resting energy came from (periodNumbers'
// `restingFrom`): Health Connect's app on every day, on some ("Health
// Connect on 20 of 30 days, else Mifflin–St Jeor"), or none (by
// Mifflin–St Jeor from your weight, height, age and sex).
function restingWords(n) {
  const { health_connect: hc, origin } = n.restingFrom;
  if (!hc) return "by Mifflin–St Jeor, from your weight, height, age and sex";
  return hc === n.n
    ? `from Health Connect (${appOf(origin)})`
    : `from Health Connect on ${hc} of ${plural(n.n, "day")}, else Mifflin–St Jeor`;
}

// The chart's and calendar's metrics: the key targets, as the switch
// names them; the pick kept on this device.
const calendarMetrics = () => KEY_TARGETS.map((k) => [k, nutrient(k).short]);
const METRIC_KEY = "food-metric";
const picked = () => {
  const saved = localStorage.getItem(METRIC_KEY);
  return calendarMetrics().some(([k]) => k === saved) ? saved : "energy";
};

// "+6 %", "−12 %", "±0 %".
const signedPct = (change) => {
  const r = Math.round(change * 100);
  return `${r > 0 ? "+" : r < 0 ? "−" : "±"}${Math.abs(r)}${NBSP}%`;
};

// A legend row: a cell's look and its words.
const swatch = (cls, words) =>
  h(
    "li",
    {},
    h("span", { class: `cal-cell ${cls}`, "aria-hidden": "true" }),
    words,
  );

// Each day of the period against the picked key target (Energy · Protein ·
// Carbs · Fat): its tiles (the food days through yesterday, as the
// Highlights count them), its amount, shaded on target, under (lighter the
// further) or over (outlined); without a target, by amount. {node,
// paint(key)}: a new pick re-paints in place.
function foodCalendar(p, days, byMetric, ctx) {
  const end = tileThrough(p.from, p.to, ctx.last);
  // A water-only day is no food day: nothing logged here.
  const eaten = days.filter((x) => foodDay(x));
  const counted = eaten.filter((d) => d.day <= end);
  // Today's still being logged: its amount shows, unjudged.
  const done = (day) => day <= end;
  const prepared = prepare(ctx);
  const node = h("section", { class: "finder-section food-calendar stack" });
  const paint = (key) => {
    const n = nutrient(key);
    const target = byMetric[key];
    const judged = !isNil(target?.value);
    const amounts = new Map(eaten.map((d) => [d.day, d.total[key] ?? 0]));
    // A day leaving some of `key` out is a floor, "≥" as the Diary's
    // (partlyOf), judged only as far as it proves.
    const byDay = new Map(eaten.map((d) => [d.day, d]));
    const partly = new Set(
      eaten.filter((d) => partlyOf(d, key)).map((d) => d.day),
    );
    const atLeast = (day) => (partly.has(day) ? `≥${NBSP}` : "");
    const bounds = quartiles(counted.map((d) => d.total[key] ?? 0));
    const of = (day) => amounts.get(day) ?? 0;
    const t = tally(
      counted.map((d) => d.total[key] ?? 0),
      target,
      counted.map((d) => partly.has(d.day)),
    );
    // The period's mean and total are floors when any day is.
    const floorOf = t.partly ? `≥${NBSP}` : "";
    const change = compare(prepared, key);
    const series = {
      amount: (day) =>
        amounts.has(day) ? `${atLeast(day)}${cellAmount(n.show(of(day)))}` : "",
      step: (day) =>
        amounts.has(day) && done(day)
          ? shade(of(day), target, bounds, partly.has(day))
          : 0,
      unlogged: (day) => !amounts.has(day),
      over: (day) =>
        amounts.has(day) &&
        done(day) &&
        standing(of(day), target, partly.has(day)) === "over",
      marks: () => null,
      // "Tue, Oct 6: 2,140 kcal, on target", "…: 1,760 kcal, 380 kcal
      // under", "…: ≥ 1,848 kcal, at most 52 kcal under", "…: 2,500
      // kcal, over", "…: nothing logged", today's "…: ≥ 667 kcal so far".
      label: (day) => {
        if (!amounts.has(day)) return `${pretty(day)}: nothing logged`;
        const amount = of(day);
        const shown = `${atLeast(day)}${fmtUnit(key, amount)}`;
        if (!done(day)) return `${pretty(day)}: ${shown} so far`;
        const verdict = verdictWords(amount, target, {
          floor: partly.has(day),
          known: coverage([byDay.get(day)], key) >= KNOWN,
          say: (x) => fmtUnit(key, x),
        });
        return `${pretty(day)}: ${shown}${verdict}`;
      },
    };
    const what = lower(n.label);
    const floorWords = t.partly
      ? ` At least: some food logged without ${what}.`
      : "";
    const vs = change && {
      value: signedPct(change.change),
      short: `vs ${prepared.noun}`,
      long: `Your ${what} a day this period against ${prepared.noun}, food-logged days only.`,
    };
    const stats = judged
      ? [
          {
            value: `${fmt(t.on)} of ${fmt(t.days)}`,
            short: "days on target",
            long: `Days whose ${what} landed in your target, of the days with food logged.`,
          },
          isNil(target.max)
            ? null
            : {
                value: fmt(t.over),
                short: noun(t.over, "day over", "days over"),
                long: `Days whose ${what} went over your target's upper limit.`,
              },
          vs,
        ]
      : [
          {
            value: fmt(t.days),
            short: noun(t.days, "logged day"),
            long: "Days with food logged.",
          },
          {
            value: `${floorOf}${fmtUnit(key, t.total)}`,
            short: "in total",
            long: `All the ${what} you logged this period, added up.${floorWords}`,
          },
          vs,
        ];
    fill(
      node,
      tiles(n.short, stats),
      calendarView({
        kind: p.kind,
        from: p.from,
        // Not the chart's heading again.
        caption: `${n.short}: days ${judged ? "against the target" : "by amount"}`,
        series,
        monthLink: (month) => href.summary("month", `${month}-01`, KEY),
        className: "food-cal",
      }),
      h(
        "div",
        { class: "cal-legend muted" },
        h(
          "ul",
          { "aria-label": "Shades" },
          judged
            ? [
                swatch("shade-4", "on target"),
                swatch("shade-3", `under, ≥ 75${NBSP}%`),
                swatch("shade-2", `≥ 50${NBSP}%`),
                swatch("shade-1", "less"),
              ]
            : ["0", "less", "", "", "most this period"].map((w, i) =>
                swatch(`shade-${i}`, w),
              ),
        ),
        h(
          "ul",
          { "aria-label": "Marks" },
          swatch("none", "Nothing logged"),
          judged && !isNil(target.max) ? swatch("shade-0 over", "over") : null,
        ),
        judged ? null : h("p", {}, "No target: shaded by amount"),
      ),
    );
  };
  return { node, paint };
}
