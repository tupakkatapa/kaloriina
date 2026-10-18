// A nutrient against its target as a bar: the Diary's day (eaten, planned
// as a ghost after it, what's left) and the Summary's daily average; and
// the nutrient card both show them in.

import { capitalized, fmtNum, isNil, NBSP } from "./format.mjs";
import {
  amountShown,
  barShares,
  byCategory,
  fmtUnit,
  judge,
  KEY_TARGETS,
  nutrient,
  ordered,
} from "./nutrients.mjs";
import { tipFor } from "./tips.mjs";
import { h } from "./ui.mjs";

// Where a bar is full and its to-go counts to: a range's middle (an
// "about" target's value is its min), else the target.
export const fillTo = ({ value, min, max }) =>
  isNil(min) || isNil(max) ? value : (min + max) / 2;

// A bar's status line, from `shown` (amountShown's, as the amount reads):
// only what the amount proves (ADR 0030). A range counts to its middle
// (neither losing nor gaining is assumed) and anywhere in it is in range;
// "at least" counts to its min, "at most" says what's left to its max. A
// floor proves an excess and a minimum met, never that a range's max holds
// ("Minimum met"), and what's left only as an upper bound ("≤"); under
// KNOWN nothing is judged but an excess. An excess counts from the top of
// what's allowed (the range's max). Eaten unknown, what's planned is said.
export function barStatus(
  key,
  target,
  eaten,
  total,
  shown,
  { average = false } = {},
) {
  const goal = target.value;
  const hint = shown.hint ? capitalized(shown.hint) : "Not known";
  if (judge(total, target) === "over") {
    const by = fmtUnit(key, total - target.max);
    const what = target.max > goal ? "the range" : "target";
    return eaten > target.max
      ? `${by} over ${what}`
      : `${by} over ${what} with planned`;
  }
  if (shown.text === "–" && total > (eaten ?? 0))
    return `${hint} · ${fmtUnit(key, total - (eaten ?? 0))} planned`;
  if (!shown.judged) return hint;
  return countdown(key, target, eaten, total, shown.lower, average);
}

// A judged amount short of its target or under its max: what's to go
// (left, under "at most"), counted to a range's middle, else its min, else
// its max; with `lower` (a floor) an upper bound, and a min it reaches
// proves only the minimum of a range.
function countdown(key, target, eaten, total, lower, average) {
  const { min, max } = target;
  const to = fillTo(target);
  const range = !isNil(min) && !isNil(max);
  const met = range && lower ? "minimum met" : range ? "in range" : null;
  if (!isNil(min) && eaten >= min) return met ? capitalized(met) : "Target met";
  const amount = (v) => `${lower ? `≤${NBSP}` : ""}${fmtUnit(key, v)}`;
  if (average)
    return `${amount(to - eaten)} under ${range ? "the range's middle" : "target"}`;
  const now = `${amount(to - eaten)} ${isNil(min) ? "left" : "to go"}`;
  if (total <= eaten) return now;
  if (!isNil(min) && total >= min)
    return `${now} · ${met ?? "met"} with planned`;
  return `${now} · ${amount(to - total)} after planned`;
}

// A nutrient without a target: the amount eaten over an empty track, so
// rows line up; under it "No target", or why the amount isn't known.
const untargeted = (label, amount, shown, { compact, blank }) =>
  h(
    "div",
    { class: "target" },
    h("div", { class: "target-label" }, h("span", {}, label), amount()),
    h("div", { class: "bar unfilled", "aria-hidden": "true" }),
    compact || blank
      ? null
      : h(
          "small",
          {},
          shown.judged
            ? "No target"
            : shown.hint
              ? capitalized(shown.hint)
              : "Not known",
        ),
  );

// A bar's words to a screen reader: eaten (or not known) of the goal, what
// planned adds, and the amount's coverage.
function barLabel(n, shown, { eaten, goal, total, average, planned, floor }) {
  const num = (v) => fmtNum(n.show(v));
  const done =
    shown.text === "–"
      ? "not known, "
      : `${shown.lower ? "at least " : ""}${num(eaten ?? 0)} `;
  const withPlanned = planned
    ? `, ${floor ? "at least " : ""}${num(total)} with planned`
    : "";
  return `${n.label}: ${done}of ${num(goal)} ${n.unit} ${average ? "a day on average" : "eaten"}${withPlanned}${shown.hint ? `, ${shown.hint}` : ""}`;
}

