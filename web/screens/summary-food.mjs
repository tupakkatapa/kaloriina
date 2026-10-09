// Summary → Food: averages of eaten food against targets, where each
// nutrient came from, a calendar of the days against a key target, energy
// and macros by bucket, and the energy balance behind an adaptive energy
// target.

import { api, currentProfile, get, loadProfiles, scoped } from "../api.mjs";
import { calendarView } from "../calendar.mjs";
import { quartiles } from "../calendar-grid.mjs";
import { pretty, shift, today } from "../dates.mjs";
import {
  MIN_FOOD_DAYS,
  MIN_WEIGH_SPAN,
  balance,
  balanceText,
  balanceRange,
  withEnergy,
} from "../energy.mjs";
import { judge, shade, tally } from "../food-calendar.mjs";
import { compare, highlights, prepare, tileThrough } from "../insights.mjs";
import { href, route } from "../nav.mjs";
import {
  KCAL_PER_G,
  KEY_TARGETS,
  byCategory,
  fmt,
  fmtUnit,
  isNil,
  kcal,
  nutrient,
  ordered,
  noun,
  plural,
  qty,
  rangeOf,
} from "../nutrients.mjs";
import {
  busy,
  categoryRow,
  choice,
  confirmDialog,
  fill,
  h,
  highlightList,
  notify,
  tiles,
} from "../ui.mjs";
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

export const KEY = "food";
export const LABEL = "Food";

// A bucket's mean per logged day.
const avg = (b, n = "energy") => b[n] / b.days;

// A dashed line across the plot at `value`.
const targetLine = (value, color) => ({
  id: "target",
  afterDatasetsDraw(c) {
    const y = c.scales.y.getPixelForValue(value);
    const { left, right } = c.chartArea;
    const g = c.ctx;
    g.save();
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.setLineDash([6, 4]);
    g.beginPath();
    g.moveTo(left, y);
    g.lineTo(right, y);
    g.stroke();
    g.restore();
  },
});

