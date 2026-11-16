// Foods and recipes left unsaved, kept on this device: one draft per
// editor, keyed `food:new`, `recipe:new`, `food:<id>` or `recipe:<id>`, or
// `food:new?name=…` (`?barcode=…`) for a new food opened with one given,
// each the editor's body as it was left (an existing one's with the `rev`
// it was read at). A store that can't be written (private mode, full)
// keeps nothing; the editor works on.

import { readJson, writeJson } from "./prefs.mjs";

const KEY = "drafts";

const all = () => {
  const drafts = readJson(KEY, {});
  return typeof drafts === "object" && !Array.isArray(drafts) ? drafts : {};
};

// Whether the store took `drafts`.
const store = (drafts) => {
  try {
    writeJson(KEY, drafts);
    return true;
  } catch {
    return false;
  }
};

export const read = (key) => all()[key] ?? null;

// Keep `body` as `key`'s draft, the newest; false when it can't be kept.
export function write(key, body) {
  const drafts = all();
  delete drafts[key];
  drafts[key] = body;
  return store(drafts);
}

export function drop(key) {
  const drafts = all();
  if (!(key in drafts)) return;
  delete drafts[key];
  store(drafts);
}

// Every draft, newest first: `{key, body}`.
export const list = () =>
  Object.entries(all())
    .toReversed()
    .map(([key, body]) => ({ key, body }));

// An editor's draft: `value()` kept as `key` while `dirty()`, `wait` ms
// after the last input (`soon()`) or at once (`keep()`, true when kept);
// kept clean, it's dropped. `drop()` forgets it, a pending write too.
export function keeper(key, value, dirty, wait = 300) {
  let timer = 0;
  const keep = () => {
    clearTimeout(timer);
    if (dirty()) return write(key, value());
    drop(key);
    return true;
  };
  return {
    keep,
    soon: () => {
      clearTimeout(timer);
      timer = setTimeout(keep, wait);
    },
    drop: () => {
      clearTimeout(timer);
      drop(key);
    },
  };
}
