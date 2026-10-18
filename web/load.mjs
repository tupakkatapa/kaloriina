// Cardio load (ADR 0034): Banister's TRIMP of an activity, from its
// average heart rate, the resting heart rate near its day and a maximum
// by age (Tanaka) raised to the activity's own; a period's sum. Activities
// carry no time in zones, so Edwards' zones and a device's EPOC are out of
// reach. No DOM here, so `node --test` covers it.

import { ageOn, shift } from "./dates.mjs";
import { isNil, NBSP } from "./format.mjs";

// Why a load can't be worked out without the profile's sex or birth date
// (the activity view links it to the profile).
export const NEEDS_PROFILE = "needs your sex and birth date";

// Banister's weighting of the heart-rate reserve by sex: a × e^(b × HRr)
// (Banister 1991; the exponents from Morton, Fitz-Clarke & Banister, J
// Appl Physiol 1990).
const WEIGHT = { male: [0.64, 1.92], female: [0.86, 1.67] };

// A resting heart rate up to this many days before stands in for a day's
// own (a night not worn).
const REST_DAYS = 7;

// Tanaka, Monahan & Seals, J Am Coll Cardiol 2001: 208 − 0.7 × age (people
// scatter about 10 bpm around it); an activity that went over it proves
// the maximum higher.
export const maxHr = (birth, day, ownMax) =>
  Math.max(208 - 0.7 * ageOn(birth, day), ownMax ?? 0);

// The resting heart rate on `day`, else the latest of the days before it
// within REST_DAYS, from device days; null without one.
export function restingOn(day, deviceDays) {
  const from = shift(day, 1 - REST_DAYS);
  return (
    deviceDays
      .filter((d) => d.day >= from && d.day <= day && !isNil(d.resting_hr))
      .toSorted((a, b) => b.day.localeCompare(a.day))[0]?.resting_hr ?? null
  );
}

// An activity's load: {load, rest, max, seen} (`seen`: the maximum is the
// activity's own, measured), `{load: null, why}` when it has a heart rate
// but the load can't be worked out, null without a heart rate.
export function activityLoad(s, { sex, birth_date }, deviceDays) {
  if (isNil(s.avg_hr)) return null;
  if (!WEIGHT[sex] || !birth_date) return { load: null, why: NEEDS_PROFILE };
  const rest = restingOn(s.day, deviceDays);
  if (isNil(rest))
    return { load: null, why: "no resting heart rate that week" };
  const max = maxHr(birth_date, s.day, s.max_hr);
  if (rest >= max)
    return { load: null, why: "resting heart rate at or over the maximum" };
  const hrr = Math.min(1, Math.max(0, (s.avg_hr - rest) / (max - rest)));
  const [a, b] = WEIGHT[sex];
  return {
    load: s.minutes * hrr * a * Math.exp(b * hrr),
    rest,
    max,
    seen: max === s.max_hr,
  };
}

// A period's load: `total` over the activities that have one (`loaded`),
// and how many have none (`missing`: no heart rate, or no resting heart
// rate near it), which makes the total a floor.
export function periodLoad(activities, profile, deviceDays) {
  const loads = activities.map(
    (s) => activityLoad(s, profile, deviceDays)?.load ?? null,
  );
  const known = loads.filter((x) => x !== null);
  return {
    total: known.reduce((t, x) => t + x, 0),
    loaded: known.length,
    missing: loads.length - known.length,
  };
}

// The activity view's line: "≈ 54 · resting 55, max ≈ 186 bpm" (an
// estimate always: the maximum, and an average over an activity), "– · why"
// without one, null without a heart rate.
export function loadText(x) {
  if (!x) return null;
  if (x.load === null) return `– · ${x.why}`;
  const max = `${x.seen ? "" : `≈${NBSP}`}${Math.round(x.max)}${NBSP}bpm`;
  return `≈${NBSP}${Math.round(x.load)} · resting ${x.rest}, max ${max}`;
}