// Average energy and macros per logged day in each bucket of the period
// (its days, weeks or months, as picked): line charts, then the numbers as
// a list linking to the finer view. A new pick re-draws the section.
function energyBreakdown(p, days, target) {
  const node = h("section", { class: "energy-breakdown" });
  const pick = chartByPicker(p.kind, (by) => paint(by));
  const energyHead = h("h2");
  const macrosHead = h("h2");
  const energyBox = h("div", { class: "chart-box" });
  const macrosBox = h("div", { class: "chart-box" });
  const list = h("ul", { class: "days" });
  const card = (head, name, box) =>
    h(
      "div",
      { class: "stack" },
      chartHead(head, pick(name)),
      h("div", { class: "chart-card card" }, box),
    );
  fill(
    node,
    h(
      "div",
      { class: "split" },
      card(energyHead, "Energy", energyBox),
      card(macrosHead, "Macros", macrosBox),
    ),
    list,
  );
  // In this device's energy unit (kcal or kJ), as the list below.
  const e = nutrient("energy");
  const goal = target?.value && e.show(target.value);
  const paint = (by) => {
    const k = BY[by];
    const buckets = new Map(
      [...bucketed(by, days)].map(([key, rows]) => [
        key,
        {
          days: rows.length,
          ...Object.fromEntries(
            KEY_TARGETS.map((n) => [
              n,
              rows.reduce((sum, d) => sum + (d.total[n] ?? 0), 0),
            ]),
          ),
        },
      ]),
    );
    const labels = [...buckets.keys()].map((key) => k.short(key, p.kind));
    const links = [...buckets.keys()].map((key) => k.link(key, p.tab));
    const values = [...buckets.values()];
    energyHead.textContent = `Energy by ${by}`;
    macrosHead.textContent = `Macros by ${by}`;
    const energy = h("canvas", {
      role: "img",
      "aria-label": `Energy by ${by}: average ${e.unit} per logged day${goal ? `, target ${fmt(goal)} ${e.unit}` : ""}. The list below has the numbers.`,
    });
    const macros = h("canvas", {
      role: "img",
      "aria-label": `Macros by ${by}: average ${e.unit} from protein, carbohydrate and fat.`,
    });
    fill(energyBox, energy);
    fill(macrosBox, macros);
    fill(
      list,
      [...buckets].map(([key, b], i) =>
        h(
          "li",
          {},
          h("a", { href: links[i] }, k.label(key)),
          h(
            "span",
            {},
            kcal(b.energy / b.days),
            by === "day"
              ? null
              : h(
                  "span",
                  { class: "muted" },
                  ` · avg of ${plural(b.days, "day")}`,
                ),
          ),
        ),
      ),
    );
    drawCharts(() => {
      const css = getComputedStyle(document.documentElement);
      const color = (name) => css.getPropertyValue(name).trim();
      const over = (b) => !isNil(target?.max) && avg(b) > target.max;
      const line = (label, data, c) => ({
        label,
        data,
        borderColor: color(c),
        backgroundColor: color(c),
        borderWidth: 2,
        pointRadius: 3,
      });
      chart(energy, {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              ...line(
                `Energy (${e.unit})`,
                values.map((b) => Math.round(e.show(avg(b)))),
                "--energy",
              ),
              // Days, weeks or months over the target's max show red.
              pointBackgroundColor: values.map((b) =>
                color(over(b) ? "--danger" : "--energy"),
              ),
              pointBorderColor: values.map((b) =>
                color(over(b) ? "--danger" : "--energy"),
              ),
            },
            // In the legend only: the line itself is drawn across the
            // whole plot (below), so even one point has its target.
            ...(goal
              ? [
                  {
                    label: "Target",
                    data: [],
                    borderColor: color("--muted"),
                    borderDash: [6, 4],
                    borderWidth: 2,
                    pointRadius: 0,
                  },
                ]
              : []),
          ],
        },
        // From zero, so day-to-day noise isn't magnified, and with room for
        // the target even when every point is under it.
        options: {
          ...pointLinks(links),
          scales: {
            y: { beginAtZero: true, suggestedMax: goal && goal * 1.1 },
          },
        },
        plugins: goal ? [targetLine(goal, color("--muted"))] : [],
      });
      chart(macros, {
        type: "line",
        data: {
          labels,
          datasets: [
            ["protein", "Protein", "--protein"],
            ["net_carbs", "Carbohydrate", "--carbs"],
            ["fat", "Fat", "--fat"],
          ].map(([n, label, c]) =>
            line(
              `${label} (${e.unit})`,
              values.map((b) => Math.round(e.show(avg(b, n) * KCAL_PER_G[n]))),
              c,
            ),
          ),
        },
        options: { ...pointLinks(links), scales: { y: { beginAtZero: true } } },
      });
    });
  };
  paint(chartBy(p.kind));
  return node;
}

// The period's food (`/summary`), the 4 weeks before today the energy
// balance reads, and the period before for the Highlights; the targets and
// Health Connect come shared (web/series.mjs).
export async function load(p) {
  const b = balanceRange(shift(today(), -1));
  const [data, recent, recentWeights, before] = await Promise.all([
    get(scoped(`/summary?from=${p.from}&to=${p.to}`)),
    get(scoped(`/summary?from=${b.from}&to=${b.to}`)),
    get(scoped(`/weights?from=${b.from}&to=${b.to}`)),
    get(scoped(`/summary?from=${p.before.from}&to=${p.before.to}`)),
  ]);
  return { data, recent, recentWeights, before };
}

// `/summary`'s numbers through `end`: its logged days up to then and their
// mean, as the server takes it over the days that have any.
function through(data, end) {
  const days = data.days.filter((d) => d.day <= end);
  const average = {};
  for (const d of days)
    for (const [k, v] of Object.entries(d.total))
      average[k] = (average[k] ?? 0) + v / days.length;
  return { days_logged: days.length, average, days };
}

