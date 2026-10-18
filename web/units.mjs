// Units as shown on this device: Metric or US (imperial). The server keeps
// metric (kg, cm, metres, ml, g); only what's shown and typed converts, here.
// An input left as shown sends the stored value back, so a save never drifts
// a value through rounding. No DOM here, so `node --test` covers it.

import { isNil, NBSP, qty } from "./format.mjs";

export const UNIT_SYSTEMS = [
  ["metric", "Metric"],
  ["us", "US (imperial)"],
];
const KEY = "units";

// This device's units ("metric" without a choice, or outside a browser).
export function unitSystem() {
  try {
    return localStorage.getItem(KEY) === "us" ? "us" : "metric";
  } catch {
    return "metric";
  }
}

export function setUnitSystem(system) {
  localStorage.setItem(KEY, system);
}

// Energy shows in kcal or kJ, chosen per device. Stored values stay kcal.
// nutrients.mjs's setEnergyUnit saves the choice and re-reads the registry.
export const ENERGY_UNITS = ["kcal", "kJ"];
export const ENERGY_KEY = "energy-unit";

// This device's energy unit ("kcal" without a choice, or outside a browser).
export function energyUnit() {
  try {
    return localStorage.getItem(ENERGY_KEY) === "kJ" ? "kJ" : "kcal";
  } catch {
    return "kcal";
  }
}

// The nutrition label read on this device: EU (per 100 g, net carbs, salt)
// or US (per serving, total carbs, sodium, %DV). Stored values never change;
// nutrients.mjs's setLabelStyle saves the choice.
export const LABEL_STYLES = [
  ["eu", "EU"],
  ["us", "US"],
];
export const LABEL_KEY = "label-style";

// This device's label ("eu" without a choice, or outside a browser).
export function labelStyle() {
  try {
    return localStorage.getItem(LABEL_KEY) === "us" ? "us" : "eu";
  } catch {
    return "eu";
  }
}

// Exact by definition (NIST): 1 lb = 0.45359237 kg, 1 in = 2.54 cm,
// 1 mi = 1.609344 km, 1 US fl oz = 29.5735295625 ml, 1 oz = 28.349523125 g.
const LB_KG = 0.45359237;
const IN_CM = 2.54;
export const MI_M = 1609.344;
// 100 yd in metres: a US pool's pace.
export const YD100_M = 91.44;
const FL_OZ_ML = 29.5735295625;
const OZ_G = 28.349523125;

// A metric unit's US one: [unit, shown per metric unit, input decimals].
const US = {
  kg: ["lb", 1 / LB_KG, 1],
  cm: ["in", 1 / IN_CM, 1],
  km: ["mi", 1000 / MI_M, 2],
  L: ["fl oz", 1000 / FL_OZ_ML, 0],
  ml: ["fl oz", 1 / FL_OZ_ML, 1],
  g: ["oz", 1 / OZ_G, 1],
};
// Compound units ("kg/week") convert by their first part.
const parts = (unit) => {
  const i = unit.indexOf("/");
  return i < 0 ? [unit, ""] : [unit.slice(0, i), unit.slice(i)];
};

// A display (`shown = stored × factor` in `unit`) as this device shows it:
// a metric unit becomes its US one under US units; anything else (%, kcal,
// steps) is left alone.
export function localDisplay({ unit, factor = 1 }, system = unitSystem()) {
  const [head, tail] = parts(unit);
  const us = system === "us" && US[head];
  return us ? { unit: us[0] + tail, factor: factor * us[1] } : { unit, factor };
}

// The unit a metric `unit` reads in on this device: "lb" for "kg" under US.
export const unitOf = (unit, system = unitSystem()) =>
  localDisplay({ unit }, system).unit;
export const toShown = (stored, unit, system = unitSystem()) =>
  stored * localDisplay({ unit }, system).factor;
export const toStored = (shown, unit, system = unitSystem()) =>
  shown / localDisplay({ unit }, system).factor;

// A stored amount as read: "80 kg" or "176.4 lb" (`digits` as `qty`).
export const unitQty = (stored, unit, digits = null, system = unitSystem()) =>
  qty(
    isNil(stored) ? stored : toShown(stored, unit, system),
    unitOf(unit, system),
    digits,
  );

// A number input's text for a stored value: metric as stored (no float
// noise), US to the unit's decimals; "" when unknown.
export function inputText(stored, unit, system = unitSystem()) {
  if (isNil(stored) || stored === "") return "";
  const us = system === "us" && US[parts(unit)[0]];
  return String(+toShown(Number(stored), unit, system).toFixed(us ? us[2] : 3));
}

// A typed number, whatever the locale: one decimal separator, `,` or `.`
// ("1,5" and "1.5" are 1.5); null when empty; NaN for anything else, a
// grouping separator included ("1 234,5", "1,234.5", and "5,000" as the
// app itself prints thousands: a comma before exactly three digits after
// a nonzero whole, "0,125" still a decimal): refused, never guessed. The
// one parser every number input reads through.
const NUMBER = /^[-−]?(\d+[.,]?\d*|[.,]\d+)$/u;
const THOUSANDS = /^[-−]?[1-9]\d{0,2},\d{3}$/u;
export function parseNum(text) {
  const t = String(text).trim();
  if (t === "") return null;
  return NUMBER.test(t) && !THOUSANDS.test(t)
    ? Number(t.replace(",", ".").replace("−", "-"))
    : NaN;
}

// What an input's `text` stores: null when empty; `before` itself when the
// text is still what `inputText(before)` showed (no drift); else converted.
export function readInput(text, before, unit, system = unitSystem()) {
  if (text === "") return null;
  if (!isNil(before) && text === inputText(before, unit, system))
    return Number(before);
  return toStored(parseNum(text), unit, system);
}

// -------------------------------------------------------------- height

// Whole feet and inches for `cm`: 178 → [5, 10] (never 12 inches).
export function feetInches(cm) {
  const inches = Math.round(cm / IN_CM);
  return [Math.floor(inches / 12), inches % 12];
}
export const fromFeetInches = (ft, inches) => (ft * 12 + inches) * IN_CM;

// "178 cm" or "5 ft 10 in".
export function heightText(cm, system = unitSystem()) {
  if (system !== "us" || isNil(cm)) return qty(cm, "cm", 0);
  const [ft, inches] = feetInches(cm);
  return `${ft}${NBSP}ft ${inches}${NBSP}in`;
}

// ------------------------------------------------------------ distance

// "8.2 km" or "5.1 mi" for metres; null without a distance.
export const distanceText = (metres, system = unitSystem()) =>
  isNil(metres) ? null : unitQty(metres / 1000, "km", 2, system);
