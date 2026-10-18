// Building a workout: steps one line each (opened to edit), repeats, drag by
// pointer or keyboard, select and wrap, Undo; time and energy estimated.

import { copyForm } from "../actions.mjs";
import { kcalFor, metOf } from "../activities.mjs";
import { api, createId, get, meta, profileId, uid, weightKg } from "../api.mjs";
import { stepDrag } from "../drag.mjs";
import { activeEnergyText } from "../energy-text.mjs";
import { activeEnergy } from "../expenditure.mjs";
import { plural } from "../format.mjs";
import { go, href, safeBack } from "../nav.mjs";
import { shownEnergy } from "../nutrients.mjs";
import { exerciseRow, loadResting, workoutEnergy } from "../rows.mjs";
import {
  busy,
  chip,
  choice,
  editor,
  energyLabel,
  energyNum,
  energyOf,
  field,
  fill,
  GRIP,
  h,
  icon,
  nameInput,
  notify,
  num,
  numberOrNull,
  picker,
  POSITIVE,
  undoable,
  unitNum,
  unitValue,
} from "../ui.mjs";
import { unitOf } from "../units.mjs";
import {
  at,
  effort,
  exerciseIds,
  fit,
  fitsAt,
  insert,
  library,
  listAt,
  pathKey,
  pathLabel,
  pathOf,
  remove,
  replaceAt,
  STEP_KINDS,
  unwrap,
  update,
  variantLabel,
  workoutLine,
  wrap,
} from "../workouts.mjs";

// A number typed into a panel changes the step in place; its line follows.
function fieldInput(step, prop, labelText, attrs, refresh) {
  return num({
    value: step[prop] ?? "",
    step: 1,
    min: 1,
    "aria-label": labelText,
    ...attrs,
    oninput: (e) => {
      if (e.target.value === "") delete step[prop];
      else step[prop] = Number(e.target.value);
      refresh();
    },
  });
}

// A step's weight in this device's units (kg, or lb in US units); left as
// shown, its kg stay as they were.
function weightInput(step, labelText, required, refresh) {
  const input = unitNum({
    value: step.kg,
    unit: "kg",
    min: Number(POSITIVE),
    max: meta.limits.kg,
    required,
    "aria-label": labelText,
    oninput: () => {
      const kg = unitValue(input);
      if (kg === null) delete step.kg;
      else step.kg = kg;
      refresh();
    },
  });
  return input;
}

// The panels and the selection bar below draw from the editor's `ed`:
// {lib, depth, steps() (now), change(result, opts) (an edit, with Undo),
// paint(focus, target), open(path) (its panel open), replaceExercise(path)
// (the picker opens to replace its exercise), selection() and select(s)}.

const removeButton = (ed, path, text) =>
  h(
    "button",
    {
      type: "button",
      class: "danger",
      "aria-label": `Remove ${text} (step ${pathLabel(path)})`,
      onclick: () => {
        const parent = path.slice(0, -1);
        const next = remove(ed.steps(), path);
        const left = listAt(next, parent).length;
        ed.change(
          {
            steps: next,
            path: left ? [...parent, Math.min(path.at(-1), left - 1)] : null,
          },
          { message: `Removed ${text}` },
        );
      },
    },
    "Remove",
  );

