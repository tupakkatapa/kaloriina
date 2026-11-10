// Finding food: search with filters, logging a food, barcodes and
// scanning.

import { logged, serverCopy, storedOrKept } from "../actions.mjs";
import { api, createId, get, meta, offlineOr, scoped } from "../api.mjs";
import { eatenTime } from "../dates.mjs";
import { capitalized, isNil, PER_100G } from "../format.mjs";
import { go, href, leaving } from "../nav.mjs";
import {
  EATEN,
  inputValue,
  nutrient,
  ordered,
  PLANNED,
  searchedSources,
  SOURCES,
  withUnit,
} from "../nutrients.mjs";
import { labelChips } from "../nutrition-panel.mjs";
import { photoButton } from "../photos.mjs";
import { readJson, writeJson } from "../prefs.mjs";
import {
  actionRow,
  contextLine,
  foodRow,
  result,
  resultRow,
  section,
  starButton,
} from "../rows.mjs";
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
  modal,
  notify,
  num,
  PLUS,
  removeButton,
  SCAN,
  STAR,
  titleBar,
  undoable,
} from "../ui.mjs";
import { unitOf } from "../units.mjs";
import { addWater } from "../water.mjs";
import { amountView, repeatFrom } from "./amount-view.mjs";
import { addText } from "../text-entry.mjs";

// Back from logging: the group's Add screen, or the Foods tab.
const backFrom = (day, group) => (group ? href.add(day, group) : href.foods());

