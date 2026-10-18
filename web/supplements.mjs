// Supplements that work best with a meal that has fat (vitamins A, D, E,
// K, a multivitamin, fish oil; research brief 2026-10-18), known by the
// words in their names, Finnish or English (as src/model/coverage.rs
// knows caffeine), and a Diary note on one eaten at a logged time when the
// day's log proves no meal with fat came within the hour. No DOM here, so
// `node --test` covers it.

import { nowTime, today } from "./dates.mjs";
import { minutesOf } from "./device.mjs";
import { isNil } from "./format.mjs";

// Either side of the supplement's time.
export const WINDOW_MIN = 60;
// Fat a meal needs to count: absorption studies compare a meal of 5–15 g
// with a fat-free one (brief).
export const FAT_G = 5;

// A word starting at a word's start ("kalaöljykapseli" has "kalaöljy",
// "Vitamin D3" has "vitamin d"; "C-vitamiini" has none).
const at = (words) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join("|")})`, "iu");

// First match wins: "D3 + K2" is vitamin D.
const SUPPLEMENTS = [
  { lead: "A multivitamin", re: at(["monivitamii?ni", "multivitamii?n"]) },
  {
    lead: "Fish oil",
    re: at(["kalaöljy", "krilliöljy", "fish oil", "krill oil", "omega[- ]?3"]),
  },
  { lead: "Vitamin D", re: at(["d-vitamiini", "d3", "vitamin d(?!\\p{L})"]) },
  { lead: "Vitamin A", re: at(["a-vitamiini", "vitamin a(?!\\p{L})"]) },
  { lead: "Vitamin E", re: at(["e-vitamiini", "vitamin e(?!\\p{L})"]) },
  { lead: "Vitamin K", re: at(["k-vitamiini", "k2", "vitamin k(?!\\p{L})"]) },
];

// The supplement `name` names, {lead}, or null.
export const supplementOf = (name) =>
  SUPPLEMENTS.find((s) => s.re.test(name)) ?? null;

// A dose, not a food: at most DOSE_KCAL, or (no energy known) DOSE_G.
// "Omega-3 munat" and D-vitamin milk are food that has the word.
const DOSE_KCAL = 30;
const DOSE_G = 10;
const isDose = (e) =>
  isNil(e.nutrients?.energy)
    ? e.grams <= DOSE_G
    : e.nutrients.energy <= DOSE_KCAL;

// The supplement entry `e` is a dose of, or null.
const doseOf = (e) => (isDose(e) ? supplementOf(e.name) : null);

// The most fat entry `e` could hold: its fat, else (not known) its weight.
const fatCeiling = (e) => e.nutrients?.fat ?? e.grams ?? Infinity;

// Now on this device: {day, time}.
const deviceNow = () => ({ day: today(), time: nowTime(today()) });

// Notes on `entries` (one day's Eaten), key → text, for each supplement
// dose (`doseOf`) eaten at a logged time with no meal of FAT_G fat within WINDOW_MIN.
// Said only when the log proves it: the fat of every other entry timed
// within the window and of every untimed one (it could be anywhere) is
// counted at its ceiling (fatCeiling). No time, within the window of
// midnight (the meal may be on the next day's page), or today before the
// window is over (`now`: {day, time}, this device's by default; null: no
// day is today; the meal may still come): nothing.
export function supplementNotes(entries, now = deviceNow()) {
  const out = new Map();
  const taken = entries.filter((e) => doseOf(e));
  const meals = entries.filter((e) => !doseOf(e));
  for (const s of taken) {
    if (isNil(s.time)) continue;
    const t = minutesOf(s.time);
    if (t < WINDOW_MIN || t + WINDOW_MIN > 24 * 60) continue;
    if (
      now &&
      (s.day > now.day ||
        (s.day === now.day && t + WINDOW_MIN > minutesOf(now.time)))
    )
      continue;
    const fat = meals
      .filter(
        (e) => isNil(e.time) || Math.abs(minutesOf(e.time) - t) <= WINDOW_MIN,
      )
      .reduce((sum, e) => sum + fatCeiling(e), 0);
    if (fat < FAT_G)
      out.set(
        s.key,
        `${doseOf(s).lead} works best with a meal that has fat: none within an hour`,
      );
  }
  return out;
}
