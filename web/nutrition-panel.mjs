// The nutrition panel: what a food, recipe or meal contains, with its
// health cues (traffic lights, health tags, the energy split). Split from
// ui.mjs, whose DOM builder it uses; no data here either.

import { meta } from "./api.mjs";
import { coverage, hydrationOf, knownOnly } from "./coverage.mjs";
import {
  capitalized,
  fmt,
  isNil,
  lower,
  NBSP,
  pct,
  PER_100G,
} from "./format.mjs";
import {
  alcoholic,
  density,
  energyPortion,
  lightsText,
  lightText,
  NO_KNOWN_WEIGHT,
  servingNote,
  trafficLights,
  unknownLights,
  verdictLine,
} from "./health.mjs";
import { href } from "./nav.mjs";
import {
  amountShown,
  byCategory,
  dvShare,
  energySplit,
  hydrationText,
  KEY_TARGETS,
  mainKeys,
  nutrient,
  ordered,
} from "./nutrients.mjs";
import { fill, h } from "./ui.mjs";
import { tiles } from "./tiles.mjs";
import { labelStyle } from "./units.mjs";

// One amount of a column ({values, known}) in a nutrition table, in its
// display unit: "–" when unknown, "≥ x" when the ingredients carrying it
// gave under KNOWN of the energy (coverage, ADR 0030).
const cell = (key, column) => {
  const value = column.values[key];
  if (isNil(value)) return "–";
  const shown = amountShown(
    key,
    value,
    coverage([{ total: column.values, known: column.known }], key),
    { of: "the ingredients" },
  );
  return shown.hint
    ? h(
        "span",
        { title: shown.hint },
        shown.text,
        h("span", { class: "sr-only" }, ` (${shown.hint})`),
      )
    : shown.text;
};

// The US label's %DV after a column's amount: "12 %", "≥ 12 %" of a floor
// (as its amount reads), or nothing without a Daily Value (or on the EU
// label).
const dvCell = (key, column) => {
  const value = column.values[key];
  const share = labelStyle() === "us" ? dvShare(key, value) : null;
  if (isNil(share)) return null;
  const floor =
    coverage([{ total: column.values, known: column.known }], key) < 1;
  return h(
    "small",
    { class: "muted dv" },
    ` ${floor ? `≥${NBSP}` : ""}${fmt(share)}${NBSP}%`,
  );
};

// Traffic-light chips: the level in words ("Fat low") after a dot in its
// colour, read as one sentence.
function lightChips(lights, { basis = PER_100G } = {}) {
  const shown = lights ?? [];
  if (shown.length === 0) return null;
  return h(
    "span",
    { class: "lights" },
    h(
      "span",
      { class: "light-list", "aria-hidden": "true" },
      shown.map((l) =>
        h(
          "span",
          { class: `light l-${l.level ?? "unknown"}` },
          h("span", { class: "dot" }),
          l.level === null ? `${l.label} –` : capitalized(lightText(l)),
        ),
      ),
    ),
    h("span", { class: "sr-only" }, lightsText(shown, basis)),
  );
}

// A verdict's chip colour: good news, middling or bad.
const VERDICT_TONE = { healthy: "l-good", ok: "l-medium", unhealthy: "l-bad" };

// A food's verdict (`food.labels.verdict`, the server's) as a chip with a
// dot, coloured by its tone; `detail` (a food's own view) says why in a
// line ("OK: salt, but fruit & veg · Slice (5 g): 3 % of a day's salt"),
// or, without one, which values kept it from one. Its sublabels aren't
// repeated: the panel's lights and split say them. Spans, so it sits in a
// row's button.
export function labelChips(food, detail = false) {
  const verdict = food?.labels?.verdict ?? null;
  const unknown =
    verdict || !detail ? [] : unknownLights(food.per100, food.known);
  if (!verdict && unknown.length === 0) return null;
  const text = verdict ? meta.labels.find((l) => l.key === verdict).text : null;
  const why = detail
    ? [verdictLine(food, text), servingNote(food)].filter(Boolean).join(" · ")
    : "";
  return h(
    "span",
    { class: `lights ${detail ? "labels" : "compact"}` },
    h(
      "span",
      { class: "light-list" },
      verdict
        ? h(
            "span",
            { class: `light ${VERDICT_TONE[verdict]}` },
            h("span", { class: "dot" }),
            text,
          )
        : null,
      why ? h("small", { class: "muted why" }, why) : null,
      unknown.length > 0
        ? h(
            "small",
            { class: "muted" },
            `No verdict: ${new Intl.ListFormat("en-GB").format(unknown)} not known`,
          )
        : null,
    ),
  );
}

