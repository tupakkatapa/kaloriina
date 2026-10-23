// Kaloriina web UI: a hash-routed single page over the JSON API. No
// framework; Chart.js (vendored, loaded lazily) for the Summary. `h()`
// builds DOM nodes, so text is never parsed as HTML. Every screen is
// registered here with its tab, grouped by tab (`href` in nav.mjs follows the
// same grouping); the router lives in nav.mjs.

import { currentProfile } from "./api.mjs";
import { nextDayStart, today } from "./dates.mjs";
import { register, reloadIfStale, route } from "./nav.mjs";
import { diary, entryEditor } from "./screens/diary.mjs";
import { installPull } from "./pull.mjs";
import { refresh, refreshable } from "./refresh.mjs";
import { outboxScreen, startSync } from "./screens/outbox.mjs";
import { installSwipe } from "./swipe.mjs";
import { h, showError } from "./ui.mjs";

const DAY = "(\\d{4}-\\d{2}-\\d{2})";
const ID = "(\\d+)";
const NEW_OR_ID = "(new|\\d+)";
const GROUP = "([^/]+)";
const at = (pattern) => new RegExp(`^#${pattern}$`, "u");
const ROOT = /^#?\/?$/u;

// Every screen but the Diary loads on its first open: a cold
// start fetches only the Diary's modules, which the server's index lists
// as modulepreload. Once the Diary shows, the rest load in the background,
// so the service worker holds them for an offline open.
const SCREENS = {
  activity: () => import("./screens/activity.mjs"),
  activityEditor: () => import("./screens/activity-editor.mjs"),
  activityView: () => import("./screens/activity-view.mjs"),
  connections: () => import("./screens/connections.mjs"),
  feedback: () => import("./screens/feedback.mjs"),
  finder: () => import("./screens/finder.mjs"),
  foods: () => import("./screens/foods.mjs"),
  habits: () => import("./screens/habits.mjs"),
  merge: () => import("./screens/merge.mjs"),
  plan: () => import("./screens/plan.mjs"),
  profile: () => import("./screens/profile.mjs"),
  records: () => import("./screens/records.mjs"),
  run: () => import("./screens/run.mjs"),
  sources: () => import("./screens/sources.mjs"),
  stats: () => import("./screens/stats.mjs"),
  summary: () => import("./screens/summary.mjs"),
  targets: () => import("./screens/targets.mjs"),
  workoutEditor: () => import("./screens/workout-editor.mjs"),
  workoutView: () => import("./screens/workout-view.mjs"),
};
// The view `name` of screen module `mod`, loaded on demand.
const lazy =
  (mod, name) =>
  async (...args) =>
    (await SCREENS[mod]())[name](...args);

// The day the Diary at `#/` shows: today when it rendered.
let diaryDay = null;
// Set while the Diary moves on to a new day by itself (rollover): it asks
// nothing then.
let rolling = false;

