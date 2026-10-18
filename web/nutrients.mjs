// Nutrients as shown, from the server's registry (/api/meta): each with its
// EU label name, unit and factor over the stored value; energy and amounts
// as read, coverage and recipe math. No DOM here, so `node --test` covers it.

import { fmt, fmtNum, isNil, NBSP, PER_100G, qty } from "./format.mjs";
import { sum } from "./stats.mjs";
import {
  ENERGY_KEY,
  energyUnit,
  LABEL_KEY,
  labelStyle,
  unitOf,
  unitQty,
} from "./units.mjs";

// The EU nutrition declaration, in label order.
const MAIN = [
  "energy",
  "fat",
  "saturated",
  "net_carbs",
  "sugars",
  "fiber",
  "protein",
  "sodium",
];
// The US Nutrition Facts label (21 CFR 101.9(d)) in its order, of what the
// registry holds: total carbs (fibre included) where the EU has net carbs.
const US_MAIN = [
  "energy",
  "fat",
  "saturated",
  "trans_fats",
  "cholesterol",
  "sodium",
  "carbs",
  "fiber",
  "sugars",
  "added_sugars",
  "protein",
  "vitamin_d",
  "calcium",
  "iron",
  "potassium",
];
const KJ_PER_KCAL = 4.184;
// Targets shown up front; every other target sits under "Other nutrients".
export const KEY_TARGETS = ["energy", "protein", "net_carbs", "fat"];
export const KCAL_PER_G = { protein: 4, net_carbs: 4, fat: 9 };

// Which way a target points (from the nutrient's goal).
export const GOAL_SIGN = { at_least: "≥", at_most: "≤", about: "~" };
export const GOAL_HINT = {
  at_least: "at least",
  at_most: "at most",
  about: "about; up to 10\u00A0% over is fine",
};

// "on", "under" or "over" `target` ({value, min, max}), the one judgement
// every view draws: over past `max`, under below `min`, else on (an "about"
// target's max is 10 % over; "at most" has no min, "at least" no max).
// null without a target.
export function judge(amount, target) {
  if (isNil(target?.value)) return null;
  if (!isNil(target.max) && amount > target.max) return "over";
  if (!isNil(target.min) && amount < target.min) return "under";
  return "on";
}

// Diary groups by their API names.
export const EATEN = "Eaten";
export const PLANNED = "Planned";

// Where a food's values come from, as named to the user, and the search
// scopes (`recipe`: your recipes, a food `kind`).
export const SOURCES = {
  custom: "your foods",
  recipe: "your recipes",
  off: "Open Food Facts",
  fineli: "Fineli",
};

// The sources a search covers: those `offered` (/api/meta.food_sources)
// that the saved filters (`hidden`) don't hide; never none, so a save
// hiding every database there is still finds food.
export function searchedSources(offered, saved) {
  const hidden = Array.isArray(saved?.hidden) ? saved.hidden : [];
  const shown = offered.filter((s) => !hidden.includes(s));
  return shown.length > 0 ? shown : [...offered];
}

// kcal per gram (Reg. 1169/2011 Annex XIV). KCAL_PER_G stays the three
// macro targets the Targets screen lists.
const SPLIT_KCAL = { ...KCAL_PER_G, fiber: 2, alcohol: 7 };
const SPLIT = ["protein", "net_carbs", "fiber", "fat", "alcohol"];
// A split part's name: the registry's short label ("Carbs", "Fiber" on
// the US label).
const short = (key) => nutrient(key)?.short ?? key;
const MACROS = ["protein", "net_carbs", "fat"];

