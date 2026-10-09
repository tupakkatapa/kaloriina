// Building a workout: steps one line each (opened to edit), repeats, drag by
// pointer or keyboard, select and wrap, Undo; time and energy estimated.

import { api, get, meta, profileId, weightKg } from "../api.mjs";
import { href } from "../nav.mjs";
import { plural } from "../nutrients.mjs";
import {
  busy,
  choice,
  editor,
  field,
  fill,
  h,
  notify,
  num,
  numberOrNull,
  picker,
  POSITIVE,
} from "../ui.mjs";
import {
  amount,
  at,
  clock,
  details,
  effort,
  exerciseIds,
  fit,
  fitsAt,
  insert,
  kcalFor,
  listAt,
  move,
  remove,
  repeatText,
  stepError,
  unwrap,
  update,
  wrap,
} from "../workouts.mjs";
import {
  exerciseRow,
  library,
  variantLabel,
  workoutLine,
} from "./workouts.mjs";

// A step's path as text ("1.0"), back, and as people count it ("2.1").
const key = (path) => path.join(".");
const unkey = (k) => (k === "" ? [] : k.split(".").map(Number));
const label = (path) => path.map((i) => i + 1).join(".");

// Every place a step could go in `list`, in reading order.
function slots(list, listPath = []) {
  return [
    ...list.flatMap((s, i) => [
      { list: listPath, index: i },
      ...(s.kind === "repeat" ? slots(s.steps, [...listPath, i]) : []),
    ]),
    { list: listPath, index: list.length },
  ];
}

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

