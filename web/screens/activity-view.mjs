// An activity done, read like a workout: its type, day and clock span;
// its time, distance and pace, energy, heart rate and cardio load, where it
// came from and the workout it was done from; then its sets by exercise, a
// record marked.
// The pencil opens its editor (a device's measures stay locked there); Back
// follows `back`, else its day.

import { distanceOf, pace, paceDistance } from "../activities.mjs";
import {
  activityType,
  currentProfile,
  get,
  profileId,
  scoped,
} from "../api.mjs";
import { clockAt, duration, pretty, shift } from "../dates.mjs";
import { activityHeartText } from "../device.mjs";
import { activityLoad, loadText, NEEDS_PROFILE } from "../load.mjs";
import { href, safeBack } from "../nav.mjs";
import {
  activeEnergyLine,
  loadResting,
  menuRow,
  result,
  sourceText,
} from "../rows.mjs";
import { isNil } from "../format.mjs";
import { editLink, h, titleBar } from "../ui.mjs";
import { distanceText } from "../units.mjs";
import { lastTimeText, recordSets } from "../workouts.mjs";

// "17:00–17:45": its start and end on this device's clock, or null
// without a start.
function span(s) {
  if (!s.start_at) return null;
  const end = new Date(Date.parse(s.start_at) + s.minutes * 60_000);
  return `${clockAt(s.start_at)}–${clockAt(end.toISOString())}`;
}

// Where it came from: the device's, an import's, or logged here (a hand
// log a device's record matched says so).
function source(s) {
  if (s.source !== "hand") return sourceText(s);
  return s.source_key
    ? `Logged here · matched with ${sourceText(s)}`
    : "Logged here";
}

// Its sets by exercise, in the order each was first done: "Push-up" over
// "12, 12, 10 reps", "each side" when done a side at a time, a Record
// badge when one of them beat the exercise's best then (`records`: their
// indices). A deleted exercise's sets keep its name, leading nowhere.
function setGroups(sets, records) {
  const groups = new Map();
  sets.forEach((set, i) => {
    const key = set.exercise_id ?? set.name;
    const group = groups.get(key) ?? { set, sets: [], record: false };
    group.sets.push(set);
    group.record ||= records.has(i);
    groups.set(key, group);
  });
  return h(
    "ul",
    { class: "results card activity-sets" },
    [...groups.values()].map((g) =>
      h(
        "li",
        {},
        result({
          href: g.set.exercise_id ? href.exercise(g.set.exercise_id) : null,
          name: [
            g.set.name,
            g.record ? h("span", { class: "badge" }, "Record") : null,
          ],
          detail: [
            lastTimeText(g),
            g.sets.some((x) => x.side) ? "each side" : null,
          ]
            .filter(Boolean)
            .join(" · "),
        }),
      ),
    ),
  );
}

// Its cardio load's line (load.mjs loadText); what the profile lacks
// leads to the profile, where it is set.
const loadLine = (x) =>
  x?.why === NEEDS_PROFILE
    ? ["– · ", h("a", { href: href.profileEdit(profileId) }, NEEDS_PROFILE)]
    : loadText(x);

export async function activityView(id, params = new URLSearchParams()) {
  const [s, workouts] = await Promise.all([
    get(scoped(`/activities/${id}`)),
    // Offline and never read: its workout goes unnamed.
    get("/workouts").catch(() => []),
    loadResting(),
  ]);
  const here = href.activityView(id, safeBack(params.get("back")));
  const type = activityType(s.type);
  // The sets that beat an earlier best when done; unread (offline), none.
  const records =
    s.sets.length > 0
      ? recordSets(
          await get(scoped(`/activities?to=${s.day}`)).catch(() => [s]),
          s,
        )
      : new Set();
  // Its cardio load needs the resting heart rate of its week (load.mjs);
  // unread (offline), no row.
  const near = isNil(s.avg_hr)
    ? null
    : await get(scoped(`/device-days?from=${shift(s.day, -6)}&to=${s.day}`))
        .then((r) => r.days)
        .catch(() => null);
  const metres = distanceOf(s);
  const workout = workouts.find((w) => w.id === s.workout_id);
  const facts = [
    ["Duration", duration(s.minutes)],
    ["Distance", metres === null ? null : distanceText(metres)],
    ["Pace", pace(type?.pace, paceDistance(s), s.minutes)],
    ["Energy", activeEnergyLine(s)],
    ["Heart rate", activityHeartText(s)],
    [
      "Cardio load",
      near && loadLine(activityLoad(s, currentProfile() ?? {}, near)),
    ],
    ["Source", source(s)],
  ].filter(([, v]) => v);
  return h(
    "section",
    { class: "activity-view" },
    titleBar(
      s.name,
      safeBack(params.get("back")) ?? href.day(s.day),
      editLink(href.activityEdit(s.id, { back: here }), "activity"),
    ),
    h(
      "p",
      { class: "muted activity-when" },
      [type?.label ?? "Activity", pretty(s.day), span(s)]
        .filter(Boolean)
        .join(" · "),
    ),
    h(
      "dl",
      { class: "traits" },
      facts.map(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]),
    ),
    // The workout it was done from, a row that leads to it.
    workout
      ? h(
          "section",
          { class: "finder-section" },
          h("h2", {}, "Workout"),
          h(
            "ul",
            { class: "results card activity-workout" },
            menuRow({
              href: href.workout(workout.id, here),
              name: workout.name,
            }),
          ),
        )
      : null,
    s.sets.length > 0
      ? h(
          "section",
          { class: "finder-section" },
          h("h2", {}, "Exercises"),
          setGroups(s.sets, records),
        )
      : null,
  );
}
