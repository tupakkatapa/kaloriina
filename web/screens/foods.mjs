// The Foods tab, and the editors of foods, recipes and meals.

import { copyButton, copyForm, saveOnce } from "../actions.mjs";
import { amountControl, byVolume, PORTION, weightText } from "../amount.mjs";
import { api, get, meta, scoped } from "../api.mjs";
import { recipeKnown, recipePer100, wholeOf } from "../coverage.mjs";
import { today } from "../dates.mjs";
import { isNil, NBSP, PER_100G, plural, qty } from "../format.mjs";
import { weightGuessed } from "../health.mjs";
import { go, href, safeBack } from "../nav.mjs";
import {
  byCategory,
  guessed,
  inputValue,
  mainKeys,
  netFromTotal,
  nutrient,
  ordered,
  per100Basis,
  per100Of,
  registry,
  scaled,
  shownEnergy,
  typedCarbs,
  withUnit,
} from "../nutrients.mjs";
import { nutritionPanel } from "../nutrition-panel.mjs";
import { favoriteStar, foodRow, searchFoods } from "../rows.mjs";
import { servingsEditor } from "../servings.mjs";
import {
  busy,
  confirmDialog,
  editor,
  field,
  fill,
  h,
  nameInput,
  notify,
  num,
  numberOrNull,
  picker,
  POSITIVE,
  removeButton,
  titleBar,
} from "../ui.mjs";
import { labelStyle } from "../units.mjs";
import { finder } from "./finder.mjs";

export async function foods() {
  return h(
    "section",
    {},
    titleBar("Foods"),
    h(
      "div",
      { class: "actions" },
      h("a", { class: "button", href: href.newFood() }, "New food"),
      h("a", { class: "button", href: href.recipe("new") }, "New recipe"),
      h("a", { class: "button", href: href.meal("new") }, "New meal"),
    ),
    await finder({ day: today(), group: null }),
  );
}

// What uses a food or recipe (`/foods/{id}/usage`), or null when that can't
// be read (offline): the questions below only inform (the save says how many
// diary entries it changed), so then none is asked.
const usageOf = (id) => get(`/foods/${id}/usage`).catch(() => null);

// "2 recipes and 1 meal": what holds it, or "" for nothing.
const holders = (n) =>
  [
    n.recipes ? plural(n.recipes, "recipe") : null,
    n.meals ? plural(n.meals, "meal") : null,
  ]
    .filter(Boolean)
    .join(" and ");

// "Logged 12 times and used in 2 recipes.", or "" when nothing uses it.
const usedText = (n) => {
  const text = [
    n.entries ? `logged ${plural(n.entries, "time")}` : null,
    holders(n) ? `used in ${holders(n)}` : null,
  ]
    .filter(Boolean)
    .join(" and ");
  return text && `${text[0].toUpperCase()}${text.slice(1)}.`;
};

// Before saving food or recipe `id` (`name`) with its values changed
// (`changed`) or servings removed (`gone`, their labels): say what that does
// to what uses it, and ask. Diary entries keep their amounts but follow the
// food's values, so only changed values matter to them; recipes and meals
// follow the food too, and an item measured in a removed serving keeps its
// grams. True to save.
async function confirmChange(id, name, { changed, gone, recipe }) {
  if (!changed && gone.length === 0) return true;
  const n = await usageOf(id);
  const held = n ? holders(n) : "";
  if (!n || !(held || (changed && n.entries))) return true;
  const one = n.recipes + n.meals === 1;
  return confirmDialog(`Save changes to ${name}?`, {
    detail: [
      usedText(n),
      changed && n.entries
        ? "Diary entries with this food follow its values."
        : null,
      changed && held ? `The ${held} will use the new values.` : null,
      held && gone.length > 0
        ? `Items measured in ${gone.join(", ")} keep their grams.`
        : null,
      recipe && held
        ? `To leave ${one ? "it as it is" : "them as they are"}, Cancel and use Copy: it saves your changes as a new recipe.`
        : null,
    ]
      .filter(Boolean)
      .join(" "),
    confirm: "Save",
    danger: false,
  });
}

// Labels of `before`'s servings `after` no longer has.
const goneServings = (before, after) =>
  before
    .map((s) => s.label)
    .filter((label) => !after.some((s) => s.label === label));

