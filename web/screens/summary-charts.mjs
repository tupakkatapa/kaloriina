// What the Summary's subtabs share: Chart.js (loaded once, only here), a
// chart in the app's colours, and the one chart card every subtab draws
// (`seriesChart`).

import { describe } from "../correlate.mjs";
import { parseDay, pretty, shift } from "../dates.mjs";
import { fmt, fmtFixed, isNil, lower, NBSP, plural, qty } from "../format.mjs";
import { go, href } from "../nav.mjs";
import { niceStep, placesOf, spanAtLeast, zoomTicks } from "../series.mjs";
import { coarse, FINGER, hideTip, placeTip } from "../tips.mjs";
import { abbreviated, busy, CLOSE, fill, h, icon, modal } from "../ui.mjs";

// Chart.js, loaded once and only for the Summary.
let chartLib = null;
const loadCharts = () =>
  (chartLib ??= new Promise((resolve, reject) => {
    document.head.append(
      h("script", {
        src: new URL("../vendor/chart.umd.min.js", import.meta.url).href,
        onload: () => resolve(window.Chart),
        onerror: () => {
          chartLib = null;
          reject(new Error("charts failed to load"));
        },
      }),
    );
  }));

// Run `draw` once the view is on screen; charts need a laid-out canvas. A
// failed load (most likely the server upgraded under the page: its build's
// files are gone) says so in each chart's place; the numbers stay.
function drawCharts(draw) {
  loadCharts()
    .then((Chart) =>
      requestAnimationFrame(() => {
        // Charts of views already left behind.
        for (const c of Object.values(Chart.instances))
          if (!c.canvas.isConnected) c.destroy();
        draw();
      }),
    )
    .catch(() => {
      for (const canvas of document.querySelectorAll("#app canvas"))
        canvas.replaceWith(
          h(
            "p",
            { class: "muted" },
            "Charts didn't load. ",
            h(
              "button",
              {
                type: "button",
                class: "link",
                onclick: () => location.reload(),
              },
              "Reload.",
            ),
          ),
        );
    });
}

// Where a tooltip points: its items' x and, above them all, the highest of
// them, or a finger above them (on a touch screen a thumb covers what is
// under the touch), so the tip (chartTip) goes above both.
function aboveAll(items, at) {
  const spot = window.Chart.Tooltip.positioners.average.call(this, items, at);
  if (!spot) return spot;
  const ys = items.map((i) => i.element.y).filter((y) => Number.isFinite(y));
  if (coarse() && Number.isFinite(at?.y)) ys.push(at.y);
  return ys.length > 0 ? { x: spot.x, y: Math.min(...ys) } : spot;
}

// A chart's tooltip as the app's one tooltip (tips.mjs): the chart's
// `.tip` (made on its first showing, beside the canvas; hidden from a
// screen reader, which has the chart's list), its title, each item with
// its series' swatch, then what afterBody adds (the targets), placed above
// the point (aboveAll), a finger's clearance on a touch screen.
function chartTip({ chart: drawn, tooltip }) {
  const box = drawn.canvas.parentElement;
  let tip = box.querySelector(":scope > .chart-tip");
  if (tooltip.opacity === 0) {
    if (tip) hideTip(tip);
    return;
  }
  if (!tip) {
    tip = h("div", {
      class: "tip chart-tip",
      popover: "manual",
      "aria-hidden": "true",
    });
    box.append(tip);
  }
  fill(
    tip,
    tooltip.title.map((t) => h("strong", {}, t)),
    tooltip.body.flatMap((b, i) =>
      b.lines.map((line) =>
        h(
          "span",
          {},
          h("i", {
            class: "chart-swatch",
            style: {
              background: tooltip.labelColors[i]?.backgroundColor,
              borderColor: tooltip.labelColors[i]?.borderColor,
            },
          }),
          line,
        ),
      ),
    ),
    tooltip.afterBody.map((t) => h("span", { class: "muted" }, t)),
  );
  const at = drawn.canvas.getBoundingClientRect();
  const x = at.left + tooltip.caretX;
  const y = at.top + tooltip.caretY;
  placeTip(
    tip,
    { left: x, right: x, top: y, bottom: y, width: 0, height: 0 },
    { gap: coarse() ? FINGER : 8, center: true },
  );
}

