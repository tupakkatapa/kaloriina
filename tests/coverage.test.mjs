// Coverage (web/coverage.mjs, ADR 0030): a total is
// only as complete as the food behind it, weighed by its dry matter.
// `coverage`, the one daily mean, how a partial total reads
// (`amountShown`) and a recipe's `known` (`recipeKnown`, as
// src/model/coverage.rs computes it).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  coverage,
  dryOf,
  hydrationOf,
  knownOnly,
  recipeKnown,
  recipePer100,
  waterOf,
  wholeOf,
} from "../web/coverage.mjs";
import {
  amountShown,
  carbsFloor,
  dailyMean,
  hydrationText,
  setRegistry,
  sharePct,
} from "../web/nutrients.mjs";

setRegistry([
  { key: "energy", label: "Energy", unit: "kcal", goal: "about" },
  { key: "iron", label: "Iron", unit: "mg", goal: "at_least" },
  { key: "caffeine", label: "Caffeine", unit: "mg", goal: "at_most" },
]);

const plain = (t) => t.replaceAll("\u00A0", " ");

// The server's cases (tests/fixtures/coverage-cases.json,
// read by src/model/coverage.rs and src/db/foods.rs too): the same keys,
// each value within 1e-9.
const CASES = JSON.parse(
  readFileSync(new URL("fixtures/coverage-cases.json", import.meta.url)),
);
const near = (got, want, what) => {
  assert.deepEqual(
    Object.keys(got).toSorted(),
    Object.keys(want).toSorted(),
    what,
  );
  for (const [k, v] of Object.entries(want))
    assert.ok(Math.abs(got[k] - v) < 1e-9, `${what} ${k}: ${got[k]} vs ${v}`);
};

test("recipePer100 and recipeKnown agree with the server's cases", () => {
  for (const c of CASES.recipes) {
    near(recipePer100(c.parts, c.cooked_g), c.per100, `${c.name} per100`);
    near(recipeKnown(c.parts, c.cooked_g), c.known, `${c.name} known`);
  }
});

test("coverage of one total is the server's share", () => {
  for (const c of CASES.shares)
    assert.equal(coverage([c], c.key), c.share, c.why);
});

// A day of 400 g dry matter with `iron` and its `known` shares.
const day = (iron, known = {}) => ({
  total: { energy: 2000, iron },
  known: { dry: 400, ...known },
});

test("coverage: a key the total lacks is none, one `known` omits is full", () => {
  assert.equal(coverage([day(9)], "iron"), 1);
  assert.equal(coverage([day()], "iron"), 0);
  assert.equal(coverage([day(9, { iron: 0.75 })], "iron"), 0.75);
  // Over the period's dry matter: a day without the key adds its weight.
  assert.equal(coverage([day(9), day()], "iron"), 0.5);
  // One food's column (no dry matter given): its share.
  assert.equal(coverage([{ total: { iron: 1 } }], "iron"), 1);
  assert.equal(coverage([{ total: {} }], "iron"), 0);
  assert.equal(coverage([], "iron"), 0);
  // Caffeine, by what could hold it: a day that ate none of it is a known
  // none, not a day of unknown caffeine.
  const coffee = { total: { caffeine: 120 }, known: { dry: 200 } };
  const pizza = { total: { energy: 900 }, known: { dry: 200 } };
  assert.equal(coverage([coffee, pizza], "caffeine"), 1);
});

test("dailyMean: every logged day counts, one without the key as 0", () => {
  const days = [{ total: { iron: 6 } }, { total: { iron: 3 } }, { total: {} }];
  // 9 / 3, not 9 / 2 (the old mean over the days that had it).
  assert.equal(dailyMean(days, "iron"), 3);
  assert.equal(dailyMean([], "iron"), 0);
  // No float drift: 0.1 + 0.2 over 3.
  assert.equal(
    dailyMean([{ total: { iron: 0.1 } }, { total: { iron: 0.2 } }], "iron"),
    0.15,
  );
});

