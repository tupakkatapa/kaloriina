// The Foods tab, and the editors of foods, recipes and meals.

import { api, get, meta } from "../api.mjs";
import { today } from "../dates.mjs";
import { go, href, safeBack } from "../nav.mjs";
import {
  KJ_PER_KCAL,
  MAIN,
  byCategory,
  fmtNum,
  inputValue,
  isNil,
  nutrient,
  ordered,
  qty,
  recipePer100,
  registry,
  scaled,
  summed,
  withUnit,
} from "../nutrients.mjs";
import {
  busy,
  confirmDialog,
  editor,
  field,
  fill,
  h,
  notify,
  num,
  numberOrNull,
  nutritionPanel,
  picker,
  POSITIVE,
  titleBar,
} from "../ui.mjs";
import { finder, foodRow, searchFoods } from "./finder.mjs";

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

// A recipe's serving of all of it, and of one portion when it makes some;
// the server keeps their grams at the recipe's weight (÷ portions).
const WHOLE = "Whole recipe";
const PORTION = "Portion";

// A fixed row's label, or null for one of yours.
const fixedOf = (row) => row.dataset.fixed ?? null;
// Where a serving row says it's the default, or offers to become it.
const slot = () => h("span", { class: "default" });

// Servings in order; the first is the default (logging and ingredients
// start from it), and "Set default" moves one there. With `whole` (a
// recipe: its weight now), a fixed "Whole recipe" row is kept too, and a
// fixed "Portion" row while `portion()` (its grams) isn't null.
function servingsEditor(initial, whole = null, portion = () => null) {
  const list = h("div", { class: "servings" });
  // A portion row is hidden, not removed, while `makes` is blank: it keeps
  // its place.
  const rows = () => [...list.children].filter((row) => !row.hidden);
  // The first row says it's the default; the others offer to become it.
  const mark = () => {
    for (const [i, row] of rows().entries()) {
      const name =
        fixedOf(row) ??
        (row.querySelector("input").value.trim() || "this serving");
      fill(
        row.querySelector(".default"),
        i === 0
          ? h("span", { class: "muted" }, "Default")
          : h(
              "button",
              {
                type: "button",
                class: "link",
                "aria-label": `Make ${name} the default`,
                onclick: () => {
                  list.prepend(row);
                  mark();
                  list.dispatchEvent(new Event("input", { bubbles: true }));
                },
              },
              "Set default",
            ),
      );
    }
  };
  const addRow = (s = { label: "", grams: "" }) => {
    const row = h(
      "div",
      { class: "serving" },
      h("input", {
        name: "serving-label",
        value: s.label,
        placeholder: "e.g. Slice",
        maxLength: meta.limits.label,
        "aria-label": "Serving name",
      }),
      num({
        name: "serving-grams",
        value: s.grams,
        min: POSITIVE,
        placeholder: "grams",
        "aria-label": "Serving grams",
      }),
      h("span", {}, "g"),
      slot(),
      h(
        "button",
        {
          type: "button",
          class: "danger icon",
          "aria-label": "Remove serving",
          onclick: () => {
            row.remove();
            mark();
            list.dispatchEvent(new Event("input", { bubbles: true }));
          },
        },
        "✕",
      ),
    );
    list.append(row);
    mark();
  };
  // Fixed rows by label: their grams now.
  const sizes = { [WHOLE]: () => whole(), [PORTION]: () => portion() };
  const addFixed = (label) =>
    list.append(
      h(
        "div",
        { class: "serving", "data-fixed": label },
        h("span", { class: "name" }, label),
        h("span", { class: "grams" }),
        h("span", {}, "g"),
        slot(),
        h("span", {}),
      ),
    );
  // The whole recipe goes first unless another serving was the default.
  if (whole && !initial.some((x) => x.label === WHOLE)) addFixed(WHOLE);
  for (const x of initial)
    if (whole && x.label in sizes) addFixed(x.label);
    else addRow(x);
  list.addEventListener("input", mark);
  // A new portion goes last, as the server adds it.
  const refresh = () => {
    if (whole) {
      const row = list.querySelector(`[data-fixed="${PORTION}"]`);
      if (row) row.hidden = portion() === null;
      else if (portion() !== null) addFixed(PORTION);
      for (const r of rows().filter(fixedOf))
        r.querySelector(".grams").textContent = fmtNum(sizes[fixedOf(r)]());
    }
    mark();
  };
  refresh();
  const node = h(
    "fieldset",
    {},
    h("legend", {}, "Servings"),
    list,
    h("button", { type: "button", onclick: () => addRow() }, "+ Serving"),
  );
  const value = () =>
    rows()
      .map((row) =>
        fixedOf(row)
          ? // Placed, not sized: the server sets the grams.
            { label: fixedOf(row), grams: 1 }
          : {
              label: row.querySelector("input").value.trim(),
              // 0, not null: an untouched row (no label, no grams) is dropped.
              grams: numberOrNull(row.querySelector("input[type=number]")) ?? 0,
            },
      )
      // Drop untouched rows; partial ones reach the API and get an error.
      .filter((x) => x.label || x.grams);
  return { node, value, refresh };
}