// The one chart theme, from the app's colours (read on every chart, so a
// switch to dark mode is followed): a quiet y grid and none across, no axis
// lines, the tooltip in the app's surface, lines curved without
// overshooting a point (monotone).
function theme(Chart) {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  const d = Chart.defaults;
  Chart.Tooltip.positioners.aboveAll = aboveAll;
  d.color = v("--muted");
  d.borderColor = v("--line");
  d.font.family = css.fontFamily;
  d.font.size = 12;
  d.elements.line.borderJoinStyle = "round";
  d.elements.line.borderCapStyle = "round";
  d.elements.line.cubicInterpolationMode = "monotone";
  d.elements.point.hoverBorderWidth = 2;
  // Every chart's tooltip the app's one (chartTip), above what it is
  // about and clear of a finger.
  Object.assign(d.plugins.tooltip, {
    enabled: false,
    external: chartTip,
    position: "aboveAll",
  });
  // Zoomed to the data: the lowest point at the
  // bottom, the highest at the top; a point on the edge is drawn whole.
  d.datasets.line.clip = false;
  return {
    x: { grid: { display: false }, border: { display: false } },
    y: {
      grid: { color: v("--line") },
      border: { display: false },
      bounds: "data",
      grace: 0,
      ...zoomed(),
    },
  };
}

// A y axis zoomed to its data, spanning at least `span`, its ticks
// zoomTicks' written to exactly `digits` (the data's precision: an edge
// reads "77.7", not "78"; null: the step's), a whole one too: "83.0"
// beside "82.5".
const zoomed = ({ span = 0, digits = null } = {}) => ({
  afterDataLimits: (scale) => {
    [scale.min, scale.max] = spanAtLeast(scale.min, scale.max, span);
  },
  afterBuildTicks: (scale) => {
    scale.ticks = zoomTicks(scale.min, scale.max, digits).map((value) => ({
      value,
    }));
  },
  ticks: {
    // Chart.js calls it on the scale (`this`).
    callback(value) {
      return fmtFixed(value, digits ?? placesOf(niceStep(this.max - this.min)));
    },
  },
});

// `config`'s scales over the theme's, axis by axis.
const scales = (base, own = {}) =>
  Object.fromEntries(
    [...new Set([...Object.keys(base), ...Object.keys(own)])].map((k) => [
      k,
      { ...base[k], ...own[k] },
    ]),
  );

// A chart of `config` in the theme; its own legend and tooltip options
// over the theme's.
export function chart(canvas, config) {
  const axes = theme(window.Chart);
  const own = config.options ?? {};
  return new window.Chart(canvas, {
    ...config,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: 6 },
      // The day nearest the pointer or finger, every series of it: no
      // pixel-exact aim at a dot.
      interaction: { mode: "index", intersect: false },
      ...own,
      plugins: {
        ...own.plugins,
        legend: {
          position: "bottom",
          // A dataset can keep out of the legend (`legend: false`).
          // Small dots, a space between entries.
          labels: {
            boxWidth: 8,
            boxHeight: 8,
            padding: 16,
            usePointStyle: true,
            filter: (item, data) =>
              data.datasets[item.datasetIndex].legend !== false,
            // A series' entry in its trend's colour and its points' shape:
            // its points are all one neutral.
            generateLabels: (c) =>
              window.Chart.defaults.plugins.legend.labels
                .generateLabels(c)
                .map((item) => {
                  const { group } = c.data.datasets[item.datasetIndex];
                  const trend = c.data.datasets.find(
                    (d) => d.kind === "trend" && d.group === group,
                  );
                  return trend
                    ? {
                        ...item,
                        fillStyle: trend.borderColor,
                        strokeStyle: trend.borderColor,
                        lineWidth: 1,
                      }
                    : item;
                }),
            // In the datasets' order, whatever order they draw in.
            sort: (a, b) => a.datasetIndex - b.datasetIndex,
          },
          ...own.plugins?.legend,
        },
        tooltip: {
          itemSort: (a, b) => a.datasetIndex - b.datasetIndex,
          ...own.plugins?.tooltip,
        },
      },
      scales: scales(axes, own.scales),
    },
  });
}

