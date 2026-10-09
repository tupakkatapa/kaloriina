// Summary → Food's calendar numbers (web/food-calendar.mjs): a day judged
// against its target as the diary bars judge it, its shade, the tally.

import assert from "node:assert/strict";
import test from "node:test";

import { judge, shade, tally } from "../web/food-calendar.mjs";

// As /targets serves them: "about" 2000 kcal (max +10 %), "at least" 100 g,
// "at most" 50 g.
const about = { value: 2000, min: 2000, max: 2200 };
const atLeast = { value: 100, min: 100, max: null };
const atMost = { value: 50, min: null, max: 50 };

test("judge: about is on from its value to 10 % over", () => {
  assert.equal(judge(1999, about), "under");
  assert.equal(judge(2000, about), "on");
  assert.equal(judge(2200, about), "on");
  assert.equal(judge(2201, about), "over");
});

test("judge: at least is never over, at most never under", () => {
  assert.equal(judge(99, atLeast), "under");
  assert.equal(judge(500, atLeast), "on");
  assert.equal(judge(0, atMost), "on");
  assert.equal(judge(50, atMost), "on");
  assert.equal(judge(51, atMost), "over");
});

test("judge: no target, no verdict", () => {
  assert.equal(judge(100, undefined), null);
  assert.equal(judge(100, { value: null, min: null, max: null }), null);
});

test("shade: on 4, over 0, under lighter the further below", () => {
  assert.equal(shade(2100, about), 4);
  assert.equal(shade(2300, about), 0);
  assert.equal(shade(1999, about), 3);
  assert.equal(shade(1500, about), 3);
  assert.equal(shade(1499, about), 2);
  assert.equal(shade(1000, about), 2);
  assert.equal(shade(999, about), 1);
  assert.equal(shade(0, atLeast), 0);
  assert.equal(shade(10, atMost), 4);
});

test("shade: without a target, the step of the period's quartiles", () => {
  const bounds = [10, 20, 30];
  assert.equal(shade(5, null, bounds), 1);
  assert.equal(shade(20, null, bounds), 2);
  assert.equal(shade(31, null, bounds), 4);
});

test("tally: on, over and under of the logged days, total and mean", () => {
  assert.deepEqual(tally([2100, 2300, 1500, 2000], about), {
    days: 4,
    on: 2,
    over: 1,
    under: 1,
    total: 7900,
    mean: 1975,
  });
  assert.deepEqual(tally([], about), {
    days: 0,
    on: 0,
    over: 0,
    under: 0,
    total: 0,
    mean: 0,
  });
});
