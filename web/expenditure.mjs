// The energy model (ADR 0020, 0026), two numbers with two names: _burned_, what
// a day cost (burnedDay), and _maintenance_, what keeps your weight, the
// planning number (maintenanceOf: the adaptive balance, energy.mjs, else the
// mean of what the days burned, else resting × activity level). An energy
// target is only ever offered through `needed()`, from maintenance. The client
// owns the model: `/recommended` gives no energy. No DOM here, so `node --test`
// covers it.

import { kcalFor, metOf, runMetres } from "./activities.mjs";
import { ageOn, daysIn, pretty, shift } from "./dates.mjs";
import { isNil, NBSP } from "./format.mjs";
import { kcal, kcalParts, nutrient } from "./nutrients.mjs";
import { unitQty } from "./units.mjs";

// Thermic effect of food: about 10 % of what was eaten (Westerterp, Nutr
// Metab 2004).
export const TEF = 0.1;
// Everyday movement (NEAT), a share of resting: resting × 1.1 plus TEF
// comes to about 1.2 × resting, the floor of daily need near bed rest
// (FAO/WHO/UNU, Human Energy Requirements 2004, puts sedentary lifestyles
// at PAL 1.40–1.69, so this is a low, never an inflated, estimate). Every
// day counts at least this much movement.
export const EVERYDAY = 0.1;
// Body weight as energy without a body-fat reading (Wishnofsky 1958).
export const KCAL_PER_KG = 7700;
// Days the adaptive balance needs with food logged, and the mean of
// burned with a burned estimate.
export const MIN_FOOD_DAYS = 14;
// A change to the energy target smaller than this isn't offered.
const MIN_OFFER = 50;
// Energy in a kg of fat mass and of fat-free mass changed (Hall, Int J
// Obes 2008): not adipose tissue's 7700.
const FAT_KCAL_PER_KG = 9440;
const LEAN_KCAL_PER_KG = 1816;
// The fastest change a goal is planned at, a share of body weight a week.
export const MAX_LOSS_PER_WEEK = 0.01;
const MAX_GAIN_PER_WEEK = 0.005;
// The lowest energy target offered, by sex, unless resting energy is
// higher: the conservative ends of NHLBI's (1998) low-calorie diet ranges,
// 1,000–1,200 kcal for women and 1,200–1,500 for men.
export const FLOOR = { female: 1200, male: 1500 };
// A goal weight this close is reached.
const REACHED_KG = 0.1;
// Recomposition: weight within this of the goal while fat is to go.
const RECOMP_KG = 1;
const RECOMP_CUT = 0.1;
// Protein a day: g a kg of goal weight, or in recomposition of lean mass
// (Morton et al., Br J Sports Med 2018; Barakat et al., Strength Cond J
// 2020).
const PROTEIN_PER_KG = 1.6;
const PROTEIN_PER_LEAN_KG = 2.4;
// Protein a day with a muscle goal, g a kg of goal weight: Morton et al.
// (Br J Sports Med 2018) found gains plateau near 1.6, the upper bound of
// their 95 % range 2.2; a deficit takes the upper end to keep muscle.
const PROTEIN_PER_KG_DEFICIT = 2.2;
// Building a kg of muscle costs its energy (LEAN_KCAL_PER_KG) and about
// half again to make it: about 2,500–2,800 kcal a kg gained (Slater et
// al., Front Nutr 2019).
const SYNTHESIS = 0.5;
// A realistic muscle gain, kg a month: McDonald's model puts a first
// year of lifting at about 1 kg a month, the second 0.5, later 0.25
// (Aragon's: 1–1.5 %, 0.5–1 %, then 0.25–0.5 % of body weight a month);
// women about half. A rule of thumb, planned at the trained middle.
const MUSCLE_KG_PER_MONTH = { male: 0.5, female: 0.25 };
const DAYS_PER_MONTH = 30.44;
// A weigh-in stands for resting energy this many days after it.
export const CARRY_DAYS = 90;

