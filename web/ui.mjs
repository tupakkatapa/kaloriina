// Shared UI: the DOM builder, fields and the choice widget, the small
// widgets every screen builds the same way (period header, chip, empty
// state, name input), toasts and Undo, the one modal() under every dialog, busy
// guards, the one editor shell every editor uses and the search picker
// (the nutrition panel: nutrition-panel.mjs; list rows: rows.mjs). No
// screen lives here, and no data: it imports nothing but the pure
// format.mjs, nutrients.mjs, units.mjs and dates.mjs.

import { clockOf, parseClock, period, today } from "./dates.mjs";
import { entriesUpdated, fmt, isNil } from "./format.mjs";
import { nutrient, shownEnergy } from "./nutrients.mjs";
import { inputText, parseNum, readInput, toShown } from "./units.mjs";

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || isNil(v)) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    // CSSOM, which the CSP allows (a style attribute it doesn't).
    else if (k === "style") Object.assign(el.style, v);
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

// Abbreviations a label may use, with their words; the split reads them.
const ABBR = { RHR: "resting heart rate", HRV: "heart rate variability" };
const ABBR_RE = new RegExp(`\\b(${Object.keys(ABBR).join("|")})\\b`, "u");

// `text` with each abbreviation in it as an `<abbr>` naming its words
// ("RHR 54 bpm"); anything not text as it is.
export const abbreviated = (text) =>
  typeof text === "string"
    ? text
        .split(ABBR_RE)
        .map((part, i) =>
          i % 2 ? h("abbr", { title: ABBR[part] }, part) : part || null,
        )
    : text;

// A stroked 24×24 icon, `filled` too (a starred star); decorative, the
// control carries the name. Centred by its viewBox, not by a font's
// metrics, so it sits in the middle of its button on every platform.
export function icon(d, filled = false) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  if (filled) svg.classList.add("filled");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

// The app's glyphs, one drawing each: no text glyph stands in for one.
export const CHECK = "M5 12.5l4.5 4.5L19 7";
export const CLOSE = "M6 6l12 12M18 6L6 18";
export const PLUS = "M12 5v14M5 12h14";
export const MINUS = "M5 12h14";
const CHEVRON_L = "M15 5l-7 7 7 7";
export const CHEVRON_R = "M9 5l7 7-7 7";
export const STAR =
  "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z";
export const GRIP = "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01";
export const COPY = "M9 9h11v11H9zM15 9V4H4v11h5";
const PENCIL = "M4 20h4L19 9l-4-4L4 16zM14 6l4 4";
export const RECALC = "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5";
export const SOUND = "M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7";

export const SCAN =
  "M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M10 8v8M14 8v8M17 8v8";
// A camera (feather's "camera"), drawn like Scan.
export const CAMERA =
  "M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z";
// A list with a tick: Select's icon on a narrow phone, where the word
// would push + onto a second line.
export const SELECT =
  "M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17M11 6h9M11 12h9M11 18h9";

// -------------------------------------------------------------- toasts

const toast = () => document.querySelector("#toast");
let toastTimer = 0;
// How long the toast shown stays, from when it shows or is let go, and
// whether it is counting that down (not held, not gone).
let toastWait = 0;
let toastCounting = false;
// Whether the toast shown may follow you to the next screen.
let toastTravels = false;
// The address the toast was shown at: one shown right after `go()` is
// about the screen being opened, not the one left.
let toastAt = null;

// The toast's time, started again (0: held).
function toastFor(ms) {
  clearTimeout(toastTimer);
  toastCounting = Boolean(ms);
  toastTimer = ms ? setTimeout(hideToast, ms) : 0;
}

function hideToast() {
  toastFor(0);
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
          icon(CLOSE),
        )
      : null,
  );
  box.hidden = false;
  toastTravels = travels;
  toastAt = location.hash;
  document.body.classList.add("toasting");
  // Long enough to reach Undo; held while pointed at or focused.
  toastWait = action ? 10_000 : 6000;
  const later = () => toastFor(toastWait);
  for (const [type, fn] of [
    ["mouseenter", () => toastFor(0)],
    ["focusin", () => toastFor(0)],
    ["mouseleave", later],
    ["focusout", later],
  ])
    box.addEventListener(type, fn, { signal: toastListeners.signal });
  later();
}

