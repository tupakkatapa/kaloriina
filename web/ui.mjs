// Shared UI: the DOM builder, fields and the choice widget, toasts and the
// confirm dialog, busy guards, the one editor shell every editor uses, the
// nutrition panel and the search picker. No screen lives here, and no data:
// it imports nothing but nutrients.mjs.

import {
  KEY_TARGETS,
  byCategory,
  fmtUnit,
  isNil,
  kcal,
  nutrient,
  ordered,
} from "./nutrients.mjs";

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || isNil(v)) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style")
      Object.assign(el.style, v); // CSSOM, allowed by the CSP
    else if (k in el && k !== "list") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...present(children));
  return el;
}

// Children as given, nested lists flattened, nothing for null or false.
const present = (kids) =>
  kids.flat(Infinity).filter((c) => !isNil(c) && c !== false);

// Replace `el`'s children; like `h`, null and false add nothing (the DOM's
// own replaceChildren would print them as "null").
export function fill(el, ...kids) {
  el.replaceChildren(...present(kids));
  return el;
}

// A stroked 24×24 icon; decorative, the control carries the name.
export function icon(d) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

export const SCAN_ICON =
  "M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M10 8v8M14 8v8M17 8v8";

// ------------------------------------------------------------- toasts

const toast = () => document.getElementById("toast");
let toastTimer = 0;
// Whether the toast shown may follow you to the next screen.
let toastTravels = false;
// The address the toast was shown at: one shown right after `go()` is
// about the screen being opened, not the one left.
let toastAt = null;

function hideToast() {
  clearTimeout(toastTimer);
  toast().hidden = true;
  fill(toast());
  document.body.classList.remove("toasting");
}

// Show `message` briefly. With `action` ({label, run}) it holds a button
// (Undo) and a close ✕, and stays longer. A toast with an action follows you
// to the next screen when the action still makes sense there (`travels`,
// the default); others clear when you move on.
export function notify(
  message,
  { error = false, action = null, travels = Boolean(action) } = {},
) {
  const box = toast();
  // Errors interrupt; confirmations wait their turn.
  box.setAttribute("role", error ? "alert" : "status");
  box.className = error ? "toast" : "toast info";
  fill(
    box,
    h("span", { class: "toast-text" }, message),
    action
      ? h(
          "button",
          {
            type: "button",
            onclick: async () => {
              hideToast();
              await action.run();
            },
          },
          action.label,
        )
      : null,
    action || error
      ? h(
          "button",
          {
            type: "button",
            class: "icon toast-close",
            "aria-label": "Close",
            onclick: hideToast,
          },
          "✕",
        )
      : null,
  );
  box.hidden = false;
  toastTravels = travels;
  toastAt = location.hash;
  document.body.classList.add("toasting");
  // Long enough to reach Undo; held while pointed at or focused.
  const wait = action ? 10_000 : 6000;
  const later = () => {
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, wait);
  };
  for (const [type, fn] of [
    ["mouseenter", () => clearTimeout(toastTimer)],
    ["focusin", () => clearTimeout(toastTimer)],
    ["mouseleave", later],
    ["focusout", later],
  ])
    box.addEventListener(type, fn, { signal: toastListeners.signal });
  later();
}
let toastListeners = new AbortController();

// A new screen: a toast that only meant the last one goes, and so does a
// dialog asking about the last one (cancelled: Back is how Android leaves
// it). The Log sheet minds its own: it stays across the day's addresses.
export function screenChanged() {
  for (const d of document.querySelectorAll("dialog[open]:not(.sheet)"))
    d.dispatchEvent(new Event("cancel", { cancelable: true }));
  if (!toastTravels && toastAt !== location.hash) hideToast();
  toastTravels = false;
  toastListeners.abort();
  toastListeners = new AbortController();
}

export function showError(err) {
  notify(err?.message ?? String(err), { error: true });
}

// ------------------------------------------------------------- dialog