// Resting energy (kcal/day), Mifflin–St Jeor (Am J Clin Nutr 1990). Null
// without sex, birth date or height.
export function mifflin({ sex, birth_date, height_cm }, kg, day) {
  if (!sex || !birth_date || isNil(height_cm) || isNil(kg)) return null;
  const base = 10 * kg + 6.25 * height_cm - 5 * ageOn(birth_date, day);
  return sex === "male" ? base + 5 : base - 161;
}

// The value of `list` ([{day, …}] by day) standing on `day`: the latest
// at or before it within CARRY_DAYS, else the first after (so a period
// starting before the first reading doesn't step); null when empty. A
// binary search: a year of days over a year of weigh-ins stays linear.
function carried(list, day) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].day <= day) lo = mid + 1;
    else hi = mid;
  }
  const before = list[lo - 1];
  if (before && daysIn(before.day, day) - 1 <= CARRY_DAYS) return before;
  return list[lo] ?? before ?? null;
}

// Resting energy each day (ADR 0028): Health Connect's basal metabolic
// rate in effect that day as the server serves it (`resting`, [{day, kcal,
// origin}]: the day's own, else carried up to 6 days, one app per
// profile), else Mifflin–St Jeor at the weight standing that day. Never a
// scale's own figure (openScale's `bmr_kcal`) or a device total's resting
// part, and never Katch–McArdle from a scale's body fat: bioimpedance reads
// weight and water, not lean mass (energy.mjs tracksWeight). `person` the
// profile, `weights` [{day, kg}]. Returns `(day) => {kcal, source:
// "health_connect" | "mifflin", origin} | null` (`origin` the app's
// package, null for Mifflin's).
export function bmrOf({ person, weights, resting = [] }) {
  const kgs = weights.toSorted((a, b) => a.day.localeCompare(b.day));
  const served = new Map(resting.map((r) => [r.day, r]));
  return (day) => {
    const r = served.get(day);
    if (r) return { kcal: r.kcal, source: "health_connect", origin: r.origin };
    const kg = carried(kgs, day)?.kg;
    const k = isNil(kg) ? null : mifflin(person, kg, day);
    return isNil(k) ? null : { kcal: k, source: "mifflin", origin: null };
  };
}

// The apps that write a basal metabolic rate to Health Connect, by their
// package (a prefix: openScale's builds differ by suffix).
const APPS = [
  ["com.sec.android.app.shealth", "Samsung Health"],
  ["com.fitbit.", "Fitbit"],
  ["com.google.android.apps.fitness", "Google Fit"],
  ["com.health.openscale", "openScale"],
  ["com.withings.", "Withings"],
];
// An origin package as its app's name, else the package as it is.
export const appOf = (origin) =>
  APPS.find(([prefix]) => origin.startsWith(prefix))?.[1] ?? origin;

// An activity's energy beyond resting (ADR 0020), {active, total,
// estimated}: a device's active energy is measured and net already
// (`total` null); one typed by hand, imported (Google Health's "total
// calories") or a device's total (`health_connect_total`: a device that
// writes no active energy) is a measured total, less the resting energy
// (`bmr` kcal a day) of its minutes, never below 0 (`active` null with
// resting unknown: the total adds no active energy); one without energy
// is estimated from its type, time and weight (activities.mjs kcalFor,
// net already; null without a weight). Active is whole kcal, so a day's
// sum is its rows'. energy-text.mjs activeEnergyText says it.
export function activeEnergy(s, bmr) {
  if (isNil(s.kcal))
    return {
      active: kcalFor(s.minutes, s.weight_kg, metOf(s.type), runMetres(s)),
      total: null,
      estimated: true,
    };
  if (s.kcal_source === "health_connect")
    return { active: s.kcal, total: null, estimated: false };
  return {
    active: isNil(bmr)
      ? null
      : Math.max(0, Math.round(s.kcal - (bmr / 1440) * s.minutes)),
    total: s.kcal,
    estimated: false,
  };
}

