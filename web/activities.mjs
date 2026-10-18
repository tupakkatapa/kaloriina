// Activities without the DOM: what any activity (a run, a walk, a workout)
// is worth and how it reads, whatever its type: energy from METs, pace,
// and the records of a type, a day and a week's target. Workouts (the
// saved plans) and exercises are web/workouts.mjs'. `node --test` covers
// all of it.

import { ageOn, shift, weekStart } from "./dates.mjs";
import { countdown, fmt, isNil, NBSP } from "./format.mjs";
import { median } from "./stats.mjs";
import { MI_M, toShown, unitSystem, YD100_M } from "./units.mjs";

// Each activity type's metabolic equivalent (MET), a moderate effort of
// it: the server's (`/api/meta` `activity_types[].met`), given when meta
// loads (nav.mjs), as the nutrient registry is.
let mets = new Map();
export function setActivityTypes(types) {
  mets = new Map(types.map((t) => [t.key, t.met]));
}

// The MET of an activity of `type`: "other"'s for a type the server
// doesn't serve.
export const metOf = (type) => mets.get(type) ?? mets.get("other");

// A device's leftovers, not activity: a distance under MIN_DISTANCE_M
// isn't one (shown, it reads "0 km"), a pace needs MIN_PACE_M (26 m in 28
// min is no pace), and an activity under MIN_MINUTES counts toward no
// weekly target (a 2-minute "Activity" on a sync).
export const MIN_DISTANCE_M = 50;
const MIN_PACE_M = 200;
export const MIN_MINUTES = 5;

// An activity's distance, when it is one; else null. An "other" activity's
// synced metres are the phone's step count (a class has no route): only
// one typed by hand is (the server's `REAL_DISTANCE`).
export const distanceOf = (s) =>
  s.distance_m >= MIN_DISTANCE_M && (s.type !== "other" || s.source === "hand")
    ? s.distance_m
    : null;

// The metres a list of activities covered: each one's distanceOf, once.
// The day's distance too: a device sends none of its own.
export const activitiesMetres = (list) =>
  list.reduce((t, s) => t + (distanceOf(s) ?? 0), 0);

// The slowest a type moves (km/h) for its distance to have a pace: slower
// is a phone's leftover (317 m in 19 min is no walk). The server's
// `ActivityType::min_kmh`.
const MIN_KMH = { walk: 2, run: 5, cycling: 5 };

// An activity's distance when its pace is one: a distance (distanceOf)
// covered at least as fast as its type moves (MIN_KMH); else null.
export function paceDistance(s) {
  const metres = distanceOf(s);
  return metres !== null &&
    s.minutes > 0 &&
    (metres * 0.06) / s.minutes >= (MIN_KMH[s.type] ?? 0)
    ? metres
    : null;
}

// Whether a device day holds tracking: steps, active energy or sleep. A
// day with only a total burned (the phone's passive resting baseline) is
// no tracking: the months before a device aren't rest days.
export const tracksActivity = (d) =>
  d.steps > 0 ||
  !isNil(d.active_kcal) ||
  d.in_bed_min > 0 ||
  d.total_asleep_min > 0;

// Whether an activity counts toward the weekly target.
export const counted = (s) => s.minutes >= MIN_MINUTES;

// The energy beyond resting for `minutes` of a `type` of activity by someone
// weighing `kg`, net like a device's active energy: a run over `metres`
// (runMetres) at its net cost of about 1 kcal a kg a km, whatever the pace
// (Margaria et al., J Appl Physiol 1963; ACSM's 0.2 ml O₂/kg/m), else (MET − 1)
// × kg × hours, `met` its type's (metOf). Null without a weight. An estimate:
// said with "≈".
export function kcalFor(minutes, kg, met, metres = null) {
  if (!kg) return null;
  if (minutes && metres >= MIN_DISTANCE_M)
    return Math.round((kg * metres) / 1000);
  return Math.round(((met - 1) * kg * minutes) / 60);
}

// The distance an activity's energy is costed by (kcalFor): a run's.
export const runMetres = (s) => (s.type === "run" ? s.distance_m : null);

// ---------------------------------------------------- activity records

// The bests an activity sets for its type (Activity → Records): its key, how
// it's named, and the activity's value (bigger is better; null: none).
// Pace is minutes a kilometre, so it counts negated, over 1 km or more.
// Energy is no record (Records' typeRows says why).
const TYPE_BESTS = [
  ["distance", "longest distance", distanceOf],
  ["minutes", "longest time", (s) => s.minutes || null],
  [
    "pace",
    "fastest pace",
    (s) => (paceDistance(s) >= 1000 ? -s.minutes / s.distance_m : null),
  ],
];

// Each activity type's bests over `activities` (in any order), as the
// activities holding them: `{run: {distance, minutes, pace}}`. The
// later day wins a tie (then the later listed): a record is when you last
// reached it.
export function typeRecords(activities) {
  const out = {};
  for (const s of activities)
    for (const [key, , value] of TYPE_BESTS) {
      const v = value(s);
      if (v === null) continue;
      const best = (out[s.type] ??= {});
      const held = best[key] && value(best[key]);
      if (!best[key] || v > held || (v === held && s.day >= best[key].day))
        best[key] = s;
    }
  return out;
}

