// The service worker's upgrade rule and network deadline (web/sw.js),
// without a browser: `node --test tests/`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const ctx = vm.createContext({
  self: { addEventListener: () => {}, location: { origin: "http://x" } },
});
vm.runInContext(readFileSync("web/sw.js", "utf8"), ctx);
const stale = vm.runInContext("stale", ctx);
const shellBuild = vm.runInContext("shellBuild", ctx);

test("prune keeps the cached shell's hash", () => {
  // Booted on b2 while the cached page still loads b1 (an upgrade not yet
  // opened offline): b1's files stay with b2's, b0's go.
  const shell = shellBuild(
    '<link rel="stylesheet" href="/v/b1/style.css" />' +
      '<script type="module" src="/v/b1/main.mjs"></script>',
  );
  assert.equal(shell, "b1");
  assert.ok(!stale("/v/b1/main.mjs", "b2", shell));
  assert.ok(!stale("/v/b2/screens/log.mjs", "b2", shell));
  assert.ok(stale("/v/b0/main.mjs", "b2", shell));
  // Without a cached page only the booted build is kept.
  assert.ok(stale("/v/b1/main.mjs", "b2"));
  // Never the page, the API reads or files outside /v/.
  for (const path of ["/", "/api/meta", "/api/profiles/1/day/2030-01-01"])
    assert.ok(!stale(path, "b2", shell), path);
  assert.ok(!stale("/icon.svg", "b2", shell));
});

// A day's cached path: profile `pid`'s day `n` of 2030.
const day = (pid, n) =>
  `/api/profiles/${pid}/day/${new Date(Date.UTC(2030, 0, n)).toISOString().slice(0, 10)}`;

test("sw_day_cap: a profile keeps its 60 latest days; forget drops one", () => {
  const overflow = vm.runInContext("overflow", ctx);
  const forgotten = vm.runInContext("forgotten", ctx);
  // 70 days of profile 1 (cached in no order), 3 of profile 2, the rest.
  const one = Array.from({ length: 70 }, (_, i) => day(1, 70 - ((i * 3) % 70)));
  const two = [day(2, 1), day(2, 2), day(2, 3)];
  const other = ["/api/meta", "/api/profiles", "/api/profiles/1/habits"];
  const paths = [...one, ...two, ...other];
  assert.deepEqual(
    [...overflow(paths)].toSorted(),
    Array.from({ length: 10 }, (_, i) => day(1, i + 1)).toSorted(),
  );
  // Profile 1's reads go, not 10's or 2's.
  const forgot = forgotten(1)([...paths, "/api/profiles/10/day/2030-01-01"]);
  assert.deepEqual([...forgot].toSorted(), [...one, other[2]].toSorted());
});

// A worker in a vm with a stand-in cache, a network whose requests wait
// until answered (`net`), and the messages it posts to pages (`posted`).
function worker() {
  const listeners = {};
  const store = new Map();
  const net = [];
  const posted = [];
  const cache = {
    match: (key) => Promise.resolve(store.get(key)?.clone()),
    put: (key, res) => {
      store.set(key, res);
      return Promise.resolve();
    },
    keys: () => Promise.resolve([]),
  };
  vm.runInContext(
    readFileSync("web/sw.js", "utf8"),
    vm.createContext({
      self: {
        addEventListener: (type, fn) => {
          listeners[type] = fn;
        },
        location: { origin: "http://x" },
        clients: {
          get: (id) =>
            Promise.resolve({
              postMessage: (m) => posted.push([id, { ...m }]),
            }),
        },
      },
      caches: { open: () => Promise.resolve(cache) },
      fetch: () => {
        const wire = Promise.withResolvers();
        net.push(wire);
        return wire.promise;
      },
      setTimeout: (...a) => setTimeout(...a),
      Headers,
      Response,
      URL,
      Promise,
    }),
  );
  // A GET of `path` by page `clientId`: its answer (a promise) and what it
  // keeps the worker alive for.
  const get = (path, clientId = "page") => {
    const e = {
      request: { method: "GET", url: `http://x${path}`, mode: "cors" },
      clientId,
      waits: [],
      respondWith: (p) => {
        e.answer = p;
      },
      waitUntil: (p) => e.waits.push(p),
    };
    listeners.fetch(e);
    return e;
  };
  return { store, net, posted, get, json };
}

const json = (data) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });

const settle = () =>
  new Promise((r) => {
    setImmediate(r);
  });
const cachedHeader = (res) => res.headers.get("x-kaloriina-cached");

test("sw_deadline: a hung read answers from the cache after 3 s, then refreshes and says so", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const w = worker();
  w.store.set("http://x/api/meta", w.json({ v: 1 }));
  w.store.set("http://x/api/profiles", w.json([]));

  // The network holds the read: the cache answers at the deadline, not before.
  const first = w.get("/api/meta");
  let answered = null;
  first.answer.then((res) => {
    answered = res;
  });
  await settle();
  t.mock.timers.tick(2_999);
  await settle();
  assert.equal(answered, null);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(cachedHeader(answered), "1");
  assert.deepEqual(await answered.json(), { v: 1 });

  // The page fell back: its next read is the cache's at once.
  const second = w.get("/api/profiles");
  assert.equal(cachedHeader(await second.answer), "1");
  assert.equal(w.net.length, 2);

  // The network answers: the cache holds the new copy, the page hears of it
  // and reads from the network again.
  w.net[0].resolve(w.json({ v: 2 }));
  await Promise.all(first.waits);
  assert.deepEqual(await w.store.get("http://x/api/meta").clone().json(), {
    v: 2,
  });
  assert.deepEqual(w.posted, [["page", { fresh: "/api/meta" }]]);
  const third = w.get("/api/meta");
  await settle();
  w.net[2].resolve(w.json({ v: 3 }));
  const res = await third.answer;
  assert.equal(cachedHeader(res), null);
  assert.deepEqual(await res.json(), { v: 3 });
  w.net[1].resolve(w.json([]));
  await Promise.all(second.waits);
});

test("sw_deadline: without a cached copy the network is waited for", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const w = worker();
  const e = w.get("/api/meta");
  let answered = false;
  e.answer.then(() => {
    answered = true;
  });
  await settle();
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(answered, false);
  w.net[0].resolve(w.json({ v: 1 }));
  assert.deepEqual(await (await e.answer).json(), { v: 1 });
});
