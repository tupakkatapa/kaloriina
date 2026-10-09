// What the Summary's subtabs share: Chart.js (loaded once, only here), a
// chart in the app's colours, and what a period's charts are by (each
// logged day, week or month, picked per device).

import { parseDay, pretty, weekStart } from "../dates.mjs";
import { go, href } from "../nav.mjs";
import { choice, fill, h } from "../ui.mjs";

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
// failed load leaves the numbers below in place.
export function drawCharts(draw) {
  loadCharts()
    .then((Chart) =>
      requestAnimationFrame(() => {
        // Charts of views already left behind.
        for (const c of Object.values(Chart.instances))
          if (!c.canvas.isConnected) c.destroy();
        draw();
      }),
    )
    .catch(() => {});
}

export function chart(canvas, config) {
  const css = getComputedStyle(document.documentElement);
  window.Chart.defaults.color = css.getPropertyValue("--muted").trim();
  window.Chart.defaults.borderColor = css.getPropertyValue("--line").trim();
  window.Chart.defaults.font.family = css.fontFamily;
  return new window.Chart(canvas, {
    ...config,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: 2 },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 12 } } },
      ...config.options,
    },
  });
}

// Tick and label names, built once.
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const MONTH_LONG = new Intl.DateTimeFormat(undefined, { month: "long" });
const MONTH_SHORT = new Intl.DateTimeFormat(undefined, { month: "short" });

// What a chart's points can be (`by`): each logged day, week or month,
// its key (a day, the week's Monday, `YYYY-MM`), names (`short` on the
// axis, a week period's days by weekday) and where it leads: a day to its
// diary, a week or a month to that period on the same subtab, `tab`.
export const BY = {
  day: {
    bucket: (day) => day,
    label: (key) => pretty(key),
    short: (key, kind) =>
      kind === "week" ? WEEKDAY.format(parseDay(key)) : pretty(key, false),
    link: (key) => href.day(key),
  },
  week: {
    bucket: (day) => weekStart(day),
    label: (key) => `Week of ${pretty(key)}`,
    short: (key) => pretty(key, false),
    link: (key, tab) => href.summary("week", key, tab),
  },
  month: {
    bucket: (day) => day.slice(0, 7),
    label: (key) => MONTH_LONG.format(parseDay(`${key}-01`)),
    short: (key) => MONTH_SHORT.format(parseDay(`${key}-01`)),
    link: (key, tab) => href.summary("month", `${key}-01`, tab),
  },
};

// `rows` ({day, …}, in order) by `by`'s buckets: key → its rows.
export const bucketed = (by, rows) =>
  Map.groupBy(rows, (r) => BY[by].bucket(r.day));

// What each period's charts can be by, the default first. The pick is this
// device's: one for every chart and subtab, kept per period kind.
const CHOICES = {
  week: ["day"],
  month: ["week", "day"],
  year: ["month", "week"],
};
const byKey = (kind) => `summary-chart-by-${kind}`;

export function chartBy(kind) {
  const saved = localStorage.getItem(byKey(kind));
  return CHOICES[kind].includes(saved) ? saved : CHOICES[kind][0];
}

// The Day | Week (a month's) or Week | Month (a year's) pick for each chart
// card's header: `slot(name)` makes one ("Energy" → "Energy by"; none in a
// week). A pick in any re-draws in place, `draw(by)`, and moves the others.
export function chartByPicker(kind, draw) {
  const options = ["day", "week", "month"]
    .filter((b) => CHOICES[kind].includes(b))
    .map((b) => [b, b[0].toUpperCase() + b.slice(1)]);
  const slots = [];
  const make = (slot) =>
    fill(
      slot,
      choice({
        name: "chart-by",
        look: "switch",
        label: `${slot.dataset.name} by`,
        options,
        value: chartBy(kind),
        onChange: (by) => {
          localStorage.setItem(byKey(kind), by);
          for (const other of slots) if (other !== slot) make(other);
          draw(by);
        },
      }),
    );
  return (name) => {
    if (options.length < 2) return null;
    const slot = h("div", { class: "chart-by", "data-name": name });
    slots.push(slot);
    make(slot);
    return slot;
  };
}

// A chart card's header: the heading, the pick right of it (under it when
// narrow).
export const chartHead = (heading, pick) =>
  h("div", { class: "chart-head" }, heading, pick);

// Chart options: a click on a point opens where it leads (`links`, one per
// label). The list under a chart, or the period's own views, are the
// keyboard's way there.
export const pointLinks = (links) => ({
  onClick: (_, points) => {
    if (points.length) go(links[points[0].index]);
  },
  onHover: (e, points) => {
    e.native.target.style.cursor = points.length ? "pointer" : "";
  },
});
