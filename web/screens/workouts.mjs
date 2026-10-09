// The Workouts tab: your workouts (what's in progress, what you did last,
// what your watch recorded that waits for you), and the exercise library
// with each exercise's page and editor.

import { api, get, meta, scoped, weightKg } from "../api.mjs";
import { pretty } from "../dates.mjs";
import { go, href } from "../nav.mjs";
import { pendingRow } from "./log.mjs";
import { sessionRow } from "./sessions.mjs";
import { capitalized, kcal, plural } from "../nutrients.mjs";
import { choice, editor, field, fill, h, titleBar } from "../ui.mjs";
import {
  clock,
  effort,
  exerciseIds,
  exerciseText,
  matches,
  records,
  runKey,
  weightText,
} from "../workouts.mjs";

const MEASURE_LABEL = { reps: "Reps", time: "Timed" };

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

// A set on its exercise's own page, without the name: "8 × 84 kg",
// "12 reps", "45 s · left".
const setText = (set) =>
  [
    set.seconds
      ? clock(set.seconds)
      : set.kg
        ? `${set.reps} × ${weightText(set.kg)}`
        : plural(set.reps, "rep"),
    set.side,
    set.seconds && set.kg ? weightText(set.kg) : null,
  ]
    .filter(Boolean)
    .join(" · ");

// The exercise library: lookups, variants under their root move, and search
// that finds a root by any of its variants.
export function library(exercises) {
  const byId = new Map(exercises.map((e) => [e.id, e]));
  const variants = new Map();
  for (const e of exercises)
    if (e.variant_of)
      variants.set(e.variant_of, [...(variants.get(e.variant_of) ?? []), e]);
  const roots = exercises.filter((e) => !e.variant_of);
  const text = new Map(exercises.map((e) => [e.id, exerciseText(e)]));
  const rootOf = (e) => (e.variant_of ? (byId.get(e.variant_of) ?? e) : e);
  // Roots matching `q` themselves or through a variant ({root, hit}).
  const search = (q, keep = () => true) =>
    roots.flatMap((root) => {
      const family = [root, ...(variants.get(root.id) ?? [])].filter(keep);
      const hit = family.find((e) => matches(text.get(e.id), q));
      return hit ? [{ root, hit }] : [];
    });
  return { byId, variants, roots, rootOf, search };
}

// An exercise in a list, shaped like a food row: name left; how it's
// measured, its muscle group and equipment, its variants right.
export function exerciseRow({ root, hit }, onPick, lib) {
  const e = hit ?? root;
  const more = (lib?.variants.get(root.id) ?? []).length;
  return h(
    "li",
    {},
    h(
      "button",
      { class: "result", type: "button", onclick: () => onPick({ root, hit }) },
      h("span", { class: "name" }, e.name),
      h(
        "span",
        { class: "muted" },
        [
          MEASURE_LABEL[e.measure],
          e.group,
          (e.equipment ?? []).join(", "),
          e === root && more ? plural(more, "variant") : null,
          e.source === "custom" ? "yours" : null,
        ]
          .filter(Boolean)
          .join(" · "),
      ),
    ),
  );
}

