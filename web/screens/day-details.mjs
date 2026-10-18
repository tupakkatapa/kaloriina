// The Diary's Sleep card: the night that ended the day, at a glance, from
// the Day view (`/day/{day}`): no fetch of its own. Static: the night's
// facts are Summary → Body's.

import { clockAt, clockOf, duration } from "../dates.mjs";
import { hypnogram, nightText, SLEEP_STAGES, STAGES } from "../device.mjs";
import { isNil } from "../format.mjs";
import { tipFor } from "../tips.mjs";
import { fill, h } from "../ui.mjs";

// A night's stage minutes without their spans (an older app synced them
// so): each stage's share of the stages as one bar, its minutes a stage a
// line in its tip (tips.mjs). `stages` the SLEEP_STAGES it has,
// `minutes(key)` theirs.
function stageShares(stages, minutes) {
  const all = stages.reduce((t, { key }) => t + minutes(key), 0);
  const bar = h(
    "div",
    {
      class: "stage-shares",
      role: "img",
      tabIndex: 0,
      "aria-label": `Sleep stages: ${stages.map(({ key, word }) => `${word} ${duration(minutes(key))}`).join(", ")}.`,
    },
    stages.map(({ key }) =>
      h("span", {
        class: `stage-share stage-${key}`,
        style: { width: `${(minutes(key) / all) * 100}%` },
      }),
    ),
  );
  return h(
    "div",
    { class: "tip-host" },
    bar,
    tipFor(
      bar,
      stages.map(({ key, label }) =>
        h("span", {}, `${label} ${duration(minutes(key))}`),
      ),
    ),
  );
}

// The night as a hypnogram: each stage on a lane of its own (awake on top,
// deep at the bottom) drawn as the nutrition bars are, a thin step line
// joining the spans where they meet. Hover, hold (touch) or ←/→ (keys) say
// the stage there in a tooltip: its span, how long, and the time under the
// pointer. A sideways hold scrubs; an upward swipe still scrolls.
const SVG = "http://www.w3.org/2000/svg";
const svg = (tag, attrs, ...kids) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids.flat());
  return el;
};
const LEVEL = Object.fromEntries(STAGES.map(({ key }, i) => [key, i]));
const WORD = Object.fromEntries(STAGES.map((st) => [st.key, st.label]));
// A lane's middle, in % of the hypnogram's height.
const laneMid = (i) => ((i + 0.5) / STAGES.length) * 100;
const laneTop = (i) => `calc(${laneMid(i)}% - 0.25rem)`;
// A share as a CSS length along the bar.
const cssPct = (share) => `${share * 100}%`;
// A touch held this long (ms), or moved this far sideways (px), scrubs.
const HOLD_MS = 350;
const SLOP_PX = 8;

