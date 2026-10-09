// Finding food: search with filters, logging a food or a meal, barcodes and
// scanning.

import { amountControl } from "../amount.mjs";
import { api, createId, get, meta, scoped, stored } from "../api.mjs";
import { pretty, shift, today } from "../dates.mjs";
import { go, href, keptHere, leaving, storedOrKept } from "../nav.mjs";
import {
  CONSUMED,
  PLANNED,
  SOURCES,
  capitalized,
  groupLabel,
  fmt,
  isNil,
  kcal,
  nutrient,
  ordered,
  plural,
  qty,
  scaled,
  summed,
  withUnit,
} from "../nutrients.mjs";
import {
  busy,
  errorBox,
  field,
  formDialog,
  fill,
  h,
  icon,
  notify,
  num,
  numberOrNull,
  nutritionPanel,
  SCAN_ICON,
  titleBar,
} from "../ui.mjs";
import { matches } from "../workouts.mjs";
import { waterText } from "../habits.mjs";

// Back from logging: the group's Add screen, or the Foods tab.
const backFrom = (day, group) => (group ? href.add(day, group) : href.foods());

export async function add(day, group) {
  // Known before it's needed: a tap made offline still finds the food.
  const water = get(scoped("/water-food")).catch(() => null);
  return h(
    "section",
    {},
    titleBar(
      `Add to ${groupLabel(group)}`,
      href.day(day),
      h(
        "button",
        {
          type: "button",
          class: "water-add",
          onclick: busy(() => addWater(day, group, water)),
        },
        "+ Water",
      ),
    ),
    await finder({ day, group }),
  );
}

// The amount the last "+ Water" logged on this device, offered next time.
const WATER_KEY = "water-ml";
// One-tap amounts beside the field.
const WATER_CHIPS = [250, 500];

// "+ Water" (the Add screen, the + Log sheet): how many ml, asked in a
// dialog (the last amount filled in), logged as as many grams of the
// profile's water food (Habits); waits on this device when
// offline. `water`: the water food's answer, fetched ahead, if it was.
export async function addWater(day, group, water = null) {
  const key = createId();
  const [min, max] = meta.limits.water_ml;
  const range = `${fmt(min)}–${qty(max, "ml")}`;
  const ml = num({
    name: "ml",
    required: true,
    min,
    max,
    inputMode: "numeric",
    value: localStorage.getItem(WATER_KEY) ?? "",
  });
  const chips = h(
    "div",
    { class: "chips" },
    WATER_CHIPS.map((n) =>
      h(
        "button",
        {
          type: "button",
          class: "chip",
          onclick: () => {
            ml.value = n;
            ml.focus();
          },
        },
        qty(n, "ml"),
      ),
    ),
  );
  let kept = null;
  let entries = null;
  const added = await formDialog(`Water to ${groupLabel(group)}`, {
    body: [field("Amount (ml)", ml, { hint: range }), chips],
    submit: "Add",
    run: async () => {
      const amount = numberOrNull(ml);
      if (amount === null || amount < min || amount > max)
        throw Object.assign(new Error(`Enter ${range}.`), { field: "ml" });
      const food = ((await water) ?? (await get(scoped("/water-food")))).food;
      if (!food)
        throw Object.assign(
          new Error("No water food yet: pick one in Habits."),
          { link: { href: href.habits(), text: "Habits" } },
        );
      const done = await stored(async () => {
        ({ entries } = await api(
          "POST",
          scoped("/entries"),
          { uid: key.get(), day, group, food_id: food.id, grams: amount },
          { queue: true, label: `Water ${waterText(meta.habits, amount)}` },
        ));
      });
      if (done !== true) kept = done.queued;
      key.done();
      localStorage.setItem(WATER_KEY, String(amount));
      return amount;
    },
  });
  if (added === null) return;
  if (kept) return keptHere(kept, day);
  logged(day, group, `Water ${waterText(meta.habits, added)}`, entries);
}

