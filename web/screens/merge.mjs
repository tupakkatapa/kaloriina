// Merge a duplicate food into another (the one kept): pick it, see what
// moves, confirm.

import { api, get } from "../api.mjs";
import { entriesUpdated, plural } from "../format.mjs";
import { go, href } from "../nav.mjs";
import { foodRow, searchFoods } from "../rows.mjs";
import { confirmDialog, h, notify, picker, titleBar } from "../ui.mjs";

// Why `b` can't merge into `a`, or null when it can (the server's rules).
function refusal(a, b) {
  if (b.id === a.id) return "this one";
  if (b.source === "fineli") return "from Fineli: merge it the other way";
  if (a.kind !== b.kind)
    return a.kind === "recipe" ? "not a recipe" : "a recipe";
  if (a.barcode && b.barcode) return "has a barcode too";
  return null;
}

export async function mergeFood(id) {
  const a = await get(`/foods/${id}`);
  const back = href.food(a);
  const merge = async (b) => {
    const n = await get(`/foods/${b.id}/usage`);
    const ok = await confirmDialog(`Merge ${b.name} into ${a.name}?`, {
      detail:
        `${plural(n.entries, "diary entry", "diary entries")}, ${plural(n.recipes, "recipe")}, ` +
        `${plural(n.meals, "meal")} and ${plural(n.favorites, "favourite")} move to ${a.name}. ` +
        `Its diary entries and recipes using it take ${a.name}'s values. ` +
        `${b.name} is deleted. This can't be undone.`,
      confirm: "Merge",
    });
    if (!ok) return;
    const kept = await api("POST", `/foods/${a.id}/merge`, {
      from: b.id,
      rev: a.rev,
    });
    go(back);
    notify(`Merged ${b.name} into ${a.name}${entriesUpdated(kept)}`);
  };
  const row = (b, pick) => {
    const why = refusal(a, b);
    const li = foodRow(b, pick);
    if (why) {
      li.querySelector("button").disabled = true;
      li.querySelector(".muted").append(` · ${why}`);
    }
    return li;
  };
  return h(
    "section",
    {},
    titleBar(`Merge into ${a.name}`, back),
    h(
      "p",
      { class: "muted" },
      `Pick the duplicate. What uses it moves to ${a.name}, then it's deleted.`,
    ),
    picker({
      placeholder: "Search the duplicate",
      search: searchFoods,
      row,
      onPick: merge,
    }),
  );
}