// An activity's activeEnergy, one meaning wherever an activity's energy is
// read (rows, This week, Records, the Diary's day): resting as the server
// gives it on the activity (`bmr_kcal`), else as bmrOf has it that day
// (`resting` served, else Mifflin–St Jeor at its weight). The weight is
// the weigh-in in effect on its day, as the server gives it, so history
// never rewrites itself; one not yet sent has none, so the latest of
// `weights` ([{day, kg}]) stands in. `person` the profile.
export function activeOf(s, { person = {}, weights = [], resting = [] } = {}) {
  const kg =
    "weight_kg" in s
      ? s.weight_kg
      : (carried(
          weights.toSorted((a, b) => a.day.localeCompare(b.day)),
          s.day,
        )?.kg ?? null);
  const bmr =
    s.bmr_kcal ??
    bmrOf({ person, weights: isNil(kg) ? [] : [{ day: s.day, kg }], resting })(
      s.day,
    )?.kcal ??
    null;
  return activeEnergy({ ...s, weight_kg: kg }, bmr);
}

// A day's active energy (ADR 0020), {kcal, floor, estimated}: the larger
// of the device's active energy and the sum of its activities' active
// (`energies`, each an activeEnergy). The device's active total holds the
// workouts it tracked, so the larger never counts one twice and never
// drops a logged one it missed. Without the device's, the activities'
// alone leave everyday movement out: a `floor`. `estimated` when the
// activities' sum stands and holds an estimate. Null with neither.
export function activeKcal({ deviceDay, energies }) {
  const counted = energies.filter((e) => !isNil(e.active));
  const device = deviceDay?.active_kcal;
  if (counted.length === 0 && isNil(device)) return null;
  const done = counted.reduce((t, e) => t + e.active, 0);
  const own = counted.length > 0 && (isNil(device) || done > device);
  return {
    kcal: own ? done : device,
    floor: isNil(device),
    estimated: own && counted.some((e) => e.estimated),
  };
}

// What a day burned (ADR 0028), one model for every day: resting energy
// (`bmr`, bmrOf's) + TEF + movement, the larger of the device's active
// energy (which holds everyday movement and the workouts it saw) and
// everyday movement (EVERYDAY × resting) plus the activities' net kcal (a
// activity covers its own minutes, not the rest of the day). `source`
// "active" with the device's active energy, else "activities". TEF is of
// `intake` (kcal eaten), or of resting × (1 + EVERYDAY) when nothing was
// logged (unlogged isn't fasted). The device's total isn't used: its
// resting part is the vendor's formula, not bmrOf's, and it holds no TEF;
// without resting energy (no weight) it alone stands, "device".
// `deviceDay` the day's Health Connect values (or null), `bmr` kcal (or
// null), `activities` [{kcal, kcal_source, minutes, type, distance_m,
// weight_kg}]. {kcal, source} or null.
export function burnedDay({ deviceDay, bmr, intake, activities }) {
  if (isNil(bmr)) {
    const total = deviceDay?.total_kcal;
    return isNil(total) ? null : { kcal: total, source: "device" };
  }
  const tef = TEF * (intake > 0 ? intake : bmr * (1 + EVERYDAY));
  const active = activeKcal({
    deviceDay: null,
    energies: activities.map((s) => activeEnergy(s, bmr)),
  });
  const moved = EVERYDAY * bmr + (active?.kcal ?? 0);
  const device = deviceDay?.active_kcal;
  return {
    kcal: bmr + tef + Math.max(device ?? 0, moved),
    source: isNil(device) ? "activities" : "active",
  };
}