// "6 sets · ≈ 24 min · ≈ 210 kcal": estimates say ≈, values set on the
// workout don't.
export function workoutLine(w, lib, kg = weightKg()) {
  const e = effort(w, lib.byId, kg);
  return [
    plural(e.sets, "set"),
    `${e.minutesEstimated ? "≈ " : ""}${clock(e.minutes * 60)}`,
    e.kcal === null ? null : `${e.kcalEstimated ? "≈ " : ""}${kcal(e.kcal)}`,
  ]
    .filter(Boolean)
    .join(" · ");
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

// A titled list, with an action ("All workouts done") in its header.
const section = (title, rows, empty, action = null) =>
  h(
    "section",
    { class: "finder-section" },
    action
      ? h("header", { class: "title" }, h("h2", {}, title), action)
      : h("h2", {}, title),
    rows.length
      ? h("ul", { class: "results card" }, rows)
      : h("p", { class: "muted" }, empty),
  );

// A row of a list that opens `to`.
const linkRow = (to, name) =>
  h(
    "li",
    {},
    h("a", { class: "result", href: to }, h("span", { class: "name" }, name)),
  );

// A run left in progress (in this tab), or finished but not saved yet.
function pendingRun(w) {
  try {
    const kept = JSON.parse(sessionStorage.getItem(runKey(w.id)));
    return kept ?? null;
  } catch {
    return null;
  }
}

// "Tue, Oct 6": when a workout was last done, from the sessions given.
function lastDone(sessions) {
  const last = new Map();
  for (const s of sessions) if (s.workout_id) last.set(s.workout_id, s.day);
  return last;
}

// An exercise picked from a list opens its page.
const open = ({ hit, root }) => go(href.exercise((hit ?? root).id));
const link = (x) => h("a", { href: href.exercise(x.id) }, x.name);

// The Workouts tab, shaped like Foods: create actions, one search over
// workouts and exercises with filters; until you search, a run in progress,
// your workouts (when each was last done), the watch workouts waiting for
// Add or Dismiss (any day), what you did recently, and the way into the
// exercise library.
export async function workoutList() {
  const [workouts, exercises, sessions, waiting] = await Promise.all([
    get("/workouts"),
    get("/exercises"),
    get(scoped("/sessions")),
    get(scoped("/sync/health/workouts")),
  ]);
  const lib = library(exercises);
  const last = lastDone(sessions);
  const results = h("div", { class: "finder-results" });
  const input = h("input", {
    type: "search",
    placeholder: "Search",
    "aria-label": "Search workouts and exercises",
    oninput: () => paint(),
  });
  const facets = facetPanel(() => {
    facets.paint();
    paint();
  });
  const workoutRow = (w) => {
    const pending = pendingRun(w);
    return h(
      "li",
      { class: "row-with-action" },
      h(
        "a",
        { class: "result", href: href.workout(w.id) },
        h("span", { class: "name" }, w.name),
        h(
          "span",
          { class: "muted" },
          [
            workoutLine(w, lib),
            last.has(w.id) ? `Last done ${pretty(last.get(w.id))}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        ),
      ),
      h(
        "a",
        {
          class: "button primary",
          href: href.run(w.id),
          "aria-label": `${pending ? "Resume" : "Start"} ${w.name}`,
        },
        pending ? "Resume" : "Start",
      ),
    );
  };
  function paint() {
    const q = input.value.trim();
    if (!q && !facets.active()) {
      fill(
        results,
        section(
          "Workouts",
          workouts.map(workoutRow),
          "No workouts yet. New workout builds one from exercises, rests and repeats.",
        ),
        waiting.length
          ? section(
              `Waiting from your watch (${waiting.length})`,
              waiting.map((p) =>
                pendingRow(p, () => go(location.hash), { withDay: true }),
              ),
              "",
            )
          : null,
        section(
          "Recently done",
          sessions
            .slice(-5)
            .toReversed()
            .map((s) => sessionRow(s, href.workouts())),
          "Workouts you finish or log in the diary show up here.",
          sessions.length > 5
            ? h(
                "a",
                { class: "button", href: href.sessions() },
                "All workouts done",
              )
            : null,
        ),
        section(
          "Exercises",
          [
            h(
              "li",
              {},
              h(
                "a",
                { class: "result", href: href.exercises() },
                h("span", { class: "name" }, "All exercises"),
                h(
                  "span",
                  { class: "muted" },
                  `${plural(lib.roots.length, "exercise")} (${exercises.length} with variants)`,
                ),
              ),
            ),
          ],
          "",
        ),
      );
      return;
    }
    const found = workouts.filter(
      (w) => !facets.active() && matches(w.name.toLowerCase(), q),
    );
    const moves = lib.search(q, facets.keep);
    fill(
      results,
      found.length || moves.length
        ? h("ul", { class: "results card" }, [
            ...found.map(workoutRow),
            ...moves.map((m) => exerciseRow(m, open, lib)),
          ])
        : h("p", { class: "muted" }, "No matches."),
    );
  }
  paint();
  return h(
    "section",
    {},
    titleBar("Workouts"),
    h(
      "div",
      { class: "actions" },
      h("a", { class: "button", href: href.workout("new") }, "New workout"),
      h(
        "a",
        { class: "button", href: href.exerciseEdit("new") },
        "New exercise",
      ),
    ),
    h("div", { class: "search-bar" }, input, facets.toggle),
    facets.panel,
    results,
  );
}

// The exercise library: root moves (a variant's search hit shows under its
// root), with search and filters.
export async function exerciseList() {
  const exercises = await get("/exercises");
  const lib = library(exercises);
  const input = h("input", {
    type: "search",
    placeholder: "Search",
    "aria-label": "Search exercises",
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
      href.workouts(),
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

// An exercise, read like a food: what it is, its variants, your records and
// recent sets, the workouts using it; Edit for yours (the base set is
// reference).
export async function exerciseView(id) {
  const [exercises, workouts, sessions] = await Promise.all([
    get("/exercises"),
    get("/workouts"),
    get(scoped(`/sessions?exercise_id=${id}`)),
  ]);
  const lib = library(exercises);
  const e = lib.byId.get(Number(id));
  if (!e) return get(`/exercises/${id}`); // the server's 404
  const mine = records(sessions, e.id);
  const best = [
    ["Most reps", mine.reps],
    ["Longest", mine.seconds],
    ["Heaviest", mine.kg],
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
        ? h("a", { class: "button", href: href.exerciseEdit(e.id) }, "Edit")
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
    family.length
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
      best.length
        ? [
            h(
              "dl",
              { class: "traits records" },
              best.map(([k, r]) => [
                h("dt", {}, k),
                h("dd", {}, `${setText(r.set)} · ${pretty(r.day)}`),
              ]),
            ),
            h("h3", {}, "Recent"),
            h(
              "ul",
              { class: "results card" },
              mine.history.slice(0, 10).map((top) =>
                h(
                  "li",
                  {},
                  h(
                    "a",
                    {
                      class: "result",
                      href: href.session(top.session, {
                        back: href.exercise(id),
                      }),
                    },
                    h("span", { class: "name" }, pretty(top.day)),
                    h("span", { class: "muted" }, setText(top.set)),
                  ),
                ),
              ),
            ),
          ]
        : h(
            "p",
            { class: "muted" },
            "None yet: they come from workouts you finish or log.",
          ),
    ),
    usedIn.length
      ? section(
          "Used in",
          usedIn.map((w) => linkRow(href.workout(w.id), w.name)),
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
  const name = h("input", {
    name: "name",
    value: exercise.name,
    required: true,
    maxLength: meta.limits.name,
  });
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
        h("div", { class: "fold-fields" }, detail.map(trait)),
      ),
    ],
    save: () => {
      const data = new FormData(form);
      const body = {
        name: name.value,
        measure: measure.value,
        variant_of: Number(variantOf.value) || null,
        ...(isNew ? {} : { rev: exercise.rev }),
      };
      for (const x of meta.exercise_traits) {
        if (x.many) body[x.key] = data.getAll(x.key);
        else if (data.get(x.key)) body[x.key] = data.get(x.key);
      }
      return isNew
        ? api("POST", "/exercises", body)
        : api("PUT", `/exercises/${id}`, body);
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

// "Diamond" for "Diamond push-up" under "Push-up": a variant's name without
// its root's.
export function variantLabel(v, root) {
  const short = v.name
    .replace(
      new RegExp(root.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
  return short && short !== v.name ? capitalized(short) : v.name;
}
