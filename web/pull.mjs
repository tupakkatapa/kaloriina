// Pull to refresh on a phone: from the very top of a screen, one finger
// drawn down pulls a spinner after it, with resistance; let go past
// THRESHOLD and `run` refreshes. Passive listeners, never
// `preventDefault`ed, as swipe.mjs: scrolling stays the browser's (and
// `overscroll-behavior-y` in style.css keeps Chrome's own pull, a reload,
// out of it). The rules have no DOM, so node tests load them.

import { ignored } from "./swipe.mjs";

// How far the spinner travels (px) for a release to refresh, and the most
// it ever travels.
export const THRESHOLD = 72;
export const MAX = 112;
// Moved this far, a drag's direction is known: a pull when down and this
// much more down than sideways.
const SLOP = 10;
const RATIO = 1.5;

// A drag may pull from the page's top (iOS bounces above it), with one
// finger, on a phone, off the controls that own their touches.
export const mayStart = ({ top, touches, desktop, ignored: own }) =>
  top <= 0 && touches === 1 && !desktop && !own;

// A drag of (dx, dy) so far: null until it's moved SLOP, then "pull" or
// "other" (a swipe, a scroll), which it stays.
export function heading(dx, dy) {
  if (Math.hypot(dx, dy) < SLOP) return null;
  return dy > 0 && dy >= RATIO * Math.abs(dx) ? "pull" : "other";
}

// The rubber band: the spinner follows the finger by half up to
// THRESHOLD, then ever more stiffly toward MAX, which it never reaches.
export function stretch(dy) {
  const half = Math.max(dy, 0) / 2;
  if (half <= THRESHOLD) return half;
  const room = MAX - THRESHOLD;
  return THRESHOLD + room * (1 - Math.exp(-(half - THRESHOLD) / room));
}

export const releases = (pull) => pull >= THRESHOLD;

// Listen on the page for the app's lifetime; `allowed()` says whether the
// screen shown may refresh now, `run()` refreshes it. The spinner
// (`#pull`, CSS) travels `--pull` px: `pulling` follows the finger,
// `refreshing` spins until `run` ends.
export function installPull(run, allowed) {
  const spinner = document.createElement("div");
  spinner.id = "pull";
  spinner.setAttribute("aria-hidden", "true");
  document.body.append(spinner);
  const show = (px) => spinner.style.setProperty("--pull", String(px));
  let drag = null;
  let refreshing = false;
  const end = () => {
    drag = null;
    spinner.classList.remove("pulling");
    if (!refreshing) show(0);
  };
  const opts = { passive: true };
  document.addEventListener(
    "touchstart",
    (e) => {
      // A second finger: a pinch or a two-finger swipe, not a pull.
      if (drag) {
        end();
        return;
      }
      const can = mayStart({
        top: scrollY,
        touches: e.touches.length,
        desktop: document.documentElement.classList.contains("desktop"),
        ignored: ignored(e.target),
      });
      if (refreshing || !can || !allowed()) return;
      const [t] = e.touches;
      drag = { x: t.clientX, y: t.clientY, heading: null, pull: 0 };
    },
    opts,
  );
  document.addEventListener(
    "touchmove",
    (e) => {
      if (!drag) return;
      const [t] = e.touches;
      const dy = t.clientY - drag.y;
      drag.heading ??= heading(t.clientX - drag.x, dy);
      if (drag.heading === "other") end();
      if (drag?.heading !== "pull") return;
      drag.pull = stretch(dy);
      spinner.classList.add("pulling");
      show(drag.pull);
    },
    opts,
  );
  document.addEventListener(
    "touchend",
    async (e) => {
      if (!drag || e.touches.length > 0) return;
      const go = releases(drag.pull);
      refreshing = go;
      end();
      if (!go) return;
      spinner.classList.add("refreshing");
      show(THRESHOLD);
      try {
        await run();
      } finally {
        refreshing = false;
        spinner.classList.remove("refreshing");
        show(0);
      }
    },
    opts,
  );
  document.addEventListener("touchcancel", end, opts);
}