function exercisePanel(ed, path, step, e, refresh) {
  const stepNo = pathLabel(path);
  const root = e ? ed.lib.rootOf(e) : null;
  const family = root ? [root, ...(ed.lib.variants.get(root.id) ?? [])] : [];
  const switchTo = (v) => {
    const { step: next, dropped } = fit(v, step);
    ed.open(path);
    // Focus stays on the variant: the select, or the chosen radio.
    const variant = `[aria-label="Step ${stepNo} variant"]`;
    ed.change(
      { steps: replaceAt(ed.steps(), path, next), path },
      { target: `:is(select${variant}, ${variant} [aria-checked="true"])` },
    );
    if (dropped.length > 0)
      notify(`${v.name} takes no ${dropped.join(" or ")}: removed`);
  };
  const timed = e?.measure === "time";
  const load = e?.load ?? "optional";
  return [
    h(
      "div",
      { class: "row" },
      h(
        "button",
        {
          type: "button",
          onclick: () => ed.replaceExercise(path),
        },
        "Change exercise…",
      ),
    ),
    family.length > 1
      ? choice({
          label: `Step ${stepNo} variant`,
          options: family.map((v) => [
            v.id,
            v === root ? "Standard" : variantLabel(v, root),
          ]),
          value: e.id,
          onChange: (vid) => switchTo(ed.lib.byId.get(Number(vid))),
        })
      : null,
    h(
      "div",
      { class: "row step-fields" },
      timed
        ? field(
            "Time (s)",
            fieldInput(
              step,
              "seconds",
              `Step ${stepNo} seconds`,
              { max: meta.limits.step_seconds },
              refresh,
            ),
            { inline: true },
          )
        : field(
            "Reps",
            fieldInput(
              step,
              "reps",
              `Step ${stepNo} reps`,
              { max: meta.limits.reps },
              refresh,
            ),
            { inline: true },
          ),
      load === "none"
        ? null
        : field(
            `Weight (${unitOf("kg")})`,
            weightInput(
              step,
              `Step ${stepNo} weight`,
              load === "required",
              refresh,
            ),
            { inline: true },
          ),
    ),
    e?.laterality === "unilateral"
      ? choice({
          label: `Step ${stepNo} side`,
          options: [
            ["", "Each side"],
            ["left", "Left"],
            ["right", "Right"],
          ],
          value: step.side ?? "",
          onChange: (side) => {
            ed.open(path);
            ed.change(
              {
                steps: update(ed.steps(), path, (s) => {
                  if (side) s.side = side;
                  else delete s.side;
                }),
                path,
              },
              {
                target: `[aria-label="Step ${stepNo} side"] [aria-checked="true"]`,
              },
            );
          },
        })
      : null,
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        {
          type: "button",
          onclick: () => {
            const result = wrap(
              ed.steps(),
              path.slice(0, -1),
              path.at(-1),
              path.at(-1),
              ed.depth,
            );
            if (result) ed.open(result.path);
            ed.change(result, {
              message: "Wrapped in a repeat",
              target: ".step-panel input",
            });
          },
        },
        "Wrap in repeat",
      ),
      removeButton(ed, path, e?.name ?? "step"),
    ),
  ];
}

// Each kind's panel, by STEP_KINDS' keys: (ed, path, step, its exercise,
// refresh) → its nodes.
const PANELS = {
  exercise: exercisePanel,
  rest: (ed, path, step, e, refresh) => [
    field(
      "Time (s)",
      fieldInput(
        step,
        "seconds",
        `Step ${pathLabel(path)} rest seconds`,
        { max: meta.limits.step_seconds },
        refresh,
      ),
      { inline: true },
    ),
    h("div", { class: "actions" }, removeButton(ed, path, "Rest")),
  ],
  note: (ed, path, step, e, refresh) => {
    const text = h("textarea", {
      maxLength: meta.limits.notes,
      rows: 4,
      "aria-label": `Step ${pathLabel(path)} note`,
      oninput: () => {
        step.text = text.value;
        refresh();
      },
    });
    text.value = step.text ?? "";
    // Unlabelled, as wide as the text under it: the name is a note too.
    return [
      nameInput({
        max: meta.limits.label,
        name: null,
        required: false,
        value: step.name ?? "",
        placeholder: "Name (shown when closed)",
        "aria-label": `Step ${pathLabel(path)} note name`,
        oninput: (ev) => {
          const v = ev.target.value.trim();
          if (v) step.name = v;
          else delete step.name;
          refresh();
        },
      }),
      text,
      h("div", { class: "actions" }, removeButton(ed, path, "Note")),
    ];
  },
  repeat: (ed, path, step, e, refresh) => [
    h(
      "div",
      { class: "row step-fields" },
      field(
        "Rounds",
        fieldInput(
          step,
          "times",
          `Step ${pathLabel(path)} rounds`,
          { max: meta.limits.times },
          refresh,
        ),
        { inline: true },
      ),
      field(
        "Every (s)",
        fieldInput(
          step,
          "every",
          `Step ${pathLabel(path)} every (s)`,
          { max: meta.limits.step_seconds, placeholder: "optional" },
          refresh,
        ),
        { inline: true },
      ),
      field(
        "Name",
        h("input", {
          value: step.name ?? "",
          placeholder: "optional",
          "aria-label": `Step ${pathLabel(path)} name`,
          oninput: (ev) => {
            const v = ev.target.value.trim();
            if (v) step.name = v;
            else delete step.name;
            refresh();
          },
        }),
        { inline: true },
      ),
    ),
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        {
          type: "button",
          onclick: () =>
            ed.change(
              {
                steps: unwrap(ed.steps(), path),
                path: step.steps.length > 0 ? path : null,
              },
              { message: "Unwrapped the repeat" },
            ),
        },
        "Unwrap",
      ),
      removeButton(
        ed,
        path,
        `Repeat and its ${plural(step.steps.length, "step")}`,
      ),
    ),
  ],
};

