// Kaloriina web UI: a hash-routed single page over the JSON API. No
// framework; Chart.js (vendored, loaded lazily) for the Summary. `h()`
// builds DOM nodes, so text is never parsed as HTML. Every screen is
// registered here with its tab, in tab order (`href` in nav.mjs follows the
// same order); the router lives in nav.mjs.

import { currentProfile } from "./api.mjs";
import { today } from "./dates.mjs";
import { register, route } from "./nav.mjs";
import { diary, entryEditor } from "./screens/diary.mjs";
import { add, log, logMeal, scan } from "./screens/finder.mjs";
import {
  foodEditor,
  foods,
  mealEditor,
  recipeEditor,
} from "./screens/foods.mjs";
import { connections } from "./screens/connections.mjs";
import { habitEditor, habitsScreen } from "./screens/habits.mjs";
import { mergeFood } from "./screens/merge.mjs";
import { outboxScreen, startSync } from "./screens/outbox.mjs";
import { profileEditor, profileHub, targets } from "./screens/profile.mjs";
import { planWorkout } from "./screens/plan.mjs";
import { workoutRun } from "./screens/run.mjs";
import { sessionEditor, sessionList } from "./screens/sessions.mjs";
import { sources } from "./screens/sources.mjs";
import { summary } from "./screens/summary.mjs";
import { workoutEditor } from "./screens/workout-editor.mjs";
import {
  exerciseEditor,
  exerciseList,
  exerciseView,
  workoutList,
} from "./screens/workouts.mjs";
import { h, showError } from "./ui.mjs";

const DAY = "(\\d{4}-\\d{2}-\\d{2})";
const ID = "(\\d+)";
const NEW_OR_ID = "(new|\\d+)";
const GROUP = "([^/]+)";
const at = (pattern) => new RegExp(`^#${pattern}$`);
const ROOT = /^#?\/?$/;

// The day the Diary at `#/` shows: today when it rendered.
let diaryDay = null;

register(
  // Diary
  {
    re: ROOT,
    tab: "diary",
    view: () => {
      diaryDay = today();
      return diary(diaryDay);
    },
  },
  {
    re: at(`/day/${DAY}`),
    tab: "diary",
    view: (d, params) => diary(d, params),
  },
  { re: at(`/add/${DAY}/${GROUP}`), tab: "diary", view: (d, g) => add(d, g) },
  {
    re: at(`/log/${DAY}/${GROUP}/${ID}`),
    tab: "diary",
    view: (d, g, id) => log(d, g, id),
  },
  {
    re: at(`/log-meal/${DAY}/${GROUP}/${ID}`),
    tab: "diary",
    view: (d, g, id) => logMeal(d, g, id),
  },
  { re: at(`/scan/${DAY}/${GROUP}`), tab: "diary", view: (d, g) => scan(d, g) },
  { re: at(`/entry/${ID}`), tab: "diary", view: (id) => entryEditor(id) },
  {
    re: at(`/session/${NEW_OR_ID}`),
    tab: "diary",
    view: (id, params) => sessionEditor(id, params),
  },
  {
    re: at(`/plan/${DAY}`),
    tab: "diary",
    view: (d, params) => planWorkout(d, params),
  },
  // Offline: what waits to be sent.
  { re: at("/outbox"), tab: "diary", view: () => outboxScreen() },
  // Foods
  { re: at("/foods"), tab: "foods", view: () => foods() },
  { re: at("/scan"), tab: "foods", view: () => scan(today(), null) },
  // Log a food or meal from the Foods tab: today, no group yet.
  { re: at(`/log/${ID}`), tab: "foods", view: (id) => log(today(), null, id) },
  {
    re: at(`/log-meal/${ID}`),
    tab: "foods",
    view: (id) => logMeal(today(), null, id),
  },
  {
    re: at(`/food/${NEW_OR_ID}`),
    tab: "foods",
    view: (id, params) => foodEditor(id, params),
  },
  { re: at(`/food/${ID}/merge`), tab: "foods", view: (id) => mergeFood(id) },
  {
    re: at(`/recipe/${NEW_OR_ID}`),
    tab: "foods",
    view: (id, params) => recipeEditor(id, params),
  },
  {
    re: at(`/meal/${NEW_OR_ID}`),
    tab: "foods",
    view: (id, params) => mealEditor(id, params),
  },
  // Summary
  {
    re: at(
      `/summary(?:/(food|body|training|habits))?(?:/(week|month|year))?(?:/${DAY})?`,
    ),
    tab: "summary",
    view: (t, k, d) => summary(k, d, t),
  },
  // Where a nutrient came from.
  {
    re: at("/sources/([a-z0-9_]+)"),
    tab: "summary",
    view: (key, params) => sources(key, params),
  },
  // Workouts
  { re: at("/workouts"), tab: "workouts", view: () => workoutList() },
  { re: at("/sessions"), tab: "workouts", view: () => sessionList() },
  { re: at("/exercises"), tab: "workouts", view: () => exerciseList() },
  {
    re: at("/exercise/new"),
    tab: "workouts",
    view: () => exerciseEditor("new"),
  },
  {
    re: at(`/exercise/${ID}`),
    tab: "workouts",
    view: (id) => exerciseView(id),
  },
  {
    re: at(`/exercise/${ID}/edit`),
    tab: "workouts",
    view: (id) => exerciseEditor(id),
  },
  {
    re: at(`/workout/${NEW_OR_ID}`),
    tab: "workouts",
    view: (id) => workoutEditor(id),
  },
  {
    re: at(`/workout/${ID}/run`),
    tab: "workouts",
    view: (id, params) => workoutRun(id, params),
  },
  // Profile
  { re: at("/profile"), tab: "profile", view: () => profileHub() },
  {
    re: at(`/profile/${NEW_OR_ID}`),
    tab: "profile",
    view: (id) => profileEditor(id),
  },
  { re: at("/targets"), tab: "profile", view: () => targets() },
  { re: at("/habits"), tab: "profile", view: () => habitsScreen() },
  {
    re: at(`/habit/${NEW_OR_ID}`),
    tab: "profile",
    view: (id) => habitEditor(id),
  },
  { re: at("/connections"), tab: "profile", view: () => connections() },
);

// ---------------------------------------------------------------- Start

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
  document.getElementById("profile-name").textContent = currentProfile().name;
});

window.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  showError(e.reason);
});

// The Diary at `#/` follows the date: left open past midnight, or resumed
// the next morning, it shows (and logs to) the new today. A day opened by
// its address stays put.
function rollover() {
  const shown = ROOT.test(location.hash.split("?")[0]) && diaryDay;
  if (shown && shown !== today()) route();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") rollover();
});
addEventListener("pageshow", rollover);
addEventListener("focus", rollover);
(function atMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  setTimeout(
    () => {
      rollover();
      atMidnight();
    },
    next - now + 1000,
  );
})();

// Offline: what waits is sent and shown in the tabs.
startSync();
// The service worker is an extra: where it is blocked (tests, some
// browsers) the app works as before, online.
navigator.serviceWorker?.register("/sw.js").catch(() => null);
// Booted on this build (/v/<build>/main.mjs): its files are cached, so the
// worker may drop other builds' (sw.js prune()).
const build = /\/v\/([^/]+)\//.exec(import.meta.url)?.[1];
if (build)
  navigator.serviceWorker?.ready.then((r) =>
    r.active?.postMessage({ booted: build }),
  );

window.addEventListener("hashchange", route);
route();
