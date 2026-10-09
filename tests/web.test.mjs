// Pure web helpers, without a browser: `TZ=Europe/Helsinki node --test tests/`.

import assert from "node:assert/strict";
import test from "node:test";

import { pretty, shift, today, weekStart } from "../web/dates.mjs";
import { SLOTS, unique } from "./slots.mjs";
import {
  byCategory,
  energyShare,
  fmtNum,
  fmtUnit,
  inputValue,
  kcal,
  nutrient,
  plural,
  qty,
  rangeOf,
  recipePer100,
  registry,
  scaled,
  setRegistry,
  summed,
} from "../web/nutrients.mjs";

setRegistry([
  {
    key: "energy",
    label: "Energy",
    unit: "kcal",
    goal: "about",
    category: "General",
  },
  {
    key: "net_carbs",
    label: "Carbohydrate",
    unit: "g",
    goal: "about",
    category: "Carbohydrates",
  },
  {
    key: "fiber",
    label: "Fibre",
    unit: "g",
    goal: "at_least",
    category: "Carbohydrates",
  },
  {
    key: "protein",
    label: "Protein",
    unit: "g",
    goal: "at_least",
    category: "Protein",
  },
  {
    key: "vitamin_d",
    label: "Vitamin D",
    unit: "IU",
    goal: "at_least",
    category: "Vitamins",
    display: { label: "Vitamin D", unit: "µg", factor: 1 / 40 },
  },
  {
    key: "sodium",
    label: "Sodium",
    unit: "mg",
    goal: "at_most",
    category: "Minerals",
    display: { label: "Salt", unit: "g", factor: 2.5 / 1000 },
  },
]);

// Floats compared to six decimals.
const rounded = (o) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +v.toFixed(6)]));

test("display units from the server round-trip and relabel", () => {
  const salt = nutrient("sodium");
  assert.equal(salt.label, "Salt");
  assert.equal(salt.unit, "g");
  assert.equal(salt.show(500), 1.25, "500 mg sodium is 1.25 g salt");
  const vitd = nutrient("vitamin_d");
  assert.equal(vitd.show(600), 15, "600 IU is 15 µg");
  for (const key of ["sodium", "vitamin_d", "protein"])
    for (const v of [0, 0.4, 1, 12.5, 2300, 98765.4321]) {
      const n = nutrient(key);
      assert.ok(Math.abs(n.store(n.show(v)) - v) < 1e-9, `${key} ${v}`);
    }
});

test("targets read as one number with its direction", () => {
  const target = { value: 2000, min: 2000, max: 2200 };
  assert.equal(rangeOf("energy", target), "2,000", "about shows the number");
  assert.equal(
    rangeOf("protein", { value: 140 }),
    "≥\u00a0140",
    "the sign stays with its number",
  );
  assert.equal(rangeOf("sodium", { value: 2000 }), "≤\u00a05", "salt in g");
});

test("macro share of energy is whole percent", () => {
  assert.equal(energyShare("protein", 150, 2000), 30);
  assert.equal(energyShare("fat", 60, 1900), 28);
});

test("numbers keep only the digits their size needs, units never apart", () => {
  assert.equal(fmtNum(2200), "2,200");
  assert.equal(fmtNum(26.2), "26");
  assert.equal(fmtNum(2.23), "2.2");
  assert.equal(fmtNum(0.256), "0.26");
  assert.equal(qty(26.2, "g"), "26\u00a0g");
  assert.equal(kcal(1899.6), "1,900\u00a0kcal");
  assert.equal(kcal(null), "–\u00a0kcal");
});

test("nutrients group by category in registry order", () => {
  const list = ["protein", "fiber", "energy", "net_carbs"].map(nutrient);
  assert.deepEqual(
    byCategory(list).map(([c, items]) => [c, items.map((n) => n.key)]),
    [
      ["General", ["energy"]],
      ["Carbohydrates", ["net_carbs", "fiber"]],
      ["Protein", ["protein"]],
    ],
  );
});

test("days shift across daylight saving and weeks start on Monday", () => {
  // Europe/Helsinki springs forward on 2026-03-29.
  assert.equal(shift("2026-03-28", 1), "2026-03-29");
  assert.equal(shift("2026-03-29", 1), "2026-03-30");
  assert.equal(shift("2026-10-25", -1), "2026-10-24");
  assert.equal(
    weekStart("2026-03-29"),
    "2026-03-23",
    "Sunday belongs to the week before",
  );
  assert.equal(weekStart("2026-03-30"), "2026-03-30");
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(pretty("2026-03-30", false), /Mar 30/);
});

