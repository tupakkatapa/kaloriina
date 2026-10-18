// Summary → Activity's cardio load (ADR 0034): the period's (a week's
// total, a month's or year's a week), and beside a week the 4 weeks before
// it (uncoupled, no ratio: the brief). Its own module, hooked from
// summary-activity.mjs's `load` and `render`.

import { currentProfile } from "../api.mjs";
import { daysIn, shift, today } from "../dates.mjs";
import { activeMark } from "../energy-text.mjs";
import { fmt, plural } from "../format.mjs";
import { periodLoad } from "../load.mjs";
import { tiles } from "../tiles.mjs";
import { h } from "../ui.mjs";

const BEFORE_DAYS = 28;
// load.mjs reads a resting heart rate up to 6 days before an activity.
const REST_BACK = 6;

// "≈ " an estimate, "≥ " a floor (an activity without a load).
const mark = (x) => activeMark({ floor: x.missing > 0, estimated: true });

// The activities from BEFORE_DAYS before the period, and the device days
// from REST_BACK before those, and whose they are: each activity's load
// as its view has it (and the Highlights' loadChange reads them).
export async function loadCardio(p, shared) {
  const from = shift(p.from, -BEFORE_DAYS);
  const [activities, deviceDays] = await Promise.all([
    shared.rows("activities", from, p.to),
    shared.rows("deviceDays", shift(from, -REST_BACK), p.to),
  ]);
  return { profile: currentProfile() ?? {}, activities, deviceDays };
}

// "≈ 210 cardio load" ("≥" a floor: an activity without a load), "≈ 13 a
// week, the 4 weeks before"; "so far" while the week runs; a month or year
// a week over its days from `since`. "–" when no activity has a load;
// nothing without activities. Through today: an activity logged today is
// whole. How it's counted is each tile's long text.
export function cardioSection(p, { profile, activities, deviceDays }, since) {
  const end = p.throughToday;
  const done = activities.filter((s) => s.day >= p.from && s.day <= end);
  if (done.length === 0) return null;
  const now = periodLoad(done, profile, deviceDays);
  const week = p.kind === "week";
  const before = week
    ? periodLoad(
        activities.filter((s) => s.day < p.from),
        profile,
        deviceDays,
      )
    : null;
  const without = now.missing
    ? ` ≥: ${plural(now.missing, "activity", "activities")} without a load (no heart rate, or no resting heart rate that week).`
    : "";
  const how = `Banister's TRIMP from each activity's average heart rate, your resting heart rate that week and a maximum by age: an estimate.${without}`;
  const weeks = Math.max(1, daysIn(since, end)) / 7;
  return h(
    "section",
    { class: "finder-section cardio-load" },
    h("h2", {}, "Cardio load"),
    tiles("Cardio load", [
      now.loaded === 0
        ? { value: "–", short: "cardio load", long: how }
        : week
          ? {
              value: `${mark(now)}${fmt(now.total)}`,
              short: `cardio load${p.to >= today() ? " so far" : ""}`,
              long: how,
            }
          : {
              value: `${mark(now)}${fmt(now.total / weeks)}`,
              short: "cardio load a week",
              long: `${how} A week on average over this ${p.kind}'s days.`,
            },
      before?.loaded
        ? {
            value: `${mark(before)}${fmt(before.total / 4)}`,
            short: "a week, the 4 weeks before",
            long: "The 28 days before this week ÷ 4.",
          }
        : null,
    ]),
  );
}