// Archiving instead of deleting: foods stay behind the history that logged
// them, so they're hidden from search, not removed. `put(change)` saves the
// change; the editor is then shown afresh.
function archiveButton(food, put, shell) {
  return h(
    "button",
    {
      type: "button",
      onclick: busy(async () => {
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

export async function foodEditor(id, params) {
  const isNew = id === "new";
  const food = isNew
    ? {
        name: params.get("name") ?? "",
        brand: "",
        barcode: params.get("barcode") ?? "",
        per100: {},
        servings: [],
        archived: false,
      }
    : await get(`/foods/${id}`);
  if (food.source === "recipe") {
    location.replace(href.recipe(id));
    return null;
  }
  // Fineli's name and values are its own: shown, not edited.
  const fineli = food.source === "fineli";
  const name = h("input", {
    name: "name",
    value: food.name,
    required: true,
    disabled: fineli,
    maxLength: meta.limits.name,
  });
  const brand = h("input", {
    name: "brand",
    value: food.brand ?? "",
    disabled: fineli,
    maxLength: meta.limits.name,
  });
  const barcode = h("input", {
    name: "barcode",
    value: food.barcode ?? "",
    inputMode: "numeric",
    pattern: "[0-9]*",
  });
  const servings = servingsEditor(food.servings);
  // Total carbohydrate is derived (available + fibre), so it isn't editable.
  const editable = registry.filter((n) => n.key !== "carbs");
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
            : inputValue(n.key, food.per100[n.key]),
        disabled: fineli,
      }),
    ]),
  );
  // EU labels print energy in kJ and kcal; either one fills the other. The
  // registry's input is in this device's unit (kcal or kJ), this one in the
  // other.
  const [otherUnit, perKcal] =
    nutrient("energy").unit === "kJ" ? ["kcal", 1] : ["kJ", KJ_PER_KCAL];
  const ratio = perKcal / nutrient("energy").show(1);
  const kj = num({
    disabled: fineli,
    value: isNil(food.per100.energy)
      ? ""
      : Math.round(food.per100.energy * perKcal),
  });
  kj.addEventListener("input", () => {
    inputs.energy.value = kj.value === "" ? "" : Math.round(kj.value / ratio);
  });
  inputs.energy.addEventListener("input", () => {
    kj.value =
      inputs.energy.value === "" ? "" : Math.round(inputs.energy.value * ratio);
  });
  const fields = (list) =>
    list.flatMap((n) => [
      ...(n.key === "energy"
        ? [field(`Energy (${otherUnit})`, kj, { inline: true })]
        : []),
      field(withUnit(n), inputs[n.key], { inline: true }),
    ]);
  const per100 = () => {
    const out = {};
    for (const [k, input] of Object.entries(inputs))
      if (input.value !== "") out[k] = nutrient(k).store(Number(input.value));
    return out;
  };
  // Live: the default serving's values as typed. Per 100 g is the form
  // itself, so the panel shows only with a serving.
  const panel = nutritionPanel();
  const repaint = () => {
    const serving = servings.value().find((s) => s.label && s.grams > 0);
    panel.node.hidden = !serving;
    if (serving)
      panel.paint([
        {
          label: `${serving.label} (${qty(serving.grams, "g")})`,
          values: scaled(per100(), serving.grams),
        },
      ]);
  };
  const category = categorySelect(food.category);
  const body = (change = {}) => ({
    // Fineli's own fields go back as they came.
    name: fineli ? food.name : name.value,
    brand: fineli ? food.brand : brand.value || null,
    barcode: barcode.value || null,
    per100: fineli ? food.per100 : per100(),
    category: category.value || null,
    servings: servings.value(),
    archived: food.archived,
    ...(isNew ? {} : { rev: food.rev }),
    ...change,
  });
  const shell = editor({
    title: isNew ? "New food" : food.name,
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
      servings.node,
      h(
        "fieldset",
        {},
        h("legend", {}, "Per 100 g"),
        fields(MAIN.map(nutrient)),
        h(
          "details",
          { class: "fold" },
          h("summary", {}, "Other nutrients"),
          h(
            "div",
            { class: "fold-fields" },
            byCategory(
              ordered()
                .slice(MAIN.length)
                .filter((n) => n.key !== "carbs"),
            ).map(([cat, list]) => [
              h("h3", { class: "category" }, cat),
              fields(list),
            ]),
          ),
        ),
      ),
    ],
    secondary: isNew
      ? []
      : [
          archiveButton(
            food,
            (change) => api("PUT", `/foods/${id}`, body(change)),
            () => shell,
          ),
          mergeLink(id),
        ],
    save: async () => {
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
        return undefined;
      return isNew
        ? api("POST", "/foods", body())
        : api("PUT", `/foods/${id}`, body());
    },
    after: (saved) => returnTo(params, saved, (x) => href.food(x)),
    aside: panel.node,
  });
  shell.form.addEventListener("input", repaint);
  repaint();
  return shell.node;
}