async function byBarcode(code, day, group, status) {
  if (!isBarcode(code)) {
    status.textContent = "Enter the digits under the barcode.";
    return;
  }
  status.textContent = "Looking up…";
  const params = { barcode: code, ...(group ? { day, group } : {}) };
  try {
    // POST: may fetch from Open Food Facts and cache the result.
    const food = await api("POST", `/foods/barcode/${code}`, {});
    go(href.log(day, group, food.id));
  } catch (err) {
    if (err.status === 404) {
      go(href.newFood({ ...params, notfound: 1 }));
      return;
    }
    fill(
      status,
      errorBox(err),
      h("a", { href: href.newFood(params) }, "Enter it by hand"),
    );
  }
}

// Logged now: back to the day, with Undo.
function logged(day, group, what, entries) {
  go(href.day(day));
  notify(`Added ${what} to ${groupLabel(group)}`, {
    action: {
      label: "Undo",
      run: async () => {
        for (const e of entries)
          await api("DELETE", scoped(`/entries/${e.id}`));
        go(href.day(day));
      },
    },
  });
}

// The group buttons of a log form: one when the group is known, both (eaten
// first, so Enter logs what you ate) from the Foods tab.
const groupButtons = (group) =>
  group
    ? h("button", { class: "primary" }, `Add to ${groupLabel(group)}`)
    : h(
        "div",
        { class: "actions" },
        h(
          "button",
          { class: "primary", value: CONSUMED },
          `Add to ${groupLabel(CONSUMED)}`,
        ),
        h("button", { value: PLANNED }, `Add to ${groupLabel(PLANNED)}`),
      );

// The header's way to edit what is being logged.
const editLink = (to, what) =>
  h("a", { class: "button", href: to, "aria-label": `Edit ${what}` }, "Edit");

// The line under a log screen's or entry's title, one format everywhere:
// "Today · Eaten · Fazer" (day, group, then brand or source).
export const contextLine = (day, group, ...rest) =>
  [day === today() ? "Today" : pretty(day), group && groupLabel(group), ...rest]
    .filter(Boolean)
    .join(" · ");

// The optional "Time eaten" of a log form ("08:15"); `body()` adds it to
// the POST only when set.
function timeEaten() {
  const input = h("input", { type: "time", name: "time" });
  return {
    node: field("Time eaten", input, { hint: "Optional" }),
    body: () => (input.value ? { time: input.value } : {}),
  };
}

// Log a food. With `group` it comes from a group's Add screen; without, from
// the Foods tab, which offers both groups.
export async function log(day, group, id) {
  const [food, favorites] = await Promise.all([
    get(`/foods/${id}`),
    get(scoped("/foods/favorites")),
  ]);
  const star = starButton(
    food,
    favorites.some((f) => f.id === food.id),
    `Favourite ${food.name}`,
  );
  const preview = h("p", { class: "muted" });
  const panel = nutritionPanel();
  const update = () => {
    const g = amount.grams();
    preview.textContent = `${qty(g, "g")} · ${kcal(isNil(food.per100.energy) ? null : (food.per100.energy * g) / 100)}`;
    panel.paint([
      { label: "Per 100 g", values: food.per100 },
      { label: `This (${qty(g, "g")})`, values: scaled(food.per100, g) },
    ]);
  };
  const amount = amountControl(food, null, update);
  update();
  const time = timeEaten();
  const key = createId();
  const submit = busy(async (e) => {
    e.preventDefault();
    const to = group ?? e.submitter?.value ?? CONSUMED;
    let entries;
    const body = {
      uid: key.get(),
      day,
      group: to,
      food_id: food.id,
      ...amount.body(),
      ...time.body(),
    };
    const write = async () => {
      ({ entries } = await api("POST", scoped("/entries"), body, {
        queue: true,
        label: food.name,
      }));
    };
    if (!(await storedOrKept(write, day))) return;
    key.done();
    logged(day, to, food.name, entries);
  });
  const here = href.log(day, group, food.id);
  return h(
    "section",
    {},
    titleBar(food.name, backFrom(day, group), [
      star,
      editLink(
        href.food(food, here),
        food.source === "recipe" ? "recipe" : "food",
      ),
    ]),
    h(
      "p",
      { class: "muted" },
      contextLine(day, group, food.brand || `From ${SOURCES[food.source]}`),
    ),
    h(
      "form",
      { class: "log", onsubmit: submit },
      field("Amount", amount.node),
      preview,
      time.node,
      groupButtons(group),
    ),
    food.instructions
      ? h(
          "section",
          { class: "finder-section instructions" },
          h("h2", {}, "Instructions"),
          h("p", { class: "instructions-text" }, food.instructions),
        )
      : null,
    panel.node,
  );
}

