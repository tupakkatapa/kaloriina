// Target writes: the energy target offered from Targets (never set
// silently), and the recommendations Recalculate and a new profile
// start from (with what they need). The screens show; this writes.

import {
  api,
  currentProfile,
  get,
  loadProfiles,
  meta,
  scoped,
} from "./api.mjs";
import { daysIn, pretty, today } from "./dates.mjs";
import { withEnergy } from "./energy.mjs";
import { FLOOR, MAX_LOSS_PER_WEEK } from "./expenditure.mjs";
import { isNil, NBSP, qty } from "./format.mjs";
import { route } from "./nav.mjs";
import { kcal } from "./nutrients.mjs";
import { plan as energyPlan } from "./series.mjs";
import { confirmDialog, undoable } from "./ui.mjs";
import { unitQty } from "./units.mjs";

// A target's value in `list`.
const valueOf = (list, key) => list.find((t) => t.metric === key)?.value;

// The targets as a PUT takes them: the profile's own (a registry default
// stays one, not a row).
const targetInput = (list) =>
  list
    .filter((t) => !t.default)
    .map(({ metric, value }) => ({ metric, value }));

// PUT `targets` made from profile revision `rev` (409 `stale` if it moved
// on since), then re-read the profile for the next change.
async function putTargets(rev, targets) {
  await api("PUT", scoped("/targets"), { rev, targets });
  await loadProfiles();
}

// Offer energy target `energy` (with protein at least `protein` g): a
// confirm, then the PUT, undone from the toast. Targets' needed energy
// sets it here, never silently.
export async function setEnergyTarget(energy, protein = 0) {
  // The rev first: targets changed after it make the PUT stale, never lost.
  await loadProfiles();
  const rev = currentProfile().rev;
  const before = targetInput(await get(scoped("/targets")));
  const after = withEnergy(before, energy, protein);
  const [p, c, f] = ["protein", "net_carbs", "fat"].map((k) =>
    valueOf(after, k),
  );
  const raised = p !== valueOf(before, "protein");
  const ok = await confirmDialog(`Set energy target to ${kcal(energy)}?`, {
    detail: [
      isNil(p) || isNil(c) || isNil(f)
        ? null
        : `Protein ${raised ? "rises to" : "stays"} ${qty(p, "g", 0)}; carbs ${qty(c, "g", 0)} and fat ${qty(f, "g", 0)} scale with the energy.`,
      "Recalculate on Targets replaces this.",
    ]
      .filter(Boolean)
      .join(" "),
    confirm: "Set target",
    danger: false,
  });
  if (!ok) return;
  await putTargets(rev, after);
  const old = valueOf(before, "energy");
  undoable(
    `Energy target ${isNil(old) ? "none" : kcal(old)} → ${kcal(energy)}`,
    async () => {
      await loadProfiles();
      await putTargets(currentProfile().rev, before);
      route();
    },
  );
  route();
}

// `/recommended` (DRIs only: the energy model is the client's, ADR 0020)
// at `path` (a profile's), plus `energy` (kcal a day, or null), which the
// shares of energy scale with.
export async function recommendedWith(path, energy) {
  const list = await get(
    `${path}/recommended?day=${today()}${isNil(energy) ? "" : `&energy=${energy}`}`,
  );
  return isNil(energy) ? list : [...list, { metric: "energy", value: energy }];
}

const MEASUREMENTS = [
  ["sex", "sex"],
  ["birth date", "birth_date"],
  ["height", "height_cm"],
  ["weight", "latest_weight_kg"],
  ["activity level", "activity"],
];

// What recommendations still need, by name ("weight").
export const missing = (p) =>
  MEASUREMENTS.filter(([, key]) => isNil(p[key])).map(([name]) => name);

// Recommendations need every measurement.
export const complete = (p) => missing(p).length === 0;

// Targets recommended for a profile just made, once it has every
// measurement: the same calls as Recalculate on Targets.
export async function recommendFor(p) {
  if (!complete(p)) return;
  // No history yet (the profile is in use): maintenance is resting energy
  // × activity level, through the energy model's face.
  const energy = (await energyPlan(p, {})).needed?.target ?? null;
  const recommended = await recommendedWith(`/profiles/${p.id}`, energy);
  await api("PUT", `/profiles/${p.id}/targets`, {
    rev: p.rev,
    targets: recommended.map((t) => ({ metric: t.metric, value: t.value })),
  });
}

// Protein past this many g a kg of body weight a day is more than any
// study found useful (Morton et al., Br J Sports Med 2018: gains plateau
// near 1.6).
const PROTEIN_G_PER_KG_HIGH = 3;