test("counts read naturally", () => {
  assert.equal(plural(1, "item"), "1 item");
  assert.equal(plural(3, "day"), "3 days");
  assert.equal(plural(0, "day"), "0 days");
});

test("amounts scale, add up, and spread over a recipe's cooked weight", () => {
  assert.deepEqual(scaled({ energy: 380, protein: 13 }, 50), {
    energy: 190,
    protein: 6.5,
  });
  assert.deepEqual(summed([{ energy: 100 }, { energy: 50, fat: 2 }]), {
    energy: 150,
    fat: 2,
  });
  const parts = [
    { per100: { energy: 360 }, grams: 200 },
    { per100: { energy: 0, fat: 10 }, grams: 100 },
  ];
  // 720 kcal and 10 g fat over the 300 g of ingredients, or over 240 g cooked.
  assert.deepEqual(rounded(recipePer100(parts)), {
    energy: 240,
    fat: 3.333333,
  });
  assert.deepEqual(rounded(recipePer100(parts, 240)), {
    energy: 300,
    fat: 4.166667,
  });
  assert.deepEqual(recipePer100([]), {});
});

test("kJ on this device: energy reads, targets and inputs follow", () => {
  const served = registry;
  setRegistry(served, "kJ");
  try {
    assert.equal(kcal(1900), "7,950\u00a0kJ");
    assert.equal(kcal(null), "–\u00a0kJ");
    assert.equal(fmtUnit("energy", 100), "418\u00a0kJ");
    assert.equal(rangeOf("energy", { value: 2000 }), "8,368");
    assert.equal(inputValue("energy", 100), "418.4");
    const stored = nutrient("energy").store(418.4);
    assert.ok(Math.abs(stored - 100) < 1e-9, "stored in kcal");
    assert.equal(fmtUnit("sodium", 500), "1.3\u00a0g", "others unchanged");
  } finally {
    setRegistry(served, "kcal");
  }
  assert.equal(kcal(1900), "1,900\u00a0kcal");
});

test("unique() days stay 62 days apart across projects, retries and repeats", () => {
  const days = [];
  for (const name of ["chromium", "firefox"]) {
    for (let repeatEachIndex = 0; repeatEachIndex < 2; repeatEachIndex++) {
      for (let retry = 0; retry < 3; retry++) {
        for (let slot = 0; slot < SLOTS; slot++) {
          const info = {
            project: { name, retries: 2 },
            retry,
            repeatEachIndex,
          };
          days.push(Date.parse(unique(slot, info).day));
        }
      }
    }
  }
  days.sort((a, b) => a - b);
  const gap = Math.min(...days.slice(1).map((d, i) => (d - days[i]) / 864e5));
  assert.ok(gap >= 62, `closest two days are ${gap} days apart`);
  assert.throws(
    () =>
      unique(SLOTS, {
        project: { name: "chromium" },
        retry: 0,
        repeatEachIndex: 0,
      }),
    RangeError,
  );
});

test("unique() days stay real dates for --repeat-each 20", () => {
  const days = [];
  for (const name of ["chromium", "mobile-chromium"]) {
    for (let repeatEachIndex = 0; repeatEachIndex < 20; repeatEachIndex++) {
      for (let slot = 0; slot < SLOTS; slot++) {
        const info = {
          project: { name, retries: 0 },
          retry: 0,
          repeatEachIndex,
        };
        const { day } = unique(slot, info);
        assert.match(
          day,
          /^\d{4}-\d{2}-\d{2}$/,
          `${name} ${repeatEachIndex} ${slot}`,
        );
        days.push(Date.parse(day));
      }
    }
  }
  days.sort((a, b) => a - b);
  const gap = Math.min(...days.slice(1).map((d, i) => (d - days[i]) / 864e5));
  assert.ok(gap >= 62, `closest two days are ${gap} days apart`);
  assert.throws(
    () =>
      unique(SLOTS - 1, {
        project: { name: "chromium", retries: 0 },
        retry: 0,
        repeatEachIndex: 23,
      }),
    RangeError,
    "past the year 9999",
  );
});
