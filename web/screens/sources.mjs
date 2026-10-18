// Where a nutrient came from over a range of days: the foods that supplied
// most of it (from the Summary's nutrient names).

import { get, scoped } from "../api.mjs";
import { coverage } from "../coverage.mjs";
import { pretty, shift, today } from "../dates.mjs";
import { fmt, lower, NBSP } from "../format.mjs";
import { href, safeBack } from "../nav.mjs";
import { amountShown, fmtUnit, nutrient } from "../nutrients.mjs";
import { kvList } from "../rows.mjs";
import { empty, h, notFound, titleBar } from "../ui.mjs";

const percent = (share) => `${fmt(share * 100)}${NBSP}%`;

export async function sources(key, params) {
  const n = nutrient(key);
  const back = safeBack(params.get("back")) ?? href.summary();
  if (!n) return notFound("nutrient", back, "Go to Summary");
  // Without a range: this month, as the Summary opens.
  const first = `${today().slice(0, 8)}01`;
  const next = `${shift(first, 31).slice(0, 8)}01`;
  const from = params.get("from") ?? first;
  const to = params.get("to") ?? shift(next, -1);
  const keys = key === "energy" ? key : `energy,${key}`;
  const [data, summary] = await Promise.all([
    get(scoped(`/summary/foods?from=${from}&to=${to}&nutrient=${key}`)),
    get(scoped(`/summary?from=${from}&to=${to}&keys=${keys}`)),
  ]);
  // How far the total is known (ADR 0030): foods without it add nothing.
  const shown = amountShown(key, data.total, coverage(summary.days, key), {
    of: "the food eaten",
  });
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
    titleBar(`Where ${lower(n.label)} comes from`, back),
    h(
      "p",
      { class: "muted" },
      `${pretty(from, false)} – ${pretty(to, false)} · ${shown.text} eaten`,
    ),
    shown.hint
      ? h(
          "p",
          { class: "muted" },
          `Partly known: foods with ${lower(n.label)} made up ${shown.hint.replace(/^from /u, "")}.`,
        )
      : null,
    data.foods.length > 0
      ? kvList(
          data.foods.map((f) => [
            f.name,
            h(
              "span",
              {},
              fmtUnit(key, f.amount),
              h("span", { class: "muted" }, ` · ${percent(f.share)}`),
            ),
          ]),
          { cls: "sources" },
        )
      : empty(`No food logged in these days has ${lower(n.label)}.`),
    imported,
  );
}