// A meal's energy and size: "3 items · 422 kcal".
const mealLine = (m, portions = 1) => {
  const energy = summed(m.items.map((i) => scaled(i.per100, i.grams))).energy;
  return `${plural(m.items.length, "item")} · ${kcal(isNil(energy) ? null : energy * portions)}`;
};

// Log a meal: every item, times a number of portions, as entries of their
// own.
export async function logMeal(day, group, id) {
  const meal = await get(`/meals/${id}`);
  const portions = num({
    name: "portions",
    value: 1,
    min: "0.1",
    max: meta.limits.portions,
    step: "0.1",
    required: true,
    "aria-label": "Portions",
  });
  const preview = h("p", { class: "muted" });
  const panel = nutritionPanel();
  const list = h("ul", { class: "results card" });
  const paint = () => {
    const p = Number(portions.value) || 0;
    preview.textContent = mealLine(meal, p);
    fill(
      list,
      ...meal.items.map((i) =>
        h(
          "li",
          {},
          h(
            "div",
            { class: "result" },
            h("span", { class: "name" }, i.name),
            h("span", { class: "muted" }, qty(i.grams * p, "g")),
          ),
        ),
      ),
    );
    panel.paint([
      {
        label: `${plural(p, "portion")}`,
        values: summed(meal.items.map((i) => scaled(i.per100, i.grams * p))),
      },
    ]);
  };
  portions.addEventListener("input", paint);
  paint();
  const time = timeEaten();
  const form = h(
    "form",
    { class: "log" },
    field(
      "Amount",
      h("div", { class: "row amount" }, portions, h("span", {}, "portions")),
    ),
    preview,
    time.node,
    groupButtons(group),
  );
  const key = createId();
  form.addEventListener(
    "submit",
    busy(async (e) => {
      e.preventDefault();
      const to = group ?? e.submitter?.value ?? CONSUMED;
      let entries;
      const body = {
        uid: key.get(),
        day,
        group: to,
        meal_id: meal.id,
        portions: Number(portions.value),
        ...time.body(),
      };
      const write = async () => {
        ({ entries } = await api("POST", scoped("/entries"), body, {
          queue: true,
          label: meal.name,
        }));
      };
      if (!(await storedOrKept(write, day))) return;
      key.done();
      logged(day, to, meal.name, entries);
    }),
  );
  return h(
    "section",
    {},
    titleBar(
      meal.name,
      backFrom(day, group),
      editLink(href.meal(meal.id), "meal"),
    ),
    h("p", { class: "muted" }, contextLine(day, group)),
    form,
    list,
    panel.node,
  );
}

// Search filters, remembered per browser. Rule amounts are in display units.
const SORTS = [
  ["relevance", "Best match"],
  ["name", "Name"],
  ["energy", "Lowest energy"],
  ["protein", "Most protein"],
  ["protein_per_kcal", "Most protein per kcal"],
  ["fit", "Best fit for today"],
];
const FIT = "fit";
const FIT_HINT =
  "Closest to the protein, carbs and fat you have left, with a serving that fits the energy left.";
const ALL_SOURCES = ["custom", "recipe", "fineli", "off"];
// A barcode as the API accepts it: digits, as many as its limits say.
const isBarcode = (code) => {
  const [min, max] = meta.limits.barcode_digits;
  return /^\d+$/.test(code) && code.length >= min && code.length <= max;
};
const FILTERS_KEY = "food-filters";
const noFilters = () => ({
  sources: [...ALL_SOURCES],
  rules: [],
  sort: "relevance",
  archived: false,
});

