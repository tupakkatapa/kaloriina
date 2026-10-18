// A Summary subtab's Highlights stack (ADR 0030, scannable cards): the
// ranked cards of web/insights.mjs less those hidden, each opening where
// it points (a nutrient's sources, a Body chart's metric, exercises for a
// muscle, the activities, a pair's chart), with "Hide for 2 weeks"; and
// the discovery tier (web/correlate.mjs `discover`), worked out after the
// first paint, once per period, at most DISCOVERED_SHOWN across Summary
// beyond those marked "Interesting".

import { api, get, meta, profileId, scoped } from "../api.mjs";
import { discover, touching } from "../correlate.mjs";
import { coverage } from "../coverage.mjs";
import { pretty, shift, today } from "../dates.mjs";
import { allHabits, habitAmountText, habitSeries } from "../habits.mjs";
import {
  changeADay,
  highlights,
  keptPatterns,
  notHidden,
  seriesOf,
} from "../insights.mjs";
import { href } from "../nav.mjs";
import { fmtUnit, foodDay, KNOWN, nutrient } from "../nutrients.mjs";
import { trend } from "../series.mjs";
import { source } from "../series-keys.mjs";
import {
  busy,
  CHECK,
  errorBox,
  fill,
  h,
  highlightList,
  icon,
  undoable,
} from "../ui.mjs";
import { pairChart } from "./summary-charts.mjs";

// How long "Hide" hides a card: the last day hidden is this many days on.
const HIDE_DAYS = 13;

// --------------------------------------------------------- preferences

const shown = (r, prefs) => notHidden(r, prefs, today());
const kept = (list, prefs) => keptPatterns(list, prefs, today());

const prefPath = (id) => scoped(`/insights/prefs/${encodeURIComponent(id)}`);

// Set (`pref` {state, until?}) or clear (null) an insight's preference.
const setPref = async (prefs, id, pref) => {
  if (pref) {
    await api("PUT", prefPath(id), pref);
    prefs.set(id, pref);
  } else {
    await api("DELETE", prefPath(id));
    prefs.delete(id);
  }
};

// ----------------------------------------------------------- discovery

// Every daily series over the shared window for `discover`: the trailing
// ones (sleep, steps, heart, check-ins, energy, alcohol, caffeine, energy
// burned, activity minutes) plus each nutrient on the days ≥ KNOWN of the
// energy carried it, sleep stages, the weight trend's change a day and
// every habit.
async function discoverySeries(shared) {
  const { from, to } = shared.window;
  const [days, deviceDays, activities, weights, list, habitDays] =
    await Promise.all([
      shared.rows("days", from, to),
      shared.rows("deviceDays", from, to),
      shared.rows("activities", from, to),
      shared.rows("weights", shift(from, -7), to),
      get(scoped("/habits")),
      shared.rows("habits", from, to),
    ]);
  // The trailing series, less its activities (no series).
  const series = Object.fromEntries(
    Object.entries(shared.trailing).filter(([k]) => k !== "activities"),
  );
  const eaten = days.filter((x) => foodDay(x));
  const keys = new Set(eaten.flatMap((d) => Object.keys(d.total)));
  for (const key of ["energy", "alcohol", "caffeine"]) keys.delete(key);
  for (const key of keys) {
    const n = nutrient(key);
    if (!n) continue;
    series[`n:${key}`] = {
      ...seriesOf(
        eaten.filter((d) => coverage([d], key) >= KNOWN),
        (d) => d.total[key] ?? 0,
      ),
      label: n.label,
      say: (v) => fmtUnit(key, v),
      domain: ["food"],
      groups: ["food"],
    };
  }
  for (const key of ["deep_min", "rem_min", "light_min"])
    series[key] = seriesOf(source(key, deviceDays), "value");
  const trended = weights.length > 0 ? trend(weights) : [];
  series.weight_trend = seriesOf(
    changeADay(trended, "kg").filter((t) => t.day >= from),
    "kg",
  );
  const habits = allHabits(
    meta.habits,
    Object.values(shared.targets),
    list,
    activities,
  );
  const byId = new Map(habits.map((x) => [`habit:${x.id}`, x]));
  for (const [key, s] of Object.entries(habitSeries(habits, habitDays))) {
    const habit = byId.get(key);
    series[key] = {
      ...s,
      say: (v) => habitAmountText(habit, v),
      domain: ["habits"],
      // A built-in is read from food (alcohol, caffeine, water).
      groups: habit.builtin ? ["food"] : [key],
    };
  }
  return series;
}

