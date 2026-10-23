// Finding food: search with filters, logging a food or a meal, barcodes and
// scanning.

import { logged, serverCopy, storedOrKept } from "../actions.mjs";
import { api, createId, get, meta, scoped } from "../api.mjs";
import { recipeKnown, recipePer100, wholeOf } from "../coverage.mjs";
import { eatenTime, shift } from "../dates.mjs";
import { capitalized, isNil, NBSP, PER_100G, plural } from "../format.mjs";
import { weightGuessed } from "../health.mjs";
import { go, href, leaving } from "../nav.mjs";
import {
  EATEN,
  inputValue,
  kcal,
  nutrient,
  ordered,
  PLANNED,
  scaled,
  searchedSources,
  SOURCES,
  summed,
  withUnit,
} from "../nutrients.mjs";
import { labelChips, nutritionPanel } from "../nutrition-panel.mjs";
import { photoButton } from "../photos.mjs";
import { readJson, writeJson } from "../prefs.mjs";
import { contextLine, foodRow, resultRow, starButton } from "../rows.mjs";
import {
  busy,
  chip,
  editLink,
  empty,
  errorBox,
  field,
  fill,
  h,
  icon,
  notify,
  num,
  removeButton,
  SCAN,
  STAR,
  timeField,
  titleBar,
} from "../ui.mjs";
import { unitOf } from "../units.mjs";
import { addWater } from "../water.mjs";
import { matches } from "../workouts.mjs";
import { amountView, itemRow, repeatFrom } from "./amount-view.mjs";

// Back from logging: the group's Add screen, or the Foods tab.
const backFrom = (day, group) => (group ? href.add(day, group) : href.foods());

