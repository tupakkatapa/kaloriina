// How an amount reads (web/amount.mjs): a serving's label never repeats
// its own weight, and a drink logged per 100 ml reads in ml and L.
// `node --test tests/`.

import assert from "node:assert/strict";
import test from "node:test";

import {
  byVolume,
  servingText,
  unitLabel,
  weightText,
} from "../web/amount.mjs";

const nbsp = (s) => s.replaceAll(" ", " ");

test("a serving that already names its weight doesn't repeat it (TFA-D7)", () => {
  assert.equal(
    servingText(1, "1 serving (130 g)", weightText(130)),
    "1 × 1 serving (130 g)",
  );
  assert.equal(
    unitLabel({ label: "1 serving (130 g)", grams: 130 }),
    "1 serving (130 g)",
  );
  // Two of it weigh more than the label says: the total stays.
  assert.equal(
    servingText(2, "1 serving (130 g)", weightText(260)),
    "2 × 1 serving (130 g) (260\u00A0g)",
  );
  assert.equal(unitLabel({ label: "Slice", grams: 40 }), "Slice (40\u00A0g)");
});

test("a drink per 100 ml reads in ml, from 1 L in L (U3-9)", () => {
  const pepsi = { drink: true, kind: "food", source: "custom" };
  assert.equal(byVolume(pepsi), true);
  // Fineli's values are per 100 g, a recipe's too: weighed.
  assert.equal(byVolume({ ...pepsi, source: "fineli" }), false);
  assert.equal(byVolume({ ...pepsi, kind: "recipe" }), false);
  assert.equal(weightText(250, false, 1, true), nbsp("250 ml"));
  assert.equal(weightText(1000, false, 1, true), nbsp("1 L"));
  assert.equal(weightText(1250, false, 1, true), nbsp("1.3 L"));
  // A volume label says it all; a weight label gets its volume.
  assert.equal(
    unitLabel({ label: "250 ml", grams: 250 }, false, true),
    "250 ml",
  );
  assert.equal(
    unitLabel({ label: "0,33 l bottle", grams: 330 }, false, true),
    "0,33 l bottle",
  );
  assert.equal(
    unitLabel({ label: "Glass", grams: 200 }, false, true),
    "Glass (200\u00A0ml)",
  );
  assert.equal(
    servingText(1, "Can 0,33 l", weightText(330, false, 1, true), true),
    "1 × Can 0,33 l",
  );
});