// Food days as web/insights.mjs reads them: each key target a series over
// the days with energy eaten (a water-only day is no food day).
const foodSeries = (days) => {
  const eaten = days.filter((d) => (d.total.energy ?? 0) > 0);
  return Object.fromEntries(
    METRICS.map(([key, label]) => [
      key,
      {
        values: new Map(eaten.map((d) => [d.day, d.total[key] ?? 0])),
        samples: eaten.map((d) => d.day),
        label,
      },
    ]),
  );
};

// What the Highlights and the calendar's tiles read: the period's food,
// the shared series (steps, sleep, check-ins), the period before, the
// targets. Today is still being logged, so the window ends yesterday.
const insightsContext = (p, data, before, shared) => ({
  kind: p.kind,
  from: p.from,
  to: p.to,
  last: shift(today(), -1),
  before: p.before,
  series: { ...foodSeries(data.days), ...shared.series },
  prev: foodSeries(before.days),
  targets: shared.targets,
  say: { energy: kcal },
});

export function render(
  p,
  { data: all, recent, recentWeights, before },
  shared,
) {
  const sourcesOf = (key) =>
    href.sources(key, p.from, p.to, href.summary(p.kind, p.day, p.tab));
  const data = through(all, p.end);
  const byMetric = shared.targets;
  const known = ordered().filter(
    (n) => data.average[n.key] !== undefined || byMetric[n.key],
  );
  const primary = KEY_TARGETS.map(nutrient);
  const rest = known.filter((n) => !KEY_TARGETS.includes(n.key));
  const pct = (n) => {
    const t = byMetric[n.key];
    const goal = t?.value;
    if (!goal) return "";
    const mean = data.average[n.key] ?? 0;
    const over = !isNil(t.max) && mean > t.max;
    const share = (mean / goal) * 100;
    return h("span", { class: over ? "over" : null }, `${fmt(share)} %`);
  };
  const row = (n) =>
    h(
      "tr",
      {},
      h(
        "th",
        { scope: "row" },
        data.average[n.key]
          ? h("a", { href: sourcesOf(n.key) }, n.label)
          : n.label,
      ),
      h("td", {}, fmtUnit(n.key, data.average[n.key] ?? 0)),
      // The number alone: the per-day cell beside it carries the unit, so
      // four columns fit one line at 320 px.
      h(
        "td",
        { class: "range" },
        byMetric[n.key] ? rangeOf(n.key, byMetric[n.key]) : "",
      ),
      h("td", {}, pct(n)),
    );
  const ctx = insightsContext(p, all, before, shared);
  // The picked metric's comparison is its calendar tile, not a Highlight.
  const slot = h("div", { class: "insights" });
  const showHighlights = (metric) => {
    const list = highlightList(
      highlights("food", ctx, { omit: [`change:${metric}`] }),
    );
    fill(slot, list);
    slot.hidden = !list;
  };
  showHighlights(pickedMetric());
  return [
    slot,
    h(
      "p",
      { class: "muted" },
      `${plural(data.days_logged, "day")} logged${p.end < p.to ? " through yesterday" : ""}`,
    ),
    data.days_logged
      ? [
          h(
            "table",
            { class: "grid" },
            h(
              "thead",
              {},
              h(
                "tr",
                {},
                h("th", {}, "Nutrient"),
                h("th", {}, "Per day"),
                h("th", {}, "Target"),
                h("th", {}, "%"),
              ),
            ),
            h("tbody", {}, primary.map(row)),
          ),
          rest.length
            ? h(
                "details",
                { class: "fold" },
                h("summary", {}, "Other nutrients"),
                h(
                  "table",
                  { class: "grid" },
                  h(
                    "tbody",
                    {},
                    byCategory(rest).map(([name, list]) => [
                      categoryRow(name, 4),
                      list.map(row),
                    ]),
                  ),
                ),
              )
            : null,
        ]
      : h(
          "p",
          { class: "muted" },
          p.end < p.to
            ? "Nothing logged through yesterday."
            : "Nothing logged in this period.",
        ),
    all.days_logged
      ? foodCalendar(p, all.days, byMetric, ctx, showHighlights)
      : null,
    data.days_logged ? energyBreakdown(p, data.days, byMetric.energy) : null,
    energyBalance(recent.days, recentWeights, byMetric.energy),
  ];
}