// Eaten fills the bar (to `fillTo`); planned follows as a ghost, where it
// would land (their amounts: segmentWords, the bar's tip); eaten past the
// target's max reads over.
function segments(key, target, eaten, total, shown, { planned }) {
  const unknown = shown.text === "–";
  const shares = barShares(
    unknown ? 0 : (eaten ?? 0),
    total ?? 0,
    fillTo(target),
  );
  const eatenOver = judge(total, target) === "over" && eaten > target.max;
  return [
    h("span", {
      class: eatenOver ? "eaten over" : "eaten",
      style: { width: `${shares.eaten}%` },
    }),
    planned
      ? h("span", {
          class: "planned",
          style: { width: `${shares.planned}%` },
        })
      : null,
  ];
}

// What a bar's segments are, a line each, for its tip (tips.mjs: a phone
// shows it on a tap, as a hover never comes): "Eaten 1,240 kcal",
// "Planned 400 kcal · ≥ 1,640 kcal with planned".
const segmentWords = (key, eaten, total, shown, { planned, floor }) => [
  shown.text === "–" ? null : `Eaten ${shown.text}`,
  planned
    ? `Planned ${fmtUnit(key, total - (eaten ?? 0))} · ${floor}${fmtUnit(key, total)} with planned`
    : null,
];

// A bar's tip of `lines` and, `compact`, the status line (`status()`) it
// leaves out; its track then focusable. Null without any.
function barTip(track, lines, compact, status) {
  const words = [...lines, compact ? status() : null].filter(Boolean);
  if (words.length === 0) return null;
  track.tabIndex = 0;
  return tipFor(
    track,
    words.map((w) => h("span", {}, w)),
  );
}

// One nutrient against its target: eaten, planned as a ghost after it, and
// what's left. As an `average` (a period's daily mean, nothing planned) it
// says how far under or over the mean runs; `href` links the label (to
// where the nutrient came from). `compact` (a grid of them) leaves the
// status line out: it stays in the bar's tip. `share` is how much of the
// food behind `eaten` carried the nutrient (coverage, ADR 0030; `of` names
// that food, "the day's" on any day): partial, the amount reads "≥"
// and only what its floor proves is said (barStatus); none, "–" over an
// empty track. `lower` forces "≥" (energy with some unknown). `blank` (a
// day with nothing logged) says nothing under its track: nothing is
// unknown about nothing.
export function bar(
  key,
  target,
  eaten,
  total,
  {
    average = false,
    href = null,
    compact = false,
    share = 1,
    of = average ? "the food eaten" : "the day's food",
    lower = null,
    blank = false,
  } = {},
) {
  const n = nutrient(key);
  const label = href ? h("a", { href }, n.label) : n.label;
  const shown = amountShown(key, eaten, share, { of, lower });
  // The amount, its coverage on hover and to a screen reader.
  const amount = (suffix = "") =>
    h(
      "span",
      { title: shown.hint },
      `${shown.text}${suffix}`,
      shown.hint ? h("span", { class: "sr-only" }, ` (${shown.hint})`) : null,
    );
  if (!target) return untargeted(label, amount, shown, { compact, blank });
  const goal = target.value;
  // Nothing carried it: an empty track, as without a target.
  const unknown = shown.text === "–";
  const over = judge(total, target) === "over";
  // Eaten unknown is no reason to hide what's planned (it counts from 0).
  const planned = total > (eaten ?? 0);
  // With eaten a floor or unknown, so is the total it's part of.
  const floor = unknown || shown.lower ? `≥${NBSP}` : "";
  const num = (v) => fmtNum(n.show(v));
  const status = () => barStatus(key, target, eaten, total, shown, { average });
  const track = h(
    "div",
    {
      class: unknown ? "bar unfilled" : "bar",
      role: "img",
      // Nothing carried it: not known, never 0 (ADR 0030).
      "aria-label": barLabel(n, shown, {
        eaten,
        goal,
        total,
        average,
        planned,
        floor,
      }),
    },
    ...segments(key, target, eaten, total, shown, { planned, floor }),
  );
  // The bar's tip: its segments' amounts, and the status line a compact
  // bar leaves out.
  const tip = barTip(
    track,
    segmentWords(key, eaten, total, shown, { planned, floor }),
    compact,
    status,
  );
  return h(
    "div",
    {
      // A tip's host (tips.mjs), with a tip or without.
      class: `target tip-host k-${key.replaceAll("_", "-")}${over ? " over" : ""}`,
    },
    h(
      "div",
      { class: "target-label" },
      h("span", {}, label),
      // The target bare: on a bar "≥" says the amount is a floor, and only
      // that; the status line says over or under.
      amount(` / ${num(goal)} ${n.unit}`),
    ),
    track,
    tip,
    compact || blank ? null : h("small", {}, status()),
  );
}