// Items of a recipe or meal: food and grams per row. `onChange` runs after
// every add, remove or grams edit; `parts` gives what the nutrition panel
// needs; a food's name opens its editor through `onEdit`.
function itemsEditor(initial, onChange = () => {}, onEdit = null) {
  const list = h("ul", { class: "items" });
  const items = new Map(); // row → item
  const addItem = (item) => {
    const grams = num({
      value: item.grams,
      min: POSITIVE,
      required: true,
      "aria-label": `${item.name} grams`,
      oninput: onChange,
    });
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
      grams,
      h("span", {}, "g"),
      h(
        "button",
        {
          type: "button",
          class: "danger icon",
          "aria-label": `Remove ${item.name}`,
          onclick: () => {
            row.remove();
            items.delete(row);
            onChange();
          },
        },
        "✕",
      ),
    );
    items.set(row, item);
    list.append(row);
    onChange();
  };
  initial.forEach(addItem);
  const node = h(
    "fieldset",
    {},
    h("legend", {}, "Items"),
    list,
    picker({
      placeholder: "Search foods to add",
      search: searchFoods,
      row: foodRow,
      // A food's default serving is how much goes in; 100 g without one.
      onPick: (f) =>
        addItem({
          food_id: f.id,
          name: f.name,
          source: f.source,
          grams: f.servings?.[0]?.grams ?? 100,
          per100: f.per100,
        }),
    }),
  );
  const rows = () =>
    [...items].map(([row, item]) => ({
      ...item,
      grams: Number(row.querySelector("input").value) || 0,
    }));
  const value = () => rows().map(({ food_id, grams }) => ({ food_id, grams }));
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

// Leave for an ingredient's food, keeping the unsaved editor as a draft and
// coming back to it. Nothing is lost, so the editor (`shell()`) doesn't ask.
const editIngredient = (path, value, shell) => (item) => {
  draft.keep(path, value());
  shell().markClean();
  location.hash = href.food(
    { id: item.food_id, source: item.source },
    `${path}?draft=1`,
  );
};