// A toast's time doesn't run while a screen loads: one raised as a save
// left for a slow screen counts again from when that screen shows, so it
// is still there to read.
export function screenLoading() {
  clearTimeout(toastTimer);
}
export function screenShown() {
  if (toastCounting) toastFor(toastWait);
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

// A toast of what was just done, with Undo running `run`; `opts` as
// notify's (`travels: false` for an undo only this screen can do).
export const undoable = (message, run, opts = {}) =>
  notify(message, { ...opts, action: { label: "Undo", run } });

// -------------------------------------------------------------- dialog

// A modal dialog on the page (focus stays in it), `attrs` on it (its class,
// its name) and `children` in it. Esc, a screen change and `close()` close
// it once: it leaves the page, `onClose()` runs and focus goes back to what
// opened it. `focus` picks what takes focus on opening. Returns {dialog,
// close}.
export function modal(attrs, children, { onClose = () => {}, focus } = {}) {
  const opener = document.activeElement;
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    dialog.close();
    dialog.remove();
    opener?.focus?.();
    onClose();
  };
  const dialog = h(
    "dialog",
    {
      ...attrs,
      oncancel: (e) => {
        e.preventDefault();
        close();
      },
    },
    children,
  );
  document.body.append(dialog);
  dialog.showModal();
  dialog.querySelector(focus ?? "button")?.focus();
  return { dialog, close };
}

// Ask before something that can't be undone. A styled modal (Esc cancels);
// resolves to whether the user confirmed.
export function confirmDialog(
  question,
  { detail = null, confirm = "Delete", cancel = "Cancel", danger = true } = {},
) {
  return new Promise((resolve) => {
    let answer = false;
    const { close } = modal(
      { class: "confirm", "aria-labelledby": "confirm-question" },
      [
        h("h2", { id: "confirm-question" }, question),
        detail ? h("p", { class: "muted" }, detail) : null,
        h(
          "div",
          { class: "actions" },
          h("button", { type: "button", onclick: () => close() }, cancel),
          h(
            "button",
            {
              type: "button",
              class: danger ? "danger" : "primary",
              onclick: () => {
                answer = true;
                close();
              },
            },
            confirm,
          ),
        ),
      ],
      { onClose: () => resolve(answer) },
    );
  });
}