test("amountShown: known as is, partial a floor, none a dash", () => {
  const shown = (...a) => {
    const r = amountShown(...a);
    return { ...r, text: plain(r.text), hint: r.hint && plain(r.hint) };
  };
  assert.deepEqual(shown("iron", 9, 1), {
    text: "9 mg",
    lower: false,
    judged: true,
    hint: null,
  });
  // At 80 % it is judged, the share said; still a floor, so "≥".
  assert.deepEqual(shown("iron", 9, 0.8), {
    text: "≥ 9 mg",
    lower: true,
    judged: true,
    hint: "from 80 % of the day's food",
  });
  // Under 80 %: "≥", no verdict.
  assert.deepEqual(shown("iron", 9, 0.45, { of: "the week's food" }), {
    text: "≥ 9 mg",
    lower: true,
    judged: false,
    hint: "from 45 % of the week's food",
  });
  // A value nothing weighed carried (a tablet in a sea of food) is
  // a floor, never "–" over a real sum.
  assert.deepEqual(shown("iron", 9, 0), {
    text: "≥ 9 mg",
    lower: true,
    judged: false,
    hint: "from 0 % of the day's food",
  });
  // No value: "–", never "0 mg".
  assert.deepEqual(shown("iron", null, 1), {
    text: "–",
    lower: false,
    judged: false,
    hint: null,
  });
  // Energy is a floor whenever any is unknown.
  assert.equal(shown("energy", 1900, 0.95).text, "≥ 1,900 kcal");
  assert.equal(shown("energy", 1900, 0.95).judged, true);
  assert.equal(shown("energy", 1900, 1).text, "1,900 kcal");
  // `lower` forces the mark (a floor known from elsewhere).
  assert.equal(shown("iron", 9, 1, { lower: true }).text, "≥ 9 mg");
});

// A share short of all never reads "100 %", one above none
// never "0 %".
test("sharePct: never all or none unless it is", () => {
  assert.equal(plain(sharePct(0.996)), "99 %");
  assert.equal(plain(sharePct(0.004)), "< 1 %");
  assert.equal(plain(sharePct(0)), "0 %");
  assert.equal(plain(sharePct(0.455)), "45 %");
  assert.equal(
    plain(amountShown("energy", 1503, 0.9995).hint),
    "from 99 % of the day's food",
  );
});

test("knownOnly keeps energy and the keys known at 80 %", () => {
  const values = { energy: 200, iron: 2, fat: 5 };
  assert.deepEqual(knownOnly(values, { iron: 0.5, fat: 0.8, dry: 50 }), {
    energy: 200,
    fat: 5,
  });
  assert.equal(knownOnly(values, null), values);
});

test("waterOf and dryOf: a water value, a drink's estimate, else all dry", () => {
  assert.equal(waterOf({ water: 38 }, 100, false), 38);
  assert.ok(
    Math.abs(waterOf({ net_carbs: 10.6, protein: 0.1 }, 100, true) - 89.3) <
      1e-9,
  );
  assert.equal(waterOf({ net_carbs: 10 }, 100, false), null);
  assert.equal(waterOf({}, 100, true), null);
  assert.equal(dryOf({ vitamin_c: 60 }, 4.3, false), 4.3);
  assert.equal(dryOf({ water: 700 }, 700, true), 0);
});

// Parts as the recipe editor holds them: {per100, grams, drink?, known?,
// borne?}. No water values: all their grams are dry matter.
const oats = { per100: { energy: 200, iron: 2 }, grams: 100 };
const milk = { per100: { energy: 100 }, grams: 100 };

test("recipeKnown: each key's share of the parts' dry matter, per 100 g", () => {
  assert.deepEqual(recipePer100([oats, milk]), { energy: 150, iron: 1 });
  assert.deepEqual(recipeKnown([oats, milk]), { iron: 0.5, dry: 100 });
  assert.equal(
    coverage(
      [{ total: recipePer100([oats, milk]), known: recipeKnown([oats, milk]) }],
      "iron",
    ),
    0.5,
  );
  // The weight cooking takes is water, off the parts' water.
  const water = { per100: { water: 100 }, grams: 900 };
  const lentils = { per100: { energy: 350, water: 0 }, grams: 100 };
  assert.equal(recipePer100([water, lentils], 800).water, 87.5);
  assert.equal(recipePer100([water, lentils], 50).water, 0);
  assert.equal(wholeOf([water, lentils], {}, 800).values.water, 700);
  assert.equal(wholeOf([water, lentils], {}, 1000).values.water, 900);
  // Every part carries every key: only the dry matter.
  assert.deepEqual(recipeKnown([oats, oats]), { dry: 100 });
  // A cooked weight: the dry matter per 100 g grows, the share holds.
  assert.deepEqual(recipeKnown([oats, milk], 100), { iron: 0.5, dry: 200 });
});

