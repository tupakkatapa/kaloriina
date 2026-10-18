// How much of a food: a quantity of one of its servings, or grams, read the
// same wherever an amount is entered, new or already logged.

import { fmt, isNil, PER_100G } from "./format.mjs";
import { guessed, per100Basis, scaled } from "./nutrients.mjs";
import { h, num, POSITIVE } from "./ui.mjs";
import { inputText, labelStyle, readInput, unitOf, unitQty } from "./units.mjs";

// A recipe's serving of all of it, and of one portion when it makes some;
// the server keeps their grams at the recipe's weight (÷ portions).
export const WHOLE = "Whole recipe";
export const PORTION = "Portion";

// A food logged by volume: a drink whose values are per 100 ml
// (`per100Basis`); its grams read as ml, 1 g to 1 ml as the Water food's.
export const byVolume = (food) => per100Basis(food) !== PER_100G;

// A serving's label that already says how much it is (`weight` as read):
// the same weight ("1 serving (130 g)"), or a drink's volume ("250 ml",
// "0,33 l bottle").
const VOLUME = /\d\s*(ml|cl|dl|l)\b/iu;
const says = (label, weight, volume) =>
  label.replaceAll(/\s/gu, "").endsWith(`(${weight.replaceAll(/\s/gu, "")})`) ||
  (volume && VOLUME.test(label));

// "2 × Slice (80 g)": `quantity` of `serving`, with what it weighs; one
// serving that already says so reads alone ("1 × Can 0,33 l").
export const servingText = (quantity, serving, weight, volume = false) =>
  quantity === 1 && says(serving, weight, volume)
    ? `${fmt(quantity, 2)} × ${serving}`
    : `${fmt(quantity, 2)} × ${serving} (${weight})`;

// "210 g" (or "7.4 oz" in US units), "≈210 g" when the weight is a guess
// (`approx`); by `volume` (`byVolume`) "250 ml", from 1 L "1.3 L".
export const weightText = (grams, approx, digits = 1, volume = false) =>
  `${approx ? "≈" : ""}${
    volume
      ? grams >= 1000
        ? unitQty(grams / 1000, "L", 1)
        : unitQty(grams, "ml", 0)
      : unitQty(grams, "g", digits)
  }`;

// A serving as a unit to pick: "Slice (40 g)", "Burger (≈210 g)"; one that
// already says how much alone.
export function unitLabel(s, approx, volume = false) {
  const weight = weightText(s.grams, approx, 1, volume);
  return says(s.label, weight, volume) ? s.label : `${s.label} (${weight})`;
}

// How much an entry or item is, as read: "2 × Burger (≈420 g)", "150 g",
// a drink's (`by_volume`, the server's `byVolume`) "500 ml". `weight`
// overrides how its grams read.
export const amountText = (
  x,
  weight = weightText(x.grams, guessed(x), 1, x.by_volume),
) =>
  x.serving ? servingText(x.quantity, x.serving, weight, x.by_volume) : weight;

// A nutrition panel's first column for `food`: per 100 g (a drink's per
// 100 ml, `per100Basis`), or on the US label per its basis serving (else
// its first), as its label reads.
export function basisColumn(food, per100 = food.per100) {
  const s =
    labelStyle() === "us" &&
    (food.servings?.find((x) => x.label === food.basis?.serving) ??
      food.servings?.[0]);
  // A recipe's coverage (`known`, per 100 g) scales with its values.
  const known = food.known;
  return s
    ? {
        label: `Per ${unitLabel(s, guessed(food), byVolume(food))}`,
        values: scaled(per100, s.grams),
        known,
      }
    : { label: per100Basis(food), values: per100, known };
}

// A food's default serving (undefined: none): its first, but one portion
// while a recipe makes some and its whole leads.
const defaultServing = (food) =>
  food.makes && food.servings[0]?.label === WHOLE
    ? (food.servings.find((s) => s.label === PORTION) ?? food.servings[0])
    : food.servings[0];

// The quantity field and unit menu for `food`, starting from `start`
// ({grams} or {serving, quantity}; grams when that serving is gone; the
// food's default serving, else 100 g, when absent). `label` names the
// fields ("Oats quantity") where several share a screen. `body()` is what
// the API takes; `grams()` what it makes. Weight reads in this device's
// units (g, or oz in US units); left as shown, the grams go back as given.
export function amountControl(
  food,
  start = null,
  onChange = () => {},
  label = "",
) {
  // A drink by volume is typed in ml (fl oz), 1 ml to 1 g.
  const volume = byVolume(food);
  const stored = volume ? "ml" : "g";
  const weightUnit = unitOf(stored);
  const units = [...food.servings, { label: weightUnit, grams: null }];
  const isWeight = (i) => i === units.length - 1;
  const startServing = start?.serving
    ? units.findIndex((u) => u.label === start.serving)
    : -1;
  const startUnit = start
    ? startServing >= 0
      ? startServing
      : units.length - 1
    : Math.max(0, units.indexOf(defaultServing(food)));
  // The grams the weight unit starts from, if it does.
  const startGrams = start
    ? startServing >= 0
      ? null
      : start.grams
    : food.servings.length > 0
      ? null
      : 100;
  const startQty = isNil(startGrams)
    ? (start?.quantity ?? 1)
    : inputText(startGrams, stored);
  const unit = h(
    "select",
    {
      name: "unit",
      "aria-label": label ? `${label} unit` : "Unit",
      onchange: () => onChange(),
    },
    units.map((u, i) =>
      h(
        "option",
        { value: i, selected: i === startUnit },
        isWeight(i) ? weightUnit : unitLabel(u, guessed(food), volume),
      ),
    ),
  );
  const quantity = num({
    name: "quantity",
    value: startQty,
    min: POSITIVE,
    required: true,
    "aria-label": label ? `${label} quantity` : "Quantity",
    oninput: () => onChange(),
  });
  const chosen = () => units[Number(unit.value)];
  const grams = () =>
    isWeight(Number(unit.value))
      ? (readInput(quantity.value, startGrams, stored) ?? 0)
      : Number(quantity.value) * chosen().grams;
  const body = () =>
    isWeight(Number(unit.value))
      ? { grams: grams() }
      : { serving: chosen().label, quantity: Number(quantity.value) };
  const node = h("div", { class: "row amount" }, quantity, unit);
  return { node, body, grams };
}