// Archiving instead of deleting: a food in use stays behind what uses it,
// so it's hidden from search, not removed. `put(change)` saves the change;
// the editor is then shown afresh. Archiving one in use asks first.
function archiveButton(food, put, shell) {
  return h(
    "button",
    {
      type: "button",
      onclick: busy(async () => {
        const n = food.archived ? null : await usageOf(food.id);
        if (
          n &&
          usedText(n) &&
          !(await confirmDialog(`Archive ${food.name}?`, {
            detail: `${usedText(n)} Archiving hides it from search; your diary, recipes and meals keep it.`,
            confirm: "Archive",
            danger: false,
          }))
        )
          return;
        const saved = await put({ archived: !food.archived });
        shell().markClean();
        go(location.hash);
        notify(
          saved.archived
            ? `Archived ${saved.name}: hidden from search`
            : `Unarchived ${saved.name}`,
        );
      }),
    },
    food.archived ? "Unarchive" : "Archive",
  );
}

// Delete or Archive, by what the server says of food `id` (`usage`, null
// offline: archived then): nothing but favourites using it, it's deleted
// (they go with it); else it's archived, or unarchived. `put` as
// `archiveButton`'s.
const removal = (food, usage, put, shell) => ({
  secondary:
    usage?.deletable && !food.archived ? [] : [archiveButton(food, put, shell)],
  remove: usage?.deletable
    ? {
        ask: `Delete ${food.name}?`,
        detail: usage.favorites ? "It leaves your favourites too." : null,
        run: () => api("DELETE", `/foods/${food.id}`),
        after: href.foods(),
        done: `Deleted ${food.name}`,
      }
    : null,
});

// Per-100 g values within what 100 g can hold (`meta.limits.per100_max`,
// by stored unit), as the server checks them: the first over it is thrown
// at its field, so the form says so before it asks anything.
// `basis` is the serving they were typed per, if any.
function checkCaps(per100, basis) {
  for (const [key, v] of Object.entries(per100)) {
    const { unit } = meta.nutrients.find((n) => n.key === key);
    const max = meta.limits.per100_max[unit];
    if (v <= max) continue;
    const n = nutrient(key);
    throw Object.assign(
      new Error(
        `${n.label} must be at most ${qty(n.show(max), n.unit)} per 100${NBSP}g${basis ? `; check the weight of “${basis}”` : ""}`,
      ),
      { field: key },
    );
  }
}

// Merging a duplicate into this food or recipe starts here.
const mergeLink = (id) =>
  h("a", { class: "button", href: href.merge(id) }, "Merge…");

// Open Food Facts' form for a product it doesn't have (asks you to sign in
// there first). Its product page for an unknown code only says so.
const offAdd = (code) =>
  `https://world.openfoodfacts.org/cgi/product.pl?${new URLSearchParams({ type: "add", code })}`;

// Where a food or recipe editor returns to: the address it was opened
// from (`?back=`), the log screen it came from (`?day&group`), or itself.
function returnTo(params, saved, self) {
  const back = safeBack(params.get("back"));
  if (back) return back;
  const day = params.get("day");
  if (day) return href.log(day, params.get("group"), saved.id);
  return self(saved);
}

// A food's or recipe's category, from the server's list: what the built-in
// habits (sweets, fruit and vegetables…) count it under.
const categorySelect = (value) =>
  h(
    "select",
    { name: "category" },
    [["", "None"], ...meta.food_categories.map((c) => [c.key, c.label])].map(
      ([key, label]) =>
        h("option", { value: key, selected: key === (value ?? "") }, label),
    ),
  );

// The current profile's targets, for what 100 kcal gives: `paint(targets)`
// once they arrive, so an editor neither waits nor fails for them (none
// shown when they can't be read).
const withTargets = (paint) => get(scoped("/targets")).then(paint, () => {});

// A sugary drink is a drink of itself, as the server derives it
// (src/model/food.rs `drink_by_kind`).
const DRINK = "sugary_drinks";

// One carbohydrate is typed, as the label reads it (net on the EU label,
// total on the US one); the other follows from it and fibre. Nor is any
// nutrient the server sums (`derived`: EPA+DHA) typed.
const isTyped = (n) =>
  (!["carbs", "net_carbs"].includes(n.key) || n.key === typedCarbs()) &&
  !n.derived;

// An input's value: energy whole in kJ, as everywhere it shows (an
// untouched field still saves the kcal it had); the rest as `inputValue`.
const shownValue = (key, stored) =>
  key === "energy" && nutrient(key).unit === "kJ" && !isNil(stored)
    ? String(shownEnergy(stored))
    : inputValue(key, stored);

