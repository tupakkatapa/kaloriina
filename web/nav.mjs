// Navigation: every address in the app (`href`), the routes screens register
// (from main.mjs) with the tab each belongs to, and the router.

import { setActivityTypes } from "./activities.mjs";
import {
  loadMeta,
  loadProfiles,
  meta,
  prefetch,
  profileId,
  profiles,
  scoped,
  stale,
} from "./api.mjs";
import { today } from "./dates.mjs";
import { setRegistry } from "./nutrients.mjs";
import {
  errorBox,
  fill,
  h,
  notFound,
  notify,
  screenChanged,
  screenLoading,
  screenShown,
  titleBar,
  useNavigator,
} from "./ui.mjs";

export const app = document.querySelector("#app");

// Open `hash`; already there, the screen re-renders (resolves once it has).
export function go(hash) {
  if (location.hash === hash) return route();
  location.hash = hash;
  return Promise.resolve();
}

const q = (params) => {
  const s = new URLSearchParams(
    Object.entries(params).filter(
      ([, v]) => v !== null && v !== undefined && v !== "",
    ),
  ).toString();
  return s ? `?${s}` : "";
};
const g = encodeURIComponent;

// Every address, built in one place, in main.mjs's tab order (its routes
// match them). One grammar: `#/<things>` a list, `#/<thing>/:id` the item's
// view or editor, a verb (`log`, `plan`) what it does.
export const href = {
  // Diary
  today: () => "#/",
  day: (day) => `#/day/${day}`,
  // A day with a group in select mode, the entry ticked (Log again).
  select: (day, id) => `#/day/${day}${q({ select: id })}`,
  add: (day, group) => `#/add/${day}/${g(group)}`,
  // Log a food: into a group (from the diary), or from the Foods tab
  // (today, no group yet).
  log: (day, group, id) =>
    group ? `#/log/${day}/${g(group)}/${id}` : `#/log/${id}`,
  logMeal: (day, group, id) =>
    group ? `#/log-meal/${day}/${g(group)}/${id}` : `#/log-meal/${id}`,
  scan: (day, group) => (group ? `#/scan/${day}/${g(group)}` : "#/scan"),
  // An entry's editor at its `key`: its id, or a series' due day's
  // `daily-{item}-{day}` (no id until ticked: ADR 0023).
  entry: (key) => `#/entry/${key}`,
  // An activity's view; `back` is where its Back leads.
  activityView: (id, back = null) => `#/activity/${id}${q({ back })}`,
  // An activity's editor ("new" with `{day, type}`, `{workout}` or
  // `{exercise}` to start from); `back` is where saving returns to.
  activityEdit: (id, params = {}) =>
    `#/activity/${id === "new" ? "new" : `${id}/edit`}${q(params)}`,
  // Plan a workout on a day.
  plan: (day) => `#/plan/${day}`,
  outbox: () => "#/outbox",
  // Foods
  foods: () => "#/foods",
  // A food or recipe's editor; `back` is where saving returns to.
  food: (food, back = null) =>
    `${food.kind === "recipe" ? `#/recipe/${food.id}` : `#/food/${food.id}`}${q({ back })}`,
  newFood: (params = {}) => `#/food/new${q(params)}`,
  // Pick a duplicate to merge into food (or recipe) `id`.
  merge: (id) => `#/food/${id}/merge`,
  recipe: (id, back = null) => `#/recipe/${id}${q({ back })}`,
  // A meal's editor; `back` is where saving returns to.
  meal: (id, back = null) => `#/meal/${id}${q({ back })}`,
  // Summary: period `kind` (a month by default) around `day` on subtab
  // `tab` (food, body, activity, habits); without one, the subtab last used
  // on this device; `{metric}` opens the Body chart on it.
  summary: (kind = "month", day = null, tab = null, params = {}) =>
    `#/summary${tab ? `/${tab}` : ""}/${kind}${day ? `/${day}` : ""}${q(params)}`,
  // Where a nutrient came from over [from, to] (from the Summary).
  sources: (key, from, to, back = null) =>
    `#/sources/${g(key)}${q({ from, to, back })}`,
  // Activity: what you did (any type), your workouts and the exercises.
  activity: () => "#/activity",
  // Every activity, by month; `{workout}` or `{exercise}`: those done from
  // that workout or with that exercise, `back` where its Back leads.
  activities: (params = {}) => `#/activities${q(params)}`,
  // `{q}`: the list filtered by it.
  exercises: (params = {}) => `#/exercises${q(params)}`,
  // An exercise's view (its history); its editor is separate.
  exercise: (id) => `#/exercise/${id}`,
  exerciseEdit: (id) =>
    id === "new" ? "#/exercise/new" : `#/exercise/${id}/edit`,
  // A workout's view, its editor ("new" for a new one); `back` is where
  // the view's Back, or the editor's Save, leads.
  workout: (id, back = null) => `#/workout/${id}${q({ back })}`,
  workoutEdit: (id, back = null) =>
    id === "new" ? "#/workout/new" : `#/workout/${id}/edit${q({ back })}`,
  // Run a workout; `{day}` saves it to that day (a plan's Start).
  run: (id, params = {}) => `#/workout/${id}/run${q(params)}`,
  // Your bests: exercise PRs and per activity type.
  records: () => "#/records",
  // Profile
  profile: () => "#/profile",
  profileEdit: (id) => `#/profile/${id}`,
  targets: () => "#/targets",
  // The trackers, and one tracker's editor ("new" for a new one).
  habits: () => "#/habits",
  habit: (id) => `#/habit/${id}`,
  // The scale's webhook (openScale) and Health Connect.
  connections: () => "#/connections",
  // Totals since the first day logged.
  stats: () => "#/stats",
  feedback: () => "#/feedback",
};