// Each day of [from, to]'s burned energy: `days` the summary's
// ([{day, total}]), `deviceDays` Health Connect's days, `activities` the
// activities done, `bmr` a `bmrOf` for the period. [{day, kcal, source}].
// Callers go through `burnedOver`, which never asks for a day not yet over.
export function burnedDays({ from, to, days, deviceDays, activities, bmr }) {
  const eaten = new Map(days.map((d) => [d.day, d.total.energy ?? 0]));
  const device = new Map(deviceDays.map((d) => [d.day, d]));
  const done = new Map();
  for (const a of activities) {
    if (done.has(a.day)) done.get(a.day).push(a);
    else done.set(a.day, [a]);
  }
  const out = [];
  const n = daysIn(from, to);
  for (let i = 0; i < n; i++) {
    const day = shift(from, i);
    const b = burnedDay({
      deviceDay: device.get(day) ?? null,
      bmr: bmr(day)?.kcal ?? null,
      intake: eaten.get(day) ?? 0,
      activities: done.get(day) ?? [],
    });
    if (b) out.push({ day, ...b });
  }
  return out;
}

// burnedDays over [from, to] clamped to `yesterday` (a day not yet over
// has no burned energy: today's is still coming in, a future day's is
// unknown); none when the range starts after it.
export function burnedOver({ from, to, yesterday, ...inputs }) {
  const end = to < yesterday ? to : yesterday;
  return from > end ? [] : burnedDays({ from, to: end, ...inputs });
}

// Where a day's burned energy came from (burnedDay's `source`), and where
// maintenance did (maintenanceOf's), in words.
export const BURNED_FROM = {
  device: "your device's total (no weight logged for resting energy)",
  active:
    "resting energy, digesting, and the larger of your device's active energy and everyday movement plus your activities",
  activities:
    "resting energy, digesting, an estimate of everyday movement and your activities (no active energy from a device)",
};
const MAINTENANCE_FROM = {
  balance: "what you ate and how your weight moved",
  burned: "the energy you burned, its 28-day mean",
  pal: "your measurements and activity level",
};
// Each maintenance method in a word or two: a chart's legend and tooltip.
export const MAINTENANCE_BY = {
  balance: "weight trend",
  burned: "energy burned",
  pal: "activity level",
};
// Where maintenance `m` came from, in words: the activity level named.
export const maintenanceFrom = (m) =>
  m.source === "pal"
    ? `${MAINTENANCE_FROM.pal} (PAL ${m.pal})`
    : MAINTENANCE_FROM[m.source];
// Maintenance `m` as said, an estimate (estimateKcal) like its range:
// "≈ 2,250 kcal (± 180)" from the balance, its 95 % range; "≈ 2,250 kcal"
// otherwise.
export const maintenanceText = (m) =>
  `≈ ${kcal(estimateKcal(m.kcal))}${isNil(m.spread) ? "" : ` (± ${kcalParts(estimateKcal(m.spread)).value})`}`;

// The mean of what `burned`'s days (burnedDays' rows) burned: {n, kcal},
// null without one. Every day counts, whatever its source: a mean of some
// sources only would keep the days that read high.
const burnedMean = (burned) =>
  burned.length > 0
    ? {
        n: burned.length,
        kcal: burned.reduce((t, b) => t + b.kcal, 0) / burned.length,
      }
    : null;

// The adaptive balance is used only this sure: its 95 % range within
// ± MAX_SPREAD kcal, and within PLAUSIBLE × resting energy (below resting
// × 1.1 or over × 2.5 at a steady life is noise, not a body).
export const MAX_SPREAD = 250;
const PLAUSIBLE = [1.1, 2.5];

// Whether the balance `b` ({enough, maintenance, spread}) is sure enough
// to stand for maintenance, against resting energy `bmr` (null: unchecked).
export const sure = (b, bmr) =>
  Boolean(b?.enough) &&
  b.spread <= MAX_SPREAD &&
  (isNil(bmr) ||
    (b.maintenance >= PLAUSIBLE[0] * bmr &&
      b.maintenance <= PLAUSIBLE[1] * bmr));

