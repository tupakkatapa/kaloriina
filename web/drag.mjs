// Moving a workout's steps by their handle: with the keyboard (Space picks
// up and drops, arrows move through every valid place, into and out of
// repeats, Escape cancels) or by pointer (mouse, touch, pen), so scrolling
// and typing elsewhere stay as they are. `ed` is the editor's: {blocks
// (where its steps are drawn), depth, steps() (now), restore(steps, focus)
// (steps set and drawn, focus on the handle at `focus`), change(result,
// opts) (an edit, with Undo), announce(text)}.

import { h, undoable } from "./ui.mjs";
import { at, move, pathKey, pathLabel, pathOf, stepOver } from "./workouts.mjs";

export function stepDrag(ed) {
  // The step a keyboard drag holds: {path, before, origin}.
  let held = null;
  const holds = (path) => Boolean(held && pathKey(held.path) === pathKey(path));

  function keyboard(ev, path, title) {
    if (ev.key === " " || ev.key === "Enter") {
      ev.preventDefault();
      if (holds(path)) {
        const before = held.before;
        held = null;
        ed.announce(`Dropped ${title} at step ${pathLabel(path)}.`);
        if (before !== ed.steps())
          undoable(`Moved ${title}`, () => ed.restore(before), {
            travels: false,
          });
      } else {
        held = { path, before: ed.steps(), origin: path };
        ed.announce(
          `Picked up ${title}, step ${pathLabel(path)}. Arrow keys move it, Space drops it, Escape cancels.`,
        );
      }
      ed.restore(ed.steps(), path);
    } else if (
      holds(path) &&
      (ev.key === "ArrowUp" || ev.key === "ArrowDown")
    ) {
      ev.preventDefault();
      const result = stepOver(
        ed.steps(),
        path,
        ev.key === "ArrowDown" ? 1 : -1,
        ed.depth,
      );
      if (!result) return;
      held.path = result.path;
      ed.restore(result.steps, result.path);
      ed.announce(
        `Step ${pathLabel(result.path)}${result.path.length > 1 ? `, in repeat ${pathLabel(result.path.slice(0, -1))}` : ""}.`,
      );
    } else if (holds(path) && ev.key === "Escape") {
      ev.preventDefault();
      const { before, origin } = held;
      held = null;
      ed.announce("Move cancelled.");
      ed.restore(before, origin);
    }
  }

  // Where a pointer at (x, y) would drop the step from `from`: a list, an
  // index in it, and where to draw the line. Null over nowhere valid.
  function dropTarget(x, y, from) {
    const el = document.elementFromPoint(x, y);
    const empty = el?.closest(".step-empty");
    const row = el?.closest("li.step");
    let place = null;
    if (empty && ed.blocks.contains(empty)) {
      const r = empty.getBoundingClientRect();
      place = {
        list: pathOf(empty.dataset.list),
        index: 0,
        x: r.left,
        y: r.top,
      };
    } else if (row && ed.blocks.contains(row)) {
      const path = pathOf(row.dataset.path);
      const head = row
        .querySelector(":scope > .step-head")
        .getBoundingClientRect();
      const lower = y > head.top + head.height / 2;
      if (at(ed.steps(), path).kind === "repeat" && lower)
        place = { list: path, index: 0, x: head.left + 16, y: head.bottom };
      else
        place = {
          list: path.slice(0, -1),
          index: path.at(-1) + (lower ? 1 : 0),
          x: head.left,
          y: lower ? row.getBoundingClientRect().bottom : head.top,
        };
    }
    return place && move(ed.steps(), from, place.list, place.index, ed.depth)
      ? place
      : null;
  }

  function pointer(ev, path, title) {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    ev.preventDefault();
    const handle = ev.currentTarget;
    handle.setPointerCapture(ev.pointerId);
    const row = handle.closest("li.step");
    row.classList.add("dragging");
    const marker = h("div", { class: "drop-line", hidden: true });
    ed.blocks.append(marker);
    let target = null;
    const onMove = (e) => {
      target = dropTarget(e.clientX, e.clientY, path);
      marker.hidden = !target;
      if (target) {
        const box = ed.blocks.getBoundingClientRect();
        marker.style.top = `${target.y - box.top}px`;
        marker.style.left = `${target.x - box.left}px`;
      }
      if (e.clientY < 48) scrollBy(0, -12);
      else if (e.clientY > innerHeight - 96) scrollBy(0, 12);
    };
    const onEnd = (e) => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      marker.remove();
      row.classList.remove("dragging");
      if (e.type === "pointerup" && target)
        ed.change(move(ed.steps(), path, target.list, target.index, ed.depth), {
          message: `Moved ${title}`,
        });
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  }

  return { keyboard, pointer, holds };
}