// A workout is a list of steps (exercises, rests, repeats holding more
// steps), each one line until you open it. Steps move by dragging their
// handle (or with the keyboard on it); several can be wrapped in a repeat
// at once. Edits are made on a copy of the steps, saved with Save; every
// structural change can be undone. Panels are built when opened, so a long
// workout stays quick to edit.
export async function workoutEditor(id) {
  const [workout, exercises] = await Promise.all([
    id === "new"
      ? { name: "", steps: [], minutes: null }
      : get(`/workouts/${id}`),
    get("/exercises"),
  ]);
  // Repeats nest at most this deep: the server's rule, read where it's served.
  const { depth } = meta.limits;
  const lib = library(exercises);
  const isNew = id === "new";
  let steps = structuredClone(workout.steps);
  let open = null; // the step whose panel is open ("2.1" by index)
  let adding = null; // the list the picker adds to ("" for the workout)
  let replacing = null; // the step whose exercise the picker replaces
  let selection = null; // {list, indices} while selecting
  let held = null; // keyboard drag: {path, before, origin}

  const name = h("input", {
    name: "name",
    value: workout.name,
    required: true,
    maxLength: meta.limits.name,
  });
  const minutes = num({
    name: "minutes",
    value: workout.minutes ?? "",
    step: 1,
    min: 1,
    max: meta.limits.minutes,
    oninput: () => recount(),
  });
  const kcal = num({
    name: "kcal",
    value: workout.kcal ?? "",
    step: 1,
    min: 1,
    max: meta.limits.kcal,
    oninput: () => recount(),
  });
  const blocks = h("div", { class: "steps-editor" });
  const line = h("p", { class: "muted" });
  const announcer = h("p", { class: "sr-only", "aria-live": "polite" });
  const announce = (text) => {
    announcer.textContent = text;
  };

  function recount() {
    const e = effort({ steps }, lib.byId, weightKg());
    const est = kcalFor(numberOrNull(minutes) ?? e.minutes, weightKg());
    minutes.placeholder = `≈ ${e.minutes}`;
    kcal.placeholder = est === null ? "" : `≈ ${est}`;
    fill(
      line,
      ...[
        steps.length
          ? workoutLine(
              {
                steps,
                minutes: numberOrNull(minutes),
                kcal: numberOrNull(kcal),
              },
              lib,
            )
          : "",
        steps.length && weightKg() === null && kcal.value === ""
          ? [
              " · ",
              h(
                "a",
                { href: href.profileEdit(profileId) },
                "set your weight for kcal",
              ),
            ]
          : "",
      ].flat(),
    );
  }

  // Draw the steps again, then put focus back where the edit happened.
  function paint(focus = null, target = ".drag") {
    fill(blocks, stepList([], steps), selectionBar());
    recount();
    // Nothing to run until it's saved with steps.
    start.hidden = isNew || !steps.length;
    if (focus)
      blocks.querySelector(`[data-path="${key(focus)}"] ${target}`)?.focus();
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
      notify(message, {
        travels: false,
        action: {
          label: "Undo",
          run: () => {
            steps = before;
            paint();
          },
        },
      });
  }

  // Replace a step's fields in place (variant or exercise switch).
  const replaceAt = (path, step) =>
    update(steps, path, (s) => {
      for (const k of Object.keys(s)) delete s[k];
      Object.assign(s, step);
    });

  function exercisePicker(listPath) {
    const usedIds = exerciseIds(steps);
    const onPick = ({ root, hit }) => {
      const e = hit ?? root;
      if (replacing !== null) {
        const path = unkey(replacing);
        const { step, dropped } = fit(e, at(steps, path));
        replacing = null;
        adding = null;
        open = key(path);
        change({ steps: replaceAt(path, step), path }, { target: "input" });
        if (dropped.length)
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
      open = key(result.path);
      change(result, { target: ".step-panel input" });
    };
    return h(
      "div",
      { class: "step-picker", "data-picker": key(listPath) },
      picker({
        placeholder: "Search exercises",
        search: (q) => lib.search(q),
        row: (m, pick) => exerciseRow(m, pick, lib),
        onPick,
        // Until you type: what this workout already uses.
        empty: (pick) =>
          usedIds.size
            ? [
                h(
                  "li",
                  { class: "chips" },
                  h("span", { class: "muted" }, "In this workout:"),
                  [...usedIds]
                    .map((i) => lib.byId.get(i))
                    .filter(Boolean)
                    .map((e) =>
                      h(
                        "button",
                        {
                          type: "button",
                          class: "chip",
                          onclick: () => pick({ root: lib.rootOf(e), hit: e }),
                        },
                        e.name,
                      ),
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
    const k = key(listPath);
    const where = listPath.length ? `repeat ${label(listPath)}` : "the workout";
    const end = () => listAt(steps, listPath).length;
    const add = (step, target) => {
      const result = insert(steps, listPath, end(), step, depth);
      open = key(result.path);
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
      listPath.length
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
    const k = key(listPath);
    return h(
      "div",
      { class: "step-list" },
      list.length
        ? h(
            "ol",
            { class: "steps", "data-list": k },
            list.map((s, i) => stepRow([...listPath, i], s)),
          )
        : h(
            "p",
            { class: "muted step-empty", "data-list": k },
            listPath.length
              ? "Empty repeat: add steps or drop them here."
              : "Add the first step.",
          ),
      adding === k ? exercisePicker(listPath) : null,
      addBar(listPath),
    );
  }

  // Keyboard drag on the handle: Space picks up and drops, arrows move
  // through every valid place (into and out of repeats), Escape cancels.
  function keyboardDrag(ev, path, title) {
    const isHeld = held && key(held.path) === key(path);
    if (ev.key === " " || ev.key === "Enter") {
      ev.preventDefault();
      if (!isHeld) {
        held = { path, before: steps, origin: path };
        announce(
          `Picked up ${title}, step ${label(path)}. Arrow keys move it, Space drops it, Escape cancels.`,
        );
      } else {
        const before = held.before;
        held = null;
        announce(`Dropped ${title} at step ${label(path)}.`);
        if (before !== steps)
          notify(`Moved ${title}`, {
            travels: false,
            action: {
              label: "Undo",
              run: () => {
                steps = before;
                paint();
              },
            },
          });
      }
      paint(path);
    } else if (isHeld && (ev.key === "ArrowUp" || ev.key === "ArrowDown")) {
      ev.preventDefault();
      const dir = ev.key === "ArrowDown" ? 1 : -1;
      const all = slots(steps);
      const parent = key(path.slice(0, -1));
      const i = path.at(-1);
      const from = all.findIndex(
        (s) => key(s.list) === parent && s.index === i + (dir > 0 ? 1 : 0),
      );
      for (let j = from + dir; j >= 0 && j < all.length; j += dir) {
        const result = move(steps, path, all[j].list, all[j].index, depth);
        if (result && key(result.path) !== key(path)) {
          steps = result.steps;
          held.path = result.path;
          paint(result.path);
          announce(
            `Step ${label(result.path)}${result.path.length > 1 ? `, in repeat ${label(result.path.slice(0, -1))}` : ""}.`,
          );
          return;
        }
      }
    } else if (isHeld && ev.key === "Escape") {
      ev.preventDefault();
      steps = held.before;
      const { origin } = held;
      held = null;
      announce("Move cancelled.");
      paint(origin);
    }
  }

  // Where a pointer at (x, y) would drop the step from `from`: a list, an
  // index in it, and where to draw the line. Null over nowhere valid.
  function dropTarget(x, y, from) {
    const el = document.elementFromPoint(x, y);
    const empty = el?.closest(".step-empty");
    const row = el?.closest("li.step");
    let place = null;
    if (empty && blocks.contains(empty)) {
      const r = empty.getBoundingClientRect();
      place = {
        list: unkey(empty.dataset.list),
        index: 0,
        x: r.left,
        y: r.top,
      };
    } else if (row && blocks.contains(row)) {
      const path = unkey(row.dataset.path);
      const head = row
        .querySelector(":scope > .step-head")
        .getBoundingClientRect();
      const lower = y > head.top + head.height / 2;
      if (at(steps, path).kind === "repeat" && lower)
        place = { list: path, index: 0, x: head.left + 16, y: head.bottom };
      else
        place = {
          list: path.slice(0, -1),
          index: path.at(-1) + (lower ? 1 : 0),
          x: head.left,
          y: lower ? row.getBoundingClientRect().bottom : head.top,
        };
    }
    return place && move(steps, from, place.list, place.index, depth)
      ? place
      : null;
  }

  // Pointer drag (mouse, touch, pen) from the handle only, so scrolling and
  // typing elsewhere stay as they are.
  function pointerDrag(ev, path, title) {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    ev.preventDefault();
    const handle = ev.currentTarget;
    handle.setPointerCapture(ev.pointerId);
    const row = handle.closest("li.step");
    row.classList.add("dragging");
    const marker = h("div", { class: "drop-line", hidden: true });
    blocks.append(marker);
    let target = null;
    const onMove = (e) => {
      target = dropTarget(e.clientX, e.clientY, path);
      marker.hidden = !target;
      if (target) {
        const box = blocks.getBoundingClientRect();
        marker.style.top = `${target.y - box.top}px`;
        marker.style.left = `${target.x - box.left}px`;
      }
      if (e.clientY < 48) scrollBy(0, -12);
      else if (e.clientY > innerHeight - 96) scrollBy(0, 12);
    };
    const onEnd = (e) => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      marker.remove();
      row.classList.remove("dragging");
      if (e.type === "pointerup" && target)
        change(move(steps, path, target.list, target.index, depth), {
          message: `Moved ${title}`,
        });
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  }

  const removeButton = (path, text) =>
    h(
      "button",
      {
        type: "button",
        class: "danger",
        "aria-label": `Remove ${text} (step ${label(path)})`,
        onclick: () => {
          const parent = path.slice(0, -1);
          const next = remove(steps, path);
          const left = listAt(next, parent).length;
          change(
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

  function exercisePanel(path, step, e, refresh) {
    const stepNo = label(path);
    const root = e ? lib.rootOf(e) : null;
    const family = root ? [root, ...(lib.variants.get(root.id) ?? [])] : [];
    const switchTo = (v) => {
      const { step: next, dropped } = fit(v, step);
      open = key(path);
      // Focus stays on the variant: the select, or the chosen radio.
      const variant = `[aria-label="Step ${stepNo} variant"]`;
      change(
        { steps: replaceAt(path, next), path },
        { target: `:is(select${variant}, ${variant} [aria-checked="true"])` },
      );
      if (dropped.length)
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
            onclick: () => {
              replacing = key(path);
              adding = key(path.slice(0, -1));
              paint();
              blocks.querySelector(`[data-picker="${adding}"] input`)?.focus();
            },
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
            onChange: (vid) => switchTo(lib.byId.get(Number(vid))),
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
              "Weight (kg)",
              fieldInput(
                step,
                "kg",
                `Step ${stepNo} weight`,
                {
                  step: "any",
                  min: POSITIVE,
                  max: meta.limits.kg,
                  required: load === "required",
                },
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
              open = key(path);
              change(
                {
                  steps: update(steps, path, (s) => {
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
                steps,
                path.slice(0, -1),
                path.at(-1),
                path.at(-1),
                depth,
              );
              if (result) open = key(result.path);
              change(result, {
                message: "Wrapped in a repeat",
                target: ".step-panel input",
              });
            },
          },
          "Wrap in repeat",
        ),
        removeButton(path, e?.name ?? "step"),
      ),
    ];
  }

  function stepRow(path, step) {
    const k = key(path);
    const e = step.kind === "exercise" ? lib.byId.get(step.exercise_id) : null;
    const title = () =>
      step.kind === "rest"
        ? "Rest"
        : step.kind === "repeat"
          ? (step.name ?? "Repeat")
          : (e?.name ?? `Exercise ${step.exercise_id}`);
    const sub = () =>
      step.kind === "rest"
        ? clock(step.seconds || 0)
        : step.kind === "repeat"
          ? repeatText(step)
          : [step.reps || step.seconds ? amount(step) : "", details(step, e)]
              .filter(Boolean)
              .join(" · ");
    const nameEl = h("span", { class: "name" }, title());
    const subEl = h("span", { class: "muted" }, sub());
    const refresh = () => {
      nameEl.textContent = title();
      subEl.textContent = sub();
      recount();
    };
    const parentKey = key(path.slice(0, -1));
    const lead = selection
      ? h("input", {
          type: "checkbox",
          "aria-label": `Select step ${label(path)}`,
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
            "aria-label": `Move ${title()} (step ${label(path)})`,
            "aria-pressed": String(Boolean(held && key(held.path) === k)),
            onpointerdown: (ev) => pointerDrag(ev, path, title()),
            onkeydown: (ev) => keyboardDrag(ev, path, title()),
          },
          "⠿",
        );
    const buildPanel = () => {
      if (step.kind === "exercise")
        return exercisePanel(path, step, e, refresh);
      if (step.kind === "rest")
        return [
          field(
            "Time (s)",
            fieldInput(
              step,
              "seconds",
              `Step ${label(path)} rest seconds`,
              { max: meta.limits.step_seconds },
              refresh,
            ),
            { inline: true },
          ),
          h("div", { class: "actions" }, removeButton(path, "Rest")),
        ];
      return [
        h(
          "div",
          { class: "row step-fields" },
          field(
            "Rounds",
            fieldInput(
              step,
              "times",
              `Step ${label(path)} rounds`,
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
              `Step ${label(path)} every (s)`,
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
              "aria-label": `Step ${label(path)} name`,
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
                change(
                  {
                    steps: unwrap(steps, path),
                    path: step.steps.length ? path : null,
                  },
                  { message: "Unwrapped the repeat" },
                ),
            },
            "Unwrap",
          ),
          removeButton(
            path,
            `Repeat and its ${plural(step.steps.length, "step")}`,
          ),
        ),
      ];
    };
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

  function selectionBar() {
    if (!selection) return null;
    const listPath = selection.list === null ? [] : unkey(selection.list);
    const chosen = [...selection.indices].toSorted((a, b) => a - b);
    const first = chosen[0];
    const last = chosen.at(-1);
    const span =
      first === last
        ? `step ${label([...listPath, first])}`
        : `steps ${label([...listPath, first])}–${label([...listPath, last])}`;
    const wrapped = chosen.length
      ? wrap(steps, listPath, first, last, depth)
      : null;
    return h(
      "div",
      { class: "select-bar" },
      h(
        "span",
        { class: "muted" },
        `${plural(chosen.length, "step")} selected`,
      ),
      h(
        "button",
        {
          type: "button",
          onclick: () => {
            selection = null;
            paint();
          },
        },
        "Cancel",
      ),
      h(
        "button",
        {
          type: "button",
          class: "danger",
          disabled: !chosen.length,
          onclick: () => {
            let next = steps;
            for (const i of chosen.toReversed())
              next = remove(next, [...listPath, i]);
            selection = null;
            change(
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
          title:
            chosen.length && !wrapped
              ? `Repeats nest at most ${depth} deep`
              : null,
          onclick: () => {
            selection = null;
            open = key(wrapped.path);
            change(wrapped, {
              message: "Wrapped in a repeat",
              target: ".step-panel input",
            });
          },
        },
        chosen.length ? `Wrap ${span} in repeat` : "Wrap in repeat",
      ),
    );
  }

  // Every step fits its exercise and has its numbers; else the first that
  // doesn't opens, focused, and says why.
  function check(list = steps, parent = []) {
    for (const [i, step] of list.entries()) {
      const path = [...parent, i];
      const problem =
        step.kind === "repeat"
          ? !(step.times >= 1)
            ? "set how many rounds"
            : null
          : step.kind === "rest"
            ? !(step.seconds >= 1)
              ? "set how long"
              : null
            : (() => {
                const e = lib.byId.get(step.exercise_id);
                if (!e) return `unknown exercise ${step.exercise_id}`;
                if (step.reps === 0 || step.seconds === 0)
                  return `${e.name} needs more than 0`;
                return stepError(e, step);
              })();
      if (problem) {
        open = key(path);
        paint(path, ".step-panel input");
        throw new Error(`Step ${label(path)}: ${problem}.`);
      }
      if (step.kind === "repeat") check(step.steps, path);
    }
  }
  const body = () => ({
    name: name.value,
    minutes: numberOrNull(minutes),
    kcal: numberOrNull(kcal),
    steps,
    ...(isNew ? {} : { rev: workout.rev }),
  });
  const send = () => {
    check();
    return isNew
      ? api("POST", "/workouts", body())
      : api("PUT", `/workouts/${id}`, body());
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
    back: href.workouts(),
    action: start,
    body: [
      field("Name", name),
      h(
        "fieldset",
        { class: "steps-fieldset" },
        h("legend", {}, "Steps"),
        line,
        blocks,
      ),
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
          field("Energy (kcal)", kcal),
        ),
      ),
      announcer,
    ],
    state: () => steps,
    save: send,
    after: (saved) => href.workout(saved.id),
    remove: isNew
      ? null
      : {
          ask: `Delete ${workout.name}?`,
          detail: "Workouts done with it stay in the diary.",
          run: () => api("DELETE", `/workouts/${id}`),
          after: href.workouts(),
          done: `Deleted ${workout.name}`,
        },
  });
  return shell.node;
}
