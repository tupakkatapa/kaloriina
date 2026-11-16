// web/drafts.mjs: foods and recipes left unsaved, kept on this device. A
// Map stands in for localStorage.

import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const store = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
});
const { drop, keeper, list, read, write } = await import("../web/drafts.mjs");

test("a draft is read back by its key, the last written first", () => {
  store.clear();
  assert.equal(write("food:new", { name: "Soup" }), true);
  write("recipe:7", { name: "Pie", rev: 3 });
  assert.deepEqual(read("food:new"), { name: "Soup" });
  assert.equal(read("food:7"), null, "one food's draft is not another's");
  write("food:new", { name: "Soup 2" });
  assert.deepEqual(
    list().map((d) => [d.key, d.body.name]),
    [
      ["food:new", "Soup 2"],
      ["recipe:7", "Pie"],
    ],
  );
  drop("food:new");
  assert.equal(read("food:new"), null);
  assert.deepEqual(
    list().map((d) => d.key),
    ["recipe:7"],
  );
});

test("a store that can't be read or written keeps nothing and breaks nothing", () => {
  store.clear();
  store.set("drafts", "{not json");
  assert.deepEqual(list(), []);
  assert.equal(read("food:new"), null);
  const { setItem } = localStorage;
  localStorage.setItem = () => {
    throw new DOMException("quota", "QuotaExceededError");
  };
  try {
    assert.equal(write("food:new", { name: "Soup" }), false);
    drop("food:new");
  } finally {
    localStorage.setItem = setItem;
  }
});

test("a keeper writes while dirty, drops when clean, and once dropped stays so", async () => {
  store.clear();
  let dirty = true;
  let name = "Stew";
  const k = keeper(
    "recipe:new",
    () => ({ name }),
    () => dirty,
    0,
  );
  assert.equal(k.keep(), true);
  assert.deepEqual(read("recipe:new"), { name: "Stew" });
  name = "Stew 2";
  k.soon();
  k.drop();
  await delay(5);
  assert.equal(
    read("recipe:new"),
    null,
    "a pending write never outlives a drop",
  );
  k.soon();
  await delay(5);
  assert.deepEqual(read("recipe:new"), { name: "Stew 2" });
  dirty = false;
  k.keep();
  assert.equal(read("recipe:new"), null, "changes undone: no draft");
});