// An "Expand chart" button for a chart card (`target`): a full-screen
// dialog with the same chart larger, drawn again from the card's Chart.js
// config, headed `title` (what the card's heading, unit and period say
// beside it). Esc, ✕ or leaving the screen closes it, and focus returns
// to the button.
function expandButton(target, title) {
  const open = async () => {
    const canvas = target.querySelector("canvas");
    // Tapped before Chart.js drew the card's chart: open once it has
    // (drawCharts draws in the frame after the load; this frame comes after).
    if (canvas && !window.Chart?.getChart(canvas))
      await loadCharts()
        .then(() => new Promise(requestAnimationFrame))
        .catch(() => null);
    if (!button.isConnected) return;
    const drawn = canvas && window.Chart?.getChart(canvas);
    if (!drawn) return;
    chartDialog(
      canvas.getAttribute("aria-label"),
      {
        type: drawn.config.type,
        // Fresh arrays: Chart.js marks the ones it draws as its own.
        data: {
          labels: [...drawn.config.data.labels],
          datasets: drawn.config.data.datasets.map((d) => ({
            ...d,
            data: [...d.data],
          })),
        },
        options: drawn.config.options,
        plugins: drawn.config.plugins,
      },
      { focus: button, title },
    );
  };
  const button = h(
    "button",
    {
      type: "button",
      class: "icon expand",
      "aria-label": "Expand chart",
      onclick: busy(open),
    },
    icon(EXPAND),
  );
  return button;
}

// The full-screen chart dialog, named `label`: Chart.js `config` drawn
// large, under `title` (else `label`). Esc, ✕ or leaving the screen closes
// it; focus goes back to `focus` (a busy button, disabled while it opened,
// is focused by name). `className` adds to its class.
function chartDialog(
  label,
  config,
  { focus = null, className = "", title = label } = {},
) {
  const box = h(
    "div",
    { class: "chart-box" },
    h("canvas", { role: "img", "aria-label": label }),
  );
  const { close } = modal(
    { class: `chart-dialog ${className}`.trim(), "aria-label": label },
    [
      h(
        "button",
        {
          type: "button",
          class: "icon",
          "aria-label": "Close",
          onclick: () => close(),
        },
        icon(CLOSE),
      ),
      h("h2", { class: "chart-title" }, title),
      box,
    ],
    {
      onClose: () => {
        window.Chart.getChart(box.firstChild)?.destroy();
        removeEventListener("hashchange", close);
        focus?.focus();
      },
    },
  );
  addEventListener("hashchange", close);
  chart(box.firstChild, config);
}

// One line of a pair's chart, on its own `axis`.
const pairLine = (name, data, c, axis, dash = []) => ({
  label: name,
  data,
  borderColor: c,
  backgroundColor: c,
  borderDash: dash,
  pointRadius: 3,
  borderWidth: 1.5,
  yAxisID: axis,
});