// Maintenance, what keeps your weight a day, the first that applies: the
// adaptive balance's when `sure`; the mean of what the window's days
// burned (`mean`, burnedMean of `burned` unless given: the days with food
// logged or device energy, energy.mjs), with MIN_FOOD_DAYS or more of
// them, "burned": the same model as burned, so maintenance never jumps to
// an assumption when the balance is unsure; resting energy
// × the profile's activity level (PAL, `activity`), for a profile without
// that history. {kcal, source, spread?, pal?} or null.
export function maintenanceOf({
  balance,
  burned = [],
  mean = burnedMean(burned),
  bmr = null,
  activity = null,
}) {
  if (sure(balance, bmr))
    return {
      kcal: balance.maintenance,
      source: "balance",
      spread: balance.spread,
    };
  if (mean && mean.n >= MIN_FOOD_DAYS)
    return { kcal: mean.kcal, source: "burned" };
  if (!isNil(bmr) && !isNil(activity))
    return { kcal: bmr * activity, source: "pal", pal: activity };
  return null;
}

// An estimate's precision: 10 kcal, wherever burned or maintenance is said.
export const round10 = (v) => Math.round(v / 10) * 10;

// An estimate (burned, maintenance, resting, a balance's gap) as said: to
// 10 kcal, or 50 kJ in kJ (its 10 kcal is 41.84 kJ), rounded in the unit
// shown, never before converting to it. kcal, for kcal() to say.
export function estimateKcal(v) {
  const energy = nutrient("energy");
  if (energy?.unit !== "kJ") return round10(v);
  return energy.store(Math.round(energy.show(v) / 50) * 50);
}

// Whether a needed `target` is worth offering over the `current` energy
// target (null: none set).
export const offered = (target, current) =>
  current === null || Math.abs(target - current) >= MIN_OFFER;

// The energy target a goal needs (ADR 0020), or null when no goal follows (a
// body-fat goal without a reading). Inputs: `weight` kg now, `bf` the latest
// body fat % (or null), `goalWeight` kg and `goalBf` % (or null), `goalDate`
// (or null), `goalKgPerWeek`, `maintenance` and `bmr` kcal, `sex`, `today`. The
// goal weight wins; a body-fat goal alone keeps lean mass (w·(1−bf)/(1−bf_g)).
// With a reading and a body-fat goal the change splits into fat and lean mass
// (Hall 2008), else 7700 kcal a kg. A goal date after today spreads the energy
// over the days left; else kg a week sets the pace, unless the goal weight is
// reached or the pace points away from it (planned at maintenance, said in
// `clamps`). Guards: a pace over MAX_LOSS/GAIN_PER_WEEK is slowed, the target
// never under FLOOR or resting energy; each guard that bites is said in
// `clamps`. Recomposition (weight within RECOMP_KG, fat to lose): maintenance −
// 10 % with protein raised. A muscle goal (`goalMuscle` %, with `muscle` the
// latest muscle %) beside exactly one of goal weight and body fat plans by
// `composition`; alone or with both, it isn't planned (said in `clamps`).
// Returns {target, perDay, weeklyKg, goalKg, split: {fat, lean} | null, recomp,
// protein, muscle: {kg, day} | null, clamps}.
export function needed(goals) {
  const { goalWeight, goalBf, goalMuscle = null } = goals;
  if (!isNil(goalMuscle) && isNil(goalWeight) !== isNil(goalBf))
    return composition(goals);
  return byWeight(goals);
}

