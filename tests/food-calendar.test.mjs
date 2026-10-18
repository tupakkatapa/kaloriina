// Summary → Food's calendar numbers (web/food-calendar.mjs): a day judged
// against its target as the diary bars judge it, its shade, the tally.

import assert from "node:assert/strict";
import test from "node:test";

import { shade, standing, tally, verdictWords } from "../web/food-calendar.mjs";
import { judge } from "../web/nutrients.mjs";

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
  assert.equal(judge(100), null);
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
    partly: false,
  });
  assert.deepEqual(tally([], about), {
    days: 0,
    on: 0,
    over: 0,
    under: 0,
    total: 0,
    mean: 0,
    partly: false,
  });
});

// A partly known day's amount is a floor. Over a max it is
// surely over; at an "at least" minimum surely on; under, or a range's
// minimum met, nothing is proven: unshaded, and not tallied under.
test("standing: a floor proves only an excess or an at-least minimum", () => {
  assert.equal(standing(1848, about, true), null);
  assert.equal(standing(2100, about, true), null);
  assert.equal(standing(2300, about, true), "over");
  assert.equal(standing(120, atLeast, true), "on");
  assert.equal(standing(40, atMost, true), null);
  assert.equal(standing(1848, about, false), "under");
});

test("shade: a floor under its target stays unshaded", () => {
  assert.equal(shade(1848, about, null, true), 0);
  assert.equal(shade(2300, about, null, true), 0);
  assert.equal(shade(120, atLeast, null, true), 4);
});

test("tally: a floor day is never counted under; any floor marks the mean", () => {
  const t = tally([1848, 2300, 2100], about, [true, true, false]);
  assert.equal(t.under, 0);
  assert.equal(t.over, 1);
  assert.equal(t.on, 1);
  assert.equal(t.partly, true);
  assert.equal(tally([2100], about).partly, false);
});

const say = (v) => `${v} kcal`;

test("verdictWords: a floor says at most under, never plain under", () => {
  assert.equal(verdictWords(1848, about, { say }), ", 152 kcal under");
  assert.equal(
    verdictWords(1848, about, { floor: true, say }),
    ", at most 152 kcal under",
  );
  assert.equal(
    verdictWords(1848, about, { floor: true, known: false, say }),
    "",
  );
  assert.equal(
    verdictWords(2100, about, { floor: true, say }),
    ", minimum met",
  );
  assert.equal(verdictWords(2300, about, { floor: true, say }), ", over");
  assert.equal(verdictWords(40, atMost, { floor: true, say }), "");
});