export async function add(day, group) {
  return h(
    "section",
    {},
    titleBar(`Add to ${group}`, href.day(day)),
    await finder({ day, group }),
  );
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

// A log form's action row: `copy` (the view's Copy), then the group
// buttons: one when the group is known, both (eaten first, so Enter logs
// what you ate) from the Foods tab.
const groupButtons = (group, copy) =>
  h(
    "div",
    { class: "actions" },
    copy,
    group
      ? h("button", { class: "primary" }, `Add to ${group}`)
      : [
          h("button", { class: "primary", value: EATEN }, `Add to ${EATEN}`),
          h("button", { value: PLANNED }, `Add to ${PLANNED}`),
        ],
  );

// What a log form's "Time eaten" (`input`) adds to the POST: only a set
// time. Into Eaten today it starts at now (still clearable); from the Foods
// tab, where the group is picked on submit, Eaten takes now unless a time
// was typed.
const timeBody = (day, group, input) => (to) => {
  const time = group ? input.value : eatenTime(day, to, input.value);
  return time ? { time } : {};
};

function timeEaten(day, group) {
  const input = timeField({
    name: "time",
    value: eatenTime(day, group) ?? "",
  });
  return {
    node: field("Time eaten", input),
    body: timeBody(day, group, input),
  };
}

// Log a food or recipe (`amountView`). With `group` it comes from a group's
// Add screen; without, from the Foods tab, which offers both groups.
export async function log(day, group, id) {
  const [food, favorites, targets] = await Promise.all([
    get(`/foods/${id}`),
    get(scoped("/foods/favorites")),
    // Only what 100 kcal gives needs them: none, and it isn't shown.
    get(scoped("/targets")).catch(() => null),
  ]);
  const here = href.log(day, group, food.id);
  const kind = food.kind === "recipe" ? "recipe" : "food";
  const view = amountView({
    food,
    time: eatenTime(day, group) ?? "",
    sub: contextLine(
      day,
      group,
      food.brand ||
        `From ${SOURCES[food.kind === "recipe" ? "recipe" : food.source]}`,
    ),
    column: "This",
    here,
    targets,
  });
  // Into Planned nothing is eaten yet: no time to ask.
  view.timeRow.hidden = group === PLANNED;
  const time = timeBody(day, group, view.time);
  const key = createId();
  const submit = busy(async (e) => {
    e.preventDefault();
    const to = group ?? e.submitter?.value ?? EATEN;
    let entries;
    const body = {
      uid: key.get(),
      day,
      group: to,
      food_id: food.id,
      ...view.amount.body(),
      ...time(to),
      ...(view.repeat.checked ? { repeat: repeatFrom(day) } : {}),
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
  return h(
    "section",
    { class: "amount-view" },
    titleBar(food.name, backFrom(day, group), [
      starButton(
        food,
        favorites.some((f) => f.id === food.id),
        `Favourite ${food.name}`,
      ),
      editLink(href.food(food, here), kind),
    ]),
    h(
      "form",
      { class: "log", onsubmit: submit },
      view.head,
      view.fields,
      // The copy's editor saves back to logging the copy.
      groupButtons(
        group,
        serverCopy(`/foods/${food.id}`, kind, (copy) =>
          href.food(copy, href.log(day, group, copy.id)),
        ),
      ),
    ),
    view.tail,
  );
}

// A meal's energy and size: "3 items · 422 kcal", "≥ 422 kcal" when an
// item's energy (or a recipe item's, in part) is unknown.
const mealLine = (m, portions = 1) => {
  const energy = summed(m.items.map((i) => scaled(i.per100, i.grams))).energy;
  const partly = !isNil(energy) && !isNil(recipeKnown(m.items, null).energy);
  return `${plural(m.items.length, "item")} · ${partly ? `≥${NBSP}` : ""}${kcal(isNil(energy) ? null : energy * portions)}`;
};

// Log a meal: every item, times a number of portions, as entries of their
// own.
export async function logMeal(day, group, id) {
  const [meal, targets] = await Promise.all([
    get(`/meals/${id}`),
    get(scoped("/targets")).catch(() => null),
  ]);
  // A meal is graded as food, never as a drink (ADR 0017).
  const per100 = recipePer100(meal.items, null);
  const known = recipeKnown(meal.items, null);
  const mealGrams = meal.items.reduce((t, i) => t + i.grams, 0);
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
      ...meal.items.map((i) => itemRow(i, href.logMeal(day, group, id), p)),
    );
    panel.paint(
      [
        {
          label: `${plural(p, "portion")}`,
          ...wholeOf(
            meal.items.map((i) => ({ ...i, grams: i.grams * p })),
            known,
            mealGrams * p,
          ),
        },
      ],
      {
        per100,
        known,
        drink: false,
        grams: mealGrams * p,
        targets,
        estimated: weightGuessed(meal),
      },
    );
  };
  portions.addEventListener("input", paint);
  paint();
  const time = timeEaten(day, group);
  const form = h(
    "form",
    { class: "log" },
    field(
      "Amount",
      h("div", { class: "row amount" }, portions, h("span", {}, "portions")),
    ),
    preview,
    time.node,
    groupButtons(
      group,
      serverCopy(`/meals/${meal.id}`, "meal", (copy) =>
        href.meal(copy.id, href.logMeal(day, group, copy.id)),
      ),
    ),
  );
  const key = createId();
  form.addEventListener(
    "submit",
    busy(async (e) => {
      e.preventDefault();
      const to = group ?? e.submitter?.value ?? EATEN;
      let entries;
      const body = {
        uid: key.get(),
        day,
        group: to,
        meal_id: meal.id,
        portions: Number(portions.value),
        ...time.body(to),
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
    titleBar(meal.name, backFrom(day, group), [
      editLink(href.meal(meal.id), "meal"),
    ]),
    h("p", { class: "muted" }, contextLine(day, group)),
    form,
    list,
    panel.node,
  );
}

// Search filters, remembered per browser. A rule's `amount` is per 100 g in
// stored units (a change of energy unit keeps what it means), shown in
// this device's.
const sorts = () => [
  ["relevance", "Best match"],
  ["name", "Name"],
  ["energy", "Lowest energy"],
  ["protein", "Most protein"],
  ["protein_per_kcal", `Most protein per ${nutrient("energy").unit}`],
  ["fit", "Best fit for today"],
];
const FIT = "fit";
const FIT_HINT =
  "Closest to the protein, carbs and fat you have left, with a serving that fits the energy left.";
// The databases there are to search (only those holding a food).
const offered = () => meta.food_sources;
// A barcode as the API accepts it: digits, as many as its limits say.
const isBarcode = (code) => {
  const [min, max] = meta.limits.barcode_digits;
  return /^\d+$/u.test(code) && code.length >= min && code.length <= max;
};
const FILTERS_KEY = "food-filters";
// The labels the search filters by: every positive sublabel. A vitamin's
// or mineral's ("Source of iron") sit behind a chip of their own.
const filterLabels = () =>
  meta.labels.filter((l) => l.positive && l.kind !== "verdict");
// The verdicts, of which the search may keep to one.
const verdicts = () => meta.labels.filter((l) => l.kind === "verdict");
const isVitamin = (l) =>
  l.kind !== "low" &&
  ["Vitamins", "Minerals"].includes(nutrient(l.nutrient)?.category);
const noFilters = () => ({
  sources: [...offered()],
  rules: [],
  sort: "relevance",
  archived: false,
  tags: [],
});

// Saved filters, cleaned against what exists now, so a stale save can't
// break the search.
function loadFilters() {
  const saved = readJson(FILTERS_KEY, {});
  const f = noFilters();
  f.sources = searchedSources(offered(), saved);
  if (Array.isArray(saved.rules))
    f.rules = saved.rules
      .filter((r) => nutrient(r?.key) && ["min", "max"].includes(r?.dir))
      .map(({ key, dir, amount }) => ({
        key,
        dir,
        amount: typeof amount === "number" ? amount : null,
      }));
  if (sorts().some(([k]) => k === saved.sort)) f.sort = saved.sort;
  f.archived = saved.archived === true;
  if (Array.isArray(saved.tags))
    f.tags = saved.tags.filter((t) =>
      [...verdicts(), ...filterLabels()].some((l) => l.key === t),
    );
  return f;
}

// Best fit is for this visit only: a later one opens on Favourites. The
// databases are saved as those hidden, so one imported later is searched.
const saveFilters = ({ sources, ...f }) =>
  writeJson(FILTERS_KEY, {
    ...f,
    hidden: offered().filter((s) => !sources.includes(s)),
    sort: f.sort === FIT ? "relevance" : f.sort,
  });

// How many filters differ from the defaults.
const activeFilters = (f) =>
  offered().length -
  f.sources.length +
  f.rules.filter((r) => !isNil(r.amount)).length +
  (f.sort === "relevance" ? 0 : 1) +
  (f.archived ? 1 : 0) +
  f.tags.length;

// The current profile's search for `q` with filters `f` (ranked by its
// favourites and logging); best fit fits `day`.
function searchQuery(q, f, day) {
  const params = new URLSearchParams({ q });
  if (f.sources.length < offered().length)
    params.set("sources", f.sources.join(","));
  for (const dir of ["min", "max"]) {
    const rules = f.rules
      .filter((r) => r.dir === dir && !isNil(r.amount))
      .map((r) => `${r.key}:${r.amount}`);
    if (rules.length > 0) params.set(dir, rules.join(","));
  }
  if (f.sort !== "relevance") params.set("sort", f.sort);
  if (f.sort === FIT) params.set("day", day);
  if (f.archived) params.set("archived", "true");
  for (const t of f.tags) params.append("label", t);
  return scoped(`/foods?${params}`);
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
  // The positive sublabels as toggle chips in the panel (none on the
  // search's own view, which stays a search), the vitamins' and
  // minerals' behind a chip of their own: a food shows only with every
  // one picked. The button counts them with the other filters.
  const tags = h("div", { class: "chips" });
  const rating = h("div", { class: "chips" });
  const vitamins = h("div", {
    class: "chips",
    role: "group",
    "aria-label": "Vitamins & minerals",
  });
  // Open when one of them is picked.
  vitamins.hidden = !filterLabels().some(
    (l) => isVitamin(l) && filters.tags.includes(l.key),
  );
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
            ? offered().filter((s) => s === key || filters.sources.includes(s))
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
        value: inputValue(rule.key, rule.amount),
        "aria-label": "Rule amount",
        oninput: (ev) => {
          rule.amount =
            ev.target.value === ""
              ? null
              : nutrient(rule.key).store(Number(ev.target.value));
          changed(false);
        },
      }),
      removeButton("Remove rule", () => {
        filters.rules = filters.rules.filter((r) => r !== rule);
        changed();
      }),
    );
  function paint() {
    label();
    const labelChip = (l) =>
      chip(
        l.text,
        () => {
          filters.tags = filters.tags.includes(l.key)
            ? filters.tags.filter((k) => k !== l.key)
            : meta.labels
                .map((x) => x.key)
                .filter((k) => k === l.key || filters.tags.includes(k));
          changed();
        },
        { pressed: filters.tags.includes(l.key) },
      );
    // One verdict at a time: another replaces it.
    fill(
      rating,
      ...verdicts().map((l) =>
        chip(
          l.text,
          () => {
            const others = filters.tags.filter(
              (k) => !verdicts().some((v) => v.key === k),
            );
            filters.tags = filters.tags.includes(l.key)
              ? others
              : [l.key, ...others];
            changed();
          },
          { pressed: filters.tags.includes(l.key) },
        ),
      ),
    );
    fill(
      tags,
      ...filterLabels()
        .filter((l) => !isVitamin(l))
        .map((x) => labelChip(x)),
      chip(
        "Vitamins & minerals",
        () => {
          vitamins.hidden = !vitamins.hidden;
          paint();
        },
        { "aria-expanded": String(!vitamins.hidden) },
      ),
    );
    fill(
      vitamins,
      ...filterLabels()
        .filter((x) => isVitamin(x))
        .map((x) => labelChip(x)),
    );
    fill(
      panel,
      h("fieldset", {}, h("legend", {}, "Rating"), rating),
      h("fieldset", {}, h("legend", {}, "Labels"), tags, vitamins),
      h(
        "fieldset",
        {},
        h("legend", {}, "Databases"),
        offered().map((x) => sourceBox(x)),
      ),
      h(
        "fieldset",
        {},
        h("legend", {}, PER_100G),
        filters.rules.map(ruleRow),
        h(
          "button",
          {
            type: "button",
            onclick: () => {
              filters.rules.push({ key: "protein", dir: "min", amount: null });
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
          sorts()
            .filter(([k]) => k !== FIT || fit)
            .map(([k, text]) =>
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

const section = (title, list, none) =>
  h(
    "section",
    { class: "finder-section" },
    h("h2", {}, title),
    list.length > 0 ? h("ul", { class: "results card" }, list) : empty(none),
  );

// The foods Recent lists: the last few, not a second catalogue.
const RECENT = 8;

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
  // Known before it's needed: a tap made offline still finds the food.
  const waterFood = group ? get(scoped("/water-food")).catch(() => null) : null;
  const [favourites, recent, meals, yesterday, targets, recipes, made, water] =
    await Promise.all([
      get(scoped("/foods/favorites")),
      get(scoped("/foods/recent")),
      get("/meals"),
      group === PLANNED ? get(scoped(`/day/${shift(day, -1)}`)) : null,
      get(scoped("/targets")),
      own("recipe"),
      own("custom"),
      group ? null : get(scoped("/water-food")),
    ]);
  // Water is the app's food for logging water, not one you made.
  const customs = made.filter((f) => f.id !== water?.food?.id);
  const starred = new Set(favourites.map((f) => f.id));
  // Planning: what was eaten the day before, planned again in one tap (no
  // time: planned isn't eaten yet).
  const eatenYesterday = (yesterday?.groups ?? [])
    .filter((g) => g.name === EATEN)
    .flatMap((g) => g.entries)
    .filter((e) => e.kind !== "imported");
  const yesterdayKey = createId();
  const sameAsYesterday = busy(async () => {
    const what = plural(eatenYesterday.length, "food");
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
        { queue: true, label: `Same as yesterday · ${what}` },
      ));
    };
    if (!(await storedOrKept(write, day))) return;
    yesterdayKey.done();
    logged(day, group, what, entries);
  });
  const yesterdayRow =
    eatenYesterday.length > 0
      ? h(
          "ul",
          { class: "results card" },
          resultRow({
            onclick: sameAsYesterday,
            name: "Same as yesterday",
            // "≥" as the Diary says it: a food without energy, or a recipe
            // with an ingredient without (yesterday's `known.energy`).
            detail: `${plural(eatenYesterday.length, "food")} · ${
              eatenYesterday.some((e) => isNil(e.nutrients?.energy)) ||
              !isNil(yesterday.known?.energy)
                ? `≥${NBSP}`
                : ""
            }${kcal(
              summed(eatenYesterday.map((e) => e.nutrients ?? {})).energy ?? 0,
            )}`,
          }),
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
    resultRow({
      href: href.logMeal(day, group, m.id),
      name: m.name,
      detail: mealLine(m),
      extra: labelChips(m),
    });

  // Rows with a star. While browsing, starring redraws so Favourites follows;
  // in search results the star just flips in place.
  const starRow = (f, redraw) =>
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

  // Water first on a group's Add screen: how many ml, then logged.
  const waterRow = group
    ? h(
        "ul",
        { class: "results card" },
        resultRow({
          onclick: busy(() => addWater(day, group, waterFood)),
          name: "Water",
          detail: `How much, in ${unitOf("ml")}`,
        }),
      )
    : null;

  const browse = () => {
    return [
      yesterdayRow,
      waterRow,
      section(
        "Favourites",
        favourites.map((f) => starRow(f, true)),
        ["Star a food (", icon(STAR), ") to keep it here."],
      ),
      section(
        "Recent",
        recent.slice(0, RECENT).map((f) => starRow(f, true)),
        "Foods you log show up here.",
      ),
      section(
        "Meals",
        meals.map((x) => mealRow(x)),
        "A meal logs several foods at once.",
      ),
      group
        ? null
        : [
            section(
              "Your recipes",
              recipes.map((f) => starRow(f, true)),
              "Recipes you make show up here.",
            ),
            section(
              "Your foods",
              customs.map((f) => starRow(f, true)),
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
    const rows = [
      ...mine.map((x) => mealRow(x)),
      ...foods.map((f) => starRow(f, false)),
    ];
    if (isBarcode(q))
      rows.unshift(
        resultRow({
          onclick: busy(() => byBarcode(q, day, group, status)),
          name: `Look up barcode ${q}`,
          detail: "your foods, then Open Food Facts",
        }),
      );
    if (rows.length > 0) return h("ul", { class: "results card" }, rows);
    const make = h(
      "a",
      {
        class: "button",
        href: href.newFood({ name: q, ...(group ? { day, group } : {}) }),
      },
      `New food “${q}”`,
    );
    return activeFilters(filters)
      ? empty(["No matches with these filters. ", ui.clearButton()])
      : empty(["No matches. ", make]);
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
        icon(SCAN),
      ),
      ui.toggle,
    ),
    ui.panel,
    // A meal's photo is of what's eaten: not on Planned, nor the Foods tab.
    group === EATEN ? photoButton(day, group) : null,
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
