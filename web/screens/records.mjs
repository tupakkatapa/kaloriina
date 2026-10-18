// Activity → Records: your bests, as the server finds them (`/records`):
// each exercise's heaviest, most reps or longest set; each activity type's
// longest and fastest; and, from the device days, the best
// step day, the longest night and (when more) the most sleep in a day with
// naps. "Log a set" picks an exercise for a record attempt outside a
// workout.

import { dayRecords, pace } from "../activities.mjs";
import { activityType, get, meta, scoped } from "../api.mjs";
import { duration, pretty } from "../dates.mjs";
import { plural } from "../format.mjs";
import { go, href } from "../nav.mjs";
import { exerciseRow, resultRow } from "../rows.mjs";
import { h, picker, titleBar } from "../ui.mjs";
import { distanceText } from "../units.mjs";
import { library, setText } from "../workouts.mjs";

const row = (name, value, day, to = null) =>
  resultRow({ href: to, name, detail: `${value} · ${pretty(day)}` });

const list = (title, rows) =>
  rows.length > 0
    ? h(
        "section",
        { class: "finder-section" },
        h("h2", {}, title),
        h("ul", { class: "results card" }, rows),
      )
    : null;

const at = (s) => href.activityView(s.id, href.records());

// One activity type's bests, the ones it has. No "most energy": a
// activity's energy is a device's measure, a typed total or an estimate,
// read as active against a resting model (expenditure.mjs activeOf): no
// record.
function typeRows(type, best) {
  return [
    best.distance &&
      row(
        "Longest distance",
        distanceText(best.distance.distance_m),
        best.distance.day,
        at(best.distance),
      ),
    best.minutes &&
      row(
        "Longest time",
        duration(best.minutes.minutes),
        best.minutes.day,
        at(best.minutes),
      ),
    best.pace &&
      pace(activityType(type)?.pace, best.pace.distance_m, best.pace.minutes) &&
      row(
        "Fastest pace",
        pace(activityType(type)?.pace, best.pace.distance_m, best.pace.minutes),
        best.pace.day,
        at(best.pace),
      ),
  ].filter(Boolean);
}

export async function recordsScreen() {
  const [records, device, exercises] = await Promise.all([
    get(scoped("/records")),
    get(scoped("/device-days")),
    get("/exercises"),
  ]);
  const lib = library(exercises);
  // A set of the exercise picked, logged as its own activity.
  const logSet = picker({
    placeholder: "Log a set",
    search: (q) => lib.search(q),
    row: (m, pick) => exerciseRow(m, pick, lib),
    onPick: ({ root, hit }) =>
      go(
        href.activityEdit("new", {
          exercise: (hit ?? root).id,
          back: href.records(),
        }),
      ),
  });
  const byType = records.types;
  const days = dayRecords(device.days);
  // Every exercise done (by name), its heaviest set, else its most reps or
  // longest.
  const exerciseRows = records.exercises.flatMap((r) => {
    const best = r.kg ?? r.reps ?? r.seconds;
    return best
      ? [row(r.name, setText(best.set), best.day, href.exercise(r.exercise_id))]
      : [];
  });
  const sections = [
    list(
      "Days",
      [
        days.steps &&
          row(
            "Best step day",
            plural(days.steps.value, "step"),
            days.steps.day,
          ),
        days.night &&
          row("Longest night", duration(days.night.value), days.night.day),
        // Naps' time asleep added: only when that beats the night alone.
        days.sleep &&
          days.sleep.value > (days.night?.value ?? 0) &&
          row(
            "Most sleep in a day, naps added",
            duration(days.sleep.value),
            days.sleep.day,
          ),
      ].filter(Boolean),
    ),
    ...meta.activity_types
      .filter((t) => byType[t.key])
      .map((t) => list(t.label, typeRows(t.key, byType[t.key]))),
    list("Exercises", exerciseRows),
  ].filter(Boolean);
  return h(
    "section",
    {},
    titleBar("Records", href.activity()),
    logSet,
    sections.length > 0
      ? sections
      : h(
          "p",
          { class: "muted" },
          "Nothing logged yet: records start with an activity, a set or a finished workout.",
        ),
  );
}
