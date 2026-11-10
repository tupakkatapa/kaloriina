// The energy model's numbers in words, for the screens (the model itself
// is web/series.mjs's to call): where burned and maintenance came from,
// maintenance as said, and why the balance isn't maintenance yet; and
// activity energy, the one place that decides its "≈" (ADR 0020): a
// measured value (a device's active, a total netted of resting) reads
// without it, an estimate with it.

import { estimateKcal, REACHED_KG } from "./expenditure.mjs";
import { isNil, NBSP, whole } from "./format.mjs";
import { kcal, kcalParts } from "./nutrients.mjs";

export { balanceWhy } from "./energy.mjs";
export {
  BURNED_FROM,
  MAINTENANCE_BY,
  bmrOf,
  maintenanceFrom,
  maintenanceText,
} from "./expenditure.mjs";

// "active ≈ 392 kcal": active energy after its `mark` (activeMark), one
// phrase that moves whole (NBSPs inside; lines break at " · " between
// parts).
export const activeKcalText = (value, mark = "") =>
  whole(`active ${mark}${kcal(value)}`);

// An activity's energy (expenditure.mjs activeEnergy) as read: "active 410
// kcal" (a device's active), "active 290 kcal · 355 total" (a total
// netted of resting), "355 kcal total" (resting unknown), "active ≈ 288
// kcal" (an estimate); null with none (an estimate without a weight). Each
// phrase moves whole.
export function activeEnergyText({ active, total, estimated }) {
  if (isNil(active)) return isNil(total) ? null : whole(`${kcal(total)} total`);
  const shown = activeKcalText(active, estimated ? "≈ " : "");
  return isNil(total)
    ? shown
    : `${shown} · ${whole(`${kcalParts(total).value} total`)}`;
}

// The mark before a day's or a period's active energy (activeKcal's
// {floor, estimated}): "≥ " when activities alone hold it (everyday
// movement left out), "≈ " when an estimate is in it, none when measured.
export const activeMark = ({ floor = false, estimated = false }) =>
  whole(floor ? "≥ " : estimated ? "≈ " : "");

// "Your goal date needs a deficit ≈ 450 kcal a day" (a surplus to gain):
// `plan`'s target (web/energy.mjs, Targets' Needed energy) against its
// maintenance, for `goalWeight` by `goalDate` still after `today`; "≥" and
// "Targets plans no faster" when a guard limited it; "Your goal weight is
// reached." within REACHED_KG of it; else null.
export function goalPaceText({ plan, goalWeight, goalDate, today }) {
  if (isNil(goalWeight) || !goalDate || goalDate <= today) return null;
  const n = plan?.needed;
  const m = plan?.maintenance;
  if (!n || !m || n.recomp || n.muscle || isNil(plan.weight)) return null;
  if (Math.abs(goalWeight - plan.weight) <= REACHED_KG)
    return "Your goal weight is reached.";
  const gap = n.target - m.kcal;
  const shown = estimateKcal(Math.abs(gap));
  if (!(shown > 0)) return null;
  const word = gap < 0 ? "deficit" : "surplus";
  return n.limited
    ? `Your goal date needs a ${word} ≥${NBSP}${kcal(shown)} a day: Targets plans no faster.`
    : `Your goal date needs a ${word} ≈${NBSP}${kcal(shown)} a day.`;
}
