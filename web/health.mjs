// Health cues on a food, recipe or meal, from its per-100 g values: traffic
// lights, where its energy comes from, what 100 kcal (or 500 kJ) of it
// gives of the profile's targets, and how its labels (the server's) are
// shown. Pure, no DOM, so `node --test` covers it. Why these rules: ADR 0017.

import { knownOnly } from "./coverage.mjs";
import { isNil, lower, pct, PER_100G, qty } from "./format.mjs";
import { guessed, nutrient, usLabel } from "./nutrients.mjs";

// UK DH/FSA front-of-pack guide (Nov 2016), Annex 3, Tables 2 (food, per
// 100 g) and 3 (drinks, per 100 ml): [low ≤, high >, red per portion >].
// The portion reds are 30 % (food) and 15 % (drinks) of the reference
// intake; energy is never colour coded. Salt in grams.
const THRESHOLDS = {
  food: {
    fat: [3, 17.5, 21],
    saturated: [1.5, 5, 6],
    sugars: [5, 22.5, 27],
    salt: [0.3, 1.5, 1.8],
  },
  drink: {
    fat: [1.5, 8.75, 10.5],
    saturated: [0.75, 2.5, 3],
    sugars: [2.5, 11.25, 13.5],
    salt: [0.3, 0.75, 0.9],
  },
};
// The portion red applies only to a portion over this (g or ml).
const PORTION_OVER = { food: 100, drink: 150 };
// Over 1.2 % ABV (× 0.789 g/ml): no nutrition declaration, so no lights
// (Reg. (EU) 1169/2011 Art. 16(4)).
const ALCOHOL_MAX = 0.95;
// kcal per 100 g at or under which "per 100 kcal" means nothing: the EU
// "energy-free" claim (Reg. (EC) 1924/2006 Annex).
const ENERGY_FREE = 4;
// An at-most nutrient warns at this many fair shares.
const CAUTION = 2;
// The EU reference intake for energy (Reg. 1169/2011 Annex XIII Part B).
const REFERENCE_KCAL = 2000;

// The four lights in label order, with the FSA's words but saturates in
// the label chips' ("Low sat. fat": one name on one screen; the US label
// names them as its registry does).
const LIGHTS = [
  ["fat", "Fat", "fat"],
  ["saturated", "Sat. fat", "saturated"],
  ["sugars", "Sugars", "sugars"],
  ["sodium", "Salt", "salt"],
];

export const alcoholic = (per100) => (per100?.alcohol ?? 0) > ALCOHOL_MAX;

// Lights read a per-100 g fact a guessed weight doesn't give (a food known
// only per item, `basis.estimated`): none for one, nor for a recipe or meal
// holding one. Split and density are per kcal, so they still show.
export const NO_KNOWN_WEIGHT = "Lights need a known weight";
export const weightGuessed = (food) =>
  guessed(food) || (food?.items ?? []).some((x) => guessed(x));

// Salt grams from sodium mg, by the factor the server's EU label uses.
const saltOf = (sodium) => sodium * nutrient("sodium").display.factor;

// The lights of these per-100 g values, each {key, label, value, level:
// low|medium|high|null (not given), portion}; `grams` (an amount on screen)
// lets a big portion turn red. Null when none of the four is given, for a
// guessed weight (`estimated`, see `weightGuessed`), or for an alcoholic drink.
export function trafficLights(
  per100,
  { drink = false, grams = null, estimated = false } = {},
) {
  if (!per100 || estimated || alcoholic(per100)) return null;
  if (LIGHTS.every(([key]) => isNil(per100[key]))) return null;
  const table = drink ? "drink" : "food";
  const big = !isNil(grams) && grams > PORTION_OVER[table];
  const us = usLabel();
  return LIGHTS.map(([key, word, cut]) => {
    const label = (us && nutrient(key)?.label) || word;
    const raw = per100[key];
    const value = isNil(raw) ? null : key === "sodium" ? saltOf(raw) : raw;
    const [low, high, red] = THRESHOLDS[table][cut];
    let level = null;
    if (value !== null)
      level = value <= low ? "low" : value > high ? "high" : "medium";
    const portion = big && level !== "high" && (value * grams) / 100 > red;
    return { key, label, value, level: portion ? "high" : level, portion };
  });
}

// One light as read: "fat low", "salt not given", "fat high in this amount".
export const lightText = (l) =>
  `${lower(l.label)} ${
    l.level === null ? "not given" : l.portion ? "high in this amount" : l.level
  }`;

// The lights as one sentence: "Per 100 g: fat low, sat. fat medium, …".
export const lightsText = (lights, basis = PER_100G) =>
  `${basis}: ${lights.map((x) => lightText(x)).join(", ")}`;

// A target's direction, from its bounds; water is hydration, not density.
const atLeast = (t) => t.min > 0 && isNil(t.max) && t.metric !== "water";
const atMost = (t) => !isNil(t.max) && isNil(t.min);

