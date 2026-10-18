// Profile → All time: the profile's totals since its first day (`/stats`),
// what it ate and burned on the same days by the energy model (ADR 0020),
// and the same said as everyday things (fun.mjs).

import { activityType, get, meta, scoped } from "../api.mjs";
import { duration, pretty, prettyYear, today } from "../dates.mjs";
import { fmt, NBSP, noun, plural, qty } from "../format.mjs";
import { aboutLine, perspectives } from "../fun.mjs";
import { href } from "../nav.mjs";
import { kcal } from "../nutrients.mjs";
import { resultRow } from "../rows.mjs";
import { burned, periodNumbers } from "../series.mjs";
import { h, titleBar } from "../ui.mjs";
import { tiles } from "../tiles.mjs";
import { unitQty } from "../units.mjs";

// Energy eaten and burned (by the energy model) over the same days as
// Summary's balance (periodNumbers): each day with food logged through
// yesterday (today's is still coming in) that the model has a burned
// figure for. {eaten, partly, burned, days}; null before a whole such day.
// A day not logged burned too, but set beside nothing eaten it would read
// as a deficit.
async function balance() {
  const { days, bmr, energy } = await burned(null, today());
  const n = periodNumbers({ days: energy, burned: days, bmr });
  return (
    n && {
      eaten: n.eaten * n.n,
      // A day whose energy leaves some out makes the sum a floor.
      partly: n.partly,
      burned: n.burned * n.n,
      days: n.n,
    }
  );
}

// "≥ 16,303 mg" for a total some eaten food didn't carry (`/stats`
// `at_least`; energy's when a food without energy was eaten): a lower
// bound, not a total.
const atLeast = (s, key, text) =>
  s.at_least?.includes(key) ? `≥ ${text}` : text;

// " At least: some food logged without it." for a total `/stats` says
// is a floor.
const floorWords = (s, key) =>
  s.at_least?.includes(key) ? " At least: some food logged without it." : "";

// "since Jul 2" under a total starting on another day than the page's
// first (food's): earlier or later, its own start.
const since = (from, first, text) =>
  from && from !== first ? `${text} since ${pretty(from, false)}` : text;

// Alcohol in drinks, as the built-in habit counts it (`meta.habits`).
const drinks = (grams) =>
  grams * (meta.habits.find((b) => b.key === "alcohol")?.factor ?? 0);

// "In other words": the perspectives shown, and the constants behind them.
const otherWords = (shown) =>
  shown.length > 0
    ? [
        h("h2", {}, "In other words"),
        tiles(
          "In other words",
          shown.map((p) => ({ value: p.shown, short: p.text, long: p.long })),
        ),
        h("p", { class: "muted" }, aboutLine(shown)),
      ]
    : null;