// The bests of its type `activity` beats among `before` (others of its
// type; itself left out), `[{key, label}]` in TYPE_BESTS order. A best
// never set before has nothing to beat.
export function newTypeRecords(before, activity) {
  const old =
    typeRecords(
      before.filter((s) => s.type === activity.type && s.id !== activity.id),
    )[activity.type] ?? {};
  return TYPE_BESTS.filter(([key, , value]) => {
    const v = value(activity);
    return v !== null && old[key] && v > value(old[key]);
  }).map(([key, label]) => ({ key, label }));
}

// The best step day, the longest night (`asleep_min`) and the most sleep
// in a day (the naps' time asleep added: `total_asleep_min`) among Health
// Connect `days`, each `{day, value}`, or null without any. Later days win
// ties.
export function dayRecords(days) {
  const best = (key) =>
    days
      .filter((d) => !isNil(d[key]))
      .reduce(
        (b, d) => (!b || d[key] >= b.value ? { day: d.day, value: d[key] } : b),
        null,
      );
  return {
    steps: best("steps"),
    night: best("asleep_min"),
    sleep: best("total_asleep_min"),
  };
}

// How many weeks of [from, to] met `perWeek` workouts (`counted` ones), of
// how many judged: Monday-first weeks wholly inside the period, from the
// week of `since` (the first day anything was tracked: a week before it
// is no week missed) and over before `today` (a week still going shows as
// the Summary's bar instead). `perWeek` is today's target applied to every
// past week; null without one.
export function targetWeeks(
  activities,
  from,
  to,
  perWeek,
  today,
  since = from,
) {
  if (!(perWeek > 0)) return null;
  const start = since > from ? weekStart(since) : from;
  const first = weekStart(start) < start ? shift(weekStart(start), 7) : start;
  let met = 0;
  let total = 0;
  for (
    let monday = first;
    shift(monday, 6) <= to && shift(monday, 6) < today;
    monday = shift(monday, 7)
  ) {
    const sunday = shift(monday, 6);
    total += 1;
    if (
      activities.filter((s) => counted(s) && s.day >= monday && s.day <= sunday)
        .length >= perWeek
    )
      met += 1;
  }
  return { met, total };
}

// A steps target from your own days: the median of the STEPS_DAYS before
// `today` (today's are still coming) that have steps (0 is a phone not
// carried), at least
// STEPS_DAYS_MIN of them, STEPS_MORE more (each 1,000 a day goes with 15 %
// lower mortality: Banach et al., Eur J Prev Cardiol 2023), to the nearest
// 500, up to where the benefit levels off (Paluch et al., Lancet Public
// Health 2022: 8,000–10,000 under 60, 6,000–8,000 from 60) unless you're
// past it already (then kept). `deviceDays` [{day, steps}], `birth` or
// null. {median, days, value, plateau}, or null with too few days.
const STEPS_DAYS = 28;
const STEPS_DAYS_MIN = 14;
export const STEPS_MORE = 1000;
const to500 = (n) => Math.round(n / 500) * 500;
export function stepsSuggestion(deviceDays, today, birth) {
  const from = shift(today, -STEPS_DAYS);
  const steps = deviceDays
    .filter((d) => d.day >= from && d.day < today && d.steps > 0)
    .map((d) => d.steps);
  if (steps.length < STEPS_DAYS_MIN) return null;
  const m = median(steps);
  const plateau = birth && ageOn(birth, today) >= 60 ? 8000 : 10_000;
  return {
    median: m,
    days: steps.length,
    value: Math.min(to500(m + STEPS_MORE), Math.max(plateau, to500(m))),
    plateau,
  };
}

// Which activity types take a distance is the server's rule (meta
// `activity_types[].distance`); these only read one.

// "5:37 /km" (`per_km`), "24.3 km/h" (`speed`), "2:05 /100 m" (`per_100m`)
// as an activity type's `pace` reads (meta `activity_types`; US units: "/mi",
// "mph", "/100 yd"); null without a time or MIN_PACE_M, or for a type with
// no one way to read it ("other": rowing, skiing…).
export function pace(kind, metres, minutes, system = unitSystem()) {
  if (!(metres >= MIN_PACE_M) || !minutes) return null;
  const us = system === "us";
  const seconds = minutes * 60;
  const per = (m) => countdown(Math.round((seconds * m) / metres));
  if (kind === "speed") {
    const kmh = metres / 1000 / (minutes / 60);
    return `${fmt(toShown(kmh, "km", system), 1)}${NBSP}${us ? "mph" : "km/h"}`;
  }
  if (kind === "per_100m")
    return us
      ? `${per(YD100_M)}${NBSP}/100${NBSP}yd`
      : `${per(100)}${NBSP}/100${NBSP}m`;
  if (kind !== "per_km") return null;
  return `${per(us ? MI_M : 1000)}${NBSP}/${us ? "mi" : "km"}`;
}