// Saved filters, cleaned against what exists now, so a stale save can't
// break the search.
function loadFilters() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(FILTERS_KEY)) ?? {};
  } catch {
    saved = {};
  }
  const f = noFilters();
  if (Array.isArray(saved.sources))
    f.sources = ALL_SOURCES.filter((s) => saved.sources.includes(s));
  if (Array.isArray(saved.rules))
    f.rules = saved.rules.filter(
      (r) => nutrient(r?.key) && ["min", "max"].includes(r?.dir),
    );
  if (SORTS.some(([k]) => k === saved.sort)) f.sort = saved.sort;
  f.archived = saved.archived === true;
  return f;
}

// Best fit is for this visit only: a later one opens on Favourites.
const saveFilters = (f) =>
  localStorage.setItem(
    FILTERS_KEY,
    JSON.stringify({ ...f, sort: f.sort === FIT ? "relevance" : f.sort }),
  );

// How many filters differ from the defaults.
const activeFilters = (f) =>
  ALL_SOURCES.length -
  f.sources.length +
  f.rules.filter((r) => r.value !== "").length +
  (f.sort === "relevance" ? 0 : 1) +
  (f.archived ? 1 : 0);

// The current profile's search for `q` with filters `f` (ranked by its
// favourites and logging); best fit fits `day`.
function searchQuery(q, f, day) {
  const params = new URLSearchParams({ q });
  if (f.sources.length < ALL_SOURCES.length)
    params.set("sources", f.sources.join(","));
  for (const dir of ["min", "max"]) {
    const rules = f.rules
      .filter((r) => r.dir === dir && r.value !== "")
      .map((r) => `${r.key}:${nutrient(r.key).store(Number(r.value))}`);
    if (rules.length) params.set(dir, rules.join(","));
  }
  if (f.sort !== "relevance") params.set("sort", f.sort);
  if (f.sort === FIT) params.set("day", day);
  if (f.archived) params.set("archived", "true");
  return scoped(`/foods?${params}`);
}

// Ingredient search, for recipe and meal editors: the same ranking.
export const searchFoods = (q) =>
  get(scoped(`/foods?${new URLSearchParams({ q })}`));

// ☆/★ toggle of a food's favourite state; `onChange(starred)` runs after it
// flips.
function starButton(food, starred, label, onChange = () => {}) {
  const button = h("button", {
    type: "button",
    class: "icon star",
    "aria-label": label,
    onclick: busy(async () => {
      if (starred) await api("DELETE", scoped(`/foods/favorites/${food.id}`));
      else await api("POST", scoped("/foods/favorites"), { food_id: food.id });
      starred = !starred;
      paint();
      onChange(starred);
    }),
  });
  const paint = () => {
    button.setAttribute("aria-pressed", String(starred));
    button.textContent = starred ? "★" : "☆";
  };
  paint();
  return button;
}

// A food in a list: name; brand, recipe, energy per 100 g. `star`
// ({starred, onChange}) adds a favourite toggle.
export function foodRow(f, onPick, star = null) {
  return h(
    "li",
    { class: star ? "starred-row" : null },
    h(
      "button",
      { class: "result", type: "button", onclick: () => onPick(f) },
      h("span", { class: "name" }, f.name),
      h(
        "span",
        { class: "muted" },
        [
          f.brand,
          f.source === "recipe" ? "recipe" : null,
          `${kcal(f.per100.energy)} per 100 g`,
        ]
          .filter(Boolean)
          .join(" · "),
      ),
    ),
    star
      ? starButton(f, star.starred, `Favourite ${f.name}`, star.onChange)
      : null,
  );
}

