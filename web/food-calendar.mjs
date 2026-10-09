// Summary → Food's calendar as numbers: how a day's amount stands against
// its target and the shade that follows. No DOM here, so `node --test`
// covers it.

import { step } from "./calendar-grid.mjs";

const isNil = (v) => v === null || v === undefined;

// "on", "under" or "over" `target` ({value, min, max}), as the diary's
// target bars judge it: over past `max`, under below `min`, else on (an
// "about" target's max is 10 % over; "at most" has no min, "at least" no
// max). null without a target.
export function judge(amount, target) {
  if (isNil(target?.value)) return null;
  if (!isNil(target.max) && amount > target.max) return "over";
  if (!isNil(target.min) && amount < target.min) return "under";
  return "on";
}

// A logged day's shade: on target 4, under 1–3 by how close, over 0 (the
// cell is outlined); without a target, its step of `bounds` (quartiles).
export function shade(amount, target, bounds) {
  const j = judge(amount, target);
  if (j === null) return step(amount, bounds);
  if (j === "on") return 4;
  if (j === "over") return 0;
  // Under: by share of the minimum, ≥ 75 % 3, ≥ 50 % 2, any 1.
  const share = amount / target.min;
  return share >= 0.75 ? 3 : share >= 0.5 ? 2 : share > 0 ? 1 : 0;
}

// The logged days' `amounts` against `target`: how many on, over and
// under, the total and the mean a day.
export function tally(amounts, target) {
  const count = (j) => amounts.filter((a) => judge(a, target) === j).length;
  const total = amounts.reduce((t, a) => t + a, 0);
  return {
    days: amounts.length,
    on: count("on"),
    over: count("over"),
    under: count("under"),
    total,
    mean: amounts.length ? total / amounts.length : 0,
  };
}