// Where the energy of `grams` (a food's per 100 g, a day's targets)
// comes from: {parts: [{key, label, kcal, share %}], missing: [label]}.
// With a macro missing and the energy known, shares of the energy, what
// the given parts don't explain an "Unknown" part (yoghurt is 55 %
// protein, not 69 %); else shares of the parts' summed kcal (a label's
// rounding is no unknown). Null without protein, carbohydrate and fat, or
// without energy.
export function energySplit(grams) {
  if (!grams || MACROS.every((k) => isNil(grams[k]))) return null;
  const parts = SPLIT.map((key) => ({
    key,
    label: short(key),
    kcal: (grams[key] ?? 0) * SPLIT_KCAL[key],
  })).filter((p) => p.kcal > 0);
  const given = parts.reduce((t, p) => t + p.kcal, 0);
  if (!(given > 0)) return null;
  const missing = MACROS.filter((key) => isNil(grams[key])).map((x) =>
    short(x),
  );
  const rest = missing.length > 0 ? (grams.energy ?? 0) - given : 0;
  if (rest > 0) parts.push({ key: "unknown", label: "Unknown", kcal: rest });
  const total = given + Math.max(rest, 0);
  return {
    parts: parts.map((p) => ({ ...p, share: (p.kcal / total) * 100 })),
    missing,
  };
}

// A target bar's segments, % of the bar (the target): what's eaten, then
// what's planned after it; both stop at the bar's end.
export function barShares(eaten, total, goal) {
  const share = (v) => (goal > 0 ? Math.min(v / goal, 1) * 100 : 0);
  const fill = share(eaten);
  return { eaten: fill, planned: Math.max(share(total) - fill, 0) };
}

// "2,000" (about), "≥ 140" or "≤ 5", in the nutrient's display unit; a
// sign never wraps away from its number.
export function rangeOf(key, target) {
  const n = nutrient(key);
  const value = fmtNum(n.show(target.value));
  return n.goal === "about" ? value : `${GOAL_SIGN[n.goal]}${NBSP}${value}`;
}

// The registry, each nutrient with how it's shown: the display label and
// unit, and `show`/`store` converting stored ↔ shown. Set once per page;
// energy follows `unit`, the rest the label `style` (sodium as salt or
// sodium), so everything reading the registry (kcal(), fmtUnit,
// inputValue, targets, charts) shows those.
export let registry = [];
let served = [];
let style = "eu";

export function setRegistry(list, unit = energyUnit(), label = labelStyle()) {
  served = list;
  style = label;
  registry = list.map((n) => {
    let d = (label === "us" ? n.display_us : null) ??
      n.display ?? { label: n.label, unit: n.unit, factor: 1 };
    if (n.key === "energy" && unit === "kJ")
      d = { ...d, unit: "kJ", factor: d.factor * KJ_PER_KCAL };
    return {
      ...n,
      label: d.label,
      // Where room is tight: "Carbs" for net carbs on either label.
      short: d.short ?? d.label,
      unit: d.unit,
      show: (v) => v * d.factor,
      store: (v) => v / d.factor,
    };
  });
}

// Show energy in `unit` on this device from now on.
export function setEnergyUnit(unit) {
  localStorage.setItem(ENERGY_KEY, unit);
  setRegistry(served, unit, style);
}

// Read the EU or US label on this device from now on.
export function setLabelStyle(label) {
  localStorage.setItem(LABEL_KEY, label);
  setRegistry(served, energyUnit(), label);
}

// Whether the registry reads the US label.
export const usLabel = () => style === "us";

// The label's nutrients up front, in its order.
export const mainKeys = () => (style === "us" ? US_MAIN : MAIN);
// The carbohydrate the label types: total carbs (US) or net (EU); the
// other is derived from it and fibre.
export const typedCarbs = () => (style === "us" ? "carbs" : "net_carbs");
// Net carbs from a label's total: the total less fibre, only with both
// known (fibre unknown leaves the net unknown, never the total less 0).
export const netFromTotal = (total, fibre) =>
  isNil(total) || isNil(fibre) ? null : Math.max(total - fibre, 0);

// No %DV: protein's must be corrected by its PDCAAS (21 CFR
// 101.9(c)(7)(ii)), which needs its amino acids; without a protein claim
// the label may leave it out. Vitamin A is kept in µg RE (EFSA, the EU
// NRV), its DV is in µg RAE: plant sources would read up to twice theirs.
const NO_DV = new Set(["protein", "vitamin_a"]);

