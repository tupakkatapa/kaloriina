// The app's one tooltip: a stat tile's long text, a nutrient bar's
// amounts, a chart's numbers. A `popover="manual"` in the top layer (never
// clipped by a card, a carousel or a transform), placed above what it is
// about and clear of a finger (a thumb covers what is under the touch),
// below only without room, inside the window. Its look is style.css `.tip`.
// (The hypnogram's `.night-tip` is its own: a readout that follows the
// pointer along the night, not a control's description.)

import { h } from "./ui.mjs";

// px kept between a tip and the window's edges, and between a tip and the
// finger that asked for it.
const EDGE = 8;
export const FINGER = 16;

// A finger, not a mouse, points.
export const coarse = () => matchMedia("(pointer: coarse)").matches;

// Show `tip` (a `.tip` popover) about `rect` (a DOMRect-like box, window
// px): above it, `gap` px clear, else below; its left edge at `rect`'s
// (`center`: centred on it), moved in to fit the window. Shown before
// measured, so its size is real.
export function placeTip(tip, rect, { gap = 0, center = false } = {}) {
  if (!tip.matches(":popover-open")) tip.showPopover();
  const { width, height } = tip.getBoundingClientRect();
  const above = rect.top - gap - height;
  const top =
    above >= EDGE ? above : Math.min(rect.bottom + gap, innerHeight - height);
  const start = center ? rect.left + rect.width / 2 - width / 2 : rect.left;
  const left = Math.min(
    Math.max(start, EDGE),
    Math.max(EDGE, innerWidth - width - EDGE),
  );
  Object.assign(tip.style, { top: `${top}px`, left: `${left}px` });
}

export const hideTip = (tip) => {
  if (tip.matches(":popover-open")) tip.hidePopover();
};

// Tip ids, unique in the document across re-renders.
let count = 0;

// The tip host an event is about (`.tip-host`: a trigger and its tip),
// or null.
const hostOf = (target) => target.closest?.(".tip-host") ?? null;
const tipOf = (host) => host.querySelector(":scope > .tip");
const triggerOf = (host) => host.querySelector(":scope > .tip-trigger");

// A host's tip shown (pinned by a tap or click: `data-open`; or while
// hovered or focused: `data-hover`) or hidden; Esc's `data-dismissed`
// keeps it hidden until the pointer or focus leaves.
function sync(host) {
  const tip = tipOf(host);
  if (!tip) return;
  const d = host.dataset;
  if (("open" in d || "hover" in d) && !("dismissed" in d))
    placeTip(tip, triggerOf(host).getBoundingClientRect());
  else hideTip(tip);
}

const shownHosts = () =>
  document.querySelectorAll(".tip-host[data-open], .tip-host[data-hover]");

// Every pinned tip but `except`'s closed.
function closeOthers(except = null) {
  for (const host of document.querySelectorAll(".tip-host[data-open]"))
    if (host !== except) {
      delete host.dataset.open;
      sync(host);
    }
}

// A tap or click on a trigger pins its tip or unpins it, closing any
// other; a press elsewhere closes them.
function onClick(e) {
  const host = hostOf(e.target);
  if (!host || !e.target.closest(".tip-trigger")) return;
  closeOthers(host);
  if ("open" in host.dataset) delete host.dataset.open;
  else host.dataset.open = "";
  delete host.dataset.dismissed;
  sync(host);
}
const onPress = (e) => closeOthers(hostOf(e.target));

// A mouse over a host or keyboard focus in it shows its tip, one at a
// time.
function onEnter(e) {
  const host = hostOf(e.target);
  if (!host || "hover" in host.dataset) return;
  if (e.type === "pointerover" && e.pointerType !== "mouse") return;
  if (e.type === "focusin" && !e.target.matches(":focus-visible")) return;
  closeOthers(host);
  host.dataset.hover = "";
  sync(host);
}
function onLeave(e) {
  const host = hostOf(e.target);
  if (!host || host.contains(e.relatedTarget)) return;
  delete host.dataset.hover;
  delete host.dataset.dismissed;
  sync(host);
}

// Esc hides every tip shown, hovered or pinned.
function onKey(e) {
  if (e.key !== "Escape") return;
  for (const host of shownHosts()) {
    delete host.dataset.open;
    if ("hover" in host.dataset) host.dataset.dismissed = "";
    sync(host);
  }
}

// A scroll or resize moves what a tip is about: it follows.
function onMove() {
  for (const host of shownHosts()) sync(host);
}

// The listeners above, once for every tip there will be.
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  document.addEventListener("click", onClick);
  document.addEventListener("pointerdown", onPress);
  document.addEventListener("pointerover", onEnter);
  document.addEventListener("focusin", onEnter);
  document.addEventListener("pointerout", onLeave);
  document.addEventListener("focusout", onLeave);
  document.addEventListener("keydown", onKey);
  addEventListener("scroll", onMove, { capture: true, passive: true });
  addEventListener("resize", onMove);
}

// `trigger` and its tip, to go inside a `.tip-host` (tipFor).
export const withTip = (trigger, text) => [trigger, tipFor(trigger, text)];

// `trigger` described by `text` (a string or nodes): the trigger gets the
// tip's id as its aria-describedby; returns the tip, to go right after the
// trigger inside a `.tip-host`.
export function tipFor(trigger, text) {
  listen();
  const id = `tip-${++count}`;
  trigger.classList.add("tip-trigger");
  trigger.setAttribute("aria-describedby", id);
  return h(
    "span",
    { class: "tip", id, role: "tooltip", popover: "manual" },
    text,
  );
}
