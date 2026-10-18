// All time's perspectives: totals said as everyday things. Approximate by
// design; each constant names its source. No DOM here, so `node --test`
// covers it.

import { fmt, noun, qty } from "./format.mjs";
import { kcal } from "./nutrients.mjs";
import { unitQty } from "./units.mjs";

export const FUN = {
  // A cup (240 ml) of brewed coffee (USDA FoodData Central 171890).
  coffeeMg: 95,
  // Density of ethanol at 20 °C, g/L.
  ethanolGPerL: 789,
  // A medium potato (USDA FoodData Central 170093).
  potatoG: 170,
  // Retail beef from one steer, about 40 % of its live weight.
  cowBeefKg: 200,
  // A large egg and a medium banana (USDA FoodData Central).
  eggKcal: 70,
  bananaKcal: 105,
  marathonKm: 42.195,
  // Earth's equator.
  earthKm: 40_075,
  // A McDonald's double cheeseburger (McDonald's US nutrition facts).
  burgerKcal: 450,
};

// A count as few digits as it needs: "12", "1.5".
const digits = (v) => (v >= 10 ? 0 : 1);

// `stats` (`/stats`) and `burned` (kcal, the energy model's, mostly resting
// energy; null when unknown) as `[{key, value, shown, text, long, about}]`:
// `shown` the count written, `text` what it counts (its plural following
// `shown`), `long` which total it says again, `about` the constant behind it
// in words (or null). Only those of at least 1
// (a fraction of a cow is noise), and beef and potatoes only when the foods'
// classes are known (`stats.classes_known`). A lower bound (`/stats`
// `at_least`, beef and potatoes always) is shown "≥", the energy model's
// burgers "≈".
export function perspectives(stats, burned) {
  // `mark`: "≥ " for a lower bound, "≈ " for a model's estimate.
  const counted = (key, value, one, many, long, about = null, mark = "") => ({
    key,
    value,
    shown: `${mark}${fmt(value, digits(value))}`,
    text: noun(value, one, many, digits(value)),
    long,
    about,
  });
  const litres = stats.alcohol_g / FUN.ethanolGPerL;
  const least = (key) => (stats.at_least?.includes(key) ? "≥ " : "");
  const all = [
    counted(
      "coffee",
      stats.caffeine_mg / FUN.coffeeMg,
      "cup of coffee, in caffeine",
      "cups of coffee, in caffeine",
      "All the caffeine you logged, as cups of brewed coffee.",
      `a cup of coffee ${qty(FUN.coffeeMg, "mg", 0)} caffeine`,
      least("caffeine"),
    ),
    {
      key: "ethanol",
      value: litres,
      shown: `${least("alcohol")}${unitQty(litres, "L", 1)}`,
      text: "of pure alcohol",
      long: "All the alcohol you logged, as litres of pure ethanol.",
      about: null,
    },
    stats.classes_known &&
      counted(
        "potatoes",
        stats.potato_g / FUN.potatoG,
        "potato",
        "potatoes",
        "The potatoes in what you logged (at least), as medium potatoes.",
        `a potato ${unitQty(FUN.potatoG, "g", 0)}`,
        "≥ ",
      ),
    stats.classes_known &&
      counted(
        "cows",
        stats.beef_g / 1000 / FUN.cowBeefKg,
        "cow's worth of beef",
        "cows' worth of beef",
        "The beef in what you logged (at least), as the retail beef of one steer.",
        `a cow ${unitQty(FUN.cowBeefKg, "kg", 0)} of beef`,
        "≥ ",
      ),
    counted(
      "eggs",
      stats.kcal_eaten / FUN.eggKcal,
      "egg's worth of energy eaten",
      "eggs' worth of energy eaten",
      "All the energy you ate, as large eggs.",
      `an egg ${kcal(FUN.eggKcal)}`,
    ),
    counted(
      "bananas",
      stats.kcal_eaten / FUN.bananaKcal,
      "banana's worth",
      "bananas' worth",
      "All the energy you ate, as medium bananas.",
      `a banana ${kcal(FUN.bananaKcal)}`,
    ),
    counted(
      "marathons",
      stats.distance_m / 1000 / FUN.marathonKm,
      "marathon",
      "marathons",
      `Your activities' distance, as marathons (${unitQty(FUN.marathonKm, "km", 1)}).`,
    ),
    counted(
      "earth",
      stats.distance_m / 1000 / FUN.earthKm,
      "time around the Earth",
      "times around the Earth",
      `Your activities' distance, as trips around the equator (${unitQty(FUN.earthKm, "km", 0)}).`,
    ),
    counted(
      "asleep",
      stats.asleep_min / 1440,
      "day asleep",
      "days asleep",
      "All your time asleep, as whole days of 24 hours.",
    ),
    counted(
      "burgers",
      (burned ?? 0) / FUN.burgerKcal,
      "burger's worth of energy used, mostly resting",
      "burgers' worth of energy used, mostly resting",
      "An estimate of all the energy you burned on days with food logged, most of it at rest, as double cheeseburgers.",
      `a burger ${kcal(FUN.burgerKcal)}`,
      "≈ ",
    ),
  ];
  return all.filter((p) => p && p.value >= 1);
}

// "About: a cup of coffee 95 mg caffeine, a burger 450 kcal.": the
// constants behind the `shown` perspectives; null when none has one.
export function aboutLine(shown) {
  const said = shown.map((p) => p.about).filter(Boolean);
  return said.length > 0 ? `About: ${said.join(", ")}.` : null;
}