export async function recipeEditor(id, params) {
  const isNew = id === "new";
  const { path, kept } = draftOf(params);
  const loaded = isNew
    ? {
        name: "",
        cooked_g: null,
        items: [],
        servings: [],
        archived: false,
      }
    : await get(`/recipes/${id}`);
  const recipe = kept ? { ...loaded, ...kept } : loaded;
  const name = h("input", {
    name: "name",
    value: recipe.name,
    required: true,
    maxLength: meta.limits.name,
  });
  const cooked = num({ name: "cooked_g", value: recipe.cooked_g ?? "" });
  const instructions = h("textarea", {
    name: "instructions",
    maxLength: meta.limits.instructions,
    rows: 4,
    placeholder: "Optional: how you make it",
  });
  instructions.value = recipe.instructions ?? "";
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
  const weightText = h("p", {});
  // Live: per 100 g as the server will store it, and the whole recipe.
  const panel = nutritionPanel();
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
    weightText.textContent = `Weighs ${qty(weight(), "g")} ${numberOrNull(cooked) ? "cooked" : "(its ingredients)"}.`;
    servings?.refresh();
    panel.paint([
      { label: "Per 100 g", values: recipePer100(parts, numberOrNull(cooked)) },
      {
        label: `Whole recipe (${qty(weight(), "g")})`,
        values: summed(parts.map((p) => scaled(p.per100, p.grams))),
      },
    ]);
  };
  const state = () => ({
    name: name.value,
    cooked_g: numberOrNull(cooked),
    makes: numberOrNull(makes),
    items: items.named(),
    servings: servings.value(),
    instructions: instructions.value,
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
  const body = (change = {}) => ({
    name: name.value,
    cooked_g: numberOrNull(cooked),
    makes: numberOrNull(makes),
    items: items.value(),
    servings: servings.value(),
    instructions: instructions.value,
    archived: recipe.archived,
    category: category.value || null,
    ...(isNew ? {} : { rev: loaded.rev }),
    ...change,
  });
  const shell = editor({
    title: isNew ? "New recipe" : loaded.name,
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
      weightText,
      // Cooking changes weight (water boils off or soaks in): only a weighed
      // dish says by how much, so this stays out of the way until then.
      h(
        "details",
        { class: "fold", open: Boolean(recipe.cooked_g) },
        h("summary", {}, "Weighed it after cooking?"),
        field("Weight after cooking (g)", cooked, {
          hint: "Per 100 g then counts the cooked dish. Clear it to use the ingredients' total again.",
        }),
      ),
      field("Makes (portions)", makes, {
        hint: `Adds a ${PORTION} serving: the recipe's weight ÷ portions.`,
      }),
      servings.node,
      field("Instructions", instructions, {
        hint: "Shown when you log it. Line breaks are kept.",
      }),
      field("Category", category, {
        hint: "Counts toward the built-in habit of the same kind. None counts each ingredient's own.",
      }),
    ],
    state: () => [items.value(), servings.value()],
    secondary: isNew
      ? []
      : [
          archiveButton(
            recipe,
            (change) => api("PUT", `/recipes/${id}`, body(change)),
            () => shell,
          ),
          mergeLink(id),
        ],
    save: () =>
      isNew
        ? api("POST", "/recipes", body())
        : api("PUT", `/recipes/${id}`, body()),
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
  const meal = kept ? { ...loaded, ...kept } : loaded;
  const name = h("input", {
    name: "name",
    value: meal.name,
    required: true,
    maxLength: meta.limits.name,
  });
  // Live: what one logging of the meal adds up to.
  const panel = nutritionPanel();
  let items = null;
  const repaint = () => {
    if (!items) return;
    const parts = items.parts();
    panel.paint([
      {
        label: `Total (${qty(
          parts.reduce((t, p) => t + p.grams, 0),
          "g",
        )})`,
        values: summed(parts.map((p) => scaled(p.per100, p.grams))),
      },
    ]);
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
  const shell = editor({
    title: isNew ? "New meal" : loaded.name,
    back: href.foods(),
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
    save: () => {
      const body = {
        name: name.value,
        items: items.value(),
        ...(isNew ? {} : { rev: loaded.rev }),
      };
      return isNew
        ? api("POST", "/meals", body)
        : api("PUT", `/meals/${id}`, body);
    },
    after: (saved) => href.meal(saved.id),
    remove: isNew
      ? null
      : {
          ask: `Delete ${loaded.name}?`,
          detail: "Foods already logged from it stay in the diary.",
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