// Where the energy comes from: a bar of its parts and the same in words.
const splitBar = (split) =>
  h(
    "div",
    { class: "energy-split" },
    h(
      "div",
      { class: "bar split-bar", "aria-hidden": "true" },
      split.parts.map((p) =>
        h("span", {
          class: `k-${p.key.replace("_", "-")}`,
          style: { flexBasis: `${p.share}%` },
        }),
      ),
    ),
    h(
      "p",
      { class: "note" },
      "Energy: ",
      split.parts.map((p) => `${p.label} ${pct(p.share)}`).join(" · "),
    ),
    split.missing.length > 0
      ? h(
          "p",
          { class: "note muted" },
          `${split.missing.join(" and ")} not given`,
        )
      : null,
  );

// What a food, recipe or meal contains: the four key nutrients up front, the
// rest under "Other nutrients", as in the diary and Summary. One column per
// basis ("Per 100 g", "Whole recipe (540 g)"). `paint` redraws it as inputs
// change; the folds keep their open state across repaints.
//
// A column may carry `known` (a recipe's coverage, scaled as its values). With
// `cues` ({per100, known: per100's, drink, basis: what the values are per
// (`per100Basis`), grams, targets, estimated: a guessed weight,
// `weightGuessed`, so no lights, hydration: the food's, else read from the
// values}; ADR 0017) it also shows the
// traffic lights and energy split under its heading, and what 100 kcal (500 kJ)
// gives of the `targets` (null: not loaded, none shown) after the tables;
// `columns` may then be empty.
export function nutritionPanel() {
  const main = h("tbody");
  const rest = h("tbody");
  const head = h("tr");
  const table = h(
    "table",
    { class: "grid nutrition" },
    h("thead", {}, head),
    main,
  );
  const dvNote = h(
    "p",
    { class: "note muted" },
    `%: of the FDA Daily Value, on a 2,000${NBSP}kcal diet; none for protein or vitamin A.`,
  );
  const fold = h(
    "details",
    {},
    h("summary", {}, "Other nutrients"),
    h("table", { class: "grid nutrition" }, rest),
  );
  // The cues, added on the first paint that has them.
  const health = h("section", { class: "health" });
  const notes = h("div", { class: "density-notes" });
  const gives = h("div");
  // In this device's energy unit: "100 kcal" or "500 kJ".
  const portion = energyPortion().label;
  const fair = h(
    "details",
    { class: "density fold" },
    h("summary", {}, `What ${portion} gives`),
    gives,
  );
  const paintCues = (given) => {
    // A cue judges only what's known: a recipe's partial keys are left out.
    const cues = { ...given, per100: knownOnly(given.per100, given.known) };
    if (!health.parentNode) {
      table.before(health);
      fold.after(notes, fair);
    }
    // Nothing given yet (a new food): nothing to say.
    const any = Object.values(cues.per100 ?? {}).some((v) => !isNil(v));
    for (const el of [health, notes, fair]) el.hidden = !any;
    if (!any) return;
    // What the values are per (`per100Basis`): a drink's are graded per
    // 100 ml whatever its source states.
    const basis = cues.basis ?? (cues.drink ? `Per 100${NBSP}ml` : PER_100G);
    const lights = trafficLights(cues.per100, cues);
    const split = energySplit(cues.per100);
    fill(
      health,
      cues.estimated
        ? h("p", { class: "note muted" }, `${NO_KNOWN_WEIGHT}.`)
        : alcoholic(cues.per100)
          ? h(
              "p",
              { class: "note" },
              "Traffic lights don't cover alcoholic drinks.",
            )
          : lights && [
              h("p", { class: "note muted" }, basis),
              lightChips(lights, { basis }),
            ],
      split && splitBar(split),
    );
    health.hidden = !health.childElementCount;
    const d = cues.targets ? density(cues.per100, cues.targets) : {};
    // How its values bear on hydration (ADR 0020): the server's for a
    // recipe (through its parts), else read from the values.
    const wet =
      given.hydration === undefined
        ? hydrationOf(given.per100, Boolean(given.drink))
        : given.hydration;
    fill(
      notes,
      h(
        "p",
        { class: "note muted hydration" },
        hydrationText(wet, {
          per100: given.per100,
          grams: cues.grams,
          unit: basis.endsWith("ml") ? "ml" : "g",
        }),
      ),
      d.skip && h("p", { class: "note muted" }, `${d.skip}.`),
      d.none &&
        h(
          "p",
          { class: "note muted" },
          h("a", { href: href.targets() }, "Set targets"),
          " to see what this gives you.",
        ),
      (d.cautions ?? []).map((c) =>
        h(
          "p",
          { class: "note caution" },
          `Per ${portion}: ${pct(c.share)} of your ${lower(c.label)} limit.`,
        ),
      ),
    );
    notes.hidden = !notes.childElementCount;
    fair.hidden = !d.gives;
    if (d.gives)
      fill(
        gives,
        h(
          "p",
          { class: "note muted" },
          `A day's share of ${portion} is ${pct(d.fair, null)}.`,
        ),
        tiles(
          `What ${portion} gives`,
          d.gives.map((g) => ({
            value: pct(g.share),
            short: `of your ${lower(g.label)}`,
            long: `The share of your day's ${lower(g.label)} target in ${portion}.`,
          })),
        ) ??
          h(
            "p",
            { class: "note muted" },
            "Nothing here beats its share of your energy.",
          ),
      );
  };
  const paint = (columns, cues = null) => {
    table.hidden = columns.length === 0;
    if (cues) paintCues(cues);
    const row = (n) =>
      h(
        "tr",
        {},
        h("th", { scope: "row" }, n.label),
        columns.map((c) => h("td", {}, cell(n.key, c), dvCell(n.key, c))),
      );
    // The US label leads with its own list, %DV beside each amount.
    const us = labelStyle() === "us";
    const front = us ? mainKeys() : KEY_TARGETS;
    fill(
      head,
      h("th", {}, h("span", { class: "sr-only" }, "Nutrient")),
      ...columns.map((c) => h("th", { scope: "col" }, c.label)),
    );
    fill(main, ...front.map((k) => row(nutrient(k))));
    // Only on the US label: nothing extra in the EU panel.
    if (us && columns.length > 0) table.after(dvNote);
    else dvNote.remove();
    // The carbohydrate the label doesn't read (total on the EU label, net
    // on the US one) follows from the other and fibre; only the nutrients
    // some column has are listed.
    const others = ordered().filter(
      (n) =>
        !front.includes(n.key) &&
        n.key !== (us ? "net_carbs" : "carbs") &&
        columns.some((c) => !isNil(c.values[n.key])),
    );
    fill(
      rest,
      ...byCategory(others).flatMap(([name, list]) => [
        categoryRow(name, columns.length + 1),
        ...list.map((x) => row(x)),
      ]),
    );
    fold.hidden = others.length === 0;
  };
  const node = h(
    "section",
    { class: "nutrition-panel" },
    h("h2", {}, "Nutrition"),
    table,
    fold,
  );
  return { node, paint };
}

// A section heading inside an "Other nutrients" table.
export const categoryRow = (name, columns) =>
  h(
    "tr",
    {},
    h("th", { scope: "rowgroup", colspan: columns, class: "category" }, name),
  );