// The targets card's pages: the macros, and a constant list of nutrients
// worth a glance every day (compact, two columns). The page shown is
// remembered on this device; the dots only take taps.
const HIGHLIGHTED = [
  "fiber",
  "saturated",
  "sodium",
  "added_sugars",
  "vitamin_d",
  "iron",
  "magnesium",
  "epa_dha",
];
const PAGES = [
  ["Macros", KEY_TARGETS],
  ["Highlighted", HIGHLIGHTED],
];
const PAGE_KEY = "targets-page";

// The targets card, `barOf(key, compact)` drawing each bar. Its pages
// share one grid cell, the one not shown invisible and inert, so the card
// keeps the taller page's height when switched.
function targetsCard(barOf) {
  const pages = PAGES.map(([, keys], i) =>
    h(
      "div",
      { class: i ? "targets-page grid" : "targets-page" },
      keys.filter((key) => nutrient(key)).map((key) => barOf(key, i === 1)),
    ),
  );
  const show = (at) => {
    pages.forEach((page, i) => {
      page.inert = i !== at;
    });
    dots.forEach((dot, i) =>
      dot.setAttribute("aria-pressed", String(i === at)),
    );
  };
  const dots = PAGES.map(([name], i) =>
    h("button", {
      type: "button",
      class: "dot",
      "aria-label": name,
      onclick: () => {
        localStorage.setItem(PAGE_KEY, String(i));
        show(i);
      },
    }),
  );
  show(localStorage.getItem(PAGE_KEY) === "1" ? 1 : 0);
  return h(
    "div",
    { class: "targets main" },
    h("div", { class: "targets-pages" }, pages),
    h(
      "div",
      { class: "pager", role: "group", "aria-label": "Targets page" },
      dots,
    ),
  );
}

// The nutrient card (the Diary's day): `headline` over the paged targets
// card, then the other nutrients' fold. `tracked(key)`: whether the
// period's food carried a nutrient or it has a target; the rest fold away.
export const nutrientCard = (
  barOf,
  { headline = null, tracked = () => true } = {},
) => [
  headline,
  targetsCard(barOf),
  otherNutrients(barOf, KEY_TARGETS, tracked),
];

// Every nutrient but `shown`, targeted or not, by category under "Other
// nutrients" (as Targets lists them), folded; `barOf(key, compact)` draws
// each bar. Null when none is left. Never water: the `water` target is
// hydration's goal (ADR 0020), and a food's gross water (beer's included,
// coverage weighed by energy that water's carriers lack) judged against
// it was a second, wrong verdict beside the Log's Hydration.
// Those no food carried and no target asks for fold away under "N not
// tracked", so the vitamins and minerals aren't buried under a screen of
// dashes.
function otherNutrients(barOf, shown, tracked) {
  const all = ordered().filter(
    (n) => !shown.includes(n.key) && n.key !== "water",
  );
  const others = all.filter((n) => tracked(n.key));
  const untracked = all.filter((n) => !tracked(n.key));
  return all.length > 0
    ? h(
        "details",
        { class: "all-targets" },
        h("summary", {}, "Other nutrients"),
        h(
          "div",
          { class: "targets" },
          // A category is one block: on desktop the fold reads in two
          // columns, and a heading never parts from its bars.
          byCategory(others).map(([name, list]) =>
            h(
              "div",
              { class: "category-group" },
              h("h3", { class: "category" }, name),
              list.map((n) => barOf(n.key, false)),
            ),
          ),
        ),
        untracked.length > 0
          ? h(
              "details",
              { class: "untracked" },
              h("summary", {}, `${untracked.length} not tracked`),
              h(
                "p",
                { class: "muted" },
                untracked.map((n) => n.label).join(", "),
              ),
            )
          : null,
      )
    : null;
}