// `params`: `q` searched at once; `replace`, a text entry's id: only
// finding its food, which then takes its place.
export async function add(day, group, params = new URLSearchParams()) {
  const replace = params.get("replace");
  return h(
    "section",
    {},
    titleBar(
      replace ? "Find the food" : `Add to ${group}`,
      replace ? href.entry(replace) : href.day(day),
    ),
    await finder({ day, group, q: params.get("q") ?? "", replace }),
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

// Log a food or recipe (`amountView`), starting from the amount last
// logged of it. With `group` it comes from a group's Add screen; without,
// from the Foods tab, which offers both groups.
export async function log(day, group, id, params = new URLSearchParams()) {
  const replace = params.get("replace");
  // Finding a text entry's food: Back returns to its search.
  const q = replace ? params.get("q") : null;
  const [food, favorites, targets, last] = await Promise.all([
    get(`/foods/${id}`),
    get(scoped("/foods/favorites")),
    // Only what 100 kcal gives needs them: none, and it isn't shown.
    get(scoped("/targets")).catch(offlineOr(null)),
    // Without it, the food's default amount.
    get(scoped(`/foods/${id}/last`)).catch(offlineOr(null)),
  ]);
  const here = href.log(day, group, food.id, { replace, q });
  const kind = food.kind === "recipe" ? "recipe" : "food";
  const view = amountView({
    food,
    start: last,
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
  // Into Planned nothing is eaten yet: no time to ask. Finding a text
  // entry's food, its time and group stay its own, and a text repeats
  // nothing.
  view.timeRow.hidden = group === PLANNED || Boolean(replace);
  view.repeat.closest(".field").hidden = Boolean(replace);
  const time = timeBody(day, group, view.time);
  const key = createId();
  const submit = busy(async (e) => {
    e.preventDefault();
    if (replace) {
      // Online only, as an entry's edits are; no Undo (it would delete).
      await api("PATCH", scoped(`/entries/${replace}`), {
        food_id: food.id,
        ...view.amount.body(),
      });
      go(href.day(day));
      notify(`Matched to ${food.name}`);
      return;
    }
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
    titleBar(
      food.name,
      replace ? href.add(day, group, { replace, q }) : backFrom(day, group),
      [
        starButton(
          food,
          favorites.some((f) => f.id === food.id),
          `Favourite ${food.name}`,
        ),
        editLink(href.food(food, here), kind),
      ],
    ),
    h(
      "form",
      { class: "log", onsubmit: submit },
      view.head,
      view.fields,
      // The copy's editor saves back to logging the copy.
      replace
        ? h(
            "div",
            { class: "actions" },
            h("button", { class: "primary" }, "Use this food"),
          )
        : groupButtons(
            group,
            serverCopy(`/foods/${food.id}`, kind, (copy) =>
              href.food(copy, href.log(day, group, copy.id)),
            ),
          ),
    ),
    view.tail,
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
    // One rule a nutrient each way: a later row for it says what counts.
    const rules = new Map(
      f.rules
        .filter((r) => r.dir === dir && !isNil(r.amount))
        .map((r) => [r.key, r.amount]),
    );
    if (rules.size > 0)
      params.set(
        dir,
        [...rules].map(([key, amount]) => `${key}:${amount}`).join(","),
      );
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
            // Its amount was in the last nutrient's unit.
            rule.amount = null;
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

// The foods Recent lists: the last few, not a second catalogue.
const RECENT = 8;

// Which of browsing's folds this device left open (`{key: true}`).
const FOLDS_KEY = "finder-folds";

// One of browsing's lists folded away: "Title (n)", open as this device
// left it (closed at first), or when `open`.
function fold(key, title, rows, none, open) {
  const node = h(
    "details",
    {
      class: "fold finder-fold",
      open: open || readJson(FOLDS_KEY, {})[key] === true,
    },
    h(
      "summary",
      {
        // Before the toggle: it is about to flip.
        onclick: () =>
          writeJson(FOLDS_KEY, {
            ...readJson(FOLDS_KEY, {}),
            [key]: !node.open,
          }),
      },
      `${title} (${rows.length})`,
    ),
    rows.length > 0 ? h("ul", { class: "results card" }, rows) : empty(none),
  );
  return node;
}

// Find food to log: suggestions, then favourites and recent folded away,
// until you search; results with filters after, a text entry of what was
// searched, and with nothing found a way to make the food. With `group` it
// logs there; without (the Foods tab) the log screen offers both groups.
// `q` is searched at once; `replace` (a text entry's id) only finds a food
// for it: no quick logs, barcodes, water or text.
export async function finder({ day, group, q: start = "", replace = null }) {
  const filters = loadFilters();
  const status = h("p", { role: "status" });
  const results = h("div", { class: "finder-results" });
  const logHref = (f) =>
    href.log(day, group, f.id, {
      replace,
      q: replace ? input.value.trim() : null,
    });
  const pick = (f) => go(logHref(f));
  // Loaded once; a star toggled here updates them.
  // The Foods tab also lists your own recipes and foods by name (archived
  // ones hidden), so one never logged is found without its name.
  const own = (sources) =>
    group ? [] : get(scoped(`/foods?q=&sources=${sources}&sort=name`));
  // Known before it's needed: a tap made offline still finds the food.
  const waterFood = group ? get(scoped("/water-food")).catch(() => null) : null;
  // Suggested at now when that's Eaten today: the Foods tab logs there too.
  const now = eatenTime(day, group ?? EATEN);
  const [favorites, recent, suggestions, targets, recipes, made, water] =
    await Promise.all([
      get(scoped("/foods/favorites")),
      get(scoped("/foods/recent")),
      get(
        scoped(
          `/foods/suggestions?${new URLSearchParams({ day, ...(now ? { time: now } : {}) })}`,
        ),
      ).catch(() => []),
      get(scoped("/targets")),
      own("recipe"),
      own("custom"),
      group ? null : get(scoped("/water-food")),
    ]);
  // Water is the app's food for logging water, not one you made.
  const customs = made.filter((f) => f.id !== water?.food?.id);
  const starred = new Set(favorites.map((f) => f.id));
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
    value: start,
    oninput: () => later(150),
  });

  // Rows with a star. While browsing, starring redraws so Favourites follows;
  // in search results the star just flips in place.
  const starRow = (f, redraw) =>
    foodRow(f, pick, {
      starred: starred.has(f.id),
      onChange: (on) => {
        if (on) {
          starred.add(f.id);
          favorites.push(f);
        } else {
          starred.delete(f.id);
          favorites.splice(
            favorites.findIndex((x) => x.id === f.id),
            1,
          );
        }
        if (redraw) refresh();
      },
    });

  // Why a suggestion, and hiding it: through the day, or until shown
  // again (Profile). Online only, as entry edits; Undo shows it again.
  const whyDialog = (suggestion) => {
    const { food: f, reasons } = suggestion;
    const path = scoped(`/suggestions/hidden/${f.id}`);
    const hide = (until, message) =>
      busy(async () => {
        await api("PUT", path, until ? { until } : {});
        close();
        const at = suggestions.indexOf(suggestion);
        // Hidden already, by the dialog's other button.
        if (at < 0) return;
        suggestions.splice(at, 1);
        refresh();
        undoable(message, async () => {
          await api("DELETE", path);
          suggestions.splice(at, 0, suggestion);
          refresh();
        });
      });
    const { close } = modal(
      { class: "confirm", "aria-labelledby": "why-title" },
      [
        h("h2", { id: "why-title" }, `Why ${f.name}?`),
        reasons.length > 0
          ? h(
              "ul",
              {},
              reasons.map((r) => h("li", {}, r)),
            )
          : null,
        h(
          "div",
          { class: "actions" },
          h("button", { type: "button", onclick: () => close() }, "Close"),
          h(
            "button",
            {
              type: "button",
              onclick: hide(day, `Won't suggest ${f.name} today`),
            },
            "Not today",
          ),
          h(
            "button",
            { type: "button", onclick: hide(null, `Won't suggest ${f.name}`) },
            "Never suggest",
          ),
        ),
      ],
    );
  };

  // A suggestion: "?" for why, and once logged before, "+" logging that
  // amount again in one tap (into the group, or from the Foods tab into
  // Eaten). Tapping it logs with that amount to start from.
  const suggestionRow = (suggestion) => {
    const { food: f, last } = suggestion;
    const key = createId();
    const again = busy(async () => {
      const to = group ?? EATEN;
      const time = eatenTime(day, to);
      const body = {
        uid: key.get(),
        day,
        group: to,
        food_id: f.id,
        // A serving since removed: its grams.
        ...(last.serving && f.servings.some((s) => s.label === last.serving)
          ? { serving: last.serving, quantity: last.quantity }
          : { grams: last.grams }),
        ...(time ? { time } : {}),
      };
      let entries;
      const write = async () => {
        ({ entries } = await api("POST", scoped("/entries"), body, {
          queue: true,
          label: f.name,
        }));
      };
      if (!(await storedOrKept(write, day))) return;
      key.done();
      logged(day, to, f.name, entries);
    });
    const why = h(
      "button",
      {
        type: "button",
        class: "icon",
        "aria-label": `Why ${f.name}?`,
        onclick: () => whyDialog(suggestion),
      },
      "?",
    );
    return actionRow(
      result({
        href: logHref(f),
        name: f.name,
        extra: labelChips(f),
      }),
      why,
      last && !replace
        ? h(
            "button",
            {
              type: "button",
              class: "icon",
              "aria-label": `Add ${f.name} as last time`,
              onclick: again,
            },
            icon(PLUS),
          )
        : null,
    );
  };

  // First on a group's Add screen: water (how many ml, then logged), and a
  // one-off item, named and never a food.
  const waterRow =
    group && !replace
      ? h(
          "ul",
          { class: "results card" },
          resultRow({
            onclick: busy(() => addWater(day, group, waterFood)),
            name: "Water",
            detail: `How much, in ${unitOf("ml")}`,
          }),
          resultRow({
            cls: "as-text",
            onclick: () => addText(day, group, ""),
            name: "One-off item",
            detail: "Not saved as a food; kcal if you know them",
          }),
        )
      : null;

  // Suggestions open; the rest folded. With none, the first list that has
  // anything opens instead.
  const browse = () => {
    const folds = [
      [
        "favourites",
        "Favourites",
        favorites.map((f) => starRow(f, true)),
        ["Star a food (", icon(STAR), ") to keep it here."],
      ],
      [
        "recent",
        "Recent",
        recent.slice(0, RECENT).map((f) => starRow(f, true)),
        "Foods you log show up here.",
      ],
      ...(group
        ? []
        : [
            [
              "recipes",
              "Your recipes",
              recipes.map((f) => starRow(f, true)),
              "Recipes you make show up here.",
            ],
            [
              "foods",
              "Your foods",
              customs.map((f) => starRow(f, true)),
              "Foods you make show up here.",
            ],
          ]),
    ];
    const opened =
      suggestions.length > 0
        ? null
        : folds.find(([, , rows]) => rows.length > 0)?.[0];
    return [
      waterRow,
      suggestions.length > 0
        ? section(
            "Suggestions",
            suggestions.map((x) => suggestionRow(x)),
          )
        : null,
      folds.map(([key, title, rows, none]) =>
        fold(key, title, rows, none, key === opened),
      ),
    ];
  };

  async function search(q) {
    let foods;
    try {
      foods = await get(searchQuery(q, filters, day));
    } catch (err) {
      // The query itself refused (too long) is the query's to fix.
      if (err.status !== 400 || err.field === "q") throw err;
      // A filter the server no longer accepts: start over rather than stall.
      Object.assign(filters, noFilters());
      saveFilters(filters);
      ui.paint();
      notify("Reset the search filters");
      foods = await get(searchQuery(q, filters, day));
    }
    const rows = foods.map((f) => starRow(f, false));
    if (isBarcode(q) && !replace)
      rows.unshift(
        resultRow({
          onclick: busy(() => byBarcode(q, day, group, status)),
          name: `Look up barcode ${q}`,
          detail: "your foods, then Open Food Facts",
        }),
      );
    // What was searched, logged as words: a group's Add screen only.
    const typed =
      q && group && !replace
        ? h(
            "ul",
            { class: "results card" },
            resultRow({
              cls: "as-text",
              onclick: () => addText(day, group, q),
              name: `Add “${q}” as a one-off`,
              detail: "no food, kcal if you know them",
              "aria-label": `Add “${q}” as a one-off`,
            }),
          )
        : null;
    if (rows.length > 0)
      return [h("ul", { class: "results card" }, rows), typed];
    const make = h(
      "a",
      {
        class: "button",
        href: href.newFood({
          name: q,
          ...(group ? { day, group } : {}),
          replace,
        }),
      },
      `New food “${q}”`,
    );
    return [
      activeFilters(filters)
        ? empty(["No matches with these filters. ", ui.clearButton()])
        : empty(["No matches. ", make]),
      typed,
    ];
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
      replace
        ? null
        : h(
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
    group === EATEN && !replace ? photoButton(day, group) : null,
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
