// How much of a food: a quantity of one of its servings, or grams, read the
// same wherever an amount is entered, new or already logged.

import { qty } from "./nutrients.mjs";
import { POSITIVE, h, num } from "./ui.mjs";

// The serving of one portion of a recipe that makes some (server-kept).
const PORTION = "Portion";

// The quantity field and unit menu for `food`, starting from `start`
// ({grams} or {serving, quantity}; the food's default serving, else 100 g,
// when absent; a recipe that makes portions: one). `body()` is what the API
// takes; `grams()` what it makes.
export function amountControl(food, start = null, onChange = () => {}) {
  const units = [...food.servings, { label: "g", grams: 1 }];
  // A recipe that makes portions is likely eaten one at a time.
  const startUnit = Math.max(
    0,
    start
      ? start.serving
        ? units.findIndex((u) => u.label === start.serving)
        : units.length - 1
      : food.makes
        ? units.findIndex((u) => u.label === PORTION)
        : 0,
  );
  const startQty = start
    ? start.serving
      ? start.quantity
      : start.grams
    : food.servings.length
      ? 1
      : 100;
  const unit = h(
    "select",
    { name: "unit", "aria-label": "Unit", onchange: () => onChange() },
    units.map((u, i) =>
      h(
        "option",
        { value: i, selected: i === startUnit },
        u.label === "g" ? "g" : `${u.label} (${qty(u.grams, "g", 1)})`,
      ),
    ),
  );
  const quantity = num({
    name: "quantity",
    value: startQty,
    min: POSITIVE,
    required: true,
    "aria-label": "Quantity",
    oninput: () => onChange(),
  });
  const chosen = () => units[Number(unit.value)];
  const grams = () => Number(quantity.value) * chosen().grams;
  const body = () =>
    unit.value === String(units.length - 1)
      ? { grams: Number(quantity.value) }
      : { serving: chosen().label, quantity: Number(quantity.value) };
  const node = h("div", { class: "row amount" }, quantity, unit);
  return { node, body, grams };
}