function nightLine(night) {
  const spans = night.spans.filter((x) => x.stage in LEVEL);
  const from = Date.parse(night.start);
  const length = Date.parse(night.end) - from;
  let path = "";
  let reached = null;
  for (const x of spans) {
    const x0 = x.left * 100;
    const y = laneMid(LEVEL[x.stage]);
    path += `${reached !== null && Math.abs(reached - x0) < 0.2 ? "L" : "M"}${x0} ${y}L${x0 + x.width * 100} ${y}`;
    reached = x0 + x.width * 100;
  }
  const guide = h("div", { class: "night-guide", hidden: true });
  const tip = h("div", { class: "night-tip", "aria-live": "polite" });
  const line = h(
    "div",
    {
      class: "night-line",
      role: "img",
      tabIndex: 0,
      "aria-label": `Sleep stages from ${clockAt(night.start)} to ${clockAt(night.end)}: ${STAGES.map((st) => `${st.word} ${duration(night.minutes[st.key])}`).join(", ")}.`,
    },
    STAGES.map((_, i) =>
      h("div", { class: "night-lane", style: { top: laneTop(i) } }),
    ),
    svg(
      "svg",
      { viewBox: "0 0 100 100", preserveAspectRatio: "none" },
      svg("path", { class: "night-path", d: path }),
    ),
    spans.map((x) =>
      h("div", {
        class: `night-span stage-${x.stage}`,
        style: {
          top: laneTop(LEVEL[x.stage]),
          left: cssPct(x.left),
          width: cssPct(x.width),
        },
      }),
    ),
    guide,
  );

  // The guide at `share` (0–1) of the night, the tooltip over it saying
  // `span` (none: a gap without data) and, from a pointer, the time there.
  const show = (share, span, pointer) => {
    guide.hidden = false;
    guide.style.left = cssPct(share);
    fill(
      tip,
      h("strong", {}, span ? WORD[span.stage] : "No data"),
      span
        ? h(
            "span",
            {},
            `${clockAt(span.start_at)}–${clockAt(span.end_at)} · ${duration(Math.round((Date.parse(span.end_at) - Date.parse(span.start_at)) / 60_000))}`,
          )
        : null,
      pointer
        ? h("span", { class: "muted" }, clockAt(from + share * length))
        : null,
    );
    // Over the guide, kept inside the card.
    const half = tip.offsetWidth / 2;
    const width = line.clientWidth;
    tip.style.left = `${Math.min(Math.max(share * width, half), width - half)}px`;
  };
  const hide = () => {
    guide.hidden = true;
    fill(tip);
  };
  const at = (e) => {
    const box = line.getBoundingClientRect();
    const share = Math.min(Math.max((e.clientX - box.left) / box.width, 0), 1);
    show(
      share,
      spans.findLast((x) => x.left <= share && share <= x.left + x.width),
      true,
    );
  };

  // A mouse shows on hover; a touch or pen once held, or moved sideways.
  let press = null;
  let scrubbing = null;
  const scrub = (e) => {
    clearTimeout(press?.timer);
    press = null;
    scrubbing = e.pointerId;
    line.setPointerCapture(e.pointerId);
    at(e);
  };
  const release = () => {
    clearTimeout(press?.timer);
    press = null;
    scrubbing = null;
    hide();
  };
  line.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    press = { e, timer: setTimeout(() => scrub(press.e), HOLD_MS) };
  });
  line.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse" || scrubbing === e.pointerId) return at(e);
    if (press?.e.pointerId !== e.pointerId) return;
    const dx = Math.abs(e.clientX - press.e.clientX);
    const dy = Math.abs(e.clientY - press.e.clientY);
    if (dx > SLOP_PX && dx > dy) scrub(e);
    else if (dy > SLOP_PX) release();
    else press.e = e;
  });
  line.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse") hide();
  });
  for (const type of ["pointerup", "pointercancel"])
    line.addEventListener(type, (e) => {
      if (e.pointerType !== "mouse") release();
    });

  // ←/→ step span by span; Escape, or leaving, hides.
  let index = -1;
  line.addEventListener("keydown", (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (e.key === "Escape") hide();
    if (!step || spans.length === 0) return;
    e.preventDefault();
    index =
      index < 0 && step < 0
        ? spans.length - 1
        : Math.min(Math.max(index + step, 0), spans.length - 1);
    const x = spans[index];
    show(x.left + x.width / 2, x, false);
  });
  line.addEventListener("blur", hide);
  return h("div", { class: "night" }, line, tip);
}

// The Diary's Sleep card (`data`, the Day view): the night's time asleep
// right of its heading (a day of naps only, theirs); the night as a stepped
// line, or the stage shares an older app synced, with bedtime and wake-up
// under its ends. `napRows`, the day's naps, follow. The device's minutes
// win over the spans'. Null without sleep.
export function sleepCard(data, napRows = []) {
  const a = data.device_day ?? {};
  if (!nightText(a)) return null;
  const night = hypnogram(data.stages ?? []);
  const total = a.asleep_min ?? a.total_asleep_min;
  const minutes = (key) => a[`${key}_min`] ?? night?.minutes[key];
  const staged = SLEEP_STAGES.filter(({ key }) => minutes(key) > 0);
  const [from, to] = night
    ? [clockAt(night.start), clockAt(night.end)]
    : a.bedtime && a.wake_time
      ? [clockOf(a.bedtime), clockOf(a.wake_time)]
      : [];
  return h(
    "section",
    { class: "group sleep-card" },
    h(
      "header",
      {},
      h("h2", {}, "Sleep"),
      h(
        "span",
        { class: "sleep-total" },
        isNil(total)
          ? `${duration(a.nap_in_bed_min)} nap in bed`
          : duration(total),
      ),
    ),
    night
      ? nightLine(night)
      : staged.length > 0
        ? stageShares(staged, minutes)
        : null,
    from
      ? h(
          "div",
          { class: "night-ends muted" },
          h("span", {}, from),
          h("span", {}, to),
        )
      : null,
    night || staged.length === 0
      ? null
      : h(
          "p",
          { class: "muted" },
          "No stage timeline for this night: “Resync a year” in the Android app fills it in.",
        ),
    napRows.length > 0 ? h("ul", { class: "log-rows" }, napRows) : null,
  );
}
