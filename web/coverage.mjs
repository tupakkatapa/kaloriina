// The server's coverage and recipe rules, mirrored for what the client
// works out before saving (an editor's live panel) and over days it holds:
// src/model/coverage.rs (`share`, `BORNE`, `water_of`, `recipe_cover`) and
// src/model/food.rs (`Hydration`, a recipe's per 100 g). No DOM here, so
// `node --test` covers it.

import { isNil } from "./format.mjs";
import { KNOWN, scaled, summed } from "./nutrients.mjs";
import { sum } from "./stats.mjs";

// Coverage (ADR 0030): a total of a nutrient is only as complete as the
// food behind it that carries it. `known` (the server's: /day, /summary
// days, recipes) lists by key the share (0 to 1) of the food's dry matter
// (grams less water) that carries it, only where short of all, and `dry`,
// the dry matter itself (per 100 g for a recipe): what a total of several
// days is weighed by. A key of the total not listed is known in full; one
// the total lacks, not at all. Caffeine, alcohol and creatine (`BORNE`)
// are weighed by the grams of what could hold them (drinks, supplements):
// none listed and none eaten is a known none.

// As src/model/coverage.rs `BORNE`.
const BORNE = ["caffeine", "alcohol", "creatine"];

// One total's share of `key` (src/model/coverage.rs `share`).
const shareOf = (d, key) =>
  d.known?.[key] ?? (!isNil(d.total[key]) || BORNE.includes(key) ? 1 : 0);

// The share of `days`' ([{total, known}]) food behind their total of
// `key`, 0 to 1: each day's, weighed by its dry matter (`known.dry`); 0
// when nothing carried it (a BORNE key nothing could hold: 1). Without
// any dry matter (one food, or only drinks), the plain mean.
export function coverage(days, key) {
  if (days.length === 0) return 0;
  let behind = 0;
  let dry = 0;
  for (const d of days) {
    const w = d.known?.dry ?? 0;
    behind += shareOf(d, key) * w;
    dry += w;
  }
  if (dry > 0) return Math.min(behind / dry, 1);
  return sum(days.map((d) => shareOf(d, key))) / days.length;
}

// `values` without the keys `known` leaves under KNOWN: what a health cue
// (lights, tags, the energy split) may judge.
export function knownOnly(values, known) {
  if (!known || !values) return values;
  const total = { total: values, known };
  return Object.fromEntries(
    Object.entries(values).filter(
      ([k]) => k === "energy" || coverage([total], k) >= KNOWN,
    ),
  );
}

// The ingredients' amounts added up, at `weight` grams of them: the weight
// cooking takes or gives is water (boiled off, soaked in), never below none.
function cookedSum(parts, weight) {
  const total = parts.reduce((t, p) => t + p.grams, 0);
  const out = summed(parts.map((p) => scaled(p.per100, p.grams)));
  if (!isNil(out.water)) out.water = Math.max(out.water + weight - total, 0);
  return out;
}

// Per-100 g values of a recipe, as the server computes them: the ingredients'
// amounts spread over the cooked weight (default: their total weight).
export function recipePer100(parts, cookedGrams) {
  const weight = cookedGrams || parts.reduce((total, p) => total + p.grams, 0);
  if (!(weight > 0)) return {};
  return scaled(cookedSum(parts, weight), 10000 / weight);
}

// A food's water as hydration counts it (src/model/coverage.rs
// `water_of`): its water value; a drink without one, its grams less its
// solids, where any of carbohydrate, protein or fat is known; else null.
export function waterOf(n, grams, drink) {
  if (!isNil(n.water)) return n.water;
  if (!drink) return null;
  const carbs =
    n.carbs ?? (isNil(n.net_carbs) ? null : n.net_carbs + (n.fiber ?? 0));
  if ([carbs, n.protein, n.fat].every((x) => isNil(x))) return null;
  return Math.max(
    grams - (carbs ?? 0) - (n.protein ?? 0) - (n.fat ?? 0) - (n.alcohol ?? 0),
    0,
  );
}

// What 100 g of a food adds to hydration (src/model/food.rs `Hydration`):
// {water, alcohol} in ml, alcohol the urine its alcohol costs (10 ml a
// gram, never more than the water); null where it says nothing.
const ALCOHOL_ML_PER_G = 10;
export function hydrationOf(per100, drink) {
  const water = waterOf(per100 ?? {}, 100, drink);
  if (isNil(water)) return null;
  return {
    water,
    alcohol: Math.min((per100.alcohol ?? 0) * ALCOHOL_ML_PER_G, water),
  };
}

// Its dry matter: grams less water; all of it when the water isn't known.
export const dryOf = (n, grams, drink) =>
  Math.max(grams - (waterOf(n, grams, drink) ?? 0), 0);

// Rounded as amounts are written.
const round = (v) => Math.round(v * 1e9) / 1e9;

// The share of a part ({per100, known}) carrying `key`.
const carried = (p, key) => p.known?.[key] ?? (isNil(p.per100[key]) ? 0 : 1);

// recipePer100's `known` (per 100 g), as the server computes it
// (src/model/coverage.rs `recipe_cover`): each key's share of the parts'
// dry matter (a recipe part's own `known.dry`, else its own), a BORNE key's
// of the parts' weight for it (`borne`, per 100 g); `dry` per 100 g. Only
// keys short of all.
export function recipeKnown(parts, cookedGrams) {
  const total = parts.reduce((t, p) => t + p.grams, 0);
  const weight = cookedGrams || total;
  if (!(weight > 0) || !(total > 0)) return {};
  const dry100 = (p) => p.known?.dry ?? dryOf(p.per100, 100, Boolean(p.drink));
  const dry = round(sum(parts.map((p) => dry100(p) * p.grams)) / weight);
  const out = {};
  const keys = new Set(parts.flatMap((p) => Object.keys(p.per100)));
  for (const key of keys) {
    if (BORNE.includes(key)) continue;
    const behind = round(
      sum(parts.map((p) => carried(p, key) * dry100(p) * p.grams)) / weight,
    );
    const share = dry > 0 ? behind / dry : 1;
    if (share < 1) out[key] = share;
  }
  for (const key of BORNE) {
    const w = (p) => (p.borne?.[key] ?? 0) * p.grams;
    const of = sum(parts.map((x) => w(x)));
    const withIt = sum(parts.map((p) => w(p) * carried(p, key)));
    if (of > 0 && round(withIt) < round(of)) out[key] = withIt / of;
  }
  out.dry = dry;
  return out;
}

// A recipe's or meal's whole column ({values, known}): its parts' amounts
// added up as `grams` of it (cooked), and `known` (recipeKnown's: shares,
// whatever the amount).
export const wholeOf = (parts, known, grams) => ({
  values: cookedSum(parts, grams),
  known,
});
