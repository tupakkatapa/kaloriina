// A steps target suggested from your own days (Targets → Activity):
// the median of the last 28 full days, 1,000 more, up to where the benefit
// levels off. `node --test tests/`.

import assert from "node:assert/strict";
import test from "node:test";

import { stepsSuggestion } from "../web/activities.mjs";
import { shift } from "../web/dates.mjs";
import { median } from "../web/stats.mjs";

// The owner's 28 days to Oct 17 2026.
const OWNER = [
  2082, 954, 566, 882, 932, 2612, 8904, 3342, 1402, 646, 769, 2125, 1284, 5233,
  1594, 737, 644, 1138, 519, 1002, 3811, 4001, 839, 660, 721, 2943, 2847, 1411,
];
const TODAY = "2026-10-18";
// `steps` on the days before `today`, the last first.
const days = (steps, today = TODAY) =>
  steps.map((s, i) => ({ day: shift(today, -1 - i), steps: s }));
const born = "1995-09-23";
// `n` of `v`.
const many = (n, v) => Array.from({ length: n }, () => v);

test("the median of an even list is its middle two's mean", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test("the owner's month: a median of 1,211 suggests 2,000", () => {
  assert.deepEqual(stepsSuggestion(days(OWNER.toReversed()), TODAY, born), {
    median: 1211,
    days: 28,
    value: 2000,
    plateau: 10_000,
  });
});

test("1,000 more, to the nearest 500, up to the plateau for the age", () => {
  const at = (s, birth = born) =>
    stepsSuggestion(days(many(20, s)), TODAY, birth)?.value;
  assert.equal(at(7400), 8500);
  assert.equal(at(7200), 8000);
  assert.equal(at(9600), 10_000);
  // Past it already: kept, never raised.
  assert.equal(at(12_300), 12_500);
  assert.equal(at(10_000), 10_000);
  // From 60 the benefit levels off at 6,000–8,000 (Paluch 2022).
  assert.equal(at(7400, "1960-01-01"), 8000);
  assert.equal(at(5000, "1960-01-01"), 6000);
  // Halves round up: 1,250 + 1,000 → 2,500.
  assert.equal(at(1250), 2500);
  // Without a birth date: the under-60 plateau.
  assert.equal(at(9600, null), 10_000);
});

test("two weeks of steps in the last four are needed; today and days without steps don't count", () => {
  const thirteen = days([...many(13, 5000), ...many(15, null)]);
  assert.equal(stepsSuggestion(thirteen, TODAY, born), null);
  const fourteen = days([...many(14, 5000), ...many(14, null)]);
  // A day of 0 steps is a phone not carried, not a day still.
  const zeros = days([...many(13, 5000), ...many(15, 0)]);
  assert.equal(stepsSuggestion(zeros, TODAY, born), null);
  assert.equal(stepsSuggestion(fourteen, TODAY, born).days, 14);
  // Today's 95 so far, and a day 29 days back, are outside.
  const edges = [
    { day: TODAY, steps: 95 },
    ...days(many(14, 5000)),
    { day: shift(TODAY, -29), steps: 0 },
  ];
  assert.equal(stepsSuggestion(edges, TODAY, born).median, 5000);
});
