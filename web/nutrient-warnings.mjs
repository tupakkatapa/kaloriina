// Food tips and warnings (ADR 0030): a period's average against the targets,
// said only once enough of it is logged, and of a nutrient only where it is
// known (unknown isn't zero): where foods carrying it supplied most of the
// energy. Highlight results (cards: web/insights.mjs) for RULES.food, each
// opening its nutrient's sources. No DOM here, so `node --test` covers it.

import { coverage } from "./coverage.mjs";
import { fmtNum, isNil, NBSP } from "./format.mjs";
import { dailyMean, fmtUnit, KNOWN, nutrient, sharePct } from "./nutrients.mjs";

// Coverage lives with the nutrients (one rule for every screen); the
// Summary still reads it from here.
export { KNOWN, coverage };

// Logged days a period needs, in number and as a share of its elapsed days.
const MIN_DAYS = 7;
const MIN_LOGGED = 0.7;
// Under this share of an at-least target is low.
const LOW = 0.7;
// A known intake of 0 ranks as if this far under its bar: finite, past
// any ranking cap.
const ZERO_MARGIN = 100;
// The foods named after a warning.
const SOURCES_NAMED = 3;
// A good source of a nutrient holds, per 100 kcal, this many times what a
// diet just meeting its target at the energy target does.
const GOOD = 2;
// The energy target a good source is weighed against without one.
const DEFAULT_KCAL = 2000;
// Vitamin D in winter: from this latitude (either hemisphere) the sun
// makes too little from October to March (April to September south).
const WINTER_LATITUDE = 37;
const NORTH_WINTER = [10, 11, 12, 1, 2, 3];
const TIP_MARGIN = 1.5;

// "Rye bread · Oats · Beef": names as stored (Fineli's carry commas),
// each once.
const listed = (names) =>
  [...new Set(names)].slice(0, SOURCES_NAMED).join(" · ");

const withNames = (text, lead, names) =>
  names?.length ? `${lead} ${listed(names)}. ${text}` : text;

// "Mean over 24 logged days; foods carrying it made up 92 % of the
// food": how a nutrient's mean was found (by dry matter, ADR 0030).
const basis = (days, key) =>
  `Mean over ${days.length} logged days; foods carrying it made up ${sharePct(coverage(days, key))} of the food (${Math.round(KNOWN * 100)}${NBSP}% is needed to judge).`;

// The least of at-least nutrient `key` per 100 kcal (stored unit) a food
// needs to be a good source of it, against `targets` (by metric).
export const goodSourceMin = (key, targets) =>
  (GOOD * targets[key].value * 100) / (targets.energy?.value ?? DEFAULT_KCAL);

// Whether `day` (YYYY-MM-DD) is winter at `latitude`.
const winter = (latitude, day) => {
  const month = Number(day.slice(5, 7));
  const north = NORTH_WINTER.includes(month);
  return latitude > 0 ? north : !north;
};

// `key`'s mean a day over the logged `days` ([{day, total, known}]): the
// Summary's averages' (dailyMean), or null when it isn't known (under
// KNOWN coverage; see coverage).
function meanOf(days, key) {
  if (coverage(days, key) < KNOWN) return null;
  return dailyMean(days, key);
}

// The vitamin D tip's conditions: far enough from the equator, its winter,
// known and under the target.
function vitaminDTipDue({ days, targets, through, latitude }) {
  const target = targets.vitamin_d?.value;
  const mean = meanOf(days, "vitamin_d");
  return (
    !isNil(latitude) &&
    Math.abs(latitude) >= WINTER_LATITUDE &&
    winter(latitude, through) &&
    !isNil(target) &&
    mean !== null &&
    mean < target
  );
}

// nutrientWarnings' warning of nutrient `key` against its target `t`, or
// null: low for an at-least one, high for an at-most one.
function warningOf(key, t, { days, tip, period, sources }) {
  const n = nutrient(key);
  // Never water: its target is hydration's goal, judged per day by the
  // Habits Highlights (insights.mjs hydrationLow); a food's gross
  // water against it was a second, wrong verdict.
  if (!n || isNil(t?.value) || key === "water") return null;
  const mean = meanOf(days, key);
  if (mean === null) return null;
  const label = n.label;
  if (n.goal === "at_least" && mean < LOW * t.value) {
    // Covered by the tip.
    if (key === "vitamin_d" && tip) return null;
    // Foods without it count as 0: under full coverage, a floor.
    const floor = coverage(days, key) < 1 ? "≥ " : "";
    return {
      id: `low:${key}`,
      tone: "warning",
      headline: n.ai ? `${label} below recommended` : `${label} intake low`,
      numbers: `${floor}${fmtNum(n.show(mean))} of ${fmtUnit(key, t.value)} a day · ${period}`,
      detail: withNames(
        `${n.ai ? `Under ${Math.round(LOW * 100)}${NBSP}% of the recommended amount (an adequate intake)` : `Under ${Math.round(LOW * 100)}${NBSP}% of your target`}: intake, not status. ${basis(days, key)}`,
        "Good sources:",
        sources[key],
      ),
      margin: mean > 0 ? (LOW * t.value) / mean : ZERO_MARGIN,
      link: { to: "sources", key },
    };
  }
  if (n.goal === "at_most" && !isNil(t.max) && mean > t.max) {
    return {
      id: `high:${key}`,
      tone: "warning",
      headline: `${label} high`,
      numbers: `${fmtUnit(key, mean)} a day, limit ${fmtUnit(key, t.max)} · ${period}`,
      detail: withNames(basis(days, key), "Most from", sources[key]),
      margin: mean / t.max,
      link: { to: "sources", key },
    };
  }
  return null;
}

// The period's warnings and tips: `days` (the logged days' totals, stored
// units, and their `known`), `elapsed` days, `targets` by metric, `through`
// (the last day counted), `period` (its words, insights.mjs periodWords), the
// profile's `latitude` (or null) and `sources` (key → food names: for a high
// nutrient what it mostly came from, for a low one good sources of it). Nothing
// under MIN_DAYS logged or MIN_LOGGED of the elapsed days, and nothing of a
// nutrient not known (see meanOf). An at-least nutrient under LOW of its target
// warns ("Iron intake low": intake, not status; or for an adequate intake
// "below recommended"; "≥" when short of full coverage, a floor); an at-most
// one over its max warns; about-goals never do. The winter vitamin D tip
// replaces vitamin D's warning.
export function nutrientWarnings({
  days,
  elapsed,
  targets,
  through,
  latitude,
  period = "",
  sources = {},
}) {
  const logged = days.length;
  if (logged < MIN_DAYS || logged < MIN_LOGGED * elapsed) return [];
  const out = [];
  const tip = vitaminDTipDue({ days, targets, through, latitude });
  if (tip)
    out.push({
      id: "tip:vitamin-d",
      tone: "tip",
      headline: "Vitamin D in winter",
      numbers: `10 µg a day advised · ${period}`,
      detail: `The NHS advises 10 µg vitamin D a day in autumn and winter at your latitude (THL: 10 µg, 20 µg over 75), unless you already take it. ${basis(days, "vitamin_d")}`,
      margin: TIP_MARGIN,
      link: { to: "sources", key: "vitamin_d" },
    });
  for (const [key, t] of Object.entries(targets)) {
    const warning = warningOf(key, t, { days, tip, period, sources });
    if (warning) out.push(warning);
  }
  return out;
}
