// The Activity tab, read as activity > workout > exercise: what you did
// lately (any type), your workouts (each opening its view: workout-view.mjs),
// and the way into the exercise library, with each exercise's page and
// editor.

import { activitySheet } from "../activity-sheet.mjs";
import { api, createId, get, meta, scoped } from "../api.mjs";
import { duration, pretty, today, weekStart } from "../dates.mjs";
import { activeKcalText, activeMark } from "../energy-text.mjs";
import { activeOf } from "../expenditure.mjs";
import { capitalized, plural, whole } from "../format.mjs";
import { go, href } from "../nav.mjs";
import {
  activityRow,
  energyContext,
  exerciseRow,
  loadResting,
  menuRow,
  pendingRow,
  RECENT,
  recentRows,
  resultRow,
  workoutEnergy,
} from "../rows.mjs";
import {
  choice,
  editLink,
  editor,
  empty,
  field,
  fill,
  h,
  icon,
  nameInput,
  PLUS,
  titleBar,
} from "../ui.mjs";
import {
  exerciseIds,
  library,
  MEASURE_LABEL,
  setText,
  workoutLine,
} from "../workouts.mjs";
import { runBanner } from "./run.mjs";

// The traits as the server describes them (labels, which filter search,
// value labels), keyed.
export const traits = () =>
  Object.fromEntries(meta.exercise_traits.map((t) => [t.key, t]));

// A trait value as read, capitalised like its label: its own label if it
// has one ("One side at a time"), else the value ("Barbell, plate").
function traitValue(key, value) {
  const t = traits()[key];
  const labels = Object.fromEntries(t?.value_labels ?? []);
  if (Array.isArray(value)) return capitalized(value.join(", "));
  return capitalized(String(labels[value] ?? value ?? ""));
}

// Exercise filters: one select per trait the server marks a facet, in a
// panel like the food finder's.
function facetPanel(onChange) {
  const facets = meta.exercise_traits.filter((t) => t.facet);
  const selects = facets.map((t) =>
    field(
      t.label,
      h(
        "select",
        { "data-key": t.key, onchange: () => onChange() },
        h("option", { value: "" }, "Any"),
        t.values.map((v) => h("option", { value: v }, traitValue(t.key, v))),
      ),
    ),
  );
  const panel = h(
    "div",
    { class: "filters card facets", hidden: true },
    selects,
  );
  const toggle = h("button", {
    type: "button",
    "aria-expanded": "false",
    onclick: () => {
      panel.hidden = !panel.hidden;
      toggle.setAttribute("aria-expanded", String(!panel.hidden));
    },
  });
  const chosen = () =>
    [...panel.querySelectorAll("select")].filter((s) => s.value);
  const paint = () => {
    const n = chosen().length;
    toggle.textContent = n ? `Filters · ${n}` : "Filters";
  };
  paint();
  // Whether an exercise passes every chosen filter.
  const keep = (e) =>
    chosen().every((s) => {
      const have = e[s.dataset.key];
      return Array.isArray(have) ? have.includes(s.value) : have === s.value;
    });
  return { toggle, panel, paint, keep, active: () => chosen().length > 0 };
}

// A titled list.
const section = (title, rows, none) =>
  h(
    "section",
    { class: "finder-section" },
    h("h2", {}, title),
    rows.length > 0 ? h("ul", { class: "results card" }, rows) : empty(none),
  );

// A row of a list that opens `to`.
const linkRow = (to, name) => resultRow({ href: to, name });

// An exercise picked from a list opens its page.
const open = ({ hit, root }) => go(href.exercise((hit ?? root).id));
const link = (x) => h("a", { href: href.exercise(x.id) }, x.name);

