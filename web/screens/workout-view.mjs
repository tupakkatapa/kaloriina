// A saved workout, read like a food: its line (sets, time, energy), Copy
// and Start, its steps in order, its notes, and the last times it was done
// (each opening its activity's view). The pencil opens its editor; Back
// follows `back`.

import { copyButton } from "../actions.mjs";
import { startLink } from "../activity-sheet.mjs";
import { api, get, scoped, uid } from "../api.mjs";
import { href, safeBack } from "../nav.mjs";
import {
  activityRow,
  loadResting,
  RECENT,
  recentRows,
  result,
  workoutEnergy,
} from "../rows.mjs";
import { editLink, empty, h, notesSection, titleBar } from "../ui.mjs";
import { library, STEP_KINDS, workoutLine } from "../workouts.mjs";

// The steps of a list, in order, a row each: an exercise (to its page)
// with its amount and load, a rest, a note's text, a repeat's rounds with
// its own steps under it.
function stepList(steps, lib, cls = "results card workout-steps") {
  return h(
    "ol",
    { class: cls },
    steps.map((s) => {
      const e = lib.byId.get(s.exercise_id) ?? null;
      const kind = STEP_KINDS[s.kind];
      const row = {
        exercise: () =>
          result({
            href: e ? href.exercise(e.id) : null,
            name: kind.title(s, e),
            detail: kind.line(s, e),
          }),
        rest: () => result({ name: kind.title(s, e), detail: kind.line(s, e) }),
        note: () =>
          result({
            name: s.name ?? "Note",
            detail: s.text
              ? h("span", { class: "muted notes-text" }, s.text)
              : null,
          }),
        repeat: () =>
          result({ name: kind.title(s, e), detail: kind.line(s, e) }),
      }[s.kind]();
      return h(
        "li",
        { class: `step-${s.kind}` },
        row,
        s.kind === "repeat"
          ? stepList(s.steps, lib, "results workout-steps")
          : null,
      );
    }),
  );
}

// The latest times it was done (RECENT, then All activities of it), each
// its day over its brief line, opening its view with a way back to `here`;
// offline, said so (it's never cached).
async function history(id, here) {
  let done;
  try {
    done = await get(
      scoped(`/activities?workout_id=${id}&limit=${RECENT + 1}`),
    );
  } catch (err) {
    if (err.code !== "offline") throw err;
    return empty("History shows when online");
  }
  if (done.length === 0) return empty("Not done yet.");
  return h(
    "ul",
    { class: "results card workout-history" },
    recentRows(
      // The server's oldest first: the latest leads.
      done.toReversed(),
      (s) => activityRow(s, here, { byDay: true }),
      href.activities({ workout: id, back: here }),
    ),
  );
}

export async function workoutView(id, params = new URLSearchParams()) {
  const back = safeBack(params.get("back"));
  const here = href.workout(id, back);
  const [w, exercises, done] = await Promise.all([
    get(`/workouts/${id}`),
    get("/exercises"),
    history(id, here),
    loadResting(),
  ]);
  const lib = library(exercises);
  // A copy made on the server, opened in its editor, saving to its view.
  const copy = copyButton(
    () => api("POST", `/workouts/${id}/copy`, { uid: uid() }),
    null,
    (made) => href.workoutEdit(made.id, href.workout(made.id)),
    "Copy workout",
  );
  return h(
    "section",
    { class: "workout-view" },
    titleBar(
      w.name,
      back ?? href.activity(),
      editLink(href.workoutEdit(w.id, here), "workout"),
    ),
    h(
      "p",
      { class: "muted workout-line" },
      workoutLine(w, lib, workoutEnergy()),
    ),
    w.archived
      ? h(
          "p",
          { class: "note" },
          "Archived: hidden where you plan or start one.",
        )
      : null,
    h("div", { class: "actions" }, copy, startLink(w)),
    h(
      "section",
      { class: "finder-section" },
      h("h2", {}, "Steps"),
      stepList(w.steps, lib),
    ),
    notesSection(w.notes),
    h("section", { class: "finder-section" }, h("h2", {}, "History"), done),
  );
}