// A tested pair (an insight's chart link, web/insights.mjs: series keys
// `x`, `y`, series `xs`, `ys`, x read `lag` days before y) as two lines
// over the same days: y on each day it has with x on the day `lag` before,
// each on its own axis.
export async function pairChart({ x, y, xs, ys, lag }, focus = null) {
  await loadCharts();
  const X = describe(x, xs);
  const Y = describe(y, ys);
  const has = new Set(xs.samples);
  const days = ys.samples.filter((d) => has.has(shift(d, -lag)));
  const css = getComputedStyle(document.documentElement);
  const color = (c) => css.getPropertyValue(c).trim();
  const before = lag ? `, ${plural(lag, "day")} before` : "";
  const label = `${Y.label} and ${lower(X.label)}${before}, by day`;
  chartDialog(
    label,
    {
      type: "line",
      data: {
        labels: days.map((d) => BY.day.short(d)),
        datasets: [
          pairLine(
            Y.label,
            days.map((d) => ys.values.get(d) ?? 0),
            color("--accent"),
            "y",
          ),
          pairLine(
            `${X.label}${before}`,
            days.map((d) => xs.values.get(shift(d, -lag)) ?? 0),
            color("--tone-correlation"),
            "y1",
            [6, 4],
          ),
        ],
      },
      options: {
        scales: {
          y: { beginAtZero: false, position: "left" },
          y1: {
            beginAtZero: false,
            position: "right",
            grid: { display: false },
          },
        },
      },
    },
    { focus, className: "pair-chart" },
  );
}

// Four corners pointing out.
const EXPAND = "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7";

// How faint a series' points are against its trend.
const FAINT = 0.4;
const faint = (c, alpha = FAINT) =>
  window.Chart.helpers.color(c).alpha(alpha).rgbString();

// Tick and label names, built once.
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short" });

// What a chart's points can be (`by`, the period's: web/series.mjs
// bucketOf): each day or week, its key (a day, the week's Monday), names
// (`short` on the axis, a week period's days by weekday) and where it
// leads: a day to its diary, a week to that week on the same subtab, `tab`.
export const BY = {
  day: {
    label: (key) => pretty(key),
    short: (key, kind) =>
      kind === "week" ? WEEKDAY.format(parseDay(key)) : pretty(key, false),
    link: (key) => href.day(key),
  },
  week: {
    label: (key) => `Week of ${pretty(key)}`,
    short: (key) => pretty(key, false),
    link: (key, tab) => href.summary("week", key, tab),
  },
};

// A chart card's header: the heading and Expand (`expand`, the card to
// expand, its dialog headed `title`) right of it.
const chartHead = (heading, expand, title) =>
  h(
    "div",
    { class: "chart-head" },
    heading,
    h("div", { class: "chart-tools" }, expandButton(expand, title)),
  );

// Chart options: a click on a point opens where it leads (`links`, one per
// label, `names` what each is). A finger reads first: its tap shows the
// tooltip, and an "Open …" link under the chart goes there. The
// calendars' days, or the period's own views, are the keyboard's way there.
const pointLinks = (links, names) => ({
  onClick: (_, points, c) => {
    if (points.length === 0) return;
    const i = points[0].index;
    if (!coarse()) {
      go(links[i]);
      return;
    }
    const box = c.canvas.parentElement;
    let open = box.nextElementSibling;
    if (!open?.classList.contains("open-point")) {
      open = h("a", { class: "button open-point" });
      box.after(open);
    }
    open.href = links[i];
    open.textContent = `Open ${names[i]}`;
  },
  onHover: (e, points) => {
    e.native.target.style.cursor = points.length > 0 ? "pointer" : "";
  },
});

