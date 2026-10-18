// The stat tile, one contract for every screen: `tiles(label, items)`,
// each item {value, short, long, cls?}. A Summary subtab, All time,
// Targets, a food's "What … gives", and any new module that shows big
// numbers build them here. Its look is style.css `.tiles`.

import { tipFor } from "./tips.mjs";
import { abbreviated, h } from "./ui.mjs";

// A group of big numbers named `label`, read value first: "5.5 drinks a
// week". Each item (null ones skipped):
// - `value`: the number as shown, its marks with it ("≈", "≥", "–").
// - `short`: the line under it, a few plain words (text or nodes).
// - `long`: one or two sentences saying what the number is and how it is
//   counted (which days; what a "≥" or "≈" means here). The tile's
//   tooltip (tips.mjs: its aria-describedby; on hover and keyboard focus
//   on a desktop, on a tap on a phone; above the tile).
// - `cls`: a class for the tile.
// Null when no item is left. An item without `long` is a bug: logged, and
// shown without a tip.
export function tiles(label, items) {
  const list = items.filter(Boolean);
  if (list.length === 0) return null;
  return h(
    "ul",
    { class: "tiles", "aria-label": label },
    list.map((item) => {
      const { value, short, long, cls } = item;
      if (!long) console.error(`A tile of "${label}" has no long text`, item);
      const button = h(
        "button",
        { type: "button", class: "tile" },
        h("b", { class: "tile-value" }, value),
        " ",
        h("span", { class: "tile-caption" }, abbreviated(short)),
      );
      return h(
        "li",
        { class: cls ? `tip-host ${cls}` : "tip-host" },
        button,
        long ? tipFor(button, long) : null,
      );
    }),
  );
}