// The Filters button and its panel. `onChange` runs after every change;
// `paint` redraws after the filters changed from outside. With `fit` (an
// energy target to fit) "Best fit" is offered.
function filtersPanel(filters, onChange, { fit = false } = {}) {
  const toggle = h("button", {
    type: "button",
    "aria-expanded": "false",
    onclick: () => {
      panel.hidden = !panel.hidden;
      toggle.setAttribute("aria-expanded", String(!panel.hidden));
    },
  });
  const panel = h("div", { class: "filters card", hidden: true });
  const label = () => {
    const n = activeFilters(filters);
    toggle.textContent = n ? `Filters · ${n}` : "Filters";
  };
  const changed = (repaint = true) => {
    saveFilters(filters);
    if (repaint) paint();
    else label();
    onChange();
  };
  const clearButton = () =>
    h(
      "button",
      {
        type: "button",
        onclick: () => {
          Object.assign(filters, noFilters());
          changed();
        },
      },
      "Clear filters",
    );
  const sourceBox = (key) =>
    h(
      "label",
      { class: "check" },
      h("input", {
        type: "checkbox",
        checked: filters.sources.includes(key),
        onchange: (ev) => {
          filters.sources = ev.target.checked
            ? ALL_SOURCES.filter(
                (s) => s === key || filters.sources.includes(s),
              )
            : filters.sources.filter((s) => s !== key);
          changed();
        },
      }),
      ` ${capitalized(SOURCES[key])}`,
    );
  const ruleRow = (rule) =>
    h(
      "div",
      { class: "rule" },
      h(
        "select",
        {
          "aria-label": "Rule nutrient",
          onchange: (ev) => {
            rule.key = ev.target.value;
            changed();
          },
        },
        ordered().map((n) =>
          h(
            "option",
            { value: n.key, selected: n.key === rule.key },
            withUnit(n),
          ),
        ),
      ),
      h(
        "select",
        {
          "aria-label": "Rule direction",
          onchange: (ev) => {
            rule.dir = ev.target.value;
            changed();
          },
        },
        h("option", { value: "min", selected: rule.dir === "min" }, "≥"),
        h("option", { value: "max", selected: rule.dir === "max" }, "≤"),
      ),
      num({
        value: rule.value,
        "aria-label": "Rule amount",
        oninput: (ev) => {
          rule.value = ev.target.value;
          changed(false);
        },
      }),
      h(
        "button",
        {
          type: "button",
          class: "icon danger",
          "aria-label": "Remove rule",
          onclick: () => {
            filters.rules = filters.rules.filter((r) => r !== rule);
            changed();
          },
        },
        "✕",
      ),
    );
  function paint() {
    label();
    fill(
      panel,
      h(
        "fieldset",
        {},
        h("legend", {}, "Databases"),
        ALL_SOURCES.map(sourceBox),
      ),
      h(
        "fieldset",
        {},
        h("legend", {}, "Per 100 g"),
        filters.rules.map(ruleRow),
        h(
          "button",
          {
            type: "button",
            onclick: () => {
              filters.rules.push({ key: "protein", dir: "min", value: "" });
              changed();
            },
          },
          "+ Rule",
        ),
      ),
      field(
        "Sort",
        h(
          "select",
          {
            onchange: (ev) => {
              filters.sort = ev.target.value;
              changed();
            },
          },
          SORTS.filter(([k]) => k !== FIT || fit).map(([k, text]) =>
            h("option", { value: k, selected: k === filters.sort }, text),
          ),
        ),
        { hint: filters.sort === FIT ? FIT_HINT : null },
      ),
      h(
        "label",
        { class: "check" },
        h("input", {
          type: "checkbox",
          checked: filters.archived,
          onchange: (ev) => {
            filters.archived = ev.target.checked;
            changed();
          },
        }),
        " Show archived",
      ),
      clearButton(),
    );
  }
  paint();
  return { toggle, panel, paint, clearButton };
}

const section = (title, list, empty) =>
  h(
    "section",
    { class: "finder-section" },
    h("h2", {}, title),
    list.length
      ? h("ul", { class: "results card" }, list)
      : h("p", { class: "muted" }, empty),
  );