register(
  // Diary
  {
    re: ROOT,
    tab: "diary",
    view: () => {
      diaryDay = today();
      return diary(diaryDay, new URLSearchParams(), !rolling);
    },
  },
  {
    re: at(`/day/${DAY}`),
    tab: "diary",
    view: (d, params) => diary(d, params),
  },
  {
    re: at(`/add/${DAY}/${GROUP}`),
    tab: "diary",
    view: (d, g) => lazy("finder", "add")(d, g),
  },
  {
    re: at(`/log/${DAY}/${GROUP}/${ID}`),
    tab: "diary",
    view: (d, g, id) => lazy("finder", "log")(d, g, id),
  },
  {
    re: at(`/log-meal/${DAY}/${GROUP}/${ID}`),
    tab: "diary",
    view: (d, g, id) => lazy("finder", "logMeal")(d, g, id),
  },
  {
    re: at(`/scan/${DAY}/${GROUP}`),
    tab: "diary",
    view: (d, g) => lazy("finder", "scan")(d, g),
  },
  // An entry by its key: its id, or a series' due day.
  {
    re: at(`/entry/(${ID}|daily-${ID}-${DAY})`),
    tab: "diary",
    view: (key) => entryEditor(key),
  },
  {
    re: at(`/activity/${ID}`),
    tab: "diary",
    view: (id, params) => lazy("activityView", "activityView")(id, params),
  },
  {
    re: at("/activity/new"),
    tab: "diary",
    view: (params) => lazy("activityEditor", "activityEditor")("new", params),
  },
  {
    re: at(`/activity/${ID}/edit`),
    tab: "diary",
    view: (id, params) => lazy("activityEditor", "activityEditor")(id, params),
  },
  {
    re: at(`/plan/${DAY}`),
    tab: "diary",
    view: (d, params) => lazy("plan", "planWorkout")(d, params),
  },
  // Offline: what waits to be sent.
  { re: at("/outbox"), tab: "diary", view: () => outboxScreen() },
  // Foods
  { re: at("/foods"), tab: "foods", view: () => lazy("foods", "foods")() },
  {
    re: at("/scan"),
    tab: "foods",
    view: () => lazy("finder", "scan")(today(), null),
  },
  // Log a food or meal from the Foods tab: today, no group yet.
  {
    re: at(`/log/${ID}`),
    tab: "foods",
    view: (id) => lazy("finder", "log")(today(), null, id),
  },
  {
    re: at(`/log-meal/${ID}`),
    tab: "foods",
    view: (id) => lazy("finder", "logMeal")(today(), null, id),
  },
  {
    re: at(`/food/${NEW_OR_ID}`),
    tab: "foods",
    view: (id, params) => lazy("foods", "foodEditor")(id, params),
  },
  {
    re: at(`/food/${ID}/merge`),
    tab: "foods",
    view: (id) => lazy("merge", "mergeFood")(id),
  },
  {
    re: at(`/recipe/${NEW_OR_ID}`),
    tab: "foods",
    view: (id, params) => lazy("foods", "recipeEditor")(id, params),
  },
  {
    re: at(`/meal/${NEW_OR_ID}`),
    tab: "foods",
    view: (id, params) => lazy("foods", "mealEditor")(id, params),
  },
  // Summary
  {
    re: at(
      `/summary(?:/(food|body|activity|habits))?(?:/(week|month|year))?(?:/${DAY})?`,
    ),
    tab: "summary",
    view: (t, k, d, params) => lazy("summary", "summary")(k, d, t, params),
  },
  // Where a nutrient came from.
  {
    re: at("/sources/([a-z0-9_]+)"),
    tab: "summary",
    view: (key, params) => lazy("sources", "sources")(key, params),
  },
  // Activity
  {
    re: at("/activity"),
    tab: "activity",
    view: () => lazy("activity", "activityTab")(),
  },
  {
    re: at("/activities"),
    tab: "activity",
    view: (params) => lazy("activityEditor", "activityHistory")(params),
  },
  {
    re: at("/exercises"),
    tab: "activity",
    view: (params) => lazy("activity", "exerciseList")(params),
  },
  {
    re: at("/records"),
    tab: "activity",
    view: () => lazy("records", "recordsScreen")(),
  },
  {
    re: at("/exercise/new"),
    tab: "activity",
    view: () => lazy("activity", "exerciseEditor")("new"),
  },
  {
    re: at(`/exercise/${ID}`),
    tab: "activity",
    view: (id) => lazy("activity", "exerciseView")(id),
  },
  {
    re: at(`/exercise/${ID}/edit`),
    tab: "activity",
    view: (id) => lazy("activity", "exerciseEditor")(id),
  },
  {
    re: at(`/workout/${ID}`),
    tab: "activity",
    view: (id, params) => lazy("workoutView", "workoutView")(id, params),
  },
  {
    re: at("/workout/new"),
    tab: "activity",
    view: (params) => lazy("workoutEditor", "workoutEditor")("new", params),
  },
  {
    re: at(`/workout/${ID}/edit`),
    tab: "activity",
    view: (id, params) => lazy("workoutEditor", "workoutEditor")(id, params),
  },
  {
    re: at(`/workout/${ID}/run`),
    tab: "activity",
    view: (id, params) => lazy("run", "workoutRun")(id, params),
  },
  // Profile
  {
    re: at("/profile"),
    tab: "profile",
    view: () => lazy("profile", "profileHub")(),
  },
  {
    re: at(`/profile/${NEW_OR_ID}`),
    tab: "profile",
    view: (id) => lazy("profile", "profileEditor")(id),
  },
  {
    re: at("/targets"),
    tab: "profile",
    view: () => lazy("targets", "targets")(),
  },
  {
    re: at("/habits"),
    tab: "profile",
    view: () => lazy("habits", "habitsScreen")(),
  },
  {
    re: at(`/habit/${NEW_OR_ID}`),
    tab: "profile",
    view: (id) => lazy("habits", "habitEditor")(id),
  },
  {
    re: at("/connections"),
    tab: "profile",
    view: () => lazy("connections", "connections")(),
  },
  { re: at("/stats"), tab: "profile", view: () => lazy("stats", "allTime")() },
  {
    re: at("/feedback"),
    tab: "profile",
    view: () => lazy("feedback", "feedbackScreen")(),
  },
);