function byWeight({
  today,
  weight,
  bf,
  goalWeight,
  goalBf,
  goalMuscle = null,
  goalDate,
  goalKgPerWeek,
  maintenance,
  bmr,
  sex,
}) {
  let goalKg = goalWeight;
  if (isNil(goalKg) && !isNil(goalBf)) {
    if (isNil(bf)) return null;
    goalKg = (weight * (1 - bf / 100)) / (1 - goalBf / 100);
  }
  const change = isNil(goalKg) ? 0 : goalKg - weight;
  const split =
    isNil(goalKg) || isNil(bf) || isNil(goalBf)
      ? null
      : (() => {
          const fat = (goalKg * goalBf) / 100 - (weight * bf) / 100;
          return { fat, lean: change - fat };
        })();
  const clamps = [];
  if (!isNil(goalMuscle))
    clamps.push(
      isNil(goalWeight)
        ? "A muscle goal plans with a goal weight or a body-fat goal."
        : "Three goals: planned from goal weight and body fat, not muscle.",
    );
  const floored = flooring(bmr, sex, clamps);
  if (split && Math.abs(change) <= RECOMP_KG && split.fat < 0) {
    // Of lean mass: a recomposition has a body-fat reading (`split`).
    const protein = PROTEIN_PER_LEAN_KG * weight * (1 - bf / 100);
    return {
      target: floored(round10(maintenance * (1 - RECOMP_CUT))),
      perDay: -maintenance * RECOMP_CUT,
      weeklyKg: 0,
      goalKg,
      split,
      recomp: true,
      protein,
      muscle: null,
      clamps,
    };
  }
  const pace = paceOf({
    today,
    goalDate,
    goalKg,
    goalKgPerWeek,
    change,
    split,
    clamps,
  });
  const { perDay, weeklyKg } = slowed(
    pace.perDay,
    pace.weeklyKg,
    weight,
    clamps,
  );
  return {
    target: floored(round10(maintenance + perDay)),
    perDay,
    weeklyKg,
    goalKg: goalKg ?? null,
    split,
    recomp: false,
    protein: null,
    muscle: null,
    clamps,
  };
}

// byWeight's pace, {perDay, weeklyKg} before `slowed`: to the goal by its
// date (`change` kg, as fat and lean with a `split`), else at the weekly
// pace; a goal reached, or a pace away from it, at maintenance (said in
// `clamps`).
function paceOf({
  today,
  goalDate,
  goalKg,
  goalKgPerWeek,
  change,
  split,
  clamps,
}) {
  const left = goalDate && goalDate > today ? daysIn(today, goalDate) - 1 : 0;
  if (left && change) {
    const energy = split
      ? split.fat * FAT_KCAL_PER_KG + split.lean * LEAN_KCAL_PER_KG
      : change * KCAL_PER_KG;
    return { perDay: energy / left, weeklyKg: (change / left) * 7 };
  }
  if (goalKgPerWeek && !isNil(goalKg) && Math.abs(change) <= REACHED_KG) {
    // A goal reached isn't planned past.
    clamps.push("Goal weight reached: planned at maintenance.");
    return { perDay: 0, weeklyKg: 0 };
  }
  if (goalKgPerWeek && Math.sign(goalKgPerWeek) === -Math.sign(change)) {
    // A pace away from the goal weight isn't planned.
    clamps.push(
      `Your pace ${goalKgPerWeek < 0 ? "loses" : "gains"} weight but your goal is ${goalKgPerWeek < 0 ? "above" : "below"} it: planned at maintenance.`,
    );
    return { perDay: 0, weeklyKg: 0 };
  }
  return {
    perDay: (goalKgPerWeek * KCAL_PER_KG) / 7,
    weeklyKg: goalKgPerWeek,
  };
}

// The target under FLOOR or resting energy raised to it, said in `clamps`.
const flooring = (bmr, sex, clamps) => (target) => {
  const floor = Math.max(bmr ?? 0, FLOOR[sex] ?? FLOOR.female);
  if (target >= floor) return target;
  clamps.push(
    `Not below ${kcal(floor)}: ${floor === bmr ? "your resting energy" : `the lowest planned for ${sex === "male" ? "men" : "women"}`}.`,
  );
  return floor;
};

// A pace over MAX_LOSS/GAIN_PER_WEEK of `weight` slowed to it (perDay
// with it), said in `clamps`.
function slowed(perDay, weeklyKg, weight, clamps) {
  const most =
    weeklyKg < 0 ? -MAX_LOSS_PER_WEEK * weight : MAX_GAIN_PER_WEEK * weight;
  if (Math.abs(weeklyKg) <= Math.abs(most)) return { perDay, weeklyKg };
  clamps.push(
    `Slowed to ${unitQty(Math.abs(most), "kg", 1)} a week: ${weeklyKg < 0 ? `losing more than 1${NBSP}%` : `gaining more than 0.5${NBSP}%`} of body weight a week isn't planned.`,
  );
  return { perDay: (perDay * most) / weeklyKg, weeklyKg: most };
}

