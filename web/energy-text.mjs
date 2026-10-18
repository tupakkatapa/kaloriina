// The energy model's numbers in words, for the screens (the model itself
// is web/series.mjs's to call): where burned and maintenance came from,
// maintenance as said, and why the balance isn't maintenance yet; and
// activity energy, the one place that decides its "≈" (ADR 0020): a
// measured value (a device's active, a total netted of resting) reads
// without it, an estimate with it.

import { isNil, whole } from "./format.mjs";
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