// Ask before something that can't be undone. A styled modal (focus stays in
// it; Esc cancels); resolves to whether the user confirmed.
export function confirmDialog(
  question,
  { detail = null, confirm = "Delete", danger = true } = {},
) {
  return new Promise((resolve) => {
    const done = (answer) => {
      dialog.close();
      dialog.remove();
      resolve(answer);
    };
    const dialog = h(
      "dialog",
      {
        class: "confirm",
        "aria-labelledby": "confirm-question",
        oncancel: (e) => {
          e.preventDefault();
          done(false);
        },
      },
      h("h2", { id: "confirm-question" }, question),
      detail ? h("p", { class: "muted" }, detail) : null,
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", onclick: () => done(false) }, "Cancel"),
        h(
          "button",
          {
            type: "button",
            class: danger ? "danger" : "primary",
            onclick: () => done(true),
          },
          confirm,
        ),
      ),
    );
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector("button").focus();
  });
}

// A small form in a modal: `body` (its fields), Cancel and the primary
// `submit`. `run(form)` does the work; the dialog closes with what it
// returns, or `null` when cancelled (Esc too). A failure is told in the
// dialog, at the field the server named, and the dialog stays.
export function formDialog(title, { body, submit, run }) {
  return new Promise((resolve) => {
    const done = (value) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    const status = h("div", { class: "status", role: "status" });
    const form = h(
      "form",
      {
        class: "stack",
        onsubmit: busy(async (e) => {
          e.preventDefault();
          try {
            done(await run(form));
          } catch (err) {
            fill(status, errorBox(err));
            form.querySelector(`[name="${err.field}"]`)?.focus();
          }
        }),
      },
      body,
      status,
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", onclick: () => done(null) }, "Cancel"),
        h("button", { class: "primary" }, submit),
      ),
    );
    const dialog = h(
      "dialog",
      {
        class: "confirm",
        "aria-labelledby": "form-dialog-title",
        oncancel: (e) => {
          e.preventDefault();
          done(null);
        },
      },
      h("h2", { id: "form-dialog-title" }, title),
      form,
    );
    document.body.append(dialog);
    dialog.showModal();
    form.querySelector("input:not([type=hidden]), select, button")?.focus();
  });
}

// --------------------------------------------------------------- busy

// Disable the control that triggered `fn` until it settles, so a double tap
// can't log the same thing twice.
export const busy = (fn) => async (e) => {
  const el = e.currentTarget;
  // Its own flag, not "a button is disabled": forms may hold buttons that
  // are disabled for other reasons.
  if (el.dataset.busy) return;
  const form = el instanceof HTMLFormElement ? el : null;
  const els = form ? [...form.querySelectorAll("button:enabled")] : [el];
  el.dataset.busy = "1";
  for (const b of els) b.disabled = true;
  try {
    await fn(e);
  } finally {
    delete el.dataset.busy;
    for (const b of els) b.disabled = false;
  }
};

// An error as read. `err.link` ({href, text}): where its message names the
// text, it's a link there (where to fix it).
export function errorBox(err) {
  const { message, link } = err;
  const at = link ? message.lastIndexOf(link.text) : -1;
  return h(
    "p",
    { class: "error", role: "alert" },
    at < 0
      ? message
      : [
          message.slice(0, at),
          h("a", { href: link.href }, link.text),
          message.slice(at + link.text.length),
        ],
  );
}

// ------------------------------------------------------------- fields

// A labelled field: the label over its control. `inline` puts them on one
// line, for lists of numbers (a food's nutrients). `hint` explains below.
export function field(label, input, { inline = false, hint = null } = {}) {
  return h(
    // A <label> would name a segmented choice's first option after the
    // field; the radiogroup carries the label itself.
    input.getAttribute?.("role") === "radiogroup" ? "div" : "label",
    { class: inline ? "field inline" : "field" },
    h("span", {}, label),
    input,
    hint ? h("small", { class: "muted" }, hint) : null,
  );
}

// What a control is called on screen: its field's label, else its own.
const fieldName = (el) =>
  el.labels?.[0]?.querySelector(":scope > span")?.textContent ||
  el.getAttribute("aria-label") ||
  el.name;

// Smallest accepted amount; the API rejects 0 grams.
export const POSITIVE = "0.001";

// A number input's value, `null` when empty.
export const numberOrNull = (input) =>
  input.value === "" ? null : Number(input.value);

export const num = (attrs = {}) =>
  h("input", {
    type: "number",
    inputMode: "decimal",
    step: "any",
    min: "0",
    ...attrs,
  });

