// Numbers and words as read: grouped numbers, a number and its unit never
// split, plurals. No DOM here, so `node --test` covers it.

export const isNil = (v) => v === null || v === undefined;

// A no-break space: a number never wraps away from its unit.
export const NBSP = "\u00A0";

// A phrase that never breaks across lines: its spaces no-break ones. A
// line of parts (" · " between them) wraps between parts only.
export const whole = (text) => text.replaceAll(" ", NBSP);

// The basis of a food's values, as its label reads.
export const PER_100G = `Per 100${NBSP}g`;

// A number as text: grouped, at most `digits` decimals; "–" when unknown.
// One formatter per `digits`, built on first use: building one costs ~50
// calls to it.
const NUMBER = new Map();
export function fmt(value, digits = 0) {
  if (isNil(value) || Number.isNaN(value)) return "–";
  let f = NUMBER.get(digits);
  if (!f) {
    f = new Intl.NumberFormat(undefined, { maximumFractionDigits: digits });
    NUMBER.set(digits, f);
  }
  return f.format(value);
}

// A number to exactly `digits` decimals: "3.6", "25.0" (a BMI, a scale's
// mean), where a dropped zero would read as a different precision.
const FIXED = new Map();
export function fmtFixed(value, digits) {
  let f = FIXED.get(digits);
  if (!f) {
    f = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    FIXED.set(digits, f);
  }
  return f.format(value);
}

// As few decimals as the size needs: "2,200", "26", "2.2", "0.26".
export const fmtNum = (v) =>
  fmt(v, Math.abs(v) >= 10 ? 0 : Math.abs(v) >= 1 ? 1 : 2);

// A number and its unit, never split: "26 g", "1,900 kcal", "– kcal".
export const qty = (value, unit, digits = null) =>
  `${digits === null ? fmtNum(value) : fmt(value, digits)}${NBSP}${unit}`;

// A percentage and its sign, never split: "12 %"; `digits` as qty's.
export const pct = (value, digits = 0) => qty(value, "%", digits);

// "1 item", "3 items", "1.5 items": the word follows the number as shown
// (1.04 at no decimals reads "1 item").
export const plural = (n, word, words = `${word}s`, digits = 0) =>
  `${fmt(n, digits)} ${noun(n, word, words, digits)}`;

// What a food's save or merge (answer `x`) did to the diary, for its
// toast: " · 14 diary entries updated", or nothing.
export const entriesUpdated = (x) =>
  x.entries_updated
    ? ` · ${plural(x.entries_updated, "diary entry", "diary entries")} updated`
    : "";

// The word alone, for a tile whose number stands apart: "day", "days".
export const noun = (n, word, words = `${word}s`, digits = 0) =>
  fmt(n, digits) === fmt(1) ? word : words;

// "your foods" → "Your foods".
export const capitalized = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// "Vitamin C" → "vitamin C" mid-sentence; "EPA" and "B12" stay.
export const lower = (label) =>
  /^[A-Z][a-z]/u.test(label) ? label[0].toLowerCase() + label.slice(1) : label;

// A countdown (a run step's time left, a pace): "0:45", "1:30".
export const countdown = (seconds) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