// "This week · 3 activities · 2 h 5 min · active ≈ 820 kcal": Monday to
// today's activities, their time and active energy (expenditure.mjs
// activeOf, as each row reads it; energy-text.mjs activeMark: "≈" with an
// estimate in it, "≥" when one's can't be told).
function weekLine(activities) {
  const week = activities.filter(
    (s) => s.day >= weekStart(today()) && s.day <= today(),
  );
  if (week.length === 0) return "This week · Nothing logged";
  const ctx = energyContext();
  const energies = week.map((s) => activeOf(s, ctx));
  const minutes = week.reduce((t, s) => t + s.minutes, 0);
  const energy = energies.reduce((t, e) => t + (e.active ?? 0), 0);
  const mark = activeMark({
    floor: energies.some((e) => e.active === null),
    estimated: energies.some((e) => e.estimated),
  });
  return [
    "This week",
    plural(week.length, "activity", "activities"),
    duration(minutes),
    energy ? activeKcalText(energy, mark) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

// A workout: its name over its line and when it was last done, opening
// its view (Start is there, and in "+").
const workoutRow = (w, lib) =>
  menuRow({
    href: href.workout(w.id),
    name: w.name,
    detail: [
      workoutLine(w, lib, workoutEnergy()),
      w.last_done ? whole(`Last done ${pretty(w.last_done)}`) : null,
    ]
      .filter(Boolean)
      .join(" · "),
  });

// The Activity tab: "Log an activity" in its header, this week in a line,
// the device's activities waiting for Add or Dismiss (any day), the latest
// RECENT activities (then All activities), your workouts (a run in progress, when each was
// last done), then the exercise library and records, and archived
// workouts.
export async function activityTab() {
  const [workouts, exercises, activities, latest, waiting, run] =
    await Promise.all([
      get(scoped("/workouts")),
      get("/exercises"),
      get(scoped(`/activities?from=${weekStart(today())}`)),
      get(scoped(`/activities?limit=${RECENT + 1}`)),
      get(scoped("/sync/health/workouts")),
      runBanner(),
      loadResting(),
    ]);
  const lib = library(exercises);
  const plus = h(
    "button",
    {
      type: "button",
      class: "icon",
      "aria-label": "Log an activity",
      onclick: () => activitySheet({ workouts }),
    },
    icon(PLUS),
  );
  return h(
    "section",
    {},
    titleBar("Activity", null, plus),
    run,
    h("p", { class: "week" }, weekLine(activities)),
    waiting.length > 0
      ? section(
          `Waiting from Health Connect (${waiting.length})`,
          waiting.map((p) =>
            pendingRow(p, () => go(location.hash), { withDay: true }),
          ),
          "",
        )
      : null,
    section(
      "Activities",
      recentRows(
        // The server's oldest first: the latest leads.
        latest.toReversed(),
        (s) => activityRow(s, href.activity()),
        href.activities(),
      ).filter(Boolean),
      "Nothing logged yet.",
    ),
    h(
      "section",
      { class: "finder-section" },
      h("h2", {}, "Workouts"),
      h(
        "ul",
        { class: "results card workouts" },
        workouts.filter((w) => !w.archived).map((w) => workoutRow(w, lib)),
        resultRow({
          href: href.workoutEdit("new"),
          name: [icon(PLUS), "New workout"],
        }),
      ),
    ),
    section(
      "Exercises",
      [
        menuRow({
          href: href.exercises(),
          name: `Exercise library · ${lib.roots.length}`,
        }),
        menuRow({
          href: href.records(),
          name: "Records",
          detail: "Your bests: exercises, activities, steps and sleep",
        }),
      ],
      "",
    ),
    workouts.some((w) => w.archived)
      ? section(
          "Archived workouts",
          workouts.filter((w) => w.archived).map((w) => workoutRow(w, lib)),
          "",
        )
      : null,
  );
}

// The exercise library: root moves (a variant's search hit shows under its
// root), with search and filters; `?q=` starts the search (a muscle, from
// a Summary tip).
export async function exerciseList(params = new URLSearchParams()) {
  const exercises = await get("/exercises");
  const lib = library(exercises);
  const input = h("input", {
    type: "search",
    placeholder: "Search",
    "aria-label": "Search exercises",
    value: params.get("q") ?? "",
    oninput: () => paint(),
  });
  const facets = facetPanel(() => {
    facets.paint();
    paint();
  });
  const count = h("p", { class: "muted" });
  const list = h("ul", { class: "results card" });
  function paint() {
    const shown = lib.search(input.value.trim(), facets.keep);
    count.textContent = plural(shown.length, "exercise");
    fill(list, ...shown.map((m) => exerciseRow(m, open, lib)));
  }
  paint();
  return h(
    "section",
    {},
    titleBar(
      "Exercises",
      href.activity(),
      h(
        "a",
        { class: "button", href: href.exerciseEdit("new") },
        "New exercise",
      ),
    ),
    h("div", { class: "search-bar" }, input, facets.toggle),
    facets.panel,
    count,
    list,
  );
}

// An exercise, read like a food: what it is, its variants, your bests and
// every time you did it (the server's history), the workouts using it;
// Edit for yours (the base set is reference).
export async function exerciseView(id) {
  const [exercises, workouts, mine] = await Promise.all([
    get("/exercises"),
    get("/workouts"),
    get(scoped(`/exercises/${id}/history`)),
  ]);
  const lib = library(exercises);
  const e = lib.byId.get(Number(id));
  // Unknown here: the server's 404.
  if (!e) return get(`/exercises/${id}`);
  const best = [
    ["Most reps", mine.bests.reps],
    ["Longest", mine.bests.seconds],
    ["Heaviest", mine.bests.kg],
  ].filter(([, r]) => r);
  const root = lib.rootOf(e);
  const family = root === e ? (lib.variants.get(e.id) ?? []) : [];
  const usedIn = workouts.filter((w) => exerciseIds(w.steps).has(e.id));
  const rows = [
    ["Measured by", MEASURE_LABEL[e.measure]],
    ...meta.exercise_traits.map((t) => [t.label, traitValue(t.key, e[t.key])]),
  ].filter(([, v]) => v);
  return h(
    "section",
    {},
    titleBar(
      e.name,
      href.exercises(),
      e.source === "custom"
        ? editLink(href.exerciseEdit(e.id), "exercise")
        : null,
    ),
    h(
      "p",
      { class: "muted" },
      e.source === "base" ? "From the base set" : "Yours",
      root === e ? "" : [" · a variant of ", link(root)],
    ),
    h(
      "dl",
      { class: "traits" },
      rows.map(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]),
    ),
    family.length > 0
      ? section(
          "Variants",
          family.map((v) => linkRow(href.exercise(v.id), v.name)),
          "",
        )
      : null,
    h(
      "section",
      { class: "finder-section" },
      h("h2", {}, "Your records"),
      // A record attempt outside a workout: a one-set activity.
      h(
        "a",
        {
          class: "button",
          href: href.activityEdit("new", {
            exercise: e.id,
            back: href.exercise(id),
          }),
        },
        "Log a set",
      ),
      best.length > 0
        ? [
            h(
              "dl",
              { class: "traits records" },
              best.map(([k, r]) => [
                h("dt", {}, k),
                h("dd", {}, `${setText(r.set)} · ${pretty(r.day)}`),
              ]),
            ),
            h("h3", {}, "History"),
            h(
              "ul",
              { class: "results card exercise-history" },
              recentRows(
                mine.days,
                (d) =>
                  menuRow({
                    href: href.activityView(d.activity_id, href.exercise(id)),
                    name: pretty(d.day),
                    detail: d.sets.map(setText).join(", "),
                  }),
                href.activities({ exercise: id, back: href.exercise(id) }),
              ),
            ),
          ]
        : empty(
            "None yet: they come from workouts you finish or log, or a set you log here.",
          ),
    ),
    usedIn.length > 0
      ? section(
          "Used in",
          usedIn.map((w) =>
            linkRow(href.workout(w.id, href.exercise(id)), w.name),
          ),
          "",
        )
      : null,
  );
}

// Your exercise, or a new one. What changes how a step is set goes first;
// details for search fold away.
export async function exerciseEditor(id) {
  const isNew = id === "new";
  const [exercise, exercises] = await Promise.all([
    isNew
      ? { name: "", measure: "reps", source: "custom" }
      : get(`/exercises/${id}`),
    get("/exercises"),
  ]);
  if (exercise.source === "base") return go(href.exercise(id));
  const t = traits();
  const name = nameInput({ max: meta.limits.name, value: exercise.name });
  const pick = (key, value) =>
    choice({
      name: key,
      label: t[key].label,
      options: [
        ["", "Not set"],
        ...t[key].values.map((v) => [v, traitValue(key, v)]),
      ],
      value: value ?? "",
    });
  const measure = choice({
    name: "measure",
    label: "Measured by",
    options: [
      ["reps", "Reps"],
      ["time", "Timed"],
    ],
    value: exercise.measure,
  });
  const roots = exercises.filter((e) => !e.variant_of && String(e.id) !== id);
  const variantOf = h(
    "select",
    { name: "variant_of" },
    h("option", { value: "" }, "Not a variant"),
    roots.map((r) =>
      h(
        "option",
        { value: r.id, selected: r.id === exercise.variant_of },
        r.name,
      ),
    ),
  );
  const detail = meta.exercise_traits.filter(
    (x) => !["laterality", "load"].includes(x.key),
  );
  const trait = (x) =>
    x.many
      ? h(
          "fieldset",
          {},
          h("legend", {}, x.label),
          h(
            "div",
            { class: "choices" },
            x.values.map((v) =>
              h(
                "label",
                { class: "check" },
                h("input", {
                  type: "checkbox",
                  name: x.key,
                  value: v,
                  checked: (exercise[x.key] ?? []).includes(v),
                }),
                ` ${v}`,
              ),
            ),
          ),
        )
      : field(x.label, pick(x.key, exercise[x.key]));
  const sides = pick("laterality", exercise.laterality);
  const load = pick("load", exercise.load);
  const back = isNew ? href.exercises() : href.exercise(id);
  // A create carries its key: sent again after a lost answer it
  // answers the exercise saved the first time, which then takes what the
  // form holds now.
  const key = createId();
  let sent = false;
  let form = null;
  const { node, form: f } = editor({
    title: isNew ? "New exercise" : exercise.name,
    back,
    body: [
      field("Name", name),
      field("Measured by", measure, {
        hint: "Reps: done for a count. Timed: done for a time.",
      }),
      field("Sides", sides),
      field("Weight", load),
      field("Variant of", variantOf),
      h(
        "details",
        { class: "fold" },
        h("summary", {}, "Details for search and filters"),
        h(
          "div",
          { class: "fold-fields" },
          detail.map((x) => trait(x)),
        ),
      ),
    ],
    save: async () => {
      const data = new FormData(form);
      const body = {
        name: name.value,
        measure: measure.value,
        variant_of: Number(variantOf.value) || null,
        ...(isNew ? {} : { rev: exercise.rev }),
      };
      for (const x of meta.exercise_traits) {
        if (x.many) body[x.key] = data.getAll(x.key);
        else body[x.key] = data.get(x.key) || null;
      }
      if (!isNew) return api("PUT", `/exercises/${id}`, body);
      const again = sent;
      sent = true;
      let made = await api("POST", "/exercises", { ...body, uid: key.get() });
      if (again)
        made = await api("PUT", `/exercises/${made.id}`, {
          ...body,
          rev: made.rev,
        });
      key.done();
      sent = false;
      return made;
    },
    after: (saved) => href.exercise(saved.id),
    remove: isNew
      ? null
      : {
          ask: `Delete ${exercise.name}?`,
          detail: "Workouts done with it keep its name.",
          run: () => api("DELETE", `/exercises/${id}`),
          after: href.exercises(),
          done: `Deleted ${exercise.name}`,
        },
  });
  form = f;
  return node;
}