export async function allTime() {
  // Both at once: burned doesn't wait for the totals.
  const [s, b] = await Promise.all([get(scoped("/stats")), balance()]);
  const back = href.profile();
  if (!s.first_day)
    return h(
      "section",
      {},
      titleBar("All time", back),
      h(
        "p",
        { class: "muted" },
        "Nothing logged yet: your totals start with your first day.",
      ),
    );
  return h(
    "section",
    {},
    titleBar("All time", back),
    h("p", { class: "muted" }, `Since ${prettyYear(s.first_day)}.`),
    h("h2", {}, "Food"),
    tiles("Food", [
      {
        value: fmt(s.days_logged),
        short: `${noun(s.days_logged, "day")} logged`,
        long: "Days with any food logged.",
      },
      {
        value: fmt(s.longest_streak),
        short: "longest streak of logged days",
        long: "Your longest run of days in a row with food logged.",
      },
      {
        value: fmt(s.entries),
        short: noun(s.entries, "food logged", "foods logged"),
        long: "Every food and drink you logged, each time counted.",
      },
      {
        value: atLeast(s, "energy", kcal(s.kcal_eaten)),
        short: "eaten",
        long: `All the energy you logged eating.${floorWords(s, "energy")}`,
      },
      b && {
        value: `${b.partly ? `≥${NBSP}` : ""}${kcal(b.eaten / b.days)}`,
        short: "eaten a day",
        long: `Your average a day over the ${plural(b.days, "day")} with food logged through yesterday (today's is still coming in).${b.partly ? " At least: some food logged without energy." : ""}`,
      },
      b && {
        value: `≈ ${kcal(b.burned)}`,
        short: "burned on logged days",
        long: `An estimate of what you burned (resting, digesting, moving) on the ${plural(b.days, "day")} with food logged through yesterday.`,
      },
      {
        value: atLeast(s, "water", unitQty(s.water_ml / 1000, "L", 1)),
        short: "hydration",
        long: `Water from everything you ate and drank, less alcohol's effect.${floorWords(s, "water")}`,
      },
      {
        value: atLeast(s, "caffeine", qty(s.caffeine_mg, "mg", 0)),
        short: "caffeine",
        long: `All the caffeine in what you logged.${floorWords(s, "caffeine")}`,
      },
      s.alcohol_g
        ? {
            value: atLeast(s, "alcohol", fmt(drinks(s.alcohol_g))),
            short: noun(drinks(s.alcohol_g), "drink"),
            long: `Your alcohol in standard drinks, as the Alcohol habit counts them.${floorWords(s, "alcohol")}`,
          }
        : null,
      // Lower bounds: a dish counts only as far as it is plainly beef or
      // potato (/stats).
      s.classes_known && s.beef_g
        ? {
            value: `≥ ${unitQty(s.beef_g / 1000, "kg", 1)}`,
            short: "beef",
            long: "Beef in what you logged, at least: a dish counts only as far as it is plainly beef.",
          }
        : null,
      s.classes_known && s.potato_g
        ? {
            value: `≥ ${unitQty(s.potato_g / 1000, "kg", 1)}`,
            short: "potatoes",
            long: "Potatoes in what you logged, at least: a dish counts only as far as it is plainly potato.",
          }
        : null,
    ]),
    h("h2", {}, "Activity"),
    tiles("Activity", [
      {
        value: fmt(s.activities),
        short: since(
          s.activities_from,
          s.first_day,
          noun(s.activities, "activity", "activities"),
        ),
        long: "Every activity you logged or a device recorded and you added.",
      },
      {
        value: duration(s.minutes_trained),
        short: since(s.activities_from, s.first_day, "active"),
        long: "The time of all your activities, added up.",
      },
      s.distance_m
        ? {
            // A total to a tenth, not "300.29 km".
            value: unitQty(s.distance_m / 1000, "km", 1),
            short: since(s.activities_from, s.first_day, "in activities"),
            long: "The distance of your activities that have one, added up.",
          }
        : null,
      s.steps
        ? {
            value: fmt(s.steps),
            short: since(s.steps_from, s.first_day, noun(s.steps, "step")),
            long: "Every step your device counted.",
          }
        : null,
      s.step_days
        ? {
            value: fmt(s.steps / s.step_days),
            short: "steps a day",
            long: `Your average steps a day, over the ${plural(s.step_days, "day")} your device counted them.`,
          }
        : null,
      s.asleep_min
        ? {
            value: duration(s.asleep_min),
            short: since(s.sleep_from, s.first_day, "asleep"),
            long: "All your time asleep, nights and naps, as your device recorded it.",
          }
        : null,
      s.naps
        ? {
            value: fmt(s.naps),
            short: since(s.naps_from, s.first_day, noun(s.naps, "nap")),
            long: "Sleeps outside the night, as your device recorded or you logged them.",
          }
        : null,
      s.weigh_ins
        ? {
            value: fmt(s.weigh_ins),
            short: since(
              s.weigh_ins_from,
              s.first_day,
              noun(s.weigh_ins, "weigh-in"),
            ),
            long: "Days with a weight logged or from your scale.",
          }
        : null,
    ]),
    s.by_type.length > 0
      ? h(
          "ul",
          { class: "results card", "aria-label": "By type" },
          s.by_type.map((t) =>
            resultRow({
              name: activityType(t.type)?.label ?? t.type,
              detail: [
                `${fmt(t.activities)} ${noun(t.activities, "time")}`,
                duration(t.minutes),
                // A total to a tenth, not "300.29 km".
                t.distance_m ? unitQty(t.distance_m / 1000, "km", 1) : null,
              ]
                .filter(Boolean)
                .join(" · "),
            }),
          ),
        )
      : null,
    otherWords(perspectives(s, b?.burned ?? null)),
    h("h2", {}, "Your library"),
    tiles("Your library", [
      {
        value: fmt(s.custom_foods),
        short: `${noun(s.custom_foods, "food")} of your own`,
        long: "Foods you made or added yourself, not from a food database.",
      },
      {
        value: fmt(s.recipes),
        short: noun(s.recipes, "recipe"),
        long: "Recipes saved in your library.",
      },
      {
        value: fmt(s.meals),
        short: noun(s.meals, "meal"),
        long: "Meals (a set of foods logged together) saved in your library.",
      },
    ]),
    h("p", { class: "muted" }, "The library is shared by every profile."),
  );
}