// The day a Diary address shows (`#/` today's), or null.
const diaryDayOf = (path) =>
  /^#?\/?$/u.test(path)
    ? today()
    : (/^#\/day\/(\d{4}-\d{2}-\d{2})$/u.exec(path)?.[1] ?? null);

// The Diary's reads, for the profile kept on this device: started with meta
// and profiles, not after them (one round trip less on an open). A switch
// of profile meanwhile reads its own.
const diaryReads = (path) => {
  const day = diaryDayOf(path);
  return day && profileId ? [scoped(`/day/${day}`), scoped("/habits")] : [];
};

// Whether the screen shown is `day`'s diary (today's is also at `#/`).
export function showsDay(day) {
  const path = location.hash.split("?")[0];
  return path === href.day(day) || (day === today() && /^#?\/?$/u.test(path));
}

// `day`'s diary: re-rendered in place when it is the screen shown (no
// address change, so focus stays where it is), else opened.
export const goDay = (day) => go(showsDay(day) ? location.hash : href.day(day));

// Where `back` from a query may lead: only somewhere in the app.
export const safeBack = (back) =>
  typeof back === "string" && back.startsWith("#/") ? back : null;

// Teardown for the screen being built or shown, aborted when the next
// navigation starts: timers and screen locks never outlive their screen.
export let leaving = new AbortController();

// Every screen's address pattern, its view and the tab it belongs to.
export const routes = [];
export const register = (...list) => routes.push(...list);

// Which tab an address belongs to; the diary's by default.
const tabOf = (path) => routes.find((r) => r.re.test(path))?.tab ?? "diary";

// What a missing thing's screen offers instead, by tab.
const TAB_ROOT = {
  diary: [href.today(), "Go to today"],
  foods: [href.foods(), "Go to Foods"],
  summary: [href.summary(), "Go to Summary"],
  activity: [href.activity(), "Go to Activity"],
  profile: [href.profile(), "Go to Profile"],
};

// A screen that failed to build: why, and the way back to its tab, as on
// Not found.
const failed = (err, back, backLabel) =>
  h(
    "section",
    {},
    titleBar("Something went wrong", back),
    errorBox(err),
    h("p", {}, h("a", { class: "button", href: back }, backLabel)),
  );

// A screen with unsaved work may keep you: `guardLeave(node, ask)`, where
// `ask` returns `true` with nothing to ask, else resolves to whether to
// leave; staying, the address goes back to it without another hashchange. Only a guard whose `node` is on screen counts:
// a slow build that a newer navigation superseded registers too, late, and
// must not take the guard of the screen shown.
let guards = [];
export const guardLeave = (node, ask) => {
  guards.push([node, ask]);
};
let here = null;
let shown = null;
let retried = false;
let seq = 0;

useNavigator({
  go,
  reload: () => route(),
  guard: guardLeave,
  get signal() {
    return leaving.signal;
  },
});

// While a screen loads, the one shown can't be used (`inert`: a tap on it
// would act on what's being replaced), after BUSY_MS it says so
// (`aria-busy`, a moving bar), and a toast's time stands still.
const BUSY_MS = 150;
let busyTimer = 0;
function loading(on) {
  clearTimeout(busyTimer);
  app.inert = on;
  if (on) {
    screenLoading();
    busyTimer = setTimeout(
      () => app.setAttribute("aria-busy", "true"),
      BUSY_MS,
    );
  } else {
    app.removeAttribute("aria-busy");
    screenShown();
  }
}

// Whether the screen holds work a re-render would lose: a dialog open, or
// an editor with a leave guard.
export const occupied = () =>
  Boolean(document.querySelector("dialog[open]")) ||
  guards.some(([node]) => node.isConnected);

// Each render is measured: `performance` entries "render <path>" (I2's perf
// spec reads them).
// Back in the app with the server upgraded under it (api.mjs `stale`): the
// new build loads, unless a dialog or an unsaved editor is open; then a
// toast offers it.
export function reloadIfStale() {
  if (!stale) return;
  if (occupied())
    notify("Updated", {
      action: { label: "Reload", run: () => location.reload() },
    });
  else location.reload();
}

// Whether to leave the screen shown for the address now: an unsaved
// screen's guard asks (`true` at once when there's nothing to ask), and
// while it asks, and on staying, the address is the screen's again. A
// clean screen leaves the address alone: put back even for a moment, a
// reload then reloaded the screen left.
async function mayLeave() {
  const ask = guards.find(([node]) => node.isConnected)?.[1];
  if (!ask || location.hash === here) return true;
  const answer = ask();
  if (answer === true) return true;
  const target = location.hash;
  history.replaceState(null, "", here);
  if (!(await answer)) return false;
  history.replaceState(null, "", target);
  return true;
}

// What every screen reads, loaded once: the meta and the profiles.
const loadBasics = () =>
  Promise.all([
    meta
      ? null
      : loadMeta().then((m) => {
          setRegistry(m.nutrients);
          setActivityTypes(m.activity_types);
        }),
    profiles.length > 0 ? null : loadProfiles(),
  ]);

// The screen at `path`: its route's view (`found`) of the address's parts
// and `params`, else "Not found".
function screenAt(found, path, params) {
  if (!found)
    return h(
      "section",
      {},
      titleBar("Not found"),
      h("p", {}, "There's no screen at this address."),
      h("p", {}, h("a", { class: "button", href: "#/" }, "Go to today")),
    );
  const args = path
    .match(found.re)
    .slice(1)
    .map((a) => (a === undefined ? a : decodeURIComponent(a)));
  return found.view(...args, params);
}

// A new screen opens at its top and takes focus at its heading, so screen
// readers start there (the address names no element, so the window would
// keep the last screen's offset); re-renders of the same screen (after a
// save) leave scroll and focus alone. Its tab is marked current, and the
// window (and its history) names the screen, then its tab: "Today · Diary
// · Kaloriina", "Foods · Kaloriina".
function markShown(path, tab) {
  if (path !== shown) {
    window.scrollTo(0, 0);
    const heading = app.querySelector("h1");
    heading?.setAttribute("tabindex", "-1");
    heading?.focus({ preventScroll: true });
    shown = path;
  }
  for (const a of document.querySelectorAll(".tabs a"))
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  const tabName = tab[0].toUpperCase() + tab.slice(1);
  const heading = app.querySelector("h1")?.textContent;
  document.title = [heading, tabName, "Kaloriina"]
    .filter((x, i, all) => x && all.indexOf(x) === i)
    .join(" · ");
}

export async function route() {
  if (!(await mayLeave())) return;
  guards = [];
  here = location.hash;
  // The server was upgraded: the new build opens this address instead.
  if (stale) return location.reload();
  // Only the latest navigation renders: a slow screen (Summary loading its
  // charts) must not replace the one opened after it.
  const mine = ++seq;
  leaving.abort();
  leaving = new AbortController();
  const [path, query] = location.hash.split("?");
  const params = new URLSearchParams(query);
  const found = routes.find((r) => r.re.test(path));
  // A screen opened with a way `back` stays in the tab it was opened from.
  const tab = tabOf(safeBack(params.get("back"))?.split("?")[0] ?? path);
  if (path !== shown) screenChanged();
  loading(true);
  const start = performance.now();
  prefetch(meta && profiles.length > 0 ? [] : diaryReads(path));
  try {
    await loadBasics();
    // Navigated on while those loaded: this screen is never built.
    if (mine !== seq) return;
    const node = await screenAt(found, path, params);
    if (mine !== seq) return;
    if (node) fill(app, node);
  } catch (err) {
    if (mine !== seq) return;
    // The current profile was deleted elsewhere: pick another and retry.
    if (err.code === "not_found" && err.resource === "profile" && !retried) {
      retried = true;
      await loadProfiles();
      return route();
    }
    fill(
      app,
      err.code === "not_found" && err.resource
        ? notFound(err.resource, ...TAB_ROOT[tab])
        : failed(err, ...TAB_ROOT[tab]),
    );
  }
  loading(false);
  performance.measure(`render ${path}`, { start });
  retried = false;
  markShown(path, tab);
}