test("recipeKnown: a tablet without energy carries its iron; a sub-recipe's known carries", () => {
  const tablet = { per100: { iron: 5 }, grams: 100 };
  // Energy on half the dry matter; iron on all of it.
  assert.deepEqual(recipeKnown([oats, tablet]), { energy: 0.5, dry: 100 });
  const sub = {
    per100: { energy: 200, iron: 1 },
    known: { iron: 0.5, dry: 100 },
    grams: 100,
  };
  assert.deepEqual(recipeKnown([sub]), { iron: 0.5, dry: 100 });
  assert.deepEqual(recipeKnown([]), {});
});

test("recipeKnown: caffeine by what could hold it, not dry matter", () => {
  // Coffee with milk: the milk can't hold caffeine (no `borne`).
  const coffee = {
    per100: { caffeine: 40, water: 98 },
    grams: 200,
    drink: true,
    borne: { caffeine: 100, alcohol: 100 },
  };
  const milkDrink = {
    per100: { water: 90, protein: 3 },
    grams: 50,
    drink: true,
  };
  const known = recipeKnown([coffee, milkDrink]);
  assert.equal(known.caffeine, undefined);
  // Alcohol: the coffee could hold it and gives none.
  assert.equal(known.alcohol, 0);
});

// A whole recipe's or meal's column says the same coverage as its
// per-100 g one: coverage doesn't change with the amount.
test("coverage is scale-invariant: a whole column's equals its per-100 g", () => {
  const parts = [
    { per100: { energy: 380, iron: 4, water: 10 }, grams: 100 },
    { per100: { energy: 40, water: 90 }, grams: 100 },
  ];
  for (const cooked of [null, 150]) {
    const known = recipeKnown(parts, cooked);
    const per100 = { total: recipePer100(parts, cooked), known };
    const whole = wholeOf(parts, known, cooked ?? 200);
    const share = coverage([per100], "iron");
    assert.ok(Math.abs(share - 0.9) < 1e-9, String(share));
    const got = coverage([{ total: whole.values, known: whole.known }], "iron");
    assert.ok(Math.abs(got - share) < 1e-9, `${got} vs ${share}`);
  }
});

// ADR 0020 rework: a food's panel says how its values bear on hydration,
// a serving's and per 100.
test("hydrationText: water less alcohol's debit; caffeine no effect", () => {
  const beer = { net_carbs: 3, protein: 0.5, alcohol: 4 };
  const h = hydrationOf(beer, true);
  assert.deepEqual(h, { water: 92.5, alcohol: 40 });
  assert.equal(
    plain(hydrationText(h, { per100: beer, grams: 330, unit: "ml" })),
    "Hydration: 173 ml (water 305 ml, alcohol −132 ml) in this amount, " +
      "53 ml (water 93 ml, alcohol −40 ml) per 100 ml",
  );
  const coffee = { water: 99, caffeine: 40 };
  assert.equal(
    plain(
      hydrationText(hydrationOf(coffee, true), {
        per100: coffee,
        grams: 200,
        unit: "ml",
      }),
    ),
    "Hydration: 198 ml in this amount, 99 ml per 100 ml; caffeine 80 mg: no effect",
  );
  // Bread counts its moisture; a food with no water value, nothing.
  assert.equal(
    plain(hydrationText(hydrationOf({ water: 38 }, false))),
    "Hydration: 38 ml per 100 g",
  );
  assert.equal(hydrationOf({ energy: 530 }, false), null);
  assert.equal(hydrationText(null), "Hydration: not counted (no water value)");
});

// Total carbs never read under net carbs and fibre.
test("carbsFloor: total carbohydrate is at least its parts", () => {
  assert.deepEqual(carbsFloor({ carbs: 124, net_carbs: 297, fiber: 20 }), {
    carbs: 317,
    net_carbs: 297,
    fiber: 20,
  });
  const fine = { carbs: 50, net_carbs: 40, fiber: 5 };
  assert.equal(carbsFloor(fine), fine);
  assert.deepEqual(carbsFloor({ net_carbs: 40 }), { net_carbs: 40 });
});
