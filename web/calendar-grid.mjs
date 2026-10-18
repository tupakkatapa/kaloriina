// The Summary calendars' numbers: shade steps, legend words and the
// Monday-first grids. No DOM here, so `node --test` covers it.

import { shift, weekStart } from "./dates.mjs";
import { fmt, NBSP } from "./format.mjs";

// The shade of `amount`: 0 for none, else 1–4 by `bounds` (each step's
// largest amount; above the last is 4).
export function step(amount, bounds) {
  if (!(amount > 0)) return 0;
  const i = bounds.findIndex((b) => amount <= b);
  return i === -1 ? 4 : i + 1;
}

// Step bounds for amounts of your own: quartiles of the period's non-zero
// amounts (nearest rank). With fewer than 4 distinct amounts each gets a
// step of its own, the largest the darkest.
export function quartiles(amounts) {
  const sorted = amounts.filter((a) => a > 0).toSorted((a, b) => a - b);
  const distinct = [...new Set(sorted)];
  if (distinct.length < 4)
    return [
      ...Array.from({ length: 4 - distinct.length }, () => 0),
      ...distinct,
    ].slice(0, 3);
  return [1, 2, 3].map((k) => sorted[Math.ceil((k * sorted.length) / 4) - 1]);
}

// A cell's amount, whole and grouped as every number on screen ("1,087"),
// compact from 10,000 so it fits a phone's cell ("10.5K"; its label says
// it whole).
const COMPACT = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
export const cellAmount = (v) =>
  Math.abs(v) >= 10_000 ? COMPACT.format(v) : fmt(Math.round(v));

const pad = (n) => String(n).padStart(2, "0");

// The month `ym` ("2026-10") as Monday-first weeks of 7: each a day
// ("2026-10-01") or null outside the month.
export function monthGrid(ym) {
  const [y, m] = ym.split("-").map(Number);
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const length = new Date(y, m, 0).getDate();
  const cells = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length }, (_, i) => `${ym}-${pad(i + 1)}`),
  ];
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, w) =>
    cells.slice(w * 7, w * 7 + 7),
  );
}

// The Monday-to-Sunday week `day` falls in.
export const weekRow = (day) =>
  Array.from({ length: 7 }, (_, i) => shift(weekStart(day), i));

// A year's 12 months, each with its grid.
export const yearMonths = (year) =>
  Array.from({ length: 12 }, (_, i) => {
    const month = `${year}-${pad(i + 1)}`;
    return { month, weeks: monthGrid(month) };
  });

// A legend's words for steps 1–4, unit on each: by `bounds` (upper bounds,
// as `step` reads them) "≤ 1 L", "1–1.5 L", "1.5–2 L", "> 2 L"; with a
// `goal` to reach (steps at half, ¾ and all of it, as `reachedStep`
// reads them) "< 1.3 L", "1.3–1.9 L", "1.9–2.5 L", "≥ 2.5 L (target)".
// `num` writes a bound in the unit.
export function legendWords(
  bounds,
  unit,
  { goal = null, num = (v) => fmt(v, 1) } = {},
) {
  const u = unit ? `${NBSP}${unit}` : "";
  const [a, b, c] = goal === null ? bounds : [goal / 2, (goal * 3) / 4, goal];
  const range = (x, y) => `${num(x)}–${num(y)}${u}`;
  return goal === null
    ? [
        `≤${NBSP}${num(a)}${u}`,
        range(a, b),
        range(b, c),
        `>${NBSP}${num(c)}${u}`,
      ]
    : [
        `<${NBSP}${num(a)}${u}`,
        range(a, b),
        range(b, c),
        `≥${NBSP}${num(c)}${u} (target)`,
      ];
}
