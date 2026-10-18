// Units on this device (Metric or US): conversion only where values are
// shown and typed, never drift on a save, and no screen spelling a metric
// unit of its own: `node --test tests/`.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { pace } from "../web/activities.mjs";
import {
  distanceText,
  feetInches,
  fromFeetInches,
  heightText,
  inputText,
  localDisplay,
  readInput,
  toShown,
  unitOf,
  unitQty,
} from "../web/units.mjs";

const US = "us";
const METRIC = "metric";

test("metric shows and reads values as stored", () => {
  assert.equal(unitQty(80.25, "kg", 1, METRIC), "80.3 kg");
  assert.equal(inputText(80.25, "kg", METRIC), "80.25");
  assert.equal(readInput("80.25", 80.25, "kg", METRIC), 80.25);
  assert.equal(readInput("81", 80.25, "kg", METRIC), 81);
  assert.equal(readInput("", 80.25, "kg", METRIC), null);
  assert.deepEqual(localDisplay({ unit: "L", factor: 0.001 }, METRIC), {
    unit: "L",
    factor: 0.001,
  });
});

test("US converts by the exact definitions", () => {
  assert.equal(unitQty(100, "kg", 1, US), "220.5 lb");
  assert.equal(unitQty(2.54, "cm", 1, US), "1 in");
  assert.equal(distanceText(1609.344, US), "1 mi");
  assert.equal(unitQty(1000, "ml", 0, US), "34 fl oz");
  assert.equal(unitQty(28.349523125, "g", 1, US), "1 oz");
  assert.equal(unitOf("kg/week", US), "lb/week");
  // Not a length or weight: left alone.
  assert.equal(unitOf("%", US), "%");
  assert.equal(unitOf("kcal", US), "kcal");
  // A habit's litres (stored ml × 0.001) in fl oz.
  const water = localDisplay({ unit: "L", factor: 0.001 }, US);
  assert.equal(water.unit, "fl oz");
  assert.ok(Math.abs(2000 * water.factor - 67.628) < 0.001);
});

test("a value left as shown goes back unchanged: no drift", () => {
  for (const [stored, unit] of [
    [80.3, "kg"],
    [72.45, "kg"],
    [91.5, "cm"],
    [8.234, "km"],
    [330, "ml"],
    [150, "g"],
  ]) {
    const shown = inputText(stored, unit, US);
    assert.equal(readInput(shown, stored, unit, US), stored, `${unit}`);
    // Saved again and again, still the same.
    let v = stored;
    for (let i = 0; i < 5; i++)
      v = readInput(inputText(v, unit, US), v, unit, US);
    assert.equal(v, stored);
  }
});

test("display → input → display is the identity", () => {
  // A typed value reads back as typed, whatever was stored before.
  for (const [typed, unit] of [
    ["176.4", "kg"],
    ["150", "kg"],
    ["36.2", "cm"],
    ["3.11", "km"],
    ["8.5", "ml"],
    ["5.3", "g"],
  ]) {
    const stored = readInput(typed, 1, unit, US);
    assert.equal(inputText(stored, unit, US), typed, `${typed} ${unit}`);
  }
  // A changed value converts: 150 lb is 68.04 kg.
  assert.ok(Math.abs(readInput("150", 80, "kg", US) - 68.0389) < 1e-4);
});

test("height reads in feet and inches, never 12 inches", () => {
  assert.deepEqual(feetInches(178), [5, 10]);
  assert.deepEqual(feetInches(182.6), [6, 0]);
  assert.equal(heightText(178, US), "5 ft 10 in");
  assert.equal(heightText(178, METRIC), "178 cm");
  assert.ok(Math.abs(fromFeetInches(5, 10) - 177.8) < 1e-9);
});

test("pace reads per mile, mph and per 100 yd in US units", () => {
  // 5 km in 25 min.
  assert.equal(pace("per_km", 5000, 25, METRIC), "5:00 /km");
  assert.equal(pace("per_km", 5000, 25, US), "8:03 /mi");
  assert.equal(pace("speed", 30000, 60, US), "18.6 mph");
  assert.equal(pace("per_100m", 1000, 20, US), "1:50 /100 yd");
  assert.ok(Math.abs(toShown(10, "km", US) - 6.2137) < 1e-4);
});

// Screens spell no metric unit themselves: each reads through units.mjs.
// Allowed: food definitions (per 100 g, servings and recipe weights in
// grams, as stored and as the EU label reads; the US label's basis is a
// serving) and nutrients' grams (a label's unit).
const ALLOWED = [
  // Food and recipe editors: servings and weights are defined in grams.
  ["foods.mjs", 'h("span", {}, "g")'],
  ["foods.mjs", 'qty(s.grams || viewGrams, "g")'],
  ["foods.mjs", 'qty(serving.grams, "g")'],
  ["foods.mjs", 'qty(weight(), "g")'],
  ["foods.mjs", '"Weight after cooking (g)"'],
  ["foods.mjs", 'qty(total, "g")'],
  // A drink's values are per 100 ml, as its label reads.
  ["foods.mjs", "Drink (values per 100${NBSP}ml)"],
  // The metric branch of the height field (feet and inches in US units).
  ["profile.mjs", 'label: "Height (cm)"'],
  // Nutrient grams: protein, carbs and fat as on any label.
  ["targets.mjs", 'qty(n.protein, "g", 0)'],
];
// A metric unit as shown: qty()'s unit, a label's "(kg)", a suffix span,
// a unit after a template value, a pace.
const UNIT = new RegExp(
  [
    String.raw`(?<![A-Za-z])qty\([^;]*, "(kg|cm|km|ml|L|g)"`,
    String.raw`["\x60][^"\x60]* \((kg|cm|km|ml|L)(\/[a-z]+)?\)`,
    String.raw`h\("span", \{\}, "(kg|cm|km|ml|L|g)"\)`,
    String.raw`\}\s?(kg|cm|km|ml)\b`,
    String.raw`km\/h|\/km\b`,
  ].join("|"),
  "u",
);

test("screens spell no metric unit of their own", () => {
  const dir = new URL("../web/screens/", import.meta.url);
  const found = readdirSync(dir)
    .filter((f) => f.endsWith(".mjs"))
    .flatMap((f) =>
      readFileSync(new URL(f, dir), "utf8")
        .split("\n")
        .map((line, i) => [f, i + 1, line])
        .filter(
          ([, , line]) =>
            !line.trim().startsWith("//") &&
            UNIT.test(line) &&
            !ALLOWED.some(([file, text]) => file === f && line.includes(text)),
        ),
    )
    .map(([f, n, line]) => `${f}:${n}: ${line.trim()}`);
  assert.deepEqual(found, []);
});
