// A food's or recipe's servings in its editor: named amounts in grams, the
// first the default.

import { PORTION, WHOLE } from "./amount.mjs";
import { meta } from "./api.mjs";
import { fmtNum } from "./format.mjs";
import {
  fill,
  h,
  nameInput,
  num,
  numberOrNull,
  POSITIVE,
  removeButton,
} from "./ui.mjs";

// A fixed row's label, or null for one of yours.
const fixedOf = (row) => row.dataset.fixed ?? null;
// The serving "+ Serving" adds: nothing typed yet.
const BLANK = { label: "", grams: "" };
// Where a serving row says it's the default, or offers to become it.
const slot = () => h("span", { class: "default" });

// Servings in order; the first is the default (logging and ingredients
// start from it), and "Set default" moves one there. With `whole` (a
// recipe: its weight now), a fixed "Whole recipe" row is kept too, and a
// fixed "Portion" row while `portion()` (its grams) isn't null: then the
// whole recipe never leads, as `amountControl` reads it.
export function servingsEditor(initial, whole = null, portion = () => null) {
  const list = h("div", { class: "servings" });
  // A portion row is hidden, not removed, while `makes` is blank: it keeps
  // its place.
  const rows = () => [...list.children].filter((row) => !row.hidden);
  // The first row says it's the default; the others offer to become it.
  const mark = () => {
    const portioned = list.querySelector(
      `[data-fixed="${PORTION}"]:not([hidden])`,
    );
    if (portioned && rows()[0]?.dataset.fixed === WHOLE)
      list.prepend(portioned);
    for (const [i, row] of rows().entries()) {
      const name =
        fixedOf(row) ??
        (row.querySelector("input").value.trim() || "this serving");
      fill(
        row.querySelector(".default"),
        i === 0
          ? h("span", { class: "muted" }, "Default")
          : portioned && fixedOf(row) === WHOLE
            ? null
            : h(
                "button",
                {
                  type: "button",
                  class: "link",
                  "aria-label": `Make ${name} the default`,
                  onclick: () => {
                    list.prepend(row);
                    mark();
                    list.dispatchEvent(new Event("input", { bubbles: true }));
                  },
                },
                "Set default",
              ),
      );
    }
  };
  const addRow = (s = BLANK) => {
    const row = h(
      "div",
      { class: "serving" },
      nameInput({
        max: meta.limits.label,
        name: "serving-label",
        required: false,
        value: s.label,
        placeholder: "e.g. Slice",
        "aria-label": "Serving name",
      }),
      num({
        name: "serving-grams",
        value: s.grams,
        min: POSITIVE,
        placeholder: "grams",
        "aria-label": "Serving grams",
      }),
      h("span", {}, "g"),
      slot(),
      removeButton("Remove serving", () => {
        row.remove();
        mark();
        list.dispatchEvent(new Event("input", { bubbles: true }));
      }),
    );
    list.append(row);
    mark();
  };
  // Fixed rows by label: their grams now.
  const sizes = { [WHOLE]: () => whole(), [PORTION]: () => portion() };
  const addFixed = (label) =>
    list.append(
      h(
        "div",
        { class: "serving", "data-fixed": label },
        h("span", { class: "name" }, label),
        h("span", { class: "grams" }),
        h("span", {}, "g"),
        slot(),
        h("span", {}),
      ),
    );
  // The whole recipe goes first unless another serving was the default.
  if (whole && !initial.some((x) => x.label === WHOLE)) addFixed(WHOLE);
  for (const x of initial)
    if (whole && x.label in sizes) addFixed(x.label);
    else addRow(x);
  list.addEventListener("input", mark);
  // A new portion is added last, as the server does; `mark` moves it
  // before a leading whole recipe.
  const refresh = () => {
    if (whole) {
      const row = list.querySelector(`[data-fixed="${PORTION}"]`);
      if (row) row.hidden = portion() === null;
      else if (portion() !== null) addFixed(PORTION);
      for (const r of rows().filter((x) => fixedOf(x)))
        r.querySelector(".grams").textContent = fmtNum(sizes[fixedOf(r)]());
    }
    mark();
  };
  refresh();
  const node = h(
    "fieldset",
    {},
    h("legend", {}, "Servings"),
    list,
    h("button", { type: "button", onclick: () => addRow() }, "+ Serving"),
  );
  const value = () =>
    rows()
      .map((row) =>
        // A placed serving isn't sized: the server sets its grams.
        fixedOf(row)
          ? { label: fixedOf(row), grams: 1 }
          : {
              label: row.querySelector("input").value.trim(),
              // 0, not null: an untouched row (no label, no grams) is dropped.
              grams:
                numberOrNull(row.querySelector("input[inputmode=decimal]")) ??
                0,
            },
      )
      // Drop untouched rows; partial ones reach the API and get an error.
      .filter((x) => x.label || x.grams);
  // Your rows as they read now, each with its element: what a choice of
  // one keeps following through renames.
  const own = () =>
    rows()
      .filter((row) => !fixedOf(row))
      .map((row) => ({
        row,
        label: row.querySelector("input").value.trim(),
        grams: numberOrNull(row.querySelector("input[inputmode=decimal]")),
      }));
  return { node, value, refresh, own };
}