function selectionBar(ed) {
  const selection = ed.selection();
  if (!selection) return null;
  const listPath = selection.list === null ? [] : pathOf(selection.list);
  const chosen = [...selection.indices].toSorted((a, b) => a - b);
  const first = chosen[0];
  const last = chosen.at(-1);
  const span =
    first === last
      ? `step ${pathLabel([...listPath, first])}`
      : `steps ${pathLabel([...listPath, first])}–${pathLabel([...listPath, last])}`;
  const wrapped =
    chosen.length > 0
      ? wrap(ed.steps(), listPath, first, last, ed.depth)
      : null;
  return h(
    "div",
    { class: "select-bar" },
    h("span", { class: "muted" }, `${plural(chosen.length, "step")} selected`),
    h(
      "button",
      {
        type: "button",
        onclick: () => {
          ed.select(null);
          ed.paint();
        },
      },
      "Cancel",
    ),
    h(
      "button",
      {
        type: "button",
        class: "danger",
        disabled: chosen.length === 0,
        onclick: () => {
          let next = ed.steps();
          for (const i of chosen.toReversed())
            next = remove(next, [...listPath, i]);
          ed.select(null);
          ed.change(
            { steps: next },
            { message: `Removed ${plural(chosen.length, "step")}` },
          );
        },
      },
      "Remove",
    ),
    h(
      "button",
      {
        type: "button",
        disabled: !wrapped,
        onclick: () => {
          ed.select(null);
          ed.open(wrapped.path);
          ed.change(wrapped, {
            message: "Wrapped in a repeat",
            target: ".step-panel input",
          });
        },
      },
      chosen.length > 0 ? `Wrap ${span} in repeat` : "Wrap in repeat",
    ),
    // Why Wrap can't, said: a disabled button's title never shows on a
    // phone.
    chosen.length > 0 && !wrapped
      ? h("small", { class: "muted" }, `Repeats nest at most ${ed.depth} deep.`)
      : null,
  );
}