export async function foodEditor(id, params) {
  const isNew = id === "new";
  const [food, usage] = await Promise.all([
    isNew
      ? {
          name: params.get("name") ?? "",
          brand: "",
          barcode: params.get("barcode") ?? "",
          per100: {},
          servings: [],
          archived: false,
        }
      : get(`/foods/${id}`),
    isNew ? null : usageOf(id),
  ]);
  if (food.kind === "recipe") {
    location.replace(href.recipe(id));
    return null;
  }
  // Fineli's name and values are its own: shown, not edited.
  const fineli = food.source === "fineli";
  // Drink, derived; a tick changed is yours (one tick: ADR 0020).
  const touched = new Set();
  const ticks = {
    drink: h("input", {
      type: "checkbox",
      name: "drink",
      checked: Boolean(food.drink),
      onchange: () => touched.add("drink"),
    }),
  };
  const asTicked = () => ({ ...food, drink: ticks.drink.checked });
  const name = nameInput({
    max: meta.limits.name,
    value: food.name,
    disabled: fineli,
  });
  const brand = nameInput({
    max: meta.limits.name,
    name: "brand",
    required: false,
    value: food.brand ?? "",
    disabled: fineli,
  });
  const barcode = h("input", {
    name: "barcode",
    value: food.barcode ?? "",
    inputMode: "numeric",
    pattern: "[0-9]*",
  });
  const servings = servingsEditor(food.servings);
  const editable = registry.filter((x) => isTyped(x));
  const inputs = Object.fromEntries(
    editable.map((n) => [
      n.key,
      num({
        name: n.key,
        // Fineli's energy is converted from kJ: shown to 1 decimal.
        value:
          fineli && n.key === "energy" && !isNil(food.per100.energy)
            ? String(
                Math.round(nutrient("energy").show(food.per100.energy) * 10) /
                  10,
              )
            : shownValue(n.key, food.per100[n.key]),
        disabled: fineli,
      }),
    ]),
  );
  // Energy only in this device's unit (kcal or kJ), as everywhere.
  const fields = (list) =>
    list.map((n) => field(withUnit(n), inputs[n.key], { inline: true }));
  // Values per: 100 g, or one of your servings (its row, `basisRow`; a
  // rename keeps it). Per 100 g stays what's stored; the inputs show the
  // values of `viewGrams`, written from per-100 g `base` as `shown`. An
  // input still reading what was written gives back its `base` value as it
  // was, so a switch or an untouched field never re-derives it (D10).
  // The US label reads per serving: a food without a basis opens at its
  // first serving there (saved as its basis), as its label would.
  const own = servings.own();
  let basisRow =
    own.find((s) => s.label === food.basis?.serving)?.row ??
    (labelStyle() === "us" && !fineli && !food.basis
      ? own.find((s) => s.label && s.grams > 0)?.row
      : null) ??
    null;
  let viewGrams = 100;
  let base = food.per100;
  let shown = {};
  const remember = () => {
    shown = Object.fromEntries(
      Object.entries(inputs).map(([k, input]) => [k, input.value]),
    );
  };
  const write = (values, grams) => {
    const view = scaled(values, grams);
    for (const [k, input] of Object.entries(inputs))
      input.value = shownValue(k, view[k]);
    base = values;
    viewGrams = grams;
    remember();
  };
  const per100 = () => {
    const typed = {};
    for (const [k, input] of Object.entries(inputs))
      if (input.value !== "") typed[k] = nutrient(k).store(Number(input.value));
    const out = viewGrams === 100 ? typed : per100Of(typed, viewGrams);
    for (const k of Object.keys(out))
      if (inputs[k].value === shown[k] && !isNil(base[k])) out[k] = base[k];
    // US: total carbs typed, net sent only with fibre known (total less
    // fibre); without fibre the net stays unknown. Both left as shown, the
    // stored net goes back.
    if (inputs.carbs && !isNil(out.carbs)) {
      const kept =
        inputs.carbs.value === shown.carbs &&
        inputs.fiber.value === shown.fiber &&
        !isNil(base.net_carbs);
      const net = kept ? base.net_carbs : netFromTotal(out.carbs, out.fiber);
      if (!isNil(net)) out.net_carbs = net;
    }
    // The carbohydrate this label doesn't type (a total on the EU label,
    // the net on the US one), given alone, stays while the typed is unknown.
    const other = typedCarbs() === "carbs" ? "net_carbs" : "carbs";
    if (isNil(out[typedCarbs()]) && !isNil(base[other]))
      out[other] = base[other];
    return out;
  };
  const basisOf = () => servings.own().find((s) => s.row === basisRow);
  // The servings to choose from: named and weighed, and the chosen one
  // while its weight is being retyped (read at its last weight).
  const choices = () =>
    servings
      .own()
      .filter((s) => s.row === basisRow || (s.label && s.grams > 0));
  const basisSelect = h("select", {
    name: "basis",
    "aria-label": "Values per",
    // Before the form's own input listener: it rebuilds the options.
    oninput: () => {
      const values = per100();
      const pick =
        basisSelect.value === "" ? null : choices()[Number(basisSelect.value)];
      basisRow = pick?.row ?? null;
      write(values, pick ? pick.grams || viewGrams : 100);
    },
  });
  const guess = h("input", {
    type: "checkbox",
    name: "basis_estimated",
    checked: Boolean(food.basis?.estimated),
  });
  const guessHint = h("small", { class: "muted" });
  const guessField = h(
    "div",
    { class: "field" },
    h("label", { class: "check" }, guess, " Weight is a guess"),
    guessHint,
  );
  const estimated = () => Boolean(basisRow) && guess.checked;
  // Follow the servings: a removed basis serving puts the values back per
  // 100 g (at its last weight); its new weight keeps the numbers typed per
  // it, and per 100 g follows (D3).
  const syncBasis = () => {
    const now = basisOf();
    if (basisRow && !now) {
      basisRow = null;
      write(per100(), 100);
    } else if (now?.grams > 0 && now.grams !== viewGrams) {
      base = {};
      viewGrams = now.grams;
    }
    fill(
      basisSelect,
      h("option", { value: "" }, per100Basis(asTicked()).replace("Per ", "")),
      choices().map((s, i) =>
        h(
          "option",
          { value: String(i), selected: s.row === basisRow },
          `${s.label || "Unnamed"} (${qty(s.grams || viewGrams, "g")})`,
        ),
      ),
    );
    basisSelect.value = basisRow
      ? String(choices().findIndex((s) => s.row === basisRow))
      : "";
    guessField.hidden = !basisRow;
    const per = now?.label || "serving";
    guessHint.textContent = `Use when only per-item values are published. Logged nutrients stay exact per ${per}; gram counts (habits, traffic lights) use the guess.`;
  };
  if (basisRow) write(food.per100, basisOf().grams);
  else remember();
  syncBasis();
  // As the form reads them before any edit: what a change is measured by.
  const loadedValues = JSON.stringify(per100());
  // Live: the health cues, and the other view of what's typed: per 100 g
  // when typed per a serving, else the default serving's values.
  const panel = nutritionPanel();
  let targets = null;
  const repaint = () => {
    const serving = servings.value().find((s) => s.label && s.grams > 0);
    const values = per100();
    const basis = per100Basis(asTicked());
    panel.paint(
      basisRow
        ? [
            {
              label: estimated() ? `${basis} (≈ estimated weight)` : basis,
              values,
            },
          ]
        : serving
          ? [
              {
                label: `${serving.label} (${qty(serving.grams, "g")})`,
                values: scaled(values, serving.grams),
              },
            ]
          : [],
      {
        per100: values,
        drink: ticks.drink.checked,
        basis,
        grams: null,
        targets,
        estimated: estimated(),
      },
    );
  };
  const category = categorySelect(food.category);
  const send = saveOnce("/foods");
  const removing = isNew
    ? { secondary: [], remove: null }
    : removal(
        food,
        usage,
        (change) => send(body(change), food.id),
        () => shell,
      );
  const body = (change = {}) => ({
    // Fineli's own fields go back as they came.
    name: fineli ? food.name : name.value,
    brand: fineli ? food.brand : brand.value || null,
    barcode: barcode.value || null,
    per100: fineli ? food.per100 : per100(),
    basis: basisRow
      ? { serving: basisOf().label, estimated: guess.checked }
      : null,
    category: category.value || null,
    servings: servings.value(),
    archived: food.archived,
    ...Object.fromEntries([...touched].map((k) => [k, ticks[k].checked])),
    ...(isNew ? {} : { rev: food.rev }),
    ...change,
  });
  const shell = editor({
    title: isNew ? "New food" : food.name,
    action: isNew ? null : await favoriteStar(food),
    back:
      safeBack(params.get("back")) ??
      (params.get("day")
        ? href.add(params.get("day"), params.get("group"))
        : isNew
          ? href.foods()
          : href.log(today(), null, food.id)),
    body: [
      params.get("notfound")
        ? h(
            "p",
            { class: "note" },
            "Not in your foods or Open Food Facts. Enter it from its label.",
            food.barcode
              ? [
                  " · ",
                  h(
                    "a",
                    {
                      href: offAdd(food.barcode),
                      target: "_blank",
                      rel: "noopener",
                    },
                    "Add it on Open Food Facts",
                  ),
                ]
              : null,
          )
        : null,
      food.source === "off"
        ? h("p", { class: "muted" }, "From Open Food Facts; check the values.")
        : null,
      // CC BY 4.0 asks for credit wherever the data shows.
      fineli
        ? h(
            "p",
            { class: "muted" },
            "From ",
            h("a", { href: "https://fineli.fi" }, "Fineli"),
            ", THL, CC BY 4.0. Its name and values are Fineli's; servings, barcode and archiving are yours.",
          )
        : null,
      food.archived
        ? h("p", { class: "note" }, "Archived: hidden from search.")
        : null,
      field("Name", name),
      field("Brand", brand),
      field("Barcode", barcode),
      field("Category", category, {
        hint: "Counts toward the built-in habit of the same kind.",
      }),
      h(
        "div",
        { class: "field" },
        h(
          "label",
          { class: "check" },
          ticks.drink,
          fineli ? " Drink" : ` Drink (values per 100${NBSP}ml)`,
        ),
      ),
      servings.node,
      h(
        "fieldset",
        {},
        // Fineli's values are its own, per 100 g.
        h("legend", {}, fineli ? PER_100G : ["Values per ", basisSelect]),
        guessField,
        fields(
          mainKeys()
            .map((x) => nutrient(x))
            .filter((x) => isTyped(x)),
        ),
        h(
          "details",
          { class: "fold" },
          h("summary", {}, "Other nutrients"),
          h(
            "div",
            { class: "fold-fields" },
            byCategory(
              ordered()
                .slice(mainKeys().length)
                .filter((x) => isTyped(x)),
            ).map(([cat, list]) => [
              h("h3", { class: "category" }, cat),
              fields(list),
            ]),
          ),
        ),
      ),
    ],
    remove: removing.remove,
    secondary: isNew
      ? []
      : [
          ...removing.secondary,
          copyForm(
            "/foods",
            body,
            () => shell,
            href.food,
            () => ({
              brand: fineli ? null : brand.value || null,
              barcode: null,
              drink: ticks.drink.checked,
            }),
          ),
          mergeLink(id),
        ],
    save: async () => {
      if (!fineli) checkCaps(per100(), basisOf()?.label);
      // Without energy a food counts as unknown in every total: ask once.
      if (
        !fineli &&
        inputs.energy.value === "" &&
        !(await confirmDialog("Save without energy?", {
          detail: "It will count as unknown energy wherever it's logged.",
          confirm: "Save",
          danger: false,
        }))
      )
        return;
      if (isNew) return send(body());
      if (
        !(await confirmChange(id, food.name, {
          changed: JSON.stringify(per100()) !== loadedValues,
          gone: goneServings(food.servings, servings.value()),
        }))
      )
        return;
      return send(body(), food.id);
    },
    after: (saved) => returnTo(params, saved, (x) => href.food(x)),
    aside: panel.node,
  });
  shell.form.addEventListener("input", () => {
    syncBasis();
    repaint();
  });
  repaint();
  withTargets((t) => {
    targets = t;
    repaint();
  });
  return shell.node;
}

