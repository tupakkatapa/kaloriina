// "Log an activity": the sheet of the ways to log one on a day (a saved
// workout's Start today, else the workout logged as done; an empty
// workout; any other type) and a workout's Start.

import { activityType, meta } from "./api.mjs";
import { today } from "./dates.mjs";
import { href } from "./nav.mjs";
import { menuRow, resultRow } from "./rows.mjs";
import { keptRunOf } from "./screens/run.mjs";
import { h, modal } from "./ui.mjs";

// A workout's Start (Resume: a run of it left in progress, or finished but
// not saved yet), saving to `day` when given. Every Start is this one.
export function startLink(w, { day = null, cls = "button primary" } = {}) {
  const verb = keptRunOf(w.id) ? "Resume" : "Start";
  return h(
    "a",
    {
      class: cls,
      href: href.run(w.id, { day }),
      "aria-label": `${verb} ${w.name}`,
    },
    verb,
  );
}

// "+": log an activity on `day` (the Activity tab's: today, unsaid), each
// way returning to `back`. A sheet: Workout first, then every other type,
// each opening the activity editor for the day set to it. Today the
// workouts that can run come each with Start, and a workout can be
// planned; on a past day a workout opens the editor filled in from it.
export function activitySheet({
  workouts,
  day = null,
  back = href.activity(),
}) {
  const on = day ?? today();
  const past = on < today();
  const to = (params) => href.activityEdit("new", { day: on, ...params, back });
  const shown = workouts.filter((w) => !w.archived);
  const { close } = modal(
    { class: "confirm sheet", "aria-labelledby": "log-activity-title" },
    [
      h("h2", { id: "log-activity-title" }, "Log an activity"),
      h("h3", { class: "category" }, activityType("workout")?.label),
      h(
        "ul",
        { class: "menu" },
        past
          ? shown.map((w) =>
              menuRow({ href: to({ workout: w.id }), name: w.name }),
            )
          : shown
              .filter((w) => w.steps?.length)
              .map((w) =>
                resultRow({ name: w.name, action: startLink(w, { day }) }),
              ),
        menuRow({ href: to({ type: "workout" }), name: "Empty workout" }),
      ),
      h("h3", { class: "category" }, "Something else"),
      h(
        "ul",
        { class: "menu" },
        meta.activity_types
          .filter((t) => t.key !== "workout")
          .map((t) => menuRow({ href: to({ type: t.key }), name: t.label })),
        past ? null : menuRow({ href: href.plan(on), name: "Plan a workout" }),
      ),
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", onclick: () => close() }, "Done"),
      ),
    ],
    { focus: "a, button" },
  );
  // Any way off the page (a link in it, Back) closes it.
  addEventListener("hashchange", close, { once: true });
}