// A stored amount as a share of its FDA Daily Value, whole %; null without
// one (the US label's %DV).
export function dvShare(key, value) {
  const dv = !NO_DV.has(key) && nutrient(key)?.dv;
  return dv && !isNil(value) ? Math.round((value / dv) * 100) : null;
}

export const nutrient = (key) => registry.find((n) => n.key === key);

// A nutrient's name with its unit, "Protein (g)"; a name that already ends
// in brackets takes the unit inside them: "B1 (thiamine, mg)".
// A unit the label already names ("Steps", "Activities a week") isn't
// repeated.
export const withUnit = (n) =>
  n.label.toLowerCase().split(" ")[0] === n.unit.toLowerCase()
    ? n.label
    : n.label.endsWith(")")
      ? `${n.label.slice(0, -1)}, ${n.unit})`
      : `${n.label} (${n.unit})`;
export const ordered = () => [
  ...mainKeys().map((x) => nutrient(x)),
  ...registry.filter((n) => !mainKeys().includes(n.key)),
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

// A stored amount in the nutrient's display unit: "3.1 g" for 1240 mg sodium.
export const fmtUnit = (key, value) => {
  const n = nutrient(key);
  return qty(n.show(value), n.unit);
};

// Energy (stored kcal) in this device's unit, as its two parts: {value:
// "1,900", unit: "kcal"} ("–" when unknown). Text that sets the number
// apart from its unit takes these: a locale may group thousands with the
// very no-break space that joins the two, so formatted text never splits.
export function kcalParts(value) {
  const n = nutrient("energy");
  return {
    value: fmt(isNil(value) || !n ? value : n.show(value), 0),
    unit: n?.unit ?? "kcal",
  };
}

// Energy as read everywhere: "1,900 kcal" or "7,950 kJ" ("– kcal" when
// unknown).
export function kcal(value) {
  const { value: v, unit } = kcalParts(value);
  return `${v}${NBSP}${unit}`;
}

// Stored kcal as a whole number in this device's energy unit (an energy
// input's value or placeholder).
export const shownEnergy = (value) =>
  Math.round(nutrient("energy").show(value));

// For number inputs: display units, no float noise.
export const inputValue = (key, stored) =>
  isNil(stored) ? "" : String(+nutrient(key).show(stored).toFixed(3));

// Absolute amounts in `grams` of a food with these per-100 g values.
export const scaled = (per100, grams) =>
  Object.fromEntries(
    Object.entries(per100).map(([k, v]) => [k, (v * grams) / 100]),
  );

// Per-100 g values of `values` in `grams`: the inverse of `scaled`.
export const per100Of = (values, grams) => scaled(values, 10000 / grams);

// What a food's values are per, as its source gives them: a drink
// of yours or Open Food Facts' per 100 ml, as its label reads; Fineli's
// (weighed), a recipe's and any other food's per 100 g.
export const per100Basis = (food) =>
  food?.drink && food.kind !== "recipe" && food.source !== "fineli"
    ? `Per 100${NBSP}ml`
    : PER_100G;

// A food's, item's or entry's grams are a guess: its values were typed per a
// serving whose weight isn't known (a food's `basis.estimated`; items and
// entries carry `weight_estimated`). Its values per that serving are exact.
export const guessed = (x) =>
  Boolean(x?.basis?.estimated || x?.weight_estimated);

// At this share known a total reads as it is; under it, it is a lower
// bound ("≥ x") that no verdict (to go, low, on target) is drawn from.
export const KNOWN = 0.8;

// A day's mean of `key` over `days` ([{total}], the logged days): every
// day counts, one without it as 0, so under full coverage it is a lower
// bound as its total is. One definition for the Summary's averages and the
// warnings.
export const dailyMean = (days, key) =>
  days.length > 0
    ? Math.round(
        (sum(days.map((d) => d.total[key] ?? 0)) / days.length) * 1e9,
      ) / 1e9
    : 0;

// Totals with total carbohydrate never under net carbohydrate and fibre:
// foods that give only net carbs and fibre leave the summed total
// short of its own parts; the larger is the floor both are.
export function carbsFloor(totals) {
  const parts = (totals.net_carbs ?? 0) + (totals.fiber ?? 0);
  return isNil(totals.carbs) || totals.carbs >= parts
    ? totals
    : { ...totals, carbs: parts };
}

// A food day: one with energy eaten. A water-only day is none:
// not in a chart, a bucket, a calendar or a tally.
export const foodDay = (d) => (d.total.energy ?? 0) > 0;

// A share as a percentage that never rounds to all or none: "99 %" for
// 0.996, "< 1 %" for 0.004.
export function sharePct(share) {
  if (share >= 1) return `100${NBSP}%`;
  if (share > 0 && share < 0.01) return `<${NBSP}1${NBSP}%`;
  return `${fmt(Math.floor(share * 100))}${NBSP}%`;
}

// How `value`, a total of `key` with `share` of the food behind it carrying
// it, reads: {text, lower, judged, hint}. Any share short of all: "≥ x",
// `lower` (a floor), with `hint` "from 45 % of `of`"; at KNOWN or more it
// is still `judged` (ADR 0030), as a floor: what's left is "at most". A
// value with none behind it (what carried it is no part of the food's dry
// matter) is still a floor, never "–" over a real sum. None (no
// value): "–", no hint. `lower` forces the floor (energy with some
// unknown).
export function amountShown(
  key,
  value,
  share = 1,
  { of = "the day's food", lower: forced = null } = {},
) {
  const plain = key === "energy" ? kcal(value) : fmtUnit(key, value ?? 0);
  if (isNil(value))
    return { text: "–", lower: false, judged: false, hint: null };
  const judged = share >= KNOWN;
  const isLower = forced ?? share < 1;
  return {
    text: isLower ? `≥${NBSP}${plain}` : plain,
    lower: isLower,
    judged,
    hint: share < 1 ? `from ${sharePct(share)} of ${of}` : null,
  };
}

// Amounts added up, key by key; a nutrient missing everywhere stays missing.
export function summed(list) {
  const out = {};
  for (const amounts of list)
    for (const [k, v] of Object.entries(amounts)) out[k] = (out[k] ?? 0) + v;
  return out;
}

// How a food's values bear on hydration, for its panel (ADR 0020): what
// `grams` of it (else 100 g or ml) hydrates, its water less alcohol's
// debit, and per 100 beside an amount; caffeine named as no effect (coffee
// hydrates as water, Killer 2014); "Not counted" without a water value.
// `hydration` the food's (hydrationOf, or a recipe's from the server).
// In this device's unit: fl oz to a tenth under US units.
const ml = (v) => unitQty(Math.round(v), "ml", unitOf("ml") === "ml" ? 0 : 1);
export function hydrationText(
  hydration,
  { per100 = {}, grams = null, unit = "g" } = {},
) {
  if (!hydration) return "Hydration: not counted (no water value)";
  const at = (g) => {
    const water = (hydration.water * g) / 100;
    const debit = (hydration.alcohol * g) / 100;
    return `${ml(water - debit)}${debit > 0 ? ` (water ${ml(water)}, alcohol −${ml(debit)})` : ""}`;
  };
  const amount = isNil(grams) || grams === 100 ? null : grams;
  const caffeine =
    per100.caffeine > 0
      ? `; caffeine ${qty(Math.round(((amount ?? 100) * per100.caffeine) / 100), "mg", 0)}: no effect`
      : "";
  return amount
    ? `Hydration: ${at(amount)} in this amount, ${at(100)} per 100${NBSP}${unit}${caffeine}`
    : `Hydration: ${at(100)} per 100${NBSP}${unit}${caffeine}`;
}