// The discovered patterns of a window, once per profile and window
// (`found` while working, `ready` once done): off the first paint, when
// the browser is idle. A failed look is kept by neither, so the next one
// looks again; any write clears both, as the data moved.
const found = new Map();
const ready = new Map();
globalThis.addEventListener?.("written", () => {
  found.clear();
  ready.clear();
});
const windowKey = (shared) => `${profileId}:${shared.window.to}`;
const idle = (fn) =>
  new Promise((resolve) => {
    (window.requestIdleCallback ?? ((f) => setTimeout(f, 50)))(() =>
      resolve(fn()),
    );
  });
function discovered(shared) {
  const key = windowKey(shared);
  if (!found.has(key))
    found.set(
      key,
      discoverySeries(shared)
        .then((series) => idle(() => discover(series, shared.window.to)))
        .then(
          (list) => {
            ready.set(key, list);
            return list;
          },
          (err) => {
            found.delete(key);
            throw err;
          },
        ),
    );
  return found.get(key);
}

// ----------------------------------------------------------- the stack

const linkTo = (to, text) => h("a", { class: "button", href: to }, text);

// Where a card's link leads, from the period `p` shown.
function linkOf(r, p) {
  const l = r.link;
  if (!l) return null;
  const back = href.summary(p.kind, p.day, p.tab);
  switch (l.to) {
    case "sources":
      // The days the card counted: through yesterday in a running period
      // (as the averages' links).
      return linkTo(
        href.sources(l.key, p.from, p.through, back),
        "Where it came from",
      );
    case "metric":
      return linkTo(
        href.summary(p.kind, p.day, "body", { metric: l.metric }),
        "Show on the chart",
      );
    case "exercises":
      return linkTo(href.exercises({ q: l.q }), `Exercises for ${l.q}`);
    case "activities":
      return linkTo(href.activities(), "See activities");
    case "chart": {
      const button = h(
        "button",
        {
          type: "button",
          class: "button",
          onclick: busy(() => pairChart(l, button)),
        },
        "Show chart",
      );
      return button;
    }
    default:
      return null;
  }
}

// The stack for subtab `tab` over insights context `ctx` (web/insights.mjs
// `highlights`) in period `p` with the subtab's `shared` data: a slot,
// repainted by `slot.paint(omit)` (ids left out: Food's picked metric).
export function highlightStack(tab, ctx, p, shared) {
  const slot = h("div", { class: "insights" });
  let omit = [];
  let patterns = [];
  // Why the discovery tier failed, with Retry; null once it looked.
  let failure = null;
  const prefs = shared.prefs;
  const paint = () => {
    const list = highlights(
      tab,
      { ...ctx, discovered: touching(kept(patterns, prefs), tab) },
      { omit },
    ).filter((r) => shown(r, prefs));
    const node = highlightList(list, { actions });
    fill(slot, node, failure);
    slot.hidden = !node && !failure;
  };
  const hide = async (r) => {
    const until = shift(today(), HIDE_DAYS);
    // Hiding a pinned pattern unpins it; undo puts the pin back.
    const before = prefs.get(r.id) ?? null;
    await setPref(prefs, r.id, { state: "hidden", until });
    paint();
    undoable(`Hidden until ${pretty(until)}`, async () => {
      await setPref(prefs, r.id, before);
      paint();
    });
  };
  const actions = (r) =>
    h(
      "div",
      { class: "card-actions" },
      linkOf(r, p),
      r.discovered
        ? h(
            "button",
            {
              type: "button",
              class: "button",
              "aria-pressed": String(Boolean(r.pinned)),
              onclick: busy(async () => {
                await setPref(
                  prefs,
                  r.id,
                  r.pinned ? null : { state: "pinned" },
                );
                paint();
              }),
            },
            "Interesting",
            r.pinned ? icon(CHECK) : null,
          )
        : null,
      h(
        "button",
        { type: "button", class: "button", onclick: busy(() => hide(r)) },
        "Hide for 2 weeks",
      ),
    );
  slot.paint = (ids) => {
    omit = ids;
    paint();
  };
  const look = () =>
    discovered(shared).then(
      (list) => {
        const was = failure;
        failure = null;
        patterns = list;
        if (was || touching(kept(list, prefs), tab).length > 0) paint();
      },
      (err) => {
        failure = h(
          "div",
          { class: "discovery-failed" },
          errorBox({ message: `Patterns weren't looked for. ${err.message}` }),
          h(
            "button",
            { type: "button", class: "button", onclick: busy(look) },
            "Retry",
          ),
        );
        paint();
      },
    );
  const key = windowKey(shared);
  if (ready.has(key)) patterns = ready.get(key);
  else look();
  paint();
  return slot;
}
