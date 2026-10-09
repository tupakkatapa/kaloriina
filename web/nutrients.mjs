// Nutrients as shown, from the server's registry (/api/meta): each with its
// EU label name, unit and factor over the stored value; plus number and unit
// formatting. No DOM here, so `node --test` covers it.

// The EU nutrition declaration, in label order.
export const MAIN = [
  "energy",
  "fat",
  "saturated",
  "net_carbs",
  "sugars",
  "fiber",
  "protein",
  "sodium",
];
export const KJ_PER_KCAL = 4.184;
// Targets shown up front; every other target sits under "Other nutrients".
export const KEY_TARGETS = ["energy", "protein", "net_carbs", "fat"];
export const KCAL_PER_G = { protein: 4, net_carbs: 4, fat: 9 };

// Which way a target points (from the nutrient's goal).
export const GOAL_SIGN = { at_least: "≥", at_most: "≤", about: "~" };
export const GOAL_HINT = {
  at_least: "at least",
  at_most: "at most",
  about: "about; up to 10\u00a0% over is fine",
};

// A no-break space: a number never wraps away from its unit.
export const NBSP = "\u00a0";

// Diary groups by their API names.
export const CONSUMED = "Consumed";
export const PLANNED = "Planned";
// A group as the UI names it: what you ate is "Eaten".
export const groupLabel = (group) => (group === CONSUMED ? "Eaten" : group);

// Where a food's values come from, as named to the user.
export const SOURCES = {
  custom: "your foods",
  recipe: "your recipes",
  off: "Open Food Facts",
  fineli: "Fineli",
};

// Share of `energy` kcal that `grams` of a macronutrient supply, whole %.
export const energyShare = (key, grams, energy) =>
  Math.round(((grams * KCAL_PER_G[key]) / energy) * 100);

export const isNil = (v) => v === null || v === undefined;

// "2,000" (about), "≥ 140" or "≤ 5", in the nutrient's display unit; a
// sign never wraps away from its number.
export function rangeOf(key, target) {
  const n = nutrient(key);
  const value = fmtNum(n.show(target.value));
  return n.goal === "about" ? value : `${GOAL_SIGN[n.goal]}${NBSP}${value}`;
}

// Energy shows in kcal or kJ, chosen per device. Stored values stay kcal.
export const ENERGY_UNITS = ["kcal", "kJ"];
const ENERGY_KEY = "energy-unit";

// This device's energy unit ("kcal" without a choice, or outside a browser).
export function energyUnit() {
  try {
    return localStorage.getItem(ENERGY_KEY) === "kJ" ? "kJ" : "kcal";
  } catch {
    return "kcal";
  }
}

// The registry, each nutrient with how it's shown: the display label and
// unit, and `show`/`store` converting stored ↔ shown. Set once per page;
// energy follows `unit`, so everything reading the registry (kcal(),
// fmtUnit, inputValue, targets, charts) shows that unit.
export let registry = [];
let served = [];

export function setRegistry(list, unit = energyUnit()) {
  served = list;
  registry = list.map((n) => {
    let d = n.display ?? { label: n.label, unit: n.unit, factor: 1 };
    if (n.key === "energy" && unit === "kJ")
      d = { ...d, unit: "kJ", factor: d.factor * KJ_PER_KCAL };
    return {
      ...n,
      label: d.label,
      unit: d.unit,
      show: (v) => v * d.factor,
      store: (v) => v / d.factor,
    };
  });
}

// Show energy in `unit` on this device from now on.
export function setEnergyUnit(unit) {
  localStorage.setItem(ENERGY_KEY, unit);
  setRegistry(served, unit);
}

export const nutrient = (key) => registry.find((n) => n.key === key);

// A nutrient's name with its unit, "Protein (g)"; a name that already ends
// in brackets takes the unit inside them: "Sugars (carbs, g)".
export const withUnit = (n) =>
  n.label.endsWith(")")
    ? `${n.label.slice(0, -1)}, ${n.unit})`
    : `${n.label} (${n.unit})`;
export const ordered = () => [
  ...MAIN.map(nutrient),
  ...registry.filter((n) => !MAIN.includes(n.key)),
];

// `list` (nutrients or rows with `.n`) split into the registry's sections, in
// registry order.
export function byCategory(list, of = (x) => x) {
  const sections = [...new Set(registry.map((n) => n.category))];
  return sections
    .map((c) => [
      c,
      registry
        .filter((n) => n.category === c)
        .flatMap((n) => list.filter((x) => of(x).key === n.key)),
    ])
    .filter(([, items]) => items.length);
}

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

// As few decimals as the size needs: "2,200", "26", "2.2", "0.26".
export const fmtNum = (v) =>
  fmt(v, Math.abs(v) >= 10 ? 0 : Math.abs(v) >= 1 ? 1 : 2);

// A number and its unit, never split: "26 g", "1,900 kcal", "– kcal".
export const qty = (value, unit, digits = null) =>
  `${digits === null ? fmtNum(value) : fmt(value, digits)}${NBSP}${unit}`;

// A stored amount in the nutrient's display unit: "3.1 g" for 1240 mg sodium.
export const fmtUnit = (key, value) => {
  const n = nutrient(key);
  return qty(n.show(value), n.unit);
};

// Energy (stored kcal) as read everywhere, in this device's unit:
// "1,900 kcal" or "7,950 kJ" ("– kcal" when unknown).
export function kcal(value) {
  const n = nutrient("energy");
  if (!n) return qty(value, "kcal", 0);
  return qty(isNil(value) ? value : n.show(value), n.unit, 0);
}

// For number inputs: display units, no float noise.
export const inputValue = (key, stored) =>
  isNil(stored) ? "" : String(+nutrient(key).show(stored).toFixed(3));

// "1 item", "3 items", "1.5 items": the word follows the number as shown
// (1.04 at no decimals reads "1 item").
export const plural = (n, word, words = `${word}s`, digits = 0) =>
  `${fmt(n, digits)} ${noun(n, word, words, digits)}`;

// The word alone, for a tile whose number stands apart: "day", "days".
export const noun = (n, word, words = `${word}s`, digits = 0) =>
  fmt(n, digits) === fmt(1) ? word : words;

// "your foods" → "Your foods".
export const capitalized = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Absolute amounts in `grams` of a food with these per-100 g values.
export const scaled = (per100, grams) =>
  Object.fromEntries(
    Object.entries(per100).map(([k, v]) => [k, (v * grams) / 100]),
  );

// Amounts added up, key by key; a nutrient missing everywhere stays missing.
export function summed(list) {
  const out = {};
  for (const amounts of list)
    for (const [k, v] of Object.entries(amounts)) out[k] = (out[k] ?? 0) + v;
  return out;
}

// Per-100 g values of a recipe, as the server computes them: the ingredients'
// amounts spread over the cooked weight (default: their total weight).
export function recipePer100(parts, cookedGrams) {
  const weight = cookedGrams || parts.reduce((total, p) => total + p.grams, 0);
  if (!(weight > 0)) return {};
  return scaled(
    summed(parts.map((p) => scaled(p.per100, p.grams))),
    10000 / weight,
  );
}