// The energy density is read per a round amount of the energy unit shown:
// 100 kcal, or 500 kJ (≈ 120 kcal).
const ENERGY_PORTION = { kcal: 100, kJ: 500 };

// That amount on this device: its label ("100 kcal") and kcal.
export function energyPortion() {
  const e = nutrient("energy");
  return {
    label: qty(ENERGY_PORTION[e.unit], e.unit),
    kcal: e.store(ENERGY_PORTION[e.unit]),
  };
}

// What a portion of energy (`energyPortion`) of it gives of the profile's
// nutrient `targets`, % each: {fair, gives: [{key, label, share}],
// cautions: [same]}. `fair` is the portion's share of the day's energy;
// `gives` the at-least targets it meets at that share or better (top 6,
// water left out), `cautions` the at-most ones at CAUTION × fair or more.
// {skip: reason} with too little energy; {none: true} without nutrient
// targets.
export function density(per100, targets) {
  const energy = per100?.energy;
  const portion = energyPortion();
  if (isNil(energy) || energy <= ENERGY_FREE)
    return { skip: `Too little energy to measure per ${portion.label}` };
  const own = (targets ?? []).filter((t) => nutrient(t.metric));
  if (own.length === 0) return { none: true };
  const day = own.find((t) => t.metric === "energy")?.value || REFERENCE_KCAL;
  const fair = (portion.kcal * 100) / day;
  const shares = (keep) =>
    own
      .filter((t) => keep(t) && t.value > 0 && !isNil(per100[t.metric]))
      .map((t) => ({
        key: t.metric,
        label: nutrient(t.metric).label,
        share: (per100[t.metric] * portion.kcal * 100) / (energy * t.value),
      }))
      .sort((a, b) => b.share - a.share);
  return {
    fair,
    gives: shares(atLeast)
      .filter((s) => s.share >= fair)
      .slice(0, 6),
    cautions: shares(atMost).filter((s) => s.share >= CAUTION * fair),
  };
}

// The values the score needs (energy and the lights) these per-100 g
// values lack, or a recipe's `known` leaves short (knownOnly), in the
// FSA's words ("sugars", "salt"): what keeps a food from a verdict. With
// at most 1 g of fat, saturates can't score, so they aren't needed (the
// server's rule, src/model/score.rs).
export const unknownLights = (per100, known = null) => {
  const given = knownOnly(per100 ?? {}, known);
  const fatFree = !isNil(given.fat) && given.fat <= 1;
  return [["energy", "Energy"], ...LIGHTS]
    .filter(([key]) => isNil(given[key]))
    .filter(([key]) => !(key === "saturated" && fatFree))
    .map(([, word]) => lower(word));
};

// A food's verdict (`text`, "OK") and why, from its reasons (the
// server's `labels.why`): what counts against an Unhealthy food, for a
// Healthy one, and both for OK. "OK: salt, but fruit & veg". Null without
// a verdict or reasons.
export function verdictLine(food, text) {
  const { verdict = null, why = [] } = food?.labels ?? {};
  const words = (positive) =>
    why.filter((r) => r.positive === positive).map((r) => r.text);
  const [against, of] = [words(false), words(true)];
  const parts =
    verdict === "unhealthy"
      ? against
      : verdict === "healthy"
        ? of
        : [against.join(", "), of.join(", ")].filter(Boolean);
  if (!verdict || parts.length === 0) return null;
  return `${text}: ${parts.join(verdict === "ok" ? ", but " : ", ")}`;
}

// The EU reference intakes (Reg. (EU) 1169/2011 Annex XIII Part B) of
// what a score can count against a food: kcal, g, g, mg of sodium (6 g of
// salt).
const REFERENCE = { energy: 2000, saturated: 20, sugars: 90, sodium: 2400 };

// What a typical serving (the food's first, under 100 g) holds of what
// counts against a food that isn't Healthy, as the largest share of a
// day's reference intake: "Slice (5 g): 3 % of a day's salt". The score is
// per 100 g; the serving is context (ADR 0033). Null otherwise.
export function servingNote(food) {
  const serving = food?.servings?.[0];
  const { verdict = null, why = [] } = food?.labels ?? {};
  if (!serving || serving.grams >= 100 || !verdict || verdict === "healthy")
    return null;
  const top = why
    .filter(
      (r) => !r.positive && REFERENCE[r.key] && !isNil(food.per100?.[r.key]),
    )
    .map((r) => ({
      text: r.text,
      share: (food.per100[r.key] * serving.grams) / REFERENCE[r.key],
    }))
    .toSorted((a, b) => b.share - a.share)[0];
  if (!top) return null;
  const share = top.share < 1 ? `under ${pct(1)}` : pct(top.share);
  return `${serving.label} (${qty(serving.grams, "g")}): ${share} of a day's ${top.text}`;
}