// A food as a recipe's or meal's item holds it: what the amount and the
// live panel read, coverage (`known`, `borne`, `drink`) included, as the
// server's items carry it. One shape for an item picked and one restored.
const itemOf = (f) => ({
  food_id: f.id,
  name: f.name,
  source: f.source,
  kind: f.kind,
  per100: f.per100,
  servings: f.servings,
  makes: f.makes,
  known: f.known,
  borne: f.borne,
  drink: f.drink,
  weight_estimated: guessed(f),
});

// Items of a recipe or meal: food, amount (a quantity of one of its servings,
// or grams) and, for a serving, its weight per row. `onChange` runs after every
// add, remove or amount edit; `parts` gives what the nutrition panel needs; a
// food's name opens its editor through `onEdit`. A new item (`start` null)
// begins as logging would: the food's default serving.
function itemsEditor(initial, onChange = () => {}, onEdit = null) {
  const list = h("ul", { class: "items" });
  // Row → {item, amount}.
  const items = new Map();
  const addItem = (item, start = item) => {
    const weight = h("span", { class: "weight muted" });
    const ml = byVolume(item);
    // Typed by weight, the amount says it already.
    const changed = () => {
      weight.textContent = amount.body().serving
        ? weightText(amount.grams(), guessed(item), null, ml)
        : "";
      onChange();
    };
    const amount = amountControl(item, start, changed, item.name);
    const row = h(
      "li",
      { class: "item" },
      onEdit
        ? h(
            "button",
            {
              type: "button",
              class: "name link",
              "aria-label": `Edit ${item.name}`,
              onclick: () => onEdit(item),
            },
            item.name,
          )
        : h("span", { class: "name" }, item.name),
      weight,
      removeButton(`Remove ${item.name}`, () => {
        row.remove();
        items.delete(row);
        onChange();
      }),
      amount.node,
    );
    items.set(row, { item, amount });
    list.append(row);
    changed();
  };
  initial.forEach((item) => addItem(item));
  const node = h(
    "fieldset",
    {},
    h("legend", {}, "Items"),
    list,
    picker({
      placeholder: "Search foods to add",
      search: searchFoods,
      row: foodRow,
      onPick: (f) => addItem(itemOf(f), null),
    }),
  );
  // Each item as read back: its grams, and the serving and quantity they
  // came from (null for grams).
  const rows = () =>
    [...items.values()].map(({ item, amount }) => ({
      ...item,
      serving: null,
      quantity: null,
      ...amount.body(),
      grams: amount.grams() || 0,
    }));
  const value = () =>
    [...items.values()].map(({ item, amount }) => ({
      food_id: item.food_id,
      ...amount.body(),
    }));
  return { node, value, parts: rows, named: rows };
}

