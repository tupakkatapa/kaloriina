// Summary → Food's calendar as numbers: how a day's amount stands against
// its target and the shade that follows. No DOM here, so `node --test`
// covers it.

import { step } from "./calendar-grid.mjs";
import { isNil } from "./format.mjs";
import { judge } from "./nutrients.mjs";

// How `amount` stands against `target` (judge's "on", "over", "under"),
// as far as it's proven. A `floor` (a partly known day: the truth is at
// least this) proves an excess, and an "at least" minimum met; under, or a
// range's minimum met, may not hold once the rest is known: null.
export function standing(amount, target, floor = false) {
  const j = judge(amount, target);
  if (!floor || j === "over") return j;
  return j === "on" && isNil(target.max) ? "on" : null;
}

// A logged day's shade: on target 4, under 1–3 by how close, over 0 (the
// cell is outlined), a floor proving neither 0; without a target, its
// step of `bounds` (quartiles).
export function shade(amount, target, bounds, floor = false) {
  if (isNil(target?.value)) return step(amount, bounds);
  const j = standing(amount, target, floor);
  if (j === "on") return 4;
  if (j !== "under") return 0;
  // Under: by share of the target, ≥ 75 % 3, ≥ 50 % 2, any 1.
  const share = amount / target.value;
  return share >= 0.75 ? 3 : share >= 0.5 ? 2 : share > 0 ? 1 : 0;
}

// The logged days' `amounts` against `target` (`floors[i]` when day i is
// partly known): how many on, over and under as far as proven, the total
// and the mean a day, and whether any is a floor (`partly`: the total and
// mean are floors too).
export function tally(amounts, target, floors = []) {
  const count = (j) =>
    amounts.filter((a, i) => standing(a, target, floors[i]) === j).length;
  const total = amounts.reduce((t, a) => t + a, 0);
  return {
    days: amounts.length,
    on: count("on"),
    over: count("over"),
    under: count("under"),
    total,
    mean: amounts.length > 0 ? total / amounts.length : 0,
    partly: amounts.some((_, i) => Boolean(floors[i])),
  };
}

// What a day's label adds after its amount: ", on target", ", over",
// ", 380 kcal under" (`say` writes an amount). A floor says only what it
// proves (standing), then ", minimum met" or, `known` (KNOWN of it
// behind the floor, ADR 0030), ", at most 380 kcal under"; else nothing.
export function verdictWords(
  amount,
  target,
  { floor = false, known = true, say },
) {
  const j = standing(amount, target, floor);
  if (j === "on") return ", on target";
  if (j === "over") return ", over";
  if (j === "under") return `, ${say(target.value - amount)} under`;
  if (!floor || isNil(target?.value) || isNil(target.min)) return "";
  if (amount >= target.min) return ", minimum met";
  return known ? `, at most ${say(target.value - amount)} under` : "";
}