// Each mark kind as a dataset (web/series.mjs marks), `c` its series'
// colour, `dot` its points' and `m` the mark: points small, faint, unjoined
// and in `shape`, under the trend, the line that reads first (a series
// without a trend, `alone`: its points in its colour, unjoined, as they
// are what reads); a floor's point (`m.partly`) hollow; a target dashed;
// the path to a goal dotted.
const DATASET = {
  points: (c, dot, m, shape, alone) => ({
    showLine: false,
    borderColor: alone ? c : faint(dot),
    backgroundColor: alone ? c : faint(dot),
    pointStyle: shape,
    pointBackgroundColor: (x) =>
      m.partly?.[x.dataIndex] ? "transparent" : alone ? c : faint(dot),
    pointBorderWidth: (x) => (m.partly?.[x.dataIndex] ? 1.5 : 0),
    // Drawn under the trend (Chart.js draws a higher `order` first).
    order: 1,
    pointRadius: 4,
    pointHoverRadius: 6,
    pointHitRadius: 12,
  }),
  trend: (c) => ({
    borderColor: c,
    backgroundColor: c,
    borderWidth: 2,
    pointRadius: 0,
    spanGaps: true,
  }),
  line: (c) => ({
    borderColor: faint(c, 0.6),
    backgroundColor: faint(c, 0.6),
    borderDash: [6, 4],
    borderWidth: 1.5,
    pointRadius: 0,
    pointStyle: "line",
  }),
  path: (c) => ({
    borderColor: c,
    backgroundColor: c,
    borderDash: [2, 4],
    borderWidth: 1.5,
    pointRadius: 0,
    spanGaps: true,
  }),
  // A field's edges, the space between filled, under the rest.
  low: (c) => band(c),
  high: (c) => ({ ...band(c), fill: "-1" }),
};
// A field (a target range is a field, "like heart rate
// lowest/highest"): a muted fill seen in both themes and a hairline edge;
// its legend swatch the same square.
const band = (c) => ({
  borderColor: c,
  borderWidth: 1,
  pointRadius: 0,
  pointHitRadius: 0,
  pointStyle: "rect",
  backgroundColor: faint(c, 0.28),
  spanGaps: true,
  order: 2,
});

// Each series' points their own shape (points are
// neutral, so shape tells eaten from burned, one method from another).
const SHAPES = ["circle", "triangle", "rect", "rectRot", "star"];

// The least a chart's y-axis spans, by unit: a change smaller than
// this isn't drawn as a cliff.
const MIN_SPAN = {
  kg: 2,
  lb: 4,
  kcal: 100,
  kJ: 400,
  bpm: 6,
  ms: 10,
  "%": 2,
  "kg/m²": 1,
  g: 20,
  cm: 2,
  in: 1,
};

