// Planning a workout on a day: pick one of your workouts; it shows in that
// day's Activity card until an activity of it is saved that day. Those
// planned on the day already say so. Its back link is the day.

import { storedOrKept } from "../actions.mjs";
import { api, get, scoped, uid } from "../api.mjs";
import { pretty } from "../dates.mjs";
import { go, href } from "../nav.mjs";
import { resultRow } from "../rows.mjs";
import { empty, h, picker, showError, titleBar, undoable } from "../ui.mjs";
import { matches } from "../workouts.mjs";

export async function planWorkout(day) {
  const [all, plans] = await Promise.all([
    get("/workouts"),
    get(scoped(`/plans?from=${day}&to=${day}`)).catch(() => []),
  ]);
  // Archived ones are kept for history, not offered.
  const workouts = all.filter((w) => !w.archived);
  const planned = new Set(plans.map((p) => p.workout_id));
  // A workout to pick.
  const row = (w, pick) =>
    resultRow({
      onclick: () => pick(w),
      name: w.name,
      detail: planned.has(w.id) ? "Planned" : null,
    });
  const plan = async (w) => {
    let made;
    const write = async () => {
      made = await api(
        "POST",
        scoped("/plans"),
        { day, workout_id: w.id, uid: uid() },
        { queue: true, label: `Plan ${w.name}` },
      );
    };
    if (!(await storedOrKept(write, day))) return;
    go(href.day(day));
    undoable(`Planned ${w.name}`, async () => {
      await api("DELETE", scoped(`/plans/${made.id}`));
      go(href.day(day));
    });
  };
  return h(
    "section",
    {},
    // The day under the title: one line on a phone.
    titleBar("Plan a workout", href.day(day)),
    h("p", { class: "muted" }, pretty(day)),
    workouts.length > 0
      ? picker({
          placeholder: "Search your workouts",
          search: (q) =>
            workouts.filter((w) => matches(w.name.toLowerCase(), q)),
          row,
          onPick: (w) => plan(w).catch(showError),
          // Until you type: every workout.
          empty: (pick) => workouts.map((w) => row(w, pick)),
        })
      : empty([
          "No workouts yet: ",
          h("a", { href: href.workoutEdit("new") }, "build one"),
          ".",
        ]),
  );
}