// The weight at which the mass that is neither fat nor muscle (`weight`
// less its `bf` and `muscle` %) is the share `goalBf` and `goalMuscle`
// leave. Null without a body-fat reading, or with no such share.
function kgAtShares({ weight, bf, muscle, goalBf, goalMuscle }) {
  if (isNil(bf)) return null;
  const rest = weight * (1 - (bf + muscle) / 100);
  const share = 1 - (goalBf + goalMuscle) / 100;
  return rest <= 0 || share <= 0 ? null : rest / share;
}

// A muscle goal with one of goal weight and body fat (ADR 0020, muscle
// amendment): the mass that is neither fat nor muscle (bone, organs,
// water) is kept, so goal weight + muscle % sets muscle Δ and fat takes
// the rest; body fat + muscle % sets the goal weight (that mass ÷ the
// share left). Energy = fat Δ × 9440 + muscle Δ × 1816 (× 1.5 gained,
// SYNTHESIS). The days: the goal date, else the weight pace, else what a
// realistic muscle gain takes; a gain faster than MUSCLE_KG_PER_MONTH is
// planned at it, the date it reaches said. Null without the readings it
// needs (`muscle`, and `bf` without a goal weight) or a goal past them.
function composition({
  today,
  weight,
  bf,
  muscle,
  goalWeight,
  goalBf,
  goalMuscle,
  goalDate,
  goalKgPerWeek,
  maintenance,
  bmr,
  sex,
}) {
  if (isNil(muscle)) return null;
  const goalKg =
    goalWeight ?? kgAtShares({ weight, bf, muscle, goalBf, goalMuscle });
  if (isNil(goalKg)) return null;
  const change = goalKg - weight;
  const muscleKg = (goalKg * goalMuscle - weight * muscle) / 100;
  const fatKg = change - muscleKg;
  const energy =
    fatKg * FAT_KCAL_PER_KG +
    muscleKg * LEAN_KCAL_PER_KG * (muscleKg > 0 ? 1 + SYNTHESIS : 1);
  const clamps = [];
  const realistic = MUSCLE_KG_PER_MONTH[sex] ?? MUSCLE_KG_PER_MONTH.female;
  const muscleDays =
    muscleKg > 0 ? Math.ceil((muscleKg / realistic) * DAYS_PER_MONTH) : 0;
  let days = goalDate && goalDate > today ? daysIn(today, goalDate) - 1 : 0;
  if (
    !days &&
    goalKgPerWeek &&
    Math.abs(change) > REACHED_KG &&
    Math.sign(goalKgPerWeek) === Math.sign(change)
  )
    days = Math.round((change / goalKgPerWeek) * 7);
  if (days && days < muscleDays)
    clamps.push(
      `Gaining ${unitQty(muscleKg, "kg", 1)} of muscle by then is faster than realistic (about ${unitQty(realistic, "kg", 2)} a month): planned to reach it around ${pretty(shift(today, muscleDays))}.`,
    );
  days = Math.max(days, muscleDays);
  if (!days) clamps.push("No goal date or pace: planned at maintenance.");
  const floored = flooring(bmr, sex, clamps);
  const { perDay, weeklyKg } = slowed(
    days ? energy / days : 0,
    days ? (change / days) * 7 : 0,
    weight,
    clamps,
  );
  return {
    target: floored(round10(maintenance + perDay)),
    perDay,
    weeklyKg,
    goalKg,
    split: { fat: fatKg, lean: muscleKg },
    recomp: false,
    protein: (perDay < 0 ? PROTEIN_PER_KG_DEFICIT : PROTEIN_PER_KG) * goalKg,
    muscle: { kg: muscleKg, day: days ? shift(today, days) : null },
    clamps,
  };
}
