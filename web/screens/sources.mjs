// Where a nutrient came from over a range of days: the foods that supplied
// most of it (from the Summary's nutrient names).

import { get, scoped } from "../api.mjs";
import { pretty, shift, today } from "../dates.mjs";
import { safeBack } from "../nav.mjs";
import { fmt, fmtUnit, nutrient } from "../nutrients.mjs";
import { h, notFound, titleBar } from "../ui.mjs";

const percent = (share) => `${fmt(share * 100)} %`;

export async function sources(key, params) {
  const n = nutrient(key);
  const back = safeBack(params.get("back")) ?? "#/summary";
  if (!n) return notFound("nutrient", back, "Go to Summary");
  // Without a range: this month, as the Summary opens.
  const first = `${today().slice(0, 8)}01`;
  const next = `${shift(first, 31).slice(0, 8)}01`;
  const from = params.get("from") ?? first;
  const to = params.get("to") ?? shift(next, -1);
  const data = await get(
    scoped(`/summary/foods?from=${from}&to=${to}&nutrient=${key}`),
  );
  const imported =
    data.unattributed > 0 && data.total > 0
      ? h(
          "p",
          { class: "muted" },
          `${fmtUnit(key, data.unattributed)} (${percent(data.unattributed / data.total)}) is from imported history, which doesn't name its foods.`,
        )
      : null;
  return h(
    "section",
    {},
    titleBar(`Where ${n.label.toLowerCase()} comes from`, back),
    h(
      "p",
      { class: "muted" },
      `${pretty(from, false)} – ${pretty(to, false)} · ${fmtUnit(key, data.total)} eaten`,
    ),
    data.foods.length
      ? h(
          "ul",
          { class: "days sources" },
          data.foods.map((f) =>
            h(
              "li",
              {},
              h("span", {}, f.name),
              h(
                "span",
                {},
                fmtUnit(key, f.amount),
                h("span", { class: "muted" }, ` · ${percent(f.share)}`),
              ),
            ),
          ),
        )
      : h(
          "p",
          { class: "muted" },
          `No food logged in these days has ${n.label.toLowerCase()}.`,
        ),
    imported,
  );
}