// A workout is a list of steps (exercises, rests, repeats holding more
// steps), each one line until you open it. Steps move by dragging their
// handle (or with the keyboard on it); several can be wrapped in a repeat
// at once. Edits are made on a copy of the steps, saved with Save; every
// structural change can be undone. Panels are built when opened, so a long
// workout stays quick to edit. `back` is where Back and Save lead (the
// workout's view, from its pencil); without one, Save stays here.
export async function workoutEditor(id, params = new URLSearchParams()) {
  const back = safeBack(params.get("back"));
  const [workout, exercises, usage] = await Promise.all([
    id === "new"
      ? { name: "", steps: [], minutes: null, notes: null, archived: false }
      : get(`/workouts/${id}`),
    get("/exercises"),
    id === "new" ? null : get(`/workouts/${id}/usage`),
    loadResting(),
  ]);
  // Used by an activity or plan in any profile: archived, never deleted.
  const used = usage ? usage.activities + usage.plans : 0;
  // Repeats nest at most this deep: the server's rule, read where it's served.
  const { depth } = meta.limits;
  const lib = library(exercises);
  const isNew = id === "new";
  let steps = structuredClone(workout.steps);
  // The step whose panel is open ("2.1" by index); the list the picker
  // adds to ("" for the workout); the step whose exercise the picker
  // replaces; {list, indices} while selecting.
  let open = null;
  let adding = null;
  let replacing = null;
  let selection = null;

  const name = nameInput({ max: meta.limits.name, value: workout.name });
  const minutes = num({
    name: "minutes",
    value: workout.minutes ?? "",
    step: 1,
    min: 1,
    max: meta.limits.minutes,
    oninput: () => recount(),
  });
  const kcal = energyNum({
    name: "kcal",
    value: workout.kcal,
    min: 1,
    max: meta.limits.kcal,
    oninput: () => recount(),
  });
  const notes = h("textarea", {
    name: "notes",
    maxLength: meta.limits.notes,
    rows: 4,
    placeholder: "Optional: how it's done, or anything",
  });
  notes.value = workout.notes ?? "";
  const blocks = h("div", { class: "steps-editor" });
  const line = h("p", { class: "muted" });
  // Under the energy, its active part as the workout's line reads it: a
  // total typed less resting, or, empty, the estimate.
  const active = h("span", { class: "energy-active", "aria-live": "polite" });
  const announcer = h("p", { class: "sr-only", "aria-live": "polite" });
  const announce = (text) => {
    announcer.textContent = text;
  };

  function recount() {
    const e = effort({ steps }, lib.byId, weightKg());
    const est = kcalFor(
      numberOrNull(minutes) ?? e.minutes,
      weightKg(),
      metOf("workout"),
    );
    minutes.placeholder = `≈ ${e.minutes}`;
    kcal.placeholder = est === null ? "" : `≈ ${shownEnergy(est)}`;
    const time = numberOrNull(minutes) ?? e.minutes;
    const energy =
      time &&
      activeEnergy(
        {
          kcal: energyOf(kcal),
          minutes: time,
          type: "workout",
          weight_kg: weightKg(),
        },
        workoutEnergy().bmr,
      );
    active.textContent = (energy && activeEnergyText(energy)) ?? "";
    fill(
      line,
      ...[
        steps.length > 0
          ? workoutLine(
              {
                steps,
                minutes: numberOrNull(minutes),
                kcal: energyOf(kcal),
              },
              lib,
              workoutEnergy(),
            )
          : "",
        steps.length > 0 && weightKg() === null && kcal.value === ""
          ? [
              " · ",
              h(
                "a",
                { href: href.profileEdit(profileId) },
                "set your weight to estimate energy",
              ),
            ]
          : "",
      ].flat(),
    );
  }

  // Draw the steps again, then put focus back where the edit happened.
  function paint(focus = null, target = ".drag") {
    fill(blocks, stepList([], steps), selectionBar(ed));
    recount();
    // Nothing to run until it's saved with steps.
    start.hidden = isNew || steps.length === 0;
    if (focus)
      blocks
        .querySelector(`[data-path="${pathKey(focus)}"] ${target}`)
        ?.focus();
  }

  // A structural edit: new steps, focus at its result, and Undo.
  function change(result, { message = null, target = ".drag" } = {}) {
    if (!result) return;
    // Any edit closes an open exercise search: it belonged to the last one.
    adding = null;
    replacing = null;
    const before = steps;
    steps = result.steps ?? result;
    paint(result.path ?? null, target);
    if (message)
      undoable(
        message,
        () => {
          steps = before;
          paint();
        },
        { travels: false },
      );
  }

  const ed = {
    lib,
    depth,
    blocks,
    announce,
    steps: () => steps,
    change,
    paint,
    restore: (next, focus = null) => {
      steps = next;
      paint(focus);
    },
    open: (path) => {
      open = pathKey(path);
    },
    replaceExercise: (path) => {
      replacing = pathKey(path);
      adding = pathKey(path.slice(0, -1));
      paint();
      blocks.querySelector(`[data-picker="${adding}"] input`)?.focus();
    },
    selection: () => selection,
    select: (s) => {
      selection = s;
    },
  };
  const drag = stepDrag(ed);

  function exercisePicker(listPath) {
    const usedIds = exerciseIds(steps);
    const onPick = ({ root, hit }) => {
      const e = hit ?? root;
      if (replacing !== null) {
        const path = pathOf(replacing);
        const { step, dropped } = fit(e, at(steps, path));
        replacing = null;
        adding = null;
        open = pathKey(path);
        change(
          { steps: replaceAt(steps, path, step), path },
          { target: "input" },
        );
        if (dropped.length > 0)
          notify(`${e.name} takes no ${dropped.join(" or ")}: removed`);
        return;
      }
      const result = insert(
        steps,
        listPath,
        listAt(steps, listPath).length,
        fit(e).step,
        depth,
      );
      adding = null;
      open = pathKey(result.path);
      change(result, { target: ".step-panel input" });
    };
    return h(
      "div",
      { class: "step-picker", "data-picker": pathKey(listPath) },
      picker({
        placeholder: "Search exercises",
        search: (q) => lib.search(q),
        row: (m, pick) => exerciseRow(m, pick, lib),
        onPick,
        // Until you type: what this workout already uses.
        empty: (pick) =>
          usedIds.size > 0
            ? [
                h(
                  "li",
                  { class: "chips" },
                  h("span", { class: "muted" }, "In this workout:"),
                  [...usedIds]
                    .map((i) => lib.byId.get(i))
                    .filter(Boolean)
                    .map((e) =>
                      chip(e.name, () => pick({ root: lib.rootOf(e), hit: e })),
                    ),
                ),
              ]
            : [],
      }),
    );
  }

  function addBar(listPath) {
    // Selecting: the selection bar is the only way on.
    if (selection) return null;
    const k = pathKey(listPath);
    const where =
      listPath.length > 0 ? `repeat ${pathLabel(listPath)}` : "the workout";
    const end = () => listAt(steps, listPath).length;
    const add = (step, target) => {
      const result = insert(steps, listPath, end(), step, depth);
      open = pathKey(result.path);
      change(result, { target });
    };
    return h(
      "div",
      { class: "actions step-add" },
      h(
        "button",
        {
          type: "button",
          "aria-label": `Add exercise to ${where}`,
          "aria-expanded": String(adding === k && replacing === null),
          onclick: () => {
            const opening = !(adding === k && replacing === null);
            adding = opening ? k : null;
            replacing = null;
            paint();
            if (opening)
              blocks.querySelector(`[data-picker="${k}"] input`)?.focus();
          },
        },
        "+ Exercise",
      ),
      h(
        "button",
        {
          type: "button",
          "aria-label": `Add rest to ${where}`,
          onclick: () =>
            add({ kind: "rest", seconds: 60 }, ".step-panel input"),
        },
        "+ Rest",
      ),
      h(
        "button",
        {
          type: "button",
          "aria-label": `Add note to ${where}`,
          onclick: () =>
            add({ kind: "note", text: "" }, ".step-panel textarea"),
        },
        "+ Note",
      ),
      fitsAt({ kind: "repeat", times: 2, steps: [] }, listPath, depth)
        ? h(
            "button",
            {
              type: "button",
              "aria-label": `Add repeat to ${where}`,
              onclick: () =>
                add(
                  { kind: "repeat", times: 2, steps: [] },
                  ".step-panel input",
                ),
            },
            "+ Repeat",
          )
        : null,
      listPath.length > 0
        ? null
        : h(
            "button",
            {
              type: "button",
              onclick: () => {
                selection = { list: null, indices: new Set() };
                open = null;
                adding = null;
                paint();
              },
            },
            "Select",
          ),
    );
  }

  function stepList(listPath, list) {
    const k = pathKey(listPath);
    return h(
      "div",
      { class: "step-list" },
      list.length > 0
        ? h(
            "ol",
            { class: "steps", "data-list": k },
            list.map((s, i) => stepRow([...listPath, i], s)),
          )
        : h(
            "p",
            { class: "muted step-empty", "data-list": k },
            listPath.length > 0
              ? "Empty repeat: add steps or drop them here."
              : "Add the first step.",
          ),
      adding === k ? exercisePicker(listPath) : null,
      addBar(listPath),
    );
  }

  function stepRow(path, step) {
    const k = pathKey(path);
    const e = lib.byId.get(step.exercise_id) ?? null;
    const kind = STEP_KINDS[step.kind];
    const title = () => kind.title(step, e);
    const sub = () => kind.line(step, e);
    const nameEl = h("span", { class: "name" }, title());
    const subEl = h("span", { class: "muted" }, sub());
    const refresh = () => {
      nameEl.textContent = title();
      subEl.textContent = sub();
      recount();
    };
    const parentKey = pathKey(path.slice(0, -1));
    const lead = selection
      ? h("input", {
          type: "checkbox",
          "aria-label": `Select step ${pathLabel(path)}`,
          checked:
            selection.list === parentKey && selection.indices.has(path.at(-1)),
          onchange: (ev) => {
            if (selection.list !== parentKey)
              selection = { list: parentKey, indices: new Set() };
            if (ev.target.checked) selection.indices.add(path.at(-1));
            else selection.indices.delete(path.at(-1));
            paint(path, "input[type=checkbox]");
          },
        })
      : h(
          "button",
          {
            type: "button",
            class: "drag icon",
            "aria-label": `Move ${title()} (step ${pathLabel(path)})`,
            "aria-pressed": String(drag.holds(path)),
            onpointerdown: (ev) => drag.pointer(ev, path, title()),
            onkeydown: (ev) => drag.keyboard(ev, path, title()),
          },
          icon(GRIP),
        );
    const buildPanel = () => PANELS[step.kind](ed, path, step, e, refresh);
    const panel = h("div", { class: "step-panel" });
    // Built when first opened: a closed step costs one line.
    const build = () => {
      if (!panel.childElementCount)
        panel.append(...[buildPanel()].flat(Infinity).filter(Boolean));
    };
    if (open === k) build();
    return h(
      "li",
      { class: `step step-${step.kind}`, "data-path": k },
      h(
        "div",
        { class: "step-head" },
        lead,
        h(
          "details",
          {
            name: "step",
            open: open === k,
            ontoggle: (ev) => {
              if (ev.target.open) {
                open = k;
                build();
              } else if (open === k) open = null;
            },
          },
          h("summary", {}, nameEl, subEl),
          panel,
        ),
      ),
      step.kind === "repeat" ? stepList(path, step.steps) : null,
    );
  }

  // Every step fits its exercise and has its numbers; else the first that
  // doesn't opens, focused, and says why.
  function check(list = steps, parent = []) {
    for (const [i, step] of list.entries()) {
      const path = [...parent, i];
      const problem = STEP_KINDS[step.kind].problem(
        step,
        lib.byId.get(step.exercise_id),
      );
      if (problem) {
        open = pathKey(path);
        paint(path, ".step-panel :is(input, textarea)");
        throw new Error(`Step ${pathLabel(path)}: ${problem}.`);
      }
      if (step.kind === "repeat") check(step.steps, path);
    }
  }
  const body = (over = {}) => ({
    name: name.value,
    minutes: numberOrNull(minutes),
    kcal: energyOf(kcal),
    notes: notes.value,
    steps,
    archived: workout.archived,
    ...(isNew ? {} : { rev: workout.rev }),
    ...over,
  });
  // Archive (or unarchive) saves what's on screen with it.
  const archive = h(
    "button",
    {
      type: "button",
      onclick: busy(async () => {
        if (!shell.form.reportValidity()) return;
        try {
          check();
          const saved = await api(
            "PUT",
            `/workouts/${id}`,
            body({ archived: !workout.archived }),
          );
          shell.markClean();
          await go(location.hash);
          notify(
            saved.archived
              ? `Archived ${saved.name}: hidden where you plan or start one`
              : `Unarchived ${saved.name}`,
          );
        } catch (err) {
          shell.failed(err);
        }
      }),
    },
    workout.archived ? "Unarchive" : "Archive",
  );
  // Copy: a new workout of what's on screen (each press its own), opened
  // in its editor; this one stays as saved.
  const copy = copyForm(
    "/workouts",
    body,
    () => shell,
    (made) => href.workoutEdit(made.id, href.workout(made.id)),
    () => {
      check();
      return { uid: uid() };
    },
  );
  // A create carries its key: sent again after a lost answer it
  // answers the workout saved the first time, which then takes what the
  // form holds now.
  const key = createId();
  let sent = false;
  const send = async () => {
    check();
    if (!isNew) return api("PUT", `/workouts/${id}`, body());
    const again = sent;
    sent = true;
    let made = await api("POST", "/workouts", body({ uid: key.get() }));
    if (again)
      made = await api("PUT", `/workouts/${made.id}`, body({ rev: made.rev }));
    key.done();
    sent = false;
    return made;
  };
  // Start runs what's on screen: edits are saved first.
  const start = h(
    "button",
    {
      type: "button",
      class: "primary",
      onclick: busy(async () => {
        if (!shell.form.reportValidity()) return;
        try {
          const saved = shell.dirty() ? await send() : workout;
          shell.markClean();
          location.hash = href.run(saved.id);
        } catch (err) {
          shell.failed(err);
        }
      }),
    },
    "Start",
  );
  paint();
  const shell = editor({
    title: isNew ? "New workout" : workout.name,
    back: back ?? (isNew ? href.activity() : href.workout(id)),
    action: start,
    body: [
      used
        ? h(
            "p",
            { class: "note" },
            `Done or planned ${plural(used, "time")}. Past activities keep their sets; a new name reaches them.`,
          )
        : null,
      field("Name", name),
      h(
        "fieldset",
        { class: "steps-fieldset" },
        h("legend", {}, "Steps"),
        line,
        blocks,
      ),
      field("Notes", notes, {
        hint: "Shown on each step of a run. Line breaks are kept.",
      }),
      h(
        "details",
        {
          class: "fold estimates",
          open: Boolean(workout.minutes || workout.kcal),
        },
        h("summary", {}, "Duration and energy"),
        h(
          "p",
          { class: "muted" },
          "Estimated from the steps (energy from your weight). Type your own to replace an estimate; clear it to go back.",
        ),
        h(
          "div",
          { class: "pair" },
          field("Duration (min)", minutes),
          // A typed value is the total, as a device or a machine shows it,
          // read as active (resting taken off); empty, it is estimated.
          field(energyLabel("total"), kcal, {
            hint: [
              weightKg() === null
                ? "What your device or machine says, resting included. Log a weight to estimate it."
                : "What your device or machine says, resting included. Empty: estimated from time and weight.",
              active,
            ],
          }),
        ),
      ),
      announcer,
    ],
    state: () => steps,
    save: send,
    after: (saved) => back ?? href.workoutEdit(saved.id),
    secondary: isNew ? [] : [used ? archive : null, copy],
    remove:
      isNew || used
        ? null
        : {
            ask: `Delete ${workout.name}?`,
            detail: "Workouts done with it stay in the Diary.",
            run: () => api("DELETE", `/workouts/${id}`),
            after: href.activity(),
            done: `Deleted ${workout.name}`,
          },
  });
  return shell.node;
}
