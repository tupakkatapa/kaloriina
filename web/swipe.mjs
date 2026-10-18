// Swipes on a phone: one finger follows the view's ‹ › links (marked
// `data-swipe="prev"`/`"next"`), two fingers move between the Summary's
// subtabs. The listeners are passive and a gesture is read only when it
// ends, never `preventDefault`ed: scrolling, zoom and the system's back
// gesture stay the browser's. No DOM, so node tests load the rules.

import { mean } from "./stats.mjs";

// A start this close to either edge belongs to the system (back).
export const EDGE = 32;
// At least this far sideways, this much more sideways than down, this fast.
export const MIN_DX = 60;
const RATIO = 1.5;
export const MAX_MS = 600;
// Two fingers whose gap changes by this share are pinching, not swiping.
const PINCH = 0.15;

const gap = ([a, b]) => Math.hypot(b.x - a.x, b.y - a.y);

// A finished gesture: the view's `width`, the visual viewport's `scale`,
// the most fingers down at once, each finger's `start` and `end` and how
// long it took. Answers `{fingers, dir}` (`dir` 1 forward: a move to the
// left, -1 back) or null when it isn't a swipe.
export function classify({ width, scale, maxTouches, start, end, ms }) {
  const n = start.length;
  if (scale !== 1 || n > 2 || maxTouches !== n || end.length !== n) return null;
  if (ms > MAX_MS) return null;
  if (start.some((p) => p.x < EDGE || p.x > width - EDGE)) return null;
  if (n === 2 && Math.abs(gap(end) - gap(start)) >= PINCH * gap(start))
    return null;
  const dx = mean(end.map((p, i) => p.x - start[i].x));
  const dy = mean(end.map((p, i) => p.y - start[i].y));
  if (Math.abs(dx) < MIN_DX || Math.abs(dx) < RATIO * Math.abs(dy)) return null;
  return { fingers: n, dir: dx < 0 ? 1 : -1 };
}

// Where a touch is the control's own: fields, sliders, charts, anything
// that scrolls sideways, and what sits over the screen (dialogs, popovers,
// the tab bar, the toast). Pull to refresh (pull.mjs) leaves them too.
export function ignored(el) {
  for (let at = el; at instanceof Element; at = at.parentElement) {
    if (
      at.matches(
        "input, select, textarea, canvas, [contenteditable], dialog, [popover], .tabs, #toast",
      )
    )
      return true;
    const { overflowX } = getComputedStyle(at);
    if (/auto|scroll/u.test(overflowX) && at.scrollWidth > at.clientWidth)
      return true;
  }
  return false;
}

// What a swipe does: follow the ‹ or › link, or open the next subtab.
function act({ fingers, dir }) {
  if (fingers === 1) {
    document
      .querySelector(`[data-swipe="${dir > 0 ? "next" : "prev"}"]`)
      ?.click();
    return;
  }
  const tabs = [...document.querySelectorAll(".subtabs a")];
  const at = tabs.findIndex((a) => a.getAttribute("aria-current") === "page");
  if (at >= 0) tabs[at + dir]?.click();
}

const point = (t) => ({ x: t.clientX, y: t.clientY });

// Listen on `root` for the app's lifetime: the whole page by default, so
// the empty space below a short screen swipes too.
export function installSwipe(root = document) {
  let g = null;
  const opts = { passive: true };
  root.addEventListener(
    "touchstart",
    (e) => {
      g ??= { t0: e.timeStamp, start: new Map(), end: new Map(), max: 0 };
      if (ignored(e.target)) g.ignored = true;
      for (const t of e.changedTouches) {
        g.start.set(t.identifier, point(t));
        g.end.set(t.identifier, point(t));
      }
      g.max = Math.max(g.max, e.touches.length);
    },
    opts,
  );
  const moved = (e) => {
    for (const t of e.changedTouches)
      if (g?.end.has(t.identifier)) g.end.set(t.identifier, point(t));
  };
  root.addEventListener("touchmove", moved, opts);
  root.addEventListener(
    "touchend",
    (e) => {
      if (!g) return;
      moved(e);
      if (e.touches.length > 0) return;
      const done = g;
      g = null;
      if (done.ignored) return;
      const ids = [...done.start.keys()];
      const swipe = classify({
        width: document.documentElement.clientWidth,
        scale: globalThis.visualViewport?.scale ?? 1,
        maxTouches: done.max,
        start: ids.map((id) => done.start.get(id)),
        end: ids.map((id) => done.end.get(id)),
        ms: e.timeStamp - done.t0,
      });
      if (swipe) act(swipe);
    },
    opts,
  );
  root.addEventListener(
    "touchcancel",
    () => {
      g = null;
    },
    opts,
  );
}
