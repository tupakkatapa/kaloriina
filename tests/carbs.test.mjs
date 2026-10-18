// The US label's total carbohydrate and the net carbohydrate stored from it:
// `node --test tests/`.

import assert from "node:assert/strict";
import test from "node:test";

import { netFromTotal } from "../web/nutrients.mjs";

test("net carbs come from the total only with fibre known", () => {
  assert.equal(netFromTotal(34, 3), 31);
  assert.equal(netFromTotal(34, 0), 34, "a known 0 is fibre known");
  // Fibre unknown: the net is unknown, never the total less 0.
  assert.equal(netFromTotal(34, null), null);
  assert.equal(netFromTotal(34), null);
  assert.equal(netFromTotal(null, 3), null);
  // A label's rounding never makes it negative.
  assert.equal(netFromTotal(2, 3), 0);
});
