// The Summary tab's shell: the section row (Food · Body · Activity ·
// Habits), the period (‹ title ›, Week/Month/Year) and the subtab's own
// content: what every subtab shares loads once (web/series.mjs), the rest
// each subtab itself. A day's detail is the Diary's (a calendar day opens
// it). Links inside keep the subtab; a tabless address opens the one last
// used on this device.

import { period, today } from "../dates.mjs";
import { href, route } from "../nav.mjs";
import { sharedSeries } from "../series.mjs";
import { h, periodNav } from "../ui.mjs";
import * as activity from "./summary-activity.mjs";
import * as body from "./summary-body.mjs";
import * as food from "./summary-food.mjs";
import * as habits from "./summary-habits.mjs";

const SUBTABS = [food, body, activity, habits];

const TAB_KEY = "summary-tab";

// `tab` (else the last used here, else Food) for the period `kind` (a month
// unless named) around `day`: the shell around the subtab's content, once
// its data has loaded (a failed load goes to the router). `?metric=` opens
// Body on that chart metric (an insight's link).
export async function summary(
  kind = "month",
  day = today(),
  tab = null,
  params = new URLSearchParams(),
) {
  const key = tab ?? localStorage.getItem(TAB_KEY);
  const sub = SUBTABS.find((t) => t.KEY === key) ?? food;
  localStorage.setItem(TAB_KEY, sub.KEY);
  const p = {
    tab: sub.KEY,
    kind,
    day,
    metric: params.get("metric"),
    ...period(kind, day),
  };
  // The period before, for the Highlights' comparisons.
  const { from, to } = period(kind, p.prev);
  p.before = { from, to };
  const content = await subtabContent(p, sub).catch((err) => {
    // Without the server the Summary has nothing to show, and says so
    // under its own tabs; any other failure is the router's.
    if (err.code !== "offline") throw err;
    return offline(err);
  });
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
    periodNav({
      kind,
      day,
      kinds: ["week", "month", "year"],
      hrefFor: (k, d) => href.summary(k, d, sub.KEY),
    }),
    content,
  );
}

// A period's content: shared data loads beside the subtab's own; a subtab
// may wait on it.
async function subtabContent(p, sub) {
  const sharing = sharedSeries(p);
  const [data, shared] = await Promise.all([sub.load(p, sharing), sharing]);
  return sub.render(p, data, shared);
}

// The Summary without the server: what happened, and Retry.
const offline = (err) =>
  h(
    "div",
    { class: "summary-offline" },
    h("h2", {}, "You're offline"),
    h(
      "p",
      { class: "muted" },
      `${err.message} The Summary reads every number from the server.`,
    ),
    h(
      "button",
      { type: "button", class: "button", onclick: () => route() },
      "Retry",
    ),
  );