// An unsaved recipe or meal, kept while you edit one of its foods: taken
// back only when you return from there (`?draft=1`), so an abandoned one
// never fills a later visit. Keyed by the editor's address.
const draft = {
  key: (path) => `draft:${path}`,
  keep: (path, value) =>
    sessionStorage.setItem(draft.key(path), JSON.stringify(value)),
  read: (path) => {
    try {
      return JSON.parse(sessionStorage.getItem(draft.key(path)));
    } catch {
      return null;
    }
  },
  drop: (path) => sessionStorage.removeItem(draft.key(path)),
};

// The editor's own address and whether it was returned to with a draft.
function draftOf(params) {
  const path = location.hash.split("?")[0];
  const kept = params.get("draft") ? draft.read(path) : null;
  return { path, kept };
}

// A draft's items with their foods as they are now (one was likely just
// edited: a new serving, new values), each amount as it was left. A food
// that can't be read (offline) stays as the draft had it.
const current = (items) =>
  Promise.all(
    items.map((item) =>
      get(`/foods/${item.food_id}`).then(
        (f) => ({ ...item, ...itemOf(f) }),
        () => item,
      ),
    ),
  );

// Leave for an ingredient's food, keeping the unsaved editor as a draft that
// its Save or Back returns to. Nothing lost, the editor (`shell()`) won't ask.
const editIngredient = (path, value, shell) => (item) => {
  const back = `${path}?draft=1`;
  draft.keep(path, value());
  shell().markClean();
  history.replaceState(history.state, "", back);
  location.hash = href.food({ id: item.food_id, kind: item.kind }, back);
};