// --------------------------------------------------------------- Start

// The first thing a keyboard reaches: past the tabs to the screen.
document.body.prepend(
  h(
    "button",
    {
      type: "button",
      class: "skip",
      onclick: () => document.querySelector("#app h1")?.focus(),
    },
    "Skip to content",
  ),
);

// The Profile tab names the current profile.
addEventListener("profiles", () => {
  document.querySelector("#profile-name").textContent = currentProfile().name;
});

window.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  showError(e.reason);
});

// The Diary at `#/` follows the date: left open past 03:00, or resumed
// the next morning, it shows (and logs to) the new today. A day opened by
// its address stays put.
function rollover() {
  const shown = ROOT.test(location.hash.split("?")[0]) && diaryDay;
  if (!shown || shown === today()) return;
  rolling = true;
  route().finally(() => {
    rolling = false;
  });
}
// Connections shows what other apps send (openScale sync's Test, a phone
// sync): coming back from them repaints it, unless a dialog is open.
const LIVE = /^#\/connections$/u;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  reloadIfStale();
  rollover();
  if (LIVE.test(location.hash) && !document.querySelector("dialog[open]"))
    route();
});
addEventListener("pageshow", rollover);
addEventListener("focus", rollover);
(function atDayStart() {
  setTimeout(
    () => {
      rollover();
      atDayStart();
    },
    nextDayStart() - Date.now() + 1000,
  );
})();

// Offline: what waits is sent and shown in the tabs.
startSync();
// Swipes between days, periods and Summary subtabs.
installSwipe();
// Pull down from the top to send, sync and re-read.
installPull(refresh, refreshable);
// The service worker is an extra: where it is blocked (tests, some
// browsers) the app works as before, online.
navigator.serviceWorker?.register("/sw.js").catch(() => null);
// Booted on this build (/v/<build>/main.mjs): its files are cached, so the
// worker may drop other builds' (sw.js prune()).
const build = /\/v\/([^/]+)\//u.exec(import.meta.url)?.[1];
if (build)
  navigator.serviceWorker?.ready.then((r) =>
    r.active?.postMessage({ booted: build }),
  );

// A day the worker answered from its cache while the network hung has
// landed since (sw.js `{fresh}`): the Diary still showing it re-reads it,
// unless a dialog is open.
navigator.serviceWorker?.addEventListener("message", (e) => {
  const fresh = /\/day\/(\d{4}-\d{2}-\d{2})$/u.exec(e.data?.fresh ?? "")?.[1];
  const hash = location.hash.split("?")[0];
  const shown = ROOT.test(hash) ? diaryDay : at(`/day/${DAY}`).exec(hash)?.[1];
  if (fresh && fresh === shown && !document.querySelector("dialog[open]"))
    route();
});

window.addEventListener("hashchange", route);
route().then(() =>
  setTimeout(() => {
    for (const load of Object.values(SCREENS)) load().catch(() => null);
  }, 1000),
);
