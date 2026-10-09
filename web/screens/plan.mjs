// Planning a workout on a day: pick one of your workouts; it shows in that
// day's Log until a session of it is saved that day. With `?start=1` the
// pick runs it for that day instead (the Log sheet's "Start a saved
// workout").

import { api, get, scoped, uid } from "../api.mjs";
import { pretty } from "../dates.mjs";
import { go, href, storedOrKept } from "../nav.mjs";
import { h, notify, picker, showError, titleBar } from "../ui.mjs";
import { matches } from "../workouts.mjs";

// A workout to pick.
const row = (w, pick) =>
  h(
    "li",
    {},
    h(
      "button",
      { type: "button", class: "result", onclick: () => pick(w) },
      h("span", { class: "name" }, w.name),
    ),
  );

export async function planWorkout(day, params = new URLSearchParams()) {
  const start = params.get("start") === "1";
  const all = await get("/workouts");
  // Only a workout with steps can run.
  const workouts = start ? all.filter((w) => w.steps?.length) : all;
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
    notify(`Planned ${w.name}`, {
      action: {
        label: "Undo",
        run: async () => {
          await api("DELETE", scoped(`/plans/${made.id}`));
          go(href.day(day));
        },
      },
    });
  };
  const onPick = start
    ? (w) => go(`${href.run(w.id)}?day=${day}`)
    : (w) => plan(w).catch(showError);
  return h(
    "section",
    {},
    titleBar(
      `${start ? "Start" : "Plan"} a workout · ${pretty(day)}`,
      href.day(day),
    ),
    workouts.length
      ? picker({
          placeholder: "Search your workouts",
          search: async (q) =>
            workouts.filter((w) => matches(w.name.toLowerCase(), q)),
          row,
          onPick,
          // Until you type: every workout.
          empty: (pick) => workouts.map((w) => row(w, pick)),
        })
      : h(
          "p",
          { class: "muted" },
          "No workouts yet: ",
          h("a", { href: href.workout("new") }, "build one"),
          ".",
        ),
  );
}
