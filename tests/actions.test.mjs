// web/actions.mjs: an editor's Copy posts its form as it is when pressed,
// not as it was when the editor opened. A stand-in DOM and
// fetch: the button's click is all that runs.

import assert from "node:assert/strict";
import test from "node:test";

// The least of a DOM `h()` builds a button from.
class El {
  dataset = {};
  disabled = false;
  isConnected = false;
  listeners = {};
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }
  setAttribute() {}
  append() {}
}
// Never a form: `busy` asks.
globalThis.HTMLFormElement = Function;
globalThis.document = {
  createElement: () => new El(),
  querySelector: () => null,
};
globalThis.location = { hash: "" };
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// Answers /api/meta; records each POST's body, then fails it (the button's
// work ends there).
const posted = [];
globalThis.fetch = (url, init) => {
  if (url === "/api/meta")
    return Promise.resolve(
      Response.json({ limits: { name: 80 }, nutrients: [] }),
    );
  posted.push(JSON.parse(init.body));
  return Promise.reject(new TypeError("offline"));
};

const { loadMeta } = await import("../web/api.mjs");
const { copyForm, holds } = await import("../web/actions.mjs");
await loadMeta();

// The click's own failure (the stand-in fetch) is beside the point.
const click = (button) =>
  button.listeners.click({ currentTarget: button }).catch(() => {});

// The last POST's body without its uid, which each press makes anew.
const lastPosted = () => {
  const { uid, ...body } = posted.at(-1);
  assert.match(uid, /^[\da-f-]{36}$/u);
  return body;
};

test("copyForm reads the form and its change when Copy is pressed", async () => {
  const form = { name: "Stale probe", brand: "B1", drink: false };
  const button = copyForm(
    "/foods",
    (change = {}) => ({ ...form, rev: 3, archived: true, ...change }),
    () => null,
    () => "#/",
    () => ({ brand: form.brand, barcode: null, drink: form.drink }),
  );
  // Edited after the editor opened, before Copy.
  Object.assign(form, { name: "Edited name", brand: "B2", drink: true });
  await click(button);
  assert.deepEqual(lastPosted(), {
    name: "Edited name (copy)",
    brand: "B2",
    drink: true,
    barcode: null,
    archived: false,
  });
});

test("copyForm without a change copies the form as it is", async () => {
  const form = { name: "Soup" };
  const button = copyForm(
    "/recipes",
    (change = {}) => ({ ...form, ...change }),
    () => null,
    () => "#/",
  );
  form.name = "Soup 2";
  await click(button);
  assert.deepEqual(lastPosted(), {
    name: "Soup 2 (copy)",
    archived: false,
  });
});

test("each Copy press is a copy of its own", async () => {
  const button = copyForm(
    "/meals",
    () => ({ name: "Lunch" }),
    () => null,
    () => "#/",
  );
  await click(button);
  const first = posted.at(-1).uid;
  await click(button);
  assert.notEqual(posted.at(-1).uid, first);
});

// A record answered for a form holds it when it stores each value
// the form sent; what only the form has (a create's `day`) is no value.
test("holds compares what the form sent with what the record stores", () => {
  const sent = {
    name: "Oats",
    brand: null,
    notes: "",
    day: "2026-10-17",
    rev: 2,
    per100: { energy: 370, protein: 13.2 },
    items: [{ food_id: 1, grams: 30 }],
  };
  const got = {
    id: 9,
    name: "Oats",
    notes: null,
    rev: 3,
    per100: { energy: 370.0000000001, protein: 13.2, fat: 7 },
    items: [{ food_id: 1, grams: 30, serving: null, name: "Oat" }],
  };
  assert.equal(holds(got, sent), true);
  assert.equal(holds({ ...got, name: "Oat" }, sent), false);
  assert.equal(holds({ ...got, per100: { energy: 370 } }, sent), false);
  assert.equal(holds({ ...got, items: [] }, sent), false);
  assert.equal(holds({ ...got, notes: "Soak" }, sent), false);
  assert.equal(
    holds({ ...got, items: [{ food_id: 1, grams: 31 }] }, sent),
    false,
  );
});

// A view's Copy is the server's; the staged client copies of
// saved items and the header copy icons are gone.
test("the staged copy helpers are gone", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const web = new URL("../web/", import.meta.url);
  const sources = readdirSync(web, { recursive: true })
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => readFileSync(new URL(f, web), "utf8"));
  for (const name of ["copySaved", "copyIcon", "copyFoodIcon", "itemInput"])
    assert.equal(
      sources.some((s) => new RegExp(`\\b${name}\\b`, "u").test(s)),
      false,
      name,
    );
});