// The one chart builder: a card drawing `marks` (web/series.mjs:
// each series' points and trend, targets as lines or fields; a goal's
// path, a band's `low` and `high` edges) over `keys` by `by` (the period
// `p`'s buckets), values in `unit` to `digits`; `colors` key → [trend]
// (CSS custom properties; unless named, the accent). Points are neutral,
// each series' its own shape; targets neutral and faint. The axis is
// zoomed to the data, at least the unit's MIN_SPAN, its ticks round. The
// legend names each series (each method of one) once, in its trend's
// colour and its points' shape, and each target; a tap shows or hides all
// of a series. One web/series.mjs `withHidden` hid starts struck through.
// The canvas is named `label`; the numbers, the targets' values with
// them, are a list for screen readers only (the calendars and the points
// lead to each day). `plugins` draws more (a goal date). [heading row,
// card, list].
export function seriesChart({
  p,
  by,
  heading,
  label,
  keys,
  marks,
  unit,
  digits = 0,
  colors = {},
  plugins = [],
}) {
  const say = (v) => qty(v, unit, digits);
  // "eaten ≥ 3,545 kcal (some energy unknown)", "maintenance ≈ 2,155 kcal
  // (weight trend)": the number, then what qualifies it.
  const said = (m, i, name = lower(m.label), sep = " ") => {
    const floor = m.partly?.[i];
    return `${name}${sep}${floor ? `≥${NBSP}` : ""}${say(m.data[i])}${m.note ? ` (${m.note})` : ""}${floor ? ` (${m.partlyNote})` : ""}`;
  };
  // "Target 1,800–2,200 kcal", "Target ≥ 50 g", "Goal 75 kg": each
  // target chart `c` shows (none toggled off) at its point `i`, once, its
  // value that day (a field by its edges).
  const targetsAt = (c, i) =>
    [
      ...Map.groupBy(
        marks.filter(
          (m, d) => m.target && c.isDatasetVisible(d) && !isNil(m.data[i]),
        ),
        (m) => m.key,
      ).values(),
    ].map(([m, high]) => {
      const v = m.data[i];
      const value = high
        ? `${fmt(v, digits)}–${say(high.data[i])}`
        : `${m.sign ? `${m.sign}${NBSP}` : ""}${say(v)}`;
      return `${m.name ?? m.label} ${value}`;
    });
  const head = h("h2", {}, abbreviated(heading));
  const canvas = h("canvas", { role: "img", "aria-label": label });
  const card = h(
    "div",
    { class: "chart-card card" },
    h("div", { class: "chart-box" }, canvas),
  );
  const shown = marks.filter((m) => m.kind === "points");
  const list = h(
    "ul",
    { class: "sr-only" },
    keys.map((k, i) =>
      h(
        "li",
        {},
        `${BY[by].label(k)}: ${shown
          .filter((m) => !isNil(m.data[i]))
          .map((m) => said(m, i))
          .join(" · ")}`,
      ),
    ),
    marks.filter((m) => m.text).map((m) => h("li", {}, m.text)),
  );
  drawCharts(() => {
    const css = getComputedStyle(document.documentElement);
    const color = (name) => css.getPropertyValue(name).trim();
    // The legend names each points mark once, a series without points by
    // its trend, a target once (a field by its high edge).
    const seen = new Set();
    const trended = new Set(
      marks.filter((m) => m.kind === "trend").map((m) => m.group),
    );
    let shapes = 0;
    const datasets = marks.map((m) => {
      const group = m.group ?? m.key;
      // Targets (lines and fields) are neutral and faint; the data has
      // its own colours.
      const [c = "--accent"] = m.target ? ["--muted"] : (colors[group] ?? []);
      const id = m.kind === "trend" ? group : m.key;
      const named = !["low", "path"].includes(m.kind) && !seen.has(id);
      if (named) seen.add(id);
      if (m.kind === "points") seen.add(group);
      return {
        label: m.note ? `${m.label} (${m.note})` : m.label,
        data: m.data,
        group,
        kind: m.kind,
        legend: named,
        hidden: Boolean(m.hidden),
        partly: m.partly,
        partlyNote: m.partlyNote,
        // Every series' points the same neutral; its trend carries its
        // colour.
        ...DATASET[m.kind](
          color(c),
          color("--muted"),
          m,
          m.kind === "points" ? SHAPES[shapes++ % SHAPES.length] : undefined,
          !trended.has(group),
        ),
      };
    });
    chart(canvas, {
      type: "line",
      plugins,
      data: { labels: keys.map((k) => BY[by].short(k, p.kind)), datasets },
      options: {
        ...pointLinks(
          keys.map((k) => BY[by].link(k, p.tab)),
          keys.map((k) => BY[by].label(k)),
        ),
        scales: { y: zoomed({ span: MIN_SPAN[unit] ?? 0, digits }) },
        plugins: {
          legend: {
            onClick: (_, item, legend) => {
              const c = legend.chart;
              const group = c.data.datasets[item.datasetIndex].group;
              const show = !c.isDatasetVisible(item.datasetIndex);
              c.data.datasets.forEach((d, i) => {
                if (d.group === group) c.setDatasetVisibility(i, show);
              });
              c.update();
            },
          },
          tooltip: {
            // Targets aren't items: each is named once, under them.
            filter: (item) => !marks[item.datasetIndex].target,
            callbacks: {
              afterBody: ([item]) =>
                item ? targetsAt(item.chart, item.dataIndex) : [],
              label: (item) =>
                item.dataset.kind === "points"
                  ? said(
                      marks[item.datasetIndex],
                      item.dataIndex,
                      marks[item.datasetIndex].label,
                      ": ",
                    )
                  : `${item.dataset.label}: ${say(item.parsed.y)}`,
            },
          },
        },
      },
    });
  });
  // The dialog's heading: what the card's heading, its unit and the
  // period title say on the screen.
  const title = [heading, unit, p.title].filter(Boolean).join(" · ");
  return [chartHead(head, card, title), card, list];
}
