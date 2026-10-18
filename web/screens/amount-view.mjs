// One view of an amount of a food or recipe: logging it (`#/log`) and its
// logged entry (`#/entry`). Its name and a line under it, its verdict, the
// amount, the time eaten and Repeat daily, then its notes, its nutrition at
// that amount and a recipe's ingredients, one column at every width. The
// screens add only what differs: the entry's Group switch and its buttons,
// or the log's Add to Eaten / Planned.

import {
  amountControl,
  basisColumn,
  byVolume,
  servingText,
  weightText,
} from "../amount.mjs";
import { pretty, today } from "../dates.mjs";
import { plural } from "../format.mjs";
import { weightGuessed } from "../health.mjs";
import { href } from "../nav.mjs";
import { per100Basis, scaled } from "../nutrients.mjs";
import { labelChips, nutritionPanel } from "../nutrition-panel.mjs";
import { resultRow } from "../rows.mjs";
import { field, h, notesSection, timeField } from "../ui.mjs";

// A meal or recipe item: its name, and its amount as written (by its
// serving when it has one) times `times`; it opens its food (a recipe's
// own editor for a nested one), whose Save returns to `back`.
export const itemRow = (i, back, times = 1) =>
  resultRow({
    href: href.food({ id: i.food_id, kind: i.kind }, back),
    name: i.name,
    detail: i.serving
      ? servingText(
          i.quantity * times,
          i.serving,
          weightText(i.grams * times, weightGuessed(i), null, byVolume(i)),
          byVolume(i),
        )
      : weightText(i.grams * times, weightGuessed(i), null, byVolume(i)),
  });

// A recipe's ingredients, each opening its food (whose Save returns to
// `back`), and the portions it makes.
const ingredients = (recipe, back) =>
  h(
    "section",
    { class: "finder-section recipe-items" },
    h("h2", {}, "Ingredients"),
    recipe.makes
      ? h("p", { class: "muted" }, `Makes ${plural(recipe.makes, "portion")}`)
      : null,
    h(
      "ul",
      { class: "results card" },
      recipe.items.map((i) => itemRow(i, back)),
    ),
  );

// "Repeat daily", unticked unless it is in `series` (an entry's `repeat`).
function repeatField(series = null) {
  const input = h("input", {
    type: "checkbox",
    name: "repeat",
    checked: Boolean(series),
  });
  const node = h(
    "div",
    { class: "field" },
    h("label", { class: "check" }, input, " Repeat daily"),
    h(
      "small",
      { class: "muted" },
      series
        ? `Since ${pretty(series.start)}; days you ticked keep their entries when it stops.`
        : "In Planned every day until you tick or skip it.",
    ),
  );
  return { node, input };
}

// The view of `food` at `start` (an entry's amount; null: its default)
// eaten at `time` ("08:15" or ""): `sub` the line under its name, `column`
// what its amount's nutrition column is called ("This"), `here` its
// route (an ingredient's Save comes back to it), `fields` the screen's
// own after the time. Gives the parts the screen lays out in this order,
// `head` and `fields` inside its form, the inputs, and the time's row
// (`timeRow`, hidden where nothing is eaten).
export function amountView({
  food,
  start = null,
  time = "",
  series = null,
  sub,
  column,
  here,
  targets,
  fields = [],
}) {
  const panel = nutritionPanel();
  const estimated = weightGuessed(food);
  const paint = () => {
    const g = amount.grams();
    panel.paint(
      [
        basisColumn(food),
        {
          label: `${column} (${weightText(g, estimated, null, byVolume(food))})`,
          values: scaled(food.per100, g),
          known: food.known,
        },
      ],
      {
        per100: food.per100,
        known: food.known,
        drink: food.drink,
        hydration: food.hydration,
        basis: per100Basis(food),
        grams: g,
        targets,
        estimated,
      },
    );
  };
  const amount = amountControl(food, start, paint);
  paint();
  const timeInput = timeField({ name: "time", value: time });
  const timeRow = field("Time eaten", timeInput);
  const repeat = repeatField(series);
  return {
    head: [h("p", { class: "muted" }, sub), labelChips(food, true)],
    fields: [field("Amount", amount.node), timeRow, ...fields, repeat.node],
    tail: [
      notesSection(food.notes),
      panel.node,
      food.items ? ingredients(food, here) : null,
    ],
    amount,
    time: timeInput,
    timeRow,
    repeat: repeat.input,
  };
}

// Where "Repeat daily" starts a series of `day`'s entry: that day, or
// today for a past one (past days stay clean).
export const repeatFrom = (day) => ({
  start: day > today() ? day : today(),
});
