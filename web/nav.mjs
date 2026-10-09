// Navigation: every address in the app (`href`), the routes screens register
// (from main.mjs) with the tab each belongs to, and the router.

import {
  isQueued,
  loadMeta,
  loadProfiles,
  meta,
  profiles,
  stored,
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
  titleBar,
  useNavigator,
} from "./ui.mjs";

export const app = document.getElementById("app");

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
  entry: (id) => `#/entry/${id}`,
  session: (id, params = {}) => `#/session/${id}${q(params)}`,
  // Plan a workout on a day; `{start: 1}` picks one to run there instead.
  plan: (day, params = {}) => `#/plan/${day}${q(params)}`,
  outbox: () => "#/outbox",
  // Foods
  foods: () => "#/foods",
  // A food or recipe's editor; `back` is where saving returns to.
  food: (food, back = null) =>
    `${food.source === "recipe" ? `#/recipe/${food.id}` : `#/food/${food.id}`}${q({ back })}`,
  newFood: (params = {}) => `#/food/new${q(params)}`,
  // Pick a duplicate to merge into food (or recipe) `id`.
  merge: (id) => `#/food/${id}/merge`,
  recipe: (id, back = null) => `#/recipe/${id}${q({ back })}`,
  meal: (id) => `#/meal/${id}`,
  // Summary: period `kind` (a month by default) around `day` on subtab
  // `tab` (food, body, training, habits); without one, the subtab last used
  // on this device.
  summary: (kind = "month", day = null, tab = null) =>
    `#/summary${tab ? `/${tab}` : ""}/${kind}${day ? `/${day}` : ""}`,
  // Where a nutrient came from over [from, to] (from the Summary).
  sources: (key, from, to, back = null) =>
    `#/sources/${g(key)}${q({ from, to, back })}`,
  // Workouts
  workouts: () => "#/workouts",
  sessions: () => "#/sessions",
  exercises: () => "#/exercises",
  // An exercise's view (its history); its editor is separate.
  exercise: (id) => `#/exercise/${id}`,
  exerciseEdit: (id) =>
    id === "new" ? "#/exercise/new" : `#/exercise/${id}/edit`,
  workout: (id) => `#/workout/${id}`,
  run: (id) => `#/workout/${id}/run`,
  // Profile
  profile: () => "#/profile",
  profileEdit: (id) => `#/profile/${id}`,
  targets: () => "#/targets",
  // The trackers, and one tracker's editor ("new" for a new one).
  habits: () => "#/habits",
  habit: (id) => `#/habit/${id}`,
  // The scale's webhook (openScale) and Health Connect.
  connections: () => "#/connections",
};

// Whether the screen shown is `day`'s diary (today's is also at `#/`).
export function showsDay(day) {
  const path = location.hash.split("?")[0];
  return path === href.day(day) || (day === today() && /^#?\/?$/.test(path));
}

// `day`'s diary: re-rendered in place when it is the screen shown (no
// address change, so focus stays where it is), else opened.
export const goDay = (day) => go(showsDay(day) ? location.hash : href.day(day));

// After a write opted into the outbox: when it was kept on this device
// (ApiError "queued"), its day opens (or re-renders, when shown) and says
// so; any other error stands.
export function keptHere(err, day) {
  if (!isQueued(err)) throw err;
  goDay(day);
  notify(err.message);
}

// Run `write` (a queued `api()` call): true when stored; kept on this
// device, `day` shows it (`keptHere`) and it's false; any other error stands.
export async function storedOrKept(write, day) {
  const done = await stored(write);
  if (done === true) return true;
  keptHere(done.queued, day);
  return false;
}

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
  workouts: [href.workouts(), "Go to Workouts"],
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

// A screen with unsaved work may keep you (`guard` resolves to whether to
// leave); the address then goes back to it without another hashchange.
let guard = null;
let here = null;
let shown = null;
let retried = false;
let seq = 0;

useNavigator({
  go,
  reload: () => route(),
  guard: (fn) => {
    guard = fn;
  },
  get signal() {
    return leaving.signal;
  },
});

// While a screen loads, the one shown can't be used (`inert`: a tap on it
// would act on what's being replaced), and after BUSY_MS it says so
// (`aria-busy`, a moving bar).
const BUSY_MS = 150;
let busyTimer = 0;
function loading(on) {
  clearTimeout(busyTimer);
  app.inert = on;
  if (on)
    busyTimer = setTimeout(
      () => app.setAttribute("aria-busy", "true"),
      BUSY_MS,
    );
  else app.removeAttribute("aria-busy");
}

// Each render is measured: `performance` entries "render <path>" (I2's perf
// spec reads them).
export async function route() {
  if (guard && location.hash !== here) {
    const target = location.hash;
    history.replaceState(null, "", here);
    if (!(await guard())) return;
    history.replaceState(null, "", target);
  }
  guard = null;
  here = location.hash;
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
  try {
    await Promise.all([
      meta ? null : loadMeta().then((m) => setRegistry(m.nutrients)),
      profiles.length ? null : loadProfiles(),
    ]);
    // Navigated on while those loaded: this screen is never built.
    if (mine !== seq) return;
    const args = found
      ? path
          .match(found.re)
          .slice(1)
          .map((a) => (a === undefined ? a : decodeURIComponent(a)))
      : [];
    const node = found
      ? await found.view(...args, params)
      : h(
          "section",
          {},
          titleBar("Not found"),
          h("p", {}, "There's no screen at this address."),
          h("p", {}, h("a", { class: "button", href: "#/" }, "Go to today")),
        );
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
  // A new screen takes focus at its heading, so screen readers start there;
  // re-renders of the same screen (after a save) leave focus alone.
  if (path !== shown) {
    const heading = app.querySelector("h1");
    heading?.setAttribute("tabindex", "-1");
    heading?.focus({ preventScroll: true });
    shown = path;
  }
  for (const a of document.querySelectorAll(".tabs a"))
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  // The window (and its history) names the screen, then its tab:
  // "Today · Diary · Kaloriina", "Foods · Kaloriina".
  const tabName = tab[0].toUpperCase() + tab.slice(1);
  const heading = app.querySelector("h1")?.textContent;
  document.title = [heading, tabName, "Kaloriina"]
    .filter((x, i, all) => x && all.indexOf(x) === i)
    .join(" · ");
}