// Find food to log: favourites, recent and meals until you search; results
// with filters after (your meals that match first), and with nothing found
// a way to make the food. With `group` it logs there; without (the Foods
// tab) the log screen offers both groups.
export async function finder({ day, group }) {
  const filters = loadFilters();
  const status = h("p", { role: "status" });
  const results = h("div", { class: "finder-results" });
  const pick = (f) => go(href.log(day, group, f.id));
  // Loaded once; a star toggled here updates them.
  // The Foods tab also lists your own recipes and foods by name (archived
  // ones hidden), so one never logged is found without its name.
  const own = (sources) =>
    group ? [] : get(scoped(`/foods?q=&sources=${sources}&sort=name`));
  const [favourites, recent, meals, yesterday, targets, recipes, made, water] =
    await Promise.all([
      get(scoped("/foods/favorites")),
      get(scoped("/foods/recent")),
      get("/meals"),
      group ? get(scoped(`/day/${shift(day, -1)}`)) : null,
      get(scoped("/targets")),
      own("recipe"),
      own("custom"),
      group ? null : get(scoped("/water-food")),
    ]);
  // Water is the app's food for "+ Water", not one you made.
  const customs = made.filter((f) => f.id !== water?.food?.id);
  const starred = new Set(favourites.map((f) => f.id));
  // What was eaten the day before, to log again in one tap.
  const eatenYesterday = (yesterday?.groups ?? [])
    .filter((g) => g.name !== PLANNED)
    .flatMap((g) => g.entries)
    .filter((e) => !e.imported);
  const yesterdayKey = createId();
  const sameAsYesterday = busy(async () => {
    let entries;
    const write = async () => {
      ({ entries } = await api(
        "POST",
        scoped("/entries"),
        {
          uid: yesterdayKey.get(),
          day,
          group,
          entry_ids: eatenYesterday.map((e) => e.id),
        },
        {
          queue: true,
          label: `Same as yesterday · ${plural(eatenYesterday.length, "food")}`,
        },
      ));
    };
    if (!(await storedOrKept(write, day))) return;
    yesterdayKey.done();
    logged(day, group, plural(entries.length, "food"), entries);
  });
  const yesterdayRow = () =>
    eatenYesterday.length
      ? h(
          "ul",
          { class: "results card" },
          h(
            "li",
            {},
            h(
              "button",
              { class: "result", type: "button", onclick: sameAsYesterday },
              h("span", { class: "name" }, "Same as yesterday"),
              h(
                "span",
                { class: "muted" },
                `${plural(eatenYesterday.length, "food")} · ${kcal(
                  summed(eatenYesterday.map((e) => e.nutrients ?? {})).energy ??
                    0,
                )}`,
              ),
            ),
          ),
        )
      : null;
  let latest = 0;
  let timer = 0;
  const later = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(refresh, ms);
  };
  const ui = filtersPanel(filters, () => later(300), {
    fit: targets.some((t) => t.metric === "energy"),
  });
  const input = h("input", {
    type: "search",
    // Short: the field is narrow on a phone; its name says what.
    placeholder: "Search",
    "aria-label": "Search foods",
    oninput: () => later(150),
  });

  const mealRow = (m) =>
    h(
      "li",
      {},
      h(
        "a",
        { class: "result", href: href.logMeal(day, group, m.id) },
        h("span", { class: "name" }, m.name),
        h("span", { class: "muted" }, mealLine(m)),
      ),
    );

  // Rows with a star. While browsing, starring redraws so Favourites follows;
  // in search results the star just flips in place.
  const starRow = (redraw) => (f) =>
    foodRow(f, pick, {
      starred: starred.has(f.id),
      onChange: (on) => {
        if (on) {
          starred.add(f.id);
          favourites.push(f);
        } else {
          starred.delete(f.id);
          favourites.splice(
            favourites.findIndex((x) => x.id === f.id),
            1,
          );
        }
        if (redraw) refresh();
      },
    });

  const browse = () => {
    const row = starRow(true);
    return [
      yesterdayRow(),
      section(
        "Favourites",
        favourites.map(row),
        "Star a food (☆) to keep it here.",
      ),
      section("Recent", recent.map(row), "Foods you log show up here."),
      section(
        "Meals",
        meals.map(mealRow),
        "A meal logs several foods at once.",
      ),
      group
        ? null
        : [
            section(
              "Your recipes",
              recipes.map(row),
              "Recipes you make show up here.",
            ),
            section(
              "Your foods",
              customs.map(row),
              "Foods you make show up here.",
            ),
          ],
    ];
  };

  async function search(q) {
    let foods;
    try {
      foods = await get(searchQuery(q, filters, day));
    } catch (err) {
      if (err.status !== 400) throw err;
      // A filter the server no longer accepts: start over rather than stall.
      Object.assign(filters, noFilters());
      saveFilters(filters);
      ui.paint();
      notify("Reset the search filters");
      foods = await get(searchQuery(q, filters, day));
    }
    // Your meals lead, when the words fit; filters are about foods.
    const mine = activeFilters(filters)
      ? []
      : meals.filter((m) => matches(m.name.toLowerCase(), q));
    const rows = [...mine.map(mealRow), ...foods.map(starRow(false))];
    if (isBarcode(q))
      rows.unshift(
        h(
          "li",
          {},
          h(
            "button",
            {
              class: "result",
              type: "button",
              onclick: busy(() => byBarcode(q, day, group, status)),
            },
            h("span", { class: "name" }, `Look up barcode ${q}`),
            h("span", { class: "muted" }, "your foods, then Open Food Facts"),
          ),
        ),
      );
    if (rows.length) return h("ul", { class: "results card" }, rows);
    const make = h(
      "a",
      {
        class: "button",
        href: href.newFood({ name: q, ...(group ? { day, group } : {}) }),
      },
      `New food “${q}”`,
    );
    return activeFilters(filters)
      ? h(
          "p",
          { class: "muted none" },
          "No matches with these filters. ",
          ui.clearButton(),
        )
      : h("p", { class: "muted none" }, "No matches. ", make);
  }

  async function refresh() {
    const seq = ++latest;
    const q = input.value.trim();
    try {
      const node = q || activeFilters(filters) ? await search(q) : browse();
      if (seq === latest) fill(results, ...[node].flat());
    } catch (err) {
      if (seq === latest) fill(results, errorBox(err));
    }
  }

  await refresh();
  return h(
    "div",
    { class: "finder" },
    h(
      "div",
      { class: "search-bar" },
      input,
      h(
        "a",
        {
          class: "button icon",
          href: href.scan(day, group),
          "aria-label": "Scan barcode",
        },
        icon(SCAN_ICON),
      ),
      ui.toggle,
    ),
    ui.panel,
    status,
    results,
  );
}

