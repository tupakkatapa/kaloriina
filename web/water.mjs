// Logging water: one action, shared by every screen that offers it.

import { keptHere, logged } from "./actions.mjs";
import { api, createId, get, meta, scoped, stored } from "./api.mjs";
import { eatenTime } from "./dates.mjs";
import { fmt, qty } from "./format.mjs";
import { waterText } from "./habits.mjs";
import { href } from "./nav.mjs";
import { chip, field, formDialog, h, unitNum, unitValue } from "./ui.mjs";
import {
  inputText,
  toShown,
  toStored,
  unitOf,
  unitQty,
  unitSystem,
} from "./units.mjs";

// Stored limits [min, max] in `unit` as this device shows them, rounded
// inward to `digits` decimals: the hint, the input's bounds and its check
// alike, so every value they take converts back inside the stored ones.
export function shownBounds([min, max], unit, digits = 1) {
  const f = 10 ** digits;
  // Float noise ("5000.000001") never moves a bound a step.
  return [
    Math.ceil(toShown(min, unit) * f - 1e-6) / f,
    Math.floor(toShown(max, unit) * f + 1e-6) / f,
  ];
}

// The amount the last water logged on this device, offered next time.
const WATER_KEY = "water-ml";
// One-tap amounts beside the field (ml): a glass and a bottle, or 8 and
// 16 fl oz in US units.
const waterChips = () =>
  unitSystem() === "us" ? [8, 16].map((n) => toStored(n, "ml")) : [250, 500];

// Water (the Add screen's row and the Log sheet's Hydration): how many
// ml, asked in a dialog (the last amount filled in), logged as as many
// grams of the profile's water food (Habits); waits on this device when
// offline. `water`: the water food's answer, fetched ahead, if it was.
export async function addWater(day, group, water = null) {
  const key = createId();
  const [low, high] = shownBounds(meta.limits.water_ml, "ml");
  const range = `${fmt(low, 1)}–${qty(high, unitOf("ml"), 1)}`;
  const last = localStorage.getItem(WATER_KEY);
  const ml = unitNum({
    name: "ml",
    required: true,
    unit: "ml",
    inputMode: unitSystem() === "us" ? "decimal" : "numeric",
    value: last === null ? null : Number(last),
  });
  [ml.min, ml.max] = [low, high];
  const chips = h(
    "div",
    { class: "chips" },
    waterChips().map((n) =>
      chip(unitQty(n, "ml", 0), () => {
        ml.value = inputText(n, "ml");
        ml.focus();
      }),
    ),
  );
  let kept = null;
  let entries = null;
  const added = await formDialog(`Water to ${group}`, {
    body: [field(`Amount (${unitOf("ml")})`, ml, { hint: range }), chips],
    submit: "Add",
    run: async () => {
      const amount = unitValue(ml);
      const shown = amount === null ? null : toShown(amount, "ml");
      if (shown === null || shown < low - 1e-9 || shown > high + 1e-9)
        throw Object.assign(new Error(`Enter ${range}.`), { field: "ml" });
      const food = ((await water) ?? (await get(scoped("/water-food")))).food;
      if (!food)
        throw Object.assign(
          new Error("No water food yet: pick one in Habits."),
          { link: { href: href.habits(), text: "Habits" } },
        );
      const done = await stored(async () => {
        ({ entries } = await api(
          "POST",
          scoped("/entries"),
          {
            uid: key.get(),
            day,
            group,
            food_id: food.id,
            grams: amount,
            time: eatenTime(day, group),
          },
          { queue: true, label: `Water ${waterText(meta.habits, amount)}` },
        ));
      });
      if (done !== true) kept = done.queued;
      key.done();
      localStorage.setItem(WATER_KEY, String(amount));
      return amount;
    },
  });
  if (added === null) return;
  if (kept) return keptHere(kept, day);
  logged(day, group, `Water ${waterText(meta.habits, added)}`, entries);
}
