// A nutrient bar's status line (web/bars.mjs `barStatus`): only what its
// amount proves (ADR 0030).

import assert from "node:assert/strict";
import test from "node:test";

import { barStatus } from "../web/bars.mjs";
import { barShares, setRegistry } from "../web/nutrients.mjs";

setRegistry([
  { key: "energy", label: "Energy", unit: "kcal", goal: "about" },
  { key: "b5", label: "B5", unit: "mg", goal: "at_least" },
  { key: "salt", label: "Salt", unit: "g", goal: "at_most" },
]);

const plain = (t) => t.replaceAll(" ", " ");
const about = { value: 2000, min: 1900, max: 2100 };
const atLeast = { value: 5, min: 5, max: null };
const atMost = { value: 5, min: null, max: 5 };
// amountShown's shape: known, a floor judged, a floor unjudged, none.
const known = { text: "x", lower: false, judged: true, hint: null };
const floor = {
  text: "≥ x",
  lower: true,
  judged: true,
  hint: "from 99 % of it",
};
const loose = {
  text: "≥ x",
  lower: true,
  judged: false,
  hint: "from 5 % of it",
};
const none = { text: "–", lower: false, judged: false, hint: null };
const status = (...a) => plain(barStatus(...a));

test("TFA-D1: an unjudged amount never reads 'Target met · null'", () => {
  assert.equal(status("b5", atLeast, 6, 6, loose), "From 5 % of it");
  assert.equal(status("b5", atLeast, 0, 0, none), "Not known");
  assert.doesNotMatch(status("b5", atLeast, 6, 6, none), /null/u);
});

test("TFA-F4: a floor in range proves the minimum, not the range", () => {
  assert.equal(
    status("energy", about, 2043, 2043, floor, { average: true }),
    "Minimum met",
  );
  assert.equal(
    status("energy", about, 1950, 1950, floor),
    "Minimum met · ≤ 50 kcal to go",
  );
  assert.equal(status("energy", about, 2000, 2000, known), "Target met");
  assert.equal(status("b5", atLeast, 6, 6, floor), "Target met");
  assert.equal(status("energy", about, 1503, 1503, floor), "≤ 497 kcal to go");
});

test("TFA-F6: an excess counts from the range's top", () => {
  assert.equal(
    status("energy", about, 2132, 2132, floor, { average: true }),
    "32 kcal over the range",
  );
  assert.equal(
    status("energy", about, 2210, 2210, known),
    "110 kcal over the range",
  );
});

// The target itself is what's to go; under it but within 5 % is in range,
// and from it up to the range's top is met.
test("a range counts to its target, and from it up to the top is met", () => {
  assert.equal(status("energy", about, 844, 844, known), "1,156 kcal to go");
  assert.equal(
    status("energy", about, 844, 1244, known),
    "1,156 kcal to go · 756 kcal after planned",
  );
  assert.equal(
    status("energy", about, 844, 1950, known),
    "1,156 kcal to go · 50 kcal after planned",
  );
  assert.equal(
    status("energy", about, 844, 2050, known),
    "1,156 kcal to go · met with planned",
  );
  assert.equal(
    status("energy", about, 1920, 1920, known),
    "In range · 80 kcal to go",
  );
  assert.equal(status("energy", about, 1899, 1899, known), "101 kcal to go");
  assert.equal(status("energy", about, 2100, 2100, known), "Target met");
  assert.equal(
    status("energy", about, 844, 844, known, { average: true }),
    "1,156 kcal under target",
  );
  assert.equal(
    status("energy", about, 1950, 1950, known, { average: true }),
    "In range · 50 kcal under target",
  );
  assert.equal(
    status("energy", about, 2050, 2050, known, { average: true }),
    "Target met",
  );
});

test("a floor's to-go is an upper bound: ≤, never 'At most'", () => {
  assert.equal(
    status("energy", about, 844, 1244, floor),
    "≤ 1,156 kcal to go · ≤ 756 kcal after planned",
  );
  assert.equal(
    status("energy", about, 844, 844, floor, { average: true }),
    "≤ 1,156 kcal under target",
  );
  assert.equal(status("b5", atLeast, 2, 2, floor), "≤ 3 mg to go");
  // A floor reaching the target proves the minimum, never the range's max.
  assert.equal(
    status("energy", about, 844, 2050, floor),
    "≤ 1,156 kcal to go · minimum met with planned",
  );
  assert.equal(
    status("salt", atMost, 2, 3, floor),
    "≤ 3 g left · ≤ 2 g after planned",
  );
});

test("an at-least target counts to its min", () => {
  assert.equal(status("b5", atLeast, 2, 2, known), "3 mg to go");
  assert.equal(
    status("b5", atLeast, 2, 4, known),
    "3 mg to go · 1 mg after planned",
  );
  assert.equal(
    status("b5", atLeast, 2, 6, known),
    "3 mg to go · met with planned",
  );
  assert.equal(status("b5", atLeast, 5, 5, known), "Target met");
  assert.equal(
    status("b5", atLeast, 2, 2, known, { average: true }),
    "3 mg under target",
  );
});

test("an at-most target says what's left to its max", () => {
  assert.equal(status("salt", atMost, 2, 2, known), "3 g left");
  assert.equal(
    status("salt", atMost, 2, 4, known),
    "3 g left · 1 g after planned",
  );
  assert.equal(
    status("salt", atMost, 2, 6, known),
    "1 g over target with planned",
  );
  assert.equal(
    status("salt", atMost, 2, 2, known, { average: true }),
    "3 g under target",
  );
});

test("eaten unknown: what's planned is still said", () => {
  assert.equal(
    status("b5", atLeast, null, 45, none),
    "Not known · 45 mg planned",
  );
  assert.equal(status("b5", atLeast, null, 0, none), "Not known");
});

// The bar is full at the target: exactly when nothing is left to go.
test("the bar fills to its target", () => {
  const at = (eaten) => barShares(eaten, eaten, about.value).eaten;
  assert.equal(at(2000), 100);
  assert.equal(status("energy", about, 2000, 2000, known), "Target met");
  assert.ok(at(1950) < 100);
  assert.equal(status("energy", about, 1000, 1000, known), "1,000 kcal to go");
  assert.equal(at(1000), 50);
});