// A meal saved as a recipe, or a recipe as a meal (`path`): a new one of
// the editor's name and items as they are, the one edited kept.
const saveAs = (path, label, name, items, shell, to) =>
  copyButton(
    (key) =>
      api("POST", path, { name: name.value, items: items.value(), uid: key }),
    shell,
    to,
    label,
  );

export async function recipeEditor(id, params) {
  const isNew = id === "new";
  const { path, kept } = draftOf(params);
  const [loaded, usage] = await Promise.all([
    isNew
      ? {
          name: "",
          cooked_g: null,
          items: [],
          servings: [],
          archived: false,
        }
      : get(`/recipes/${id}`),
    isNew ? null : usageOf(id),
  ]);
  const recipe = kept
    ? { ...loaded, ...kept, items: await current(kept.items) }
    : loaded;
  const name = nameInput({ max: meta.limits.name, value: recipe.name });
  const cooked = num({
    name: "cooked_g",
    value: recipe.cooked_g ?? "",
    min: POSITIVE,
  });
  const notes = h("textarea", {
    name: "notes",
    maxLength: meta.limits.notes,
    rows: 4,
    placeholder: "Optional: how you make it, or anything",
  });
  notes.value = recipe.notes ?? "";
  const category = categorySelect(recipe.category);
  const makes = num({
    name: "makes",
    value: recipe.makes ?? "",
    min: 1,
    max: meta.limits.makes,
    step: 1,
  });
  // One portion's grams, while the recipe makes some.
  const portion = () => {
    const n = numberOrNull(makes);
    return n ? weight() / n : null;
  };
  const weighs = h("p", {});
  // Live: per 100 g as the server will store it, and the whole recipe.
  const panel = nutritionPanel();
  let targets = null;
  let items = null;
  let servings = null;
  const weight = () =>
    numberOrNull(cooked) ||
    (items ? items.parts().reduce((t, p) => t + p.grams, 0) : 0);
  const repaint = () => {
    if (!items) return;
    const parts = items.parts();
    const total = parts.reduce((t, p) => t + p.grams, 0);
    cooked.placeholder = String(Math.round(total));
    weighs.textContent = `Weighs ${qty(weight(), "g")} ${numberOrNull(cooked) ? "cooked" : "(its ingredients)"}.`;
    servings?.refresh();
    const per100 = recipePer100(parts, numberOrNull(cooked));
    const known = recipeKnown(parts, numberOrNull(cooked));
    panel.paint(
      [
        { label: PER_100G, values: per100, known },
        {
          label: `Whole recipe (${qty(weight(), "g")})`,
          ...wholeOf(parts, known, weight()),
        },
      ],
      {
        per100,
        known,
        drink: Boolean(recipe.drink) || category.value === DRINK,
        basis: PER_100G,
        grams: portion(),
        targets,
        estimated: weightGuessed({ items: parts }),
      },
    );
  };
  const state = () => ({
    name: name.value,
    cooked_g: numberOrNull(cooked),
    makes: numberOrNull(makes),
    items: items.named(),
    servings: servings.value(),
    notes: notes.value,
    archived: recipe.archived,
    category: category.value || null,
    rev: recipe.rev,
  });
  items = itemsEditor(
    recipe.items,
    repaint,
    editIngredient(path, state, () => shell),
  );
  servings = servingsEditor(recipe.servings, weight, portion);
  repaint();
  withTargets((t) => {
    targets = t;
    repaint();
  });
  // What its values and portions come from, and that as saved. A restored
  // draft may differ from what's saved already: counted as changed.
  const makeup = () =>
    JSON.stringify([items.value(), numberOrNull(cooked), numberOrNull(makes)]);
  const loadedMakeup = kept ? null : makeup();
  const send = saveOnce("/recipes");
  const removing = isNew
    ? { secondary: [], remove: null }
    : removal(
        loaded,
        usage,
        (change) => send(body(change), loaded.id),
        () => shell,
      );
  const body = (change = {}) => ({
    name: name.value,
    cooked_g: numberOrNull(cooked),
    makes: numberOrNull(makes),
    items: items.value(),
    servings: servings.value(),
    notes: notes.value,
    archived: recipe.archived,
    category: category.value || null,
    ...(isNew ? {} : { rev: loaded.rev }),
    ...change,
  });
  const shell = editor({
    title: isNew ? "New recipe" : loaded.name,
    action: isNew ? null : await favoriteStar(loaded),
    back:
      safeBack(params.get("back")) ??
      (params.get("day")
        ? href.add(params.get("day"), params.get("group"))
        : href.foods()),
    body: [
      kept
        ? h(
            "p",
            { class: "note" },
            "Your unsaved changes are back: save to keep them.",
          )
        : null,
      recipe.archived
        ? h("p", { class: "note" }, "Archived: hidden from search.")
        : null,
      field("Name", name),
      items.node,
      weighs,
      // Cooking changes weight (water boils off or soaks in): only a weighed
      // dish says by how much, so this stays out of the way until then.
      h(
        "details",
        { class: "fold", open: Boolean(recipe.cooked_g) },
        h("summary", {}, "Weighed it after cooking?"),
        field("Weight after cooking (g)", cooked, {
          hint: `${PER_100G} then counts the cooked dish. Clear it to use the ingredients' total again.`,
        }),
      ),
      field("Makes (portions)", makes, {
        hint: `Adds a ${PORTION} serving: the recipe's weight ÷ portions.`,
      }),
      servings.node,
      field("Notes", notes, {
        hint: "Shown when you log it. Line breaks are kept.",
      }),
      field("Category", category, {
        hint: "Counts toward the built-in habit of the same kind. None counts each ingredient's own.",
      }),
    ],
    state: () => [items.value(), servings.value()],
    remove: removing.remove,
    secondary: isNew
      ? []
      : [
          ...removing.secondary,
          copyForm("/recipes", body, () => shell, href.food),
          saveAs(
            "/meals",
            "Meal from this recipe",
            name,
            items,
            () => shell,
            (copy) => href.meal(copy.id),
          ),
          mergeLink(id),
        ],
    save: async () => {
      if (isNew) return send(body());
      if (
        !(await confirmChange(id, loaded.name, {
          changed: makeup() !== loadedMakeup,
          gone: goneServings(loaded.servings, servings.value()),
          recipe: true,
        }))
      )
        return;
      return send(body(), loaded.id);
    },
    after: (saved) => returnTo(params, saved, (x) => href.recipe(x.id)),
    aside: panel.node,
    unsaved: Boolean(kept),
  });
  shell.form.addEventListener("input", repaint);
  // A draft is taken once: a later visit starts from what's saved.
  draft.drop(path);
  return shell.node;
}