// A small form in a modal: `body` (its fields), Cancel and the primary
// `submit`. `run(form)` does the work; the dialog closes with what it
// returns, or `null` when cancelled (Esc too). A failure is told in the
// dialog, at the field the server named, and the dialog stays.
export function formDialog(title, { body, submit, run }) {
  return new Promise((resolve) => {
    let value = null;
    const status = h("div", { class: "status", role: "status" });
    const form = h(
      "form",
      {
        class: "stack",
        onsubmit: busy(async (e) => {
          e.preventDefault();
          try {
            value = await run(form);
            close();
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
        h("button", { type: "button", onclick: () => close() }, "Cancel"),
        h("button", { class: "primary" }, submit),
      ),
    );
    const { close } = modal(
      { class: "confirm", "aria-labelledby": "form-dialog-title" },
      [h("h2", { id: "form-dialog-title" }, title), form],
      {
        onClose: () => resolve(value),
        focus: "input:not([type=hidden]), select, button",
      },
    );
  });
}

// ---------------------------------------------------------------- busy

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
    // Disabled, it lost focus (a dialog it opened couldn't give it back):
    // it takes it again unless something else has.
    if (el.isConnected && document.activeElement === document.body) el.focus();
  }
};

// A planned thing's to-do tick, right of its row: a rounded square with
// its check (a planned food or due day: eaten; a planned workout: done).
export const tickButton = (label, run) =>
  h(
    "button",
    {
      type: "button",
      class: "icon tick",
      "aria-label": label,
      onclick: busy(run),
    },
    icon(CHECK),
  );

// A row's remove: a ✕ named by `label` ("Remove nap 13:00–13:40").
export const removeButton = (label, run) =>
  h(
    "button",
    {
      type: "button",
      class: "danger icon",
      "aria-label": label,
      onclick: busy(run),
    },
    icon(CLOSE),
  );

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

// -------------------------------------------------------------- fields

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

// A name's text input, required unless told, capped at the server's limit
// for it (`max`: `meta.limits.name`, or `.label` for the shorter ones).
export const nameInput = ({ max, ...attrs }) =>
  h("input", { name: "name", required: true, maxLength: max, ...attrs });

// A small rounded button: a pick that fills a field (an amount), or with
// `pressed` a toggle (a tag filter); with `href` a link that looks the same.
export const chip = (text, onclick, { pressed, href: to, ...attrs } = {}) =>
  h(
    to ? "a" : "button",
    {
      type: to ? null : "button",
      class: to ? "button chip" : "chip",
      href: to,
      "aria-pressed": isNil(pressed) ? null : String(pressed),
      onclick,
      ...attrs,
    },
    text,
  );

// What a list or section says when it has nothing; `tag` "li" in a list.
export const empty = (text, tag = "p") =>
  h(tag, { class: "muted empty" }, text);

// Notes as typed (a recipe's, a workout's, a note block's): line breaks
// kept, long words wrapped. `tag` "span" fits it in a line of text.
const notesText = (text, tag = "p") => h(tag, { class: "notes-text" }, text);

// A "Notes" section of `text`, or null without any; `fold` closes it in a
// <details> to open when wanted (a run's steps).
export function notesSection(text, { fold = false } = {}) {
  if (!text) return null;
  return fold
    ? h(
        "details",
        { class: "fold notes-block" },
        h("summary", {}, "Notes"),
        notesText(text),
      )
    : h(
        "section",
        { class: "finder-section notes-block" },
        h("h2", {}, "Notes"),
        notesText(text),
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
export const numberOrNull = (input) => parseNum(input.value);

// Its limits as the browser would tell them, the step's by its base.
function numberProblem(input, text) {
  const n = parseNum(text);
  if (n === null) return "";
  if (Number.isNaN(n)) return "Enter a number, with a comma or a point";
  const attr = (name) => parseNum(input.getAttribute(name) ?? "");
  const [min, max, step] = [attr("min"), attr("max"), attr("step")];
  if (!isNil(min) && n < min) return `Enter at least ${fmt(min, 3)}`;
  if (!isNil(max) && n > max) return `Enter at most ${fmt(max, 3)}`;
  const steps = step > 0 ? (n - (min ?? 0)) / step : 0;
  if (Math.abs(steps - Math.round(steps)) > 1e-9)
    return step === 1
      ? "Enter a whole number"
      : `Enter a multiple of ${fmt(step, 3)}`;
  return "";
}

// A text input whose `value` reads and takes data (`read` the typed text,
// `show` a value), "" when empty or invalid as a native input's, so every
// reader stays `input.value`; `problem(input, text)` says why it's invalid.
function typed({ value = "", ...attrs }, { read, show = String, problem }) {
  const input = h("input", { type: "text", autocomplete: "off", ...attrs });
  const { get, set } = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  );
  const check = () => input.setCustomValidity(problem(input, get.call(input)));
  Object.defineProperty(input, "value", {
    get: () => read(get.call(input)),
    set(v) {
      set.call(input, isNil(v) || v === "" ? "" : show(v));
      check();
    },
  });
  input.addEventListener("input", check);
  input.value = value;
  return input;
}

// A number input typed with either decimal mark, read through `parseNum`
// (a `type="number"` one drops a comma it can't read on an English page:
// "1,5" was stored as 15). Its limits (`min`, `max`, `step`) are checked
// here, as the browser would; its `value` reads as a machine number ("1,5"
// → "1.5"), so every reader stays `Number(input.value)`.
export const num = (attrs = {}) =>
  typed(
    { inputMode: "decimal", step: "any", min: "0", ...attrs },
    {
      read: (text) =>
        Number.isNaN(parseNum(text))
          ? ""
          : text.trim().replace(",", ".").replace("−", "-"),
      problem: numberProblem,
    },
  );

// A clock time typed as the Units setting reads it ("14:30" Metric, "2:30
// PM" US; "1430", "2pm", "14" either way), its `value` data ("14:30"): a
// `type="time"` input follows the browser's locale instead. Left valid, it
// reads back as shown.
export function timeField(attrs = {}) {
  const input = typed(
    { inputMode: "text", ...attrs },
    {
      read: (text) => parseClock(text) ?? "",
      show: clockOf,
      problem: (_, text) =>
        parseClock(text) === null
          ? `Enter a time like ${clockOf("14:30")}`
          : "",
    },
  );
  input.addEventListener("change", () => {
    const time = input.value;
    if (time) input.value = time;
  });
  return input;
}

// A whole-number energy input in this device's unit (kcal or kJ), for a
// stored kcal `value` and `max`; `energyOf` reads it back in kcal (null
// when empty), `setEnergy` sets it. Its label: `energyLabel()`.
export const energyNum = ({ value, max, ...attrs }) =>
  num({
    ...attrs,
    step: 1,
    value: isNil(value) ? "" : shownEnergy(value),
    max: shownEnergy(max),
  });
export const energyOf = (input) =>
  input.value === ""
    ? null
    : Math.round(nutrient("energy").store(Number(input.value)));
// Sets an energy input to stored `kcal` (null: empty), in its unit.
export const setEnergy = (input, kcal) => {
  input.value = isNil(kcal) ? "" : String(shownEnergy(kcal));
};
// "Energy (kJ)"; with `what`, "Energy (kJ, total)".
export const energyLabel = (what = null) =>
  `Energy (${[nutrient("energy").unit, what].filter(Boolean).join(", ")})`;

// A number input in this device's units (Metric or US) for a stored metric
// `value` in `unit`, its limits converted too (outward, so a stored value
// at a limit stays valid); `unitValue` reads it back in `unit`: the stored
// value itself while the input still shows it, so a save never drifts it.
const unitBefore = new WeakMap();
export function unitNum({ value, unit, min, max, ...attrs }) {
  const input = num({
    ...attrs,
    value: inputText(value, unit),
    ...(isNil(min)
      ? {}
      : { min: Math.floor(toShown(min, unit) * 1000) / 1000 }),
    ...(isNil(max) ? {} : { max: Math.ceil(toShown(max, unit) * 1000) / 1000 }),
  });
  unitBefore.set(input, [value, unit]);
  return input;
}
export const unitValue = (input) =>
  readInput(input.value, ...unitBefore.get(input));

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
      abbreviated(text),
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

// Each tone of a Highlight (ADR 0030): its label and icon, coloured by
// its `tone-*` class.
const TONES = {
  fact: ["Fact", "M12 2a10 10 0 1 0 0 20a10 10 0 0 0 0-20zM12 16v-5M12 8h.01"],
  correlation: ["Correlation", "M3 17l6-6 4 4 8-8M15 7h6v6"],
  tip: [
    "Tip",
    "M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z",
  ],
  warning: [
    "Warning",
    "M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01",
  ],
};

// A Highlight card (web/insights.mjs result): one row, its tone's icon,
// the headline and the numbers line; tapping it opens the detail and
// `actions(r)` (its link, Hide, …). The tone is named for a screen reader.
const card = (r, actions) => {
  const [label, d] = TONES[r.tone];
  return h(
    "li",
    { class: `tone-${r.tone}`, "data-id": r.id },
    h(
      "details",
      {},
      h(
        "summary",
        {},
        icon(d),
        h(
          "span",
          { class: "card-text" },
          h("span", { class: "sr-only" }, `${label}: `),
          h("b", { class: "headline" }, r.headline),
          h("span", { class: "numbers" }, abbreviated(r.numbers)),
        ),
      ),
      h(
        "div",
        { class: "card-detail" },
        h("p", {}, abbreviated(r.detail)),
        actions?.(r),
      ),
    ),
  );
};

// A Summary subtab's Highlights (web/insights.mjs results, ranked): one
// stack of cards, `shown` of them and the rest under "+N more"; nothing at
// all when there is none.
export const highlightList = (list, { shown = 3, actions = null } = {}) => {
  if (list.length === 0) return null;
  const cards = (part) =>
    h(
      "ul",
      { class: "highlights" },
      part.map((r) => card(r, actions)),
    );
  const rest = list.slice(shown);
  return h(
    "section",
    { class: "highlight-stack", "aria-label": "Highlights" },
    cards(list.slice(0, shown)),
    rest.length > 0
      ? h(
          "details",
          { class: "more" },
          h("summary", {}, `+${rest.length} more`),
          cards(rest),
        )
      : null,
  );
};

// -------------------------------------------------------------- titles

// A screen's title bar: back (only to an address inside the app), the
// title, an optional action on the right.
// A header's way to edit what is shown (`what`: "food", "exercise"): a
// pencil in the title's row.
export const editLink = (to, what) =>
  h(
    "a",
    {
      class: "button icon",
      href: to,
      "aria-label": `Edit ${what}`,
      title: `Edit ${what}`,
    },
    icon(PENCIL),
  );

export function titleBar(title, back, action = null) {
  const to = typeof back === "string" && back.startsWith("#/") ? back : null;
  return h(
    "header",
    { class: "title" },
    to
      ? h(
          "a",
          { class: "button icon", href: to, "aria-label": "Back" },
          icon(CHEVRON_L),
        )
      : null,
    h("h1", {}, title),
    action,
  );
}

// The words for each kind of period: the step ‹ › take, the switch's
// label and the popover's way back to now.
const PERIODS = {
  day: ["day", "Day", "Today"],
  week: ["week", "Week", "This week"],
  month: ["month", "Month", "This month"],
  year: ["year", "Year", "This year"],
};

// A screen's period header, one for every screen: ‹ [title ▾] ›. ‹ › (and
// a swipe) step to the period before or after; the title opens a popover
// anchored under it with a switch between `kinds` (only with more than
// one), a date to jump to and a way back to now. `hrefFor(kind, day)` is
// the address of the `kind` of period around `day`.
export function periodNav({ kind, day, kinds = [kind], hrefFor }) {
  const p = period(kind, day);
  const [step, , now] = PERIODS[kind];
  const arrow = (to, dir) =>
    h(
      "a",
      {
        class: "button icon",
        href: hrefFor(kind, to),
        "aria-label": `${dir === "prev" ? "Previous" : "Next"} ${step}`,
        "data-swipe": dir,
      },
      icon(dir === "prev" ? CHEVRON_L : CHEVRON_R),
    );
  const pick = h(
    "div",
    { id: "period-pick", class: "period-pick card", popover: "auto" },
    kinds.length > 1
      ? h(
          "nav",
          { class: "switch", "aria-label": "Period" },
          kinds.map((k) =>
            h(
              "a",
              {
                class: k === kind ? "button active" : "button",
                href: hrefFor(k, day),
                "aria-current": k === kind ? "page" : null,
              },
              PERIODS[k][1],
            ),
          ),
        )
      : null,
    h("input", {
      type: "date",
      value: day,
      "aria-label": "Go to day",
      onchange: (e) => e.target.value && nav.go(hrefFor(kind, e.target.value)),
    }),
    h("a", { class: "button", href: hrefFor(kind, today()) }, now),
  );
  return h(
    "header",
    { class: "day-nav" },
    arrow(p.prev, "prev"),
    h(
      "h1",
      {},
      h(
        "button",
        { type: "button", class: "period-title", popovertarget: "period-pick" },
        p.title,
      ),
    ),
    arrow(p.next, "next"),
    pick,
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

// -------------------------------------------------------------- editor

// Navigation as the editor needs it ({go, reload, guard(node, ask), signal}),
// handed over by nav.mjs (which builds on this module, so can't be imported
// here).
let nav = null;
export const useNavigator = (n) => {
  nav = n;
};

// Every editor (food, recipe, meal, exercise, workout, activity, profile,
// targets) works the same way:
// - one form, its fields in `body`;
// - one action bar: Delete, then `secondary` buttons, then Save (primary);
// - Save stays on the screen, toasts "Saved {name}" (and what a food's save
//   did to the diary, " · 14 diary entries updated") and re-reads the saved
//   thing (`after(saved)` may name another address, e.g. a new item's own);
// - a failed save says why at the bar, and focuses the field the server
//   named; a change made elsewhere meanwhile offers to reload;
// - Delete asks first (in an in-app dialog), then leaves for `remove.after`
//   and toasts `remove.done` (or `done(result of run)`, as `saved` may);
// - leaving with unsaved changes asks first (in the app and on reload);
//   `unsaved` opens it with some (a restored draft).
// `state()` adds what the form fields don't hold (lists built in code).
// Returns {node, form, dirty, markClean, failed} for the editor to use.
export function editor({
  title,
  back,
  body,
  save,
  saved = (x) => `Saved ${x.name}${entriesUpdated(x)}`,
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
                  const result = await remove.run();
                  clean = snapshot();
                  route.go(remove.after);
                  say(
                    typeof remove.done === "function"
                      ? remove.done(result)
                      : (remove.done ?? "Deleted"),
                  );
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
  // A toast: its text, or `{message, undo}` (Undo running `undo`, when
  // given).
  const say = (said) =>
    typeof said === "string"
      ? notify(said)
      : said.undo
        ? undoable(said.message, said.undo)
        : notify(said.message);
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
        // Undefined: the editor reported why it didn't save.
        if (result === undefined) return;
        clean = snapshot();
        const next = after?.(result);
        if (next && next !== location.hash) route.go(next);
        else route.reload();
        say(saved(result));
      } catch (err) {
        failed(err);
      }
    }),
  );

  route.guard(form, () => {
    if (!dirty()) return true;
    return confirmDialog(leaveAsk, {
      detail: "Your changes will be lost.",
      confirm: "Leave",
      cancel: "Stay",
    });
  });
  const unload = (e) => {
    if (form.isConnected && dirty()) e.preventDefault();
  };
  window.addEventListener("beforeunload", unload, { signal: route.signal });

  const node = h("section", {}, titleBar(title, back, action), form, aside);
  return { node, form, dirty, markClean, failed };
}

// -------------------------------------------------------------- picker

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
  empty: idle = () => [],
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
    fill(list, ...(q ? items.map((it) => row(it, pick)) : idle(pick)));
    if (q && items.length === 0) list.append(...none(q));
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
