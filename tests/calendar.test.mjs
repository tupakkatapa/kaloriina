// The Summary calendars' legends: one grammar, the unit on every item, the
// words matching how `step` and `reachedStep` shade.

import assert from "node:assert/strict";
import test from "node:test";

import { legendWords, step } from "../web/calendar-grid.mjs";
import { reachedStep } from "../web/habits.mjs";

const NB = "\u00a0";

test("bounds read as ranges, the unit on each", () => {
  assert.deepEqual(legendWords([1, 1.5, 2], "L"), [
    `≤${NB}1${NB}L`,
    `1–1.5${NB}L`,
    `1.5–2${NB}L`,
    `>${NB}2${NB}L`,
  ]);
  // The words hold at the edges: 1 L is the first step, just over 2 the last.
  assert.deepEqual(
    [1, 1.01, 2, 2.01].map((v) => step(v, [1, 1.5, 2])),
    [1, 2, 3, 4],
  );
});

test("a goal to reach: half, three quarters, the goal (target)", () => {
  assert.deepEqual(legendWords(null, "L", { goal: 2.5 }), [
    `<${NB}1.3${NB}L`,
    `1.3–1.9${NB}L`,
    `1.9–2.5${NB}L`,
    `≥${NB}2.5${NB}L (target)`,
  ]);
  assert.deepEqual(
    [1.24, 1.25, 2.49, 2.5].map((v) => reachedStep(v, 2.5)),
    [1, 2, 3, 4],
  );
});

// Minutes written as hours.
const hours = (min) => String(min / 60);

test("minutes as hours; no unit, no space", () => {
  assert.deepEqual(legendWords([390, 450, 510], "h", { num: hours }), [
    `≤${NB}6.5${NB}h`,
    `6.5–7.5${NB}h`,
    `7.5–8.5${NB}h`,
    `>${NB}8.5${NB}h`,
  ]);
  assert.deepEqual(legendWords([20, 45, 90], ""), [
    `≤${NB}20`,
    "20–45",
    "45–90",
    `>${NB}90`,
  ]);
});