// "Energy balance (last 4 weeks)": what you ate against how your weight
// moved, and the energy target that meets your goal, set with a confirm and
// undone from the toast.
function energyBalance(days, weights, current) {
  const b = balance({
    days,
    weights,
    yesterday: shift(today(), -1),
    goal: currentProfile()?.goal_kg_per_week ?? 0,
    current: current?.value ?? null,
  });
  return h(
    "section",
    { class: "finder-section energy-balance" },
    h("h2", {}, "Energy balance (last 4 weeks)"),
    b.enough
      ? [
          h("p", {}, balanceText(b)),
          b.offer
            ? h(
                "button",
                {
                  type: "button",
                  onclick: busy(() => setEnergyTarget(b.target)),
                },
                `Energy target → ${kcal(b.target)}`,
              )
            : null,
        ]
      : h(
          "p",
          { class: "muted" },
          `Not enough data yet: needs ${MIN_FOOD_DAYS} days with food logged and two weigh-ins ${MIN_WEIGH_SPAN} or more days apart. So far: ${plural(b.foodDays, "day")} with food; weigh-ins span ${plural(b.span, "day")}.`,
        ),
  );
}

// A target's value in `list`.
const valueOf = (list, key) => list.find((t) => t.metric === key)?.value;

// The targets as a PUT takes them: the profile's own (a registry default
// stays one, not a row).
const targetInput = (list) =>
  list
    .filter((t) => !t.default)
    .map(({ metric, value }) => ({ metric, value }));

// PUT `targets` made from profile revision `rev` (409 `stale` if it moved
// on since), then re-read the profile for the next change.
async function putTargets(rev, targets) {
  await api("PUT", scoped("/targets"), { rev, targets });
  await loadProfiles();
}

async function setEnergyTarget(energy) {
  // The rev first: targets changed after it make the PUT stale, never lost.
  await loadProfiles();
  const rev = currentProfile().rev;
  const before = targetInput(await get(scoped("/targets")));
  const after = withEnergy(before, energy);
  const [p, c, f] = ["protein", "net_carbs", "fat"].map((k) =>
    valueOf(after, k),
  );
  const ok = await confirmDialog(`Set energy target to ${kcal(energy)}?`, {
    detail: [
      isNil(p) || isNil(c) || isNil(f)
        ? null
        : `Protein stays ${qty(p, "g", 0)}; carbohydrate ${qty(c, "g", 0)} and fat ${qty(f, "g", 0)} scale with the energy.`,
      "Recalculate on Targets replaces this.",
    ]
      .filter(Boolean)
      .join(" "),
    confirm: "Set target",
    danger: false,
  });
  if (!ok) return;
  await putTargets(rev, after);
  const old = valueOf(before, "energy");
  notify(`Energy target ${isNil(old) ? "none" : kcal(old)} → ${kcal(energy)}`, {
    action: {
      label: "Undo",
      run: async () => {
        await loadProfiles();
        await putTargets(currentProfile().rev, before);
        route();
      },
    },
  });
  route();
}

// The calendar's metrics: the key targets, as the choice names them.
const METRICS = [
  ["energy", "Energy"],
  ["protein", "Protein"],
  ["net_carbs", "Carbohydrate"],
  ["fat", "Fat"],
];
const METRIC_KEY = "food-calendar-metric";
const pickedMetric = () => {
  const saved = localStorage.getItem(METRIC_KEY);
  return METRICS.some(([k]) => k === saved) ? saved : "energy";
};

// "+6 %", "−12 %", "±0 %".
const signedPct = (change) => {
  const r = Math.round(change * 100);
  return `${r > 0 ? "+" : r < 0 ? "−" : "±"}${Math.abs(r)} %`;
};

// A calendar cell's number, built once.
const UNGROUPED = new Intl.NumberFormat(undefined, { useGrouping: false });

// A legend row: a cell's look and its words.
const swatch = (cls, words) =>
  h(
    "li",
    {},
    h("span", { class: `cal-cell ${cls}`, "aria-hidden": "true" }),
    words,
  );

