// The Summary tab's shell: the section row (Food · Body · Training ·
// Habits), the period (‹ title ›, Week/Month/Year) and the subtab's own
// content: what every subtab shares loads once (web/series.mjs), the rest
// each subtab itself. Links inside keep the subtab; a tabless address
// opens the one last used on this device.

import { iso, parseDay, pretty, shift, today, weekStart } from "../dates.mjs";
import { tileThrough } from "../insights.mjs";
import { href } from "../nav.mjs";
import { sharedSeries } from "../series.mjs";
import { h } from "../ui.mjs";
import * as body from "./summary-body.mjs";
import * as food from "./summary-food.mjs";
import * as habits from "./summary-habits.mjs";
import * as training from "./summary-training.mjs";

const SUBTABS = [food, body, training, habits];

const TAB_KEY = "summary-tab";

export function period(kind, day) {
  const d = parseDay(day);
  if (kind === "year") {
    const y = d.getFullYear();
    return {
      from: `${y}-01-01`,
      to: `${y}-12-31`,
      prev: `${y - 1}-01-01`,
      next: `${y + 1}-01-01`,
      title: String(y),
    };
  }
  if (kind === "month") {
    const from = new Date(d.getFullYear(), d.getMonth(), 1);
    const to = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    return {
      from: iso(from),
      to: iso(to),
      prev: iso(prev),
      next: iso(next),
      title: d.toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      }),
    };
  }
  const from = weekStart(day);
  const to = shift(from, 6);
  return {
    from,
    to,
    prev: shift(from, -7),
    next: shift(from, 7),
    title: `${pretty(from, false)} – ${pretty(to, false)}`,
  };
}

// `tab` (else the last used here, else Food) for the period `kind` (a month
// unless named) around `day`: the shell around the subtab's content, once
// its data has loaded (a failed load goes to the router).
export async function summary(kind = "month", day = today(), tab = null) {
  const sub =
    SUBTABS.find((t) => t.KEY === (tab ?? localStorage.getItem(TAB_KEY))) ??
    food;
  localStorage.setItem(TAB_KEY, sub.KEY);
  const p = { tab: sub.KEY, kind, day, ...period(kind, day) };
  // The period before, for the Highlights' comparisons.
  const { from, to } = period(kind, p.prev);
  p.before = { from, to };
  // Today is still being logged: a running period's numbers end yesterday;
  // its calendars still show today.
  p.end = tileThrough(p.from, p.to, shift(today(), -1));
  // Shared data loads beside the subtab's own; a subtab may wait on it.
  const sharing = sharedSeries(p);
  const [data, shared] = await Promise.all([sub.load(p, sharing), sharing]);
  return h(
    "section",
    { class: "summary" },
    h(
      "nav",
      { class: "subtabs", "aria-label": "Section" },
      SUBTABS.map((t) =>
        h(
          "a",
          {
            href: href.summary(kind, day, t.KEY),
            "aria-current": t === sub ? "page" : null,
          },
          t.LABEL,
        ),
      ),
    ),
    h(
      "header",
      { class: "day-nav" },
      h(
        "a",
        {
          class: "button icon",
          href: href.summary(kind, p.prev, sub.KEY),
          "aria-label": "Previous period",
        },
        "‹",
      ),
      h("h1", {}, p.title),
      h(
        "a",
        {
          class: "button icon",
          href: href.summary(kind, p.next, sub.KEY),
          "aria-label": "Next period",
        },
        "›",
      ),
    ),
    h(
      "nav",
      { class: "switch", "aria-label": "Period" },
      ["week", "month", "year"].map((k) =>
        h(
          "a",
          {
            class: k === kind ? "button active" : "button",
            href: href.summary(k, day, sub.KEY),
            "aria-current": k === kind ? "page" : null,
          },
          k[0].toUpperCase() + k.slice(1),
        ),
      ),
    ),
    sub.render(p, data, shared),
  );
}