export async function mealEditor(id, params) {
  const isNew = id === "new";
  const { path, kept } = draftOf(params);
  const loaded = isNew ? { name: "", items: [] } : await get(`/meals/${id}`);
  // Opened from a copy on the log screen (`?back=`), saving returns there.
  const back = safeBack(params.get("back"));
  const meal = kept
    ? { ...loaded, ...kept, items: await current(kept.items) }
    : loaded;
  const name = nameInput({ max: meta.limits.name, value: meal.name });
  // Live: what one logging of the meal adds up to.
  const panel = nutritionPanel();
  let targets = null;
  let items = null;
  const repaint = () => {
    if (!items) return;
    const parts = items.parts();
    const total = parts.reduce((t, p) => t + p.grams, 0);
    // A meal is graded as food, never as a drink (ADR 0017).
    const known = recipeKnown(parts, null);
    panel.paint(
      [
        {
          label: `Total (${qty(total, "g")})`,
          ...wholeOf(parts, known, total),
        },
      ],
      {
        per100: recipePer100(parts, null),
        known,
        drink: false,
        grams: total,
        targets,
        estimated: weightGuessed({ items: parts }),
      },
    );
  };
  items = itemsEditor(
    meal.items,
    repaint,
    editIngredient(
      path,
      () => ({ name: name.value, items: items.named() }),
      () => shell,
    ),
  );
  repaint();
  withTargets((t) => {
    targets = t;
    repaint();
  });
  const body = (change = {}) => ({
    name: name.value,
    items: items.value(),
    ...(isNew ? {} : { rev: loaded.rev }),
    ...change,
  });
  const send = saveOnce("/meals");
  const shell = editor({
    title: isNew ? "New meal" : loaded.name,
    back: back ?? href.foods(),
    body: [
      kept
        ? h(
            "p",
            { class: "note" },
            "Your unsaved changes are back: save to keep them.",
          )
        : null,
      field("Name", name),
      items.node,
    ],
    state: () => items.value(),
    secondary: isNew
      ? []
      : [
          copyForm(
            "/meals",
            body,
            () => shell,
            (copy) => href.meal(copy.id),
          ),
          saveAs(
            "/recipes",
            "Recipe from this meal",
            name,
            items,
            () => shell,
            href.food,
          ),
        ],
    save: () => send(body(), isNew ? null : loaded.id),
    after: (saved) => back ?? href.meal(saved.id),
    remove: isNew
      ? null
      : {
          ask: `Delete ${loaded.name}?`,
          detail: "Foods already logged from it stay in the Diary.",
          run: () => api("DELETE", `/meals/${id}`),
          after: href.foods(),
          done: `Deleted ${loaded.name}`,
        },
    aside: panel.node,
    unsaved: Boolean(kept),
  });
  draft.drop(path);
  return shell.node;
}