// Each day of the period against the picked key target (Energy · Protein ·
// Carbohydrate · Fat, kept on this device): its tiles (the food days
// through yesterday, as the Highlights count them), its amount, shaded on
// target, under (lighter the further) or over (outlined); without a
// target, by amount. A new pick re-paints in place and tells `onPick`.
function foodCalendar(p, days, byMetric, ctx, onPick) {
  let key = pickedMetric();
  const end = tileThrough(p.from, p.to, ctx.last);
  const counted = days.filter((d) => (d.total.energy ?? 0) > 0 && d.day <= end);
  const prepared = prepare(ctx);
  const node = h("section", { class: "finder-section food-calendar" });
  const body = h("div", { class: "stack" });
  const paint = () => {
    const n = nutrient(key);
    const target = byMetric[key];
    const judged = !isNil(target?.value);
    const amounts = new Map(days.map((d) => [d.day, d.total[key] ?? 0]));
    const bounds = quartiles([...amounts.values()]);
    const of = (day) => amounts.get(day) ?? 0;
    const t = tally(
      counted.map((d) => d.total[key] ?? 0),
      target,
    );
    const change = compare(prepared, key);
    const series = {
      // Ungrouped, so 5 digits fit a phone's cell; the label groups them.
      amount: (day) =>
        amounts.has(day) ? UNGROUPED.format(Math.round(n.show(of(day)))) : "",
      step: (day) => (amounts.has(day) ? shade(of(day), target, bounds) : 0),
      unlogged: (day) => !amounts.has(day),
      over: (day) => amounts.has(day) && judge(of(day), target) === "over",
      marks: () => null,
      // "Tue, Oct 6: 2,140 kcal, on target", "…: 1,760 kcal, 380 kcal
      // under", "…: 2,500 kcal, over", "…: nothing logged".
      label: (day) => {
        if (!amounts.has(day)) return `${pretty(day)}: nothing logged`;
        const amount = of(day);
        const verdict = {
          on: ", on target",
          over: ", over",
          under: `, ${fmtUnit(key, target?.min - amount)} under`,
        }[judge(amount, target)];
        return `${pretty(day)}: ${fmtUnit(key, amount)}${verdict ?? ""}`;
      },
    };
    const vs = change && [signedPct(change.change), `vs ${prepared.noun}`];
    const stats = judged
      ? [
          [`${fmt(t.on)} of ${fmt(t.days)}`, "days on target"],
          [fmtUnit(key, t.mean), "a day"],
          isNil(target.max)
            ? null
            : [fmt(t.over), noun(t.over, "day over", "days over")],
          vs,
        ]
      : [
          [fmt(t.days), noun(t.days, "logged day")],
          [fmtUnit(key, t.mean), "a day"],
          [fmtUnit(key, t.total), "in total"],
          vs,
        ];
    fill(
      body,
      tiles(METRICS.find(([k]) => k === key)[1], stats),
      calendarView({
        kind: p.kind,
        from: p.from,
        caption: `${n.label} by day`,
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
                swatch("shade-3", "under, ≥ 75 %"),
                swatch("shade-2", "≥ 50 %"),
                swatch("shade-1", "less"),
              ]
            : ["None", "less", "", "", "most this period"].map((w, i) =>
                swatch(`shade-${i}`, w),
              ),
        ),
        h(
          "ul",
          { "aria-label": "Marks" },
          swatch("none", "nothing logged"),
          judged && !isNil(target.max) ? swatch("shade-0 over", "over") : null,
        ),
        judged ? null : h("p", {}, "No target: shaded by amount"),
      ),
    );
  };
  fill(
    node,
    choice({
      name: "food-calendar-metric",
      label: "Calendar",
      look: "switch",
      options: METRICS,
      value: key,
      onChange: (k) => {
        key = k;
        localStorage.setItem(METRIC_KEY, k);
        paint();
        onPick(k);
      },
    }),
    body,
  );
  paint();
  return node;
}