// What's wrong with each goal: `value(key)` its number (stored unit, or
// null), `profile` the profile, `weight` kg now (or null), `plan` the
// energy plan (energy.mjs). {key: {error, text}}: `error` impossible (a
// save is refused), else unrealistic (allowed; the plan slows it).
//
// Body goals no body reaches are impossible: the server refuses them and
// serves their bounds (`meta.limits`); shown here so a value stored before
// the rule reads as wrong before a save is refused.
export function goalProblems(value, profile, weight, plan) {
  const out = {};
  // The first said of a goal stands.
  const say = (key, text, error = false) => {
    out[key] ??= { text, error };
  };
  impossibleGoals(value, profile, say);
  unrealisticPace(value, profile, weight, plan, say);
  unrealisticIntake(value, profile, weight, plan, say);
  return out;
}

// goalProblems' body goals no body reaches, each `say`d as an error.
function impossibleGoals(value, profile, say) {
  const {
    essential_fat: essentialFat,
    goal_bmi: goalBmi,
    fat_muscle_max: fatMuscleMax,
    muscle_of_lean_max: muscleOfLeanMax,
  } = meta.limits;
  const bf = value("goal_body_fat");
  const muscle = value("goal_muscle");
  const goalKg = value("goal_weight");
  if (!isNil(bf)) {
    const floor = essentialFat[profile.sex] ?? essentialFat.male;
    if (bf < floor)
      say(
        "goal_body_fat",
        `At least ${floor}${NBSP}%: below is essential fat${profile.sex ? ` for ${profile.sex === "male" ? "men" : "women"}` : ""}.`,
        true,
      );
  }
  if (!isNil(bf) && !isNil(muscle)) {
    const most =
      Math.floor(
        Math.min(muscleOfLeanMax * (100 - bf), fatMuscleMax - bf) * 10,
      ) / 10;
    if (muscle > most)
      say(
        "goal_muscle",
        `At most ${most}${NBSP}% with ${bf}${NBSP}% body fat: bone, organs and water are the rest.`,
        true,
      );
  }
  if (!isNil(goalKg) && !isNil(profile.height_cm)) {
    const m2 = (profile.height_cm / 100) ** 2;
    const [lo, hi] = goalBmi.map((bmi) => bmi * m2);
    if (goalKg < lo || goalKg > hi)
      say(
        "goal_weight",
        `${unitQty(lo, "kg", 1)}–${unitQty(hi, "kg", 1)} for your height (BMI ${goalBmi.join("–")}).`,
        true,
      );
  }
}

// goalProblems' goals a body could reach, but not by their date: allowed,
// each `say`d as a warning.
function unrealisticPace(value, profile, weight, plan, say) {
  const muscle = value("goal_muscle");
  const goalKg = value("goal_weight");
  const day = today();
  if (
    !isNil(goalKg) &&
    !isNil(weight) &&
    profile.goal_date > day &&
    goalKg < weight
  ) {
    const weekly =
      ((weight - goalKg) / (daysIn(day, profile.goal_date) - 1)) * 7;
    if (weekly > MAX_LOSS_PER_WEEK * weight)
      say(
        "goal_weight",
        `${unitQty(weekly, "kg", 1)} a week by ${pretty(profile.goal_date)} is more than 1${NBSP}% of your weight a week: the plan slows it.`,
      );
  }
  const muscleDay = plan?.needed?.muscle?.day;
  if (!isNil(muscle) && muscleDay && profile.goal_date < muscleDay)
    say(
      "goal_muscle",
      `Faster than muscle realistically grows: around ${pretty(muscleDay)} is likelier.`,
    );
}

// goalProblems' energy and protein targets hard to live on: allowed, each
// `say`d as a warning.
function unrealisticIntake(value, profile, weight, plan, say) {
  const energy = value("energy");
  const floor = Math.max(plan?.bmr ?? 0, FLOOR[profile.sex] ?? FLOOR.female);
  if (!isNil(energy) && energy < floor)
    say(
      "energy",
      `Under ${kcal(floor)}, ${floor === plan?.bmr ? "your resting energy" : "the lowest planned"}: hard to keep, and to get enough nutrients from.`,
    );
  const protein = value("protein");
  if (
    !isNil(protein) &&
    !isNil(weight) &&
    protein > PROTEIN_G_PER_KG_HIGH * weight
  )
    say(
      "protein",
      `Over ${PROTEIN_G_PER_KG_HIGH}${NBSP}g a kg of your weight (${qty(PROTEIN_G_PER_KG_HIGH * weight, "g", 0)}): more than muscle uses.`,
    );
}