// Pick one of `options` ([value, label] pairs): a segmented control for a
// few short ones, a select beyond that. `value` is the current one (`""`
// for none; give an option for it, e.g. ["", "Not set"]). The control holds
// a form value under `name` and reads like a select (`.value`);
// `onChange(value)` follows each pick. `look: "switch"` is the Summary's
// quiet view switch: the same radios at any count, wrapping, never a select.
// `clearable` (a switch of optional values, a check-in's 1–5): toggle
// buttons instead of radios, tapping the pressed one clears it to "".
export function choice({
  name,
  label,
  options,
  value = "",
  onChange = () => {},
  look = "segmented",
  clearable = false,
}) {
  // Short enough in all to fit a phone's width (Difficulty's four don't).
  const segmented =
    look === "switch" ||
    (options.length <= 4 &&
      options.every(([, text]) => text.length <= 14) &&
      options.reduce((n, [, text]) => n + text.length, 0) <= 28);
  if (!segmented) {
    const select = h(
      "select",
      { name, "aria-label": label, onchange: () => onChange(select.value) },
      options.map(([v, text]) =>
        h("option", { value: v, selected: String(v) === String(value) }, text),
      ),
    );
    return select;
  }
  const hidden = h("input", { type: "hidden", name, value });
  const buttons = options.map(([v, text]) =>
    h(
      "button",
      {
        type: "button",
        role: clearable ? null : "radio",
        class: "button",
        "data-value": v,
        onclick: () =>
          set(clearable && hidden.value === String(v) ? "" : String(v)),
        onkeydown: (e) => {
          const i = buttons.indexOf(e.currentTarget);
          const step = {
            ArrowRight: 1,
            ArrowDown: 1,
            ArrowLeft: -1,
            ArrowUp: -1,
          }[e.key];
          if (!step) return;
          e.preventDefault();
          const next = buttons[(i + step + buttons.length) % buttons.length];
          set(next.dataset.value);
          next.focus();
        },
      },
      text,
    ),
  );
  function set(v, quiet = false) {
    hidden.value = v;
    for (const b of buttons) {
      const on = b.dataset.value === v;
      b.classList.toggle("active", on);
      b.setAttribute(clearable ? "aria-pressed" : "aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (!buttons.some((b) => b.dataset.value === v)) buttons[0].tabIndex = 0;
    if (!quiet) {
      hidden.dispatchEvent(new Event("input", { bubbles: true }));
      onChange(v);
    }
  }
  set(String(value), true);
  const node = h(
    "div",
    {
      class: look,
      role: clearable ? "group" : "radiogroup",
      "aria-label": label,
    },
    hidden,
    buttons,
  );
  // Read like a select: `.value` is the pick.
  Object.defineProperty(node, "value", { get: () => hidden.value });
  return node;
}

// A group of big numbers (`items`: [value, caption, class?], null ones
// skipped), read value first: "5.5 drinks a week". Null when none is left.
export function tiles(label, items) {
  const list = items.filter(Boolean);
  return list.length
    ? h(
        "ul",
        { class: "tiles", "aria-label": label },
        list.map(([value, caption, cls]) =>
          h(
            "li",
            { class: cls },
            h("b", { class: "tile-value" }, value),
            " ",
            h("span", { class: "tile-caption" }, caption),
          ),
        ),
      )
    : null;
}

// A Summary subtab's Highlights (web/insights.mjs results): one sentence
// each, nothing at all when there is none.
export const highlightList = (list) =>
  list.length
    ? h(
        "ul",
        { class: "highlights", "aria-label": "Highlights" },
        list.map((r) => h("li", {}, r.text)),
      )
    : null;

// ------------------------------------------------------------- titles

// A screen's title bar: back (only to an address inside the app), the
// title, an optional action on the right.
export function titleBar(title, back, action = null) {
  const to = typeof back === "string" && back.startsWith("#/") ? back : null;
  return h(
    "header",
    { class: "title" },
    to
      ? h("a", { class: "button icon", href: to, "aria-label": "Back" }, "‹")
      : null,
    h("h1", { class: title.length > 32 ? "long" : null }, title),
    action,
  );
}

// What shows instead of a screen whose thing is gone: what happened and the
// way back to its tab.
export function notFound(what, back, backLabel) {
  return h(
    "section",
    {},
    titleBar("Not found", back),
    h("p", {}, `This ${what} doesn't exist (any more).`),
    h("p", {}, h("a", { class: "button", href: back }, backLabel)),
  );
}

// ------------------------------------------------------------- editor

// Navigation as the editor needs it ({go, reload, guard, signal}), handed
// over by nav.mjs (which builds on this module, so can't be imported here).
let nav = null;
export const useNavigator = (n) => {
  nav = n;
};

// Every editor (food, recipe, meal, exercise, workout, session, profile,
// targets) works the same way:
// - one form, its fields in `body`;
// - one action bar: Delete, then `secondary` buttons, then Save (primary);
// - Save stays on the screen, toasts "Saved {name}" and re-reads the saved
//   thing (`after(saved)` may name another address, e.g. a new item's own);
// - a failed save says why at the bar, and focuses the field the server
//   named; a change made elsewhere meanwhile offers to reload;
// - Delete asks first (in an in-app dialog), then leaves for `remove.after`;
// - leaving with unsaved changes asks first (in the app and on reload);
//   `unsaved` opens it with some (a restored draft).
// `state()` adds what the form fields don't hold (lists built in code).
// Returns {node, form, dirty, markClean, failed} for the editor to use.
export function editor({
  title,
  back,
  body,
  save,
  saved = (x) => `Saved ${x.name}`,
  after = null,
  secondary = [],
  remove = null,
  aside = null,
  state = () => null,
  leaveAsk = "Leave without saving?",
  saveLabel = "Save",
  action = null,
  unsaved = false,
}) {
  const route = nav;
  const status = h("div", { class: "status", role: "status" });
  // The app reports invalid fields itself, as it does the server's.
  const form = h(
    "form",
    { class: "editor", noValidate: true },
    body,
    h(
      "div",
      { class: "actions-bar" },
      status,
      remove
        ? h(
            "button",
            {
              type: "button",
              class: "danger",
              onclick: busy(async () => {
                if (
                  !(await confirmDialog(remove.ask, {
                    detail: remove.detail ?? null,
                    confirm: remove.label ?? "Delete",
                  }))
                )
                  return;
                try {
                  await remove.run();
                  clean = snapshot();
                  route.go(remove.after);
                  notify(remove.done ?? "Deleted");
                } catch (err) {
                  failed(err);
                }
              }),
            },
            remove.label ?? "Delete",
          )
        : null,
      secondary,
      // Last, so the tab order is the order on screen.
      h("button", { class: "primary" }, saveLabel),
    ),
  );
  const snapshot = () =>
    JSON.stringify([
      [...form.elements]
        .filter((el) => el.name && el.type !== "submit")
        .map((el) => [el.name, el.type === "checkbox" ? el.checked : el.value]),
      state(),
    ]);
  let clean = null;
  const dirty = () => clean !== null && snapshot() !== clean;
  const markClean = () => {
    clean = snapshot();
  };
  // Taken once the screen is built (lists fill in after this returns). A
  // form that opens with unsaved work (a restored draft) starts dirty.
  queueMicrotask(() => {
    clean = unsaved ? "" : snapshot();
  });

  // `at`: the field at fault, by default the one the server named.
  const failed = (
    err,
    at = err.field && form.querySelector(`[name="${err.field}"]`),
  ) => {
    for (const el of form.querySelectorAll("[aria-invalid]"))
      el.removeAttribute("aria-invalid");
    if (at) {
      // A field folded away opens first.
      for (
        let d = at.closest("details");
        d;
        d = d.parentElement.closest("details")
      )
        d.open = true;
      at.setAttribute("aria-invalid", "true");
      at.focus();
    }
    fill(
      status,
      errorBox(err),
      err.code === "stale"
        ? h(
            "button",
            {
              type: "button",
              onclick: () => {
                clean = snapshot();
                route.reload();
              },
            },
            "Reload",
          )
        : null,
    );
  };
  form.addEventListener("input", () => fill(status));
  form.addEventListener(
    "submit",
    busy(async (e) => {
      e.preventDefault();
      const invalid = [...form.elements].find(
        (el) => el.willValidate && !el.validity.valid,
      );
      if (invalid) {
        failed(
          { message: `${fieldName(invalid)}: ${invalid.validationMessage}` },
          invalid,
        );
        return;
      }
      try {
        const result = await save();
        if (result === undefined) return; // the editor reported why
        clean = snapshot();
        const next = after?.(result);
        if (next && next !== location.hash) route.go(next);
        else route.reload();
        // `saved` names the toast, or gives `{message, action}` (an Undo).
        const said = saved(result);
        if (typeof said === "string") notify(said);
        else notify(said.message, { action: said.action });
      } catch (err) {
        failed(err);
      }
    }),
  );

  route.guard(async () => {
    if (!dirty()) return true;
    return confirmDialog(leaveAsk, {
      detail: "Your changes will be lost.",
      confirm: "Leave",
    });
  });
  const unload = (e) => {
    if (dirty()) e.preventDefault();
  };
  window.addEventListener("beforeunload", unload, { signal: route.signal });

  const node = h("section", {}, titleBar(title, back, action), form, aside);
  return { node, form, dirty, markClean, failed };
}

// ---------------------------------------------------- nutrition panel

// One amount in a nutrition table, in its display unit; "–" when unknown.
const cell = (key, value) => {
  if (isNil(value)) return "–";
  return key === "energy" ? kcal(value) : fmtUnit(key, value);
};

// What a food, recipe or meal contains: the four key nutrients up front, the
// rest under "Other nutrients", as in the diary and Summary. One column per
// basis ("Per 100 g", "Whole recipe (540 g)"). `paint` redraws it as inputs
// change; the fold keeps its open state across repaints.
export function nutritionPanel() {
  const main = h("tbody");
  const rest = h("tbody");
  const head = h("tr");
  const fold = h(
    "details",
    {},
    h("summary", {}, "Other nutrients"),
    h("table", { class: "grid nutrition" }, rest),
  );
  const paint = (columns) => {
    const row = (n) =>
      h(
        "tr",
        {},
        h("th", { scope: "row" }, n.label),
        columns.map((c) => h("td", {}, cell(n.key, c.values[n.key]))),
      );
    fill(
      head,
      h("th", {}, h("span", { class: "sr-only" }, "Nutrient")),
      ...columns.map((c) => h("th", { scope: "col" }, c.label)),
    );
    fill(main, ...KEY_TARGETS.map((k) => row(nutrient(k))));
    // Total carbohydrate is derived from carbohydrate and fibre; only the
    // nutrients some column has are listed.
    const others = ordered().filter(
      (n) =>
        !KEY_TARGETS.includes(n.key) &&
        n.key !== "carbs" &&
        columns.some((c) => !isNil(c.values[n.key])),
    );
    fill(
      rest,
      ...byCategory(others).flatMap(([name, list]) => [
        categoryRow(name, columns.length + 1),
        ...list.map(row),
      ]),
    );
    fold.hidden = !others.length;
  };
  const node = h(
    "section",
    { class: "nutrition-panel" },
    h("h2", {}, "Nutrition"),
    h("table", { class: "grid nutrition" }, h("thead", {}, head), main),
    fold,
  );
  return { node, paint };
}

// A section heading inside an "Other nutrients" table.
export const categoryRow = (name, columns) =>
  h(
    "tr",
    {},
    h("th", { scope: "rowgroup", colspan: columns, class: "category" }, name),
  );

// ------------------------------------------------------------- picker

// Pick from a search: nothing (or `empty()`) until you type, then matches;
// with none, `none(q)` says so (and may offer a way on). The field clears
// after each pick, ready for the next one. `search(q)` may answer later (a
// server search); only the newest query renders. Keys: ↓ from the field
// enters the results, Esc clears.
export function picker({
  search,
  row,
  onPick,
  placeholder,
  label = placeholder,
  empty = () => [],
  none = () => [h("li", { class: "muted" }, "No matches.")],
}) {
  const list = h("ul", { class: "results" });
  let timer = 0;
  let latest = 0;
  const show = async (q) => {
    // Replies can arrive out of order; only the newest query may render.
    const seq = ++latest;
    const items = q ? await search(q) : [];
    if (seq !== latest) return;
    fill(list, ...(q ? items.map((it) => row(it, pick)) : empty(pick)));
    if (q && !items.length) list.append(...none(q));
  };
  const input = h("input", {
    type: "search",
    placeholder,
    "aria-label": label,
    oninput: () => {
      clearTimeout(timer);
      timer = setTimeout(() => show(input.value.trim()), 150);
    },
    onkeydown: (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        list.querySelector("button, a")?.focus();
      } else if (e.key === "Escape" && input.value) {
        e.preventDefault();
        e.stopPropagation();
        input.value = "";
        show("");
      }
    },
  });
  const pick = (item) => {
    onPick(item);
    input.value = "";
    show("");
    input.focus();
  };
  show("");
  return h("div", { class: "picker" }, input, list);
}
