// The service worker's upgrade rule (web/sw.js), without a
// browser: `node --test tests/`.

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
  assert.ok(stale("/v/b1/main.mjs", "b2", undefined));
  // Never the page, the API reads or files outside /v/.
  for (const path of ["/", "/api/meta", "/api/profiles/1/day/2030-01-01"])
    assert.ok(!stale(path, "b2", shell), path);
  assert.ok(!stale("/icon.svg", "b2", shell));
});