let stream = null;

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

export async function scan(day, group) {
  // The camera stops when you leave, even if it was granted afterwards.
  const { signal } = leaving;
  const back = group ? href.add(day, group) : href.foods();
  const status = h("p", { role: "status" });
  const video = h("video", { playsInline: true, muted: true, class: "camera" });
  const code = h("input", {
    inputMode: "numeric",
    pattern: "[0-9]*",
    placeholder: "Barcode digits",
    "aria-label": "Barcode digits",
  });
  const typed = h(
    "form",
    {
      class: "row",
      onsubmit: busy(async (ev) => {
        ev.preventDefault();
        await byBarcode(code.value.trim(), day, group, status);
      }),
    },
    code,
    h("button", { class: "primary" }, "Look up"),
  );
  // Without a camera the digits field is the way in.
  const fallback = (message) => {
    video.hidden = true;
    status.textContent = message;
    return h("section", {}, titleBar("Scan", back), status, typed);
  };
  if (!("BarcodeDetector" in window) || !navigator.mediaDevices)
    return fallback(
      "This browser can't scan barcodes. Type the digits instead.",
    );
  const detector = new window.BarcodeDetector({
    formats: ["ean_13", "ean_8", "upc_a", "upc_e"],
  });
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
    });
  } catch (err) {
    const hint = window.isSecureContext ? "" : " Camera access needs HTTPS.";
    return fallback(
      `Camera unavailable: ${err.message}.${hint} Type the digits instead.`,
    );
  }
  signal.addEventListener("abort", stopCamera, { once: true });
  if (signal.aborted) return stopCamera();
  video.srcObject = stream;
  video.play().catch(() => {});
  status.textContent = "Point the camera at a barcode.";
  const tick = async () => {
    if (!stream || !video.isConnected) return stopCamera();
    const [hit] = await detector.detect(video).catch(() => []);
    if (!hit) return setTimeout(tick, 250);
    stopCamera();
    return byBarcode(hit.rawValue, day, group, status);
  };
  setTimeout(tick, 500);
  return h("section", {}, titleBar("Scan", back), video, status, typed);
}
