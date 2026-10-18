// contributing.md's recipes name real things: every backticked path in it
// exists, and every backticked symbol appears somewhere in the tree. A
// rename that leaves the guide behind fails here. `node --test tests/`.
//
// docs/ is private (git-ignored): KALORIINA_DOCS names it, else the
// checkout's own docs/, else the main checkout's when this is a git
// worktree. Without one (the flake's sandbox) the test skips and says so.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;

function docsDir() {
  if (process.env.KALORIINA_DOCS) return process.env.KALORIINA_DOCS;
  if (existsSync(join(ROOT, "docs"))) return join(ROOT, "docs");
  try {
    const common = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const main = join(dirname(common), "docs");
    return existsSync(main) ? main : null;
  } catch {
    return null;
  }
}

const DOCS = docsDir();
const GUIDE = DOCS && join(DOCS, "howto/contributing.md");

// Not the tree's own: build output, caches, the private notes.
const SKIP = new Set([
  ".direnv",
  ".git",
  "docs",
  "node_modules",
  "playwright-report",
  "result",
  "target",
  "test-results",
]);

function files(dir) {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    if (SKIP.has(name) || name.startsWith("result-")) return [];
    const rel = dir ? `${dir}/${name}` : name;
    return statSync(join(ROOT, rel)).isDirectory() ? files(rel) : [rel];
  });
}

const TEXT = /\.(?:css|html|java|js|json|mjs|nix|rs|sql|toml|txt|yaml)$/u;
const FILE =
  /^\w[\w.-]*\.(?:css|html|java|js|json|md|mjs|nix|rs|sql|toml|txt|yaml)$/u;
const PATH = /^[\w.-]+(?:\/[\w.-]+)+\/?$|^[\w.-]+\/$/u;
const SYMBOL = /^[A-Za-z_]\w*(?:(?:::|\.)[A-Za-z_]\w*)*(?:\(\))?$/u;

// What a backticked token claims: a path that must exist, a file name some
// file has, words that must appear, or nothing (a command, a CSS token, a
// placeholder, a path outside the tree).
function claim(token, roots) {
  if (PATH.test(token)) {
    const top = token.split("/")[0];
    if (top === "docs") return { path: join(DOCS, token.slice(5)) };
    return roots.has(top) ? { path: join(ROOT, token) } : null;
  }
  if (FILE.test(token)) return { name: token };
  if (SYMBOL.test(token))
    return { words: token.replace("()", "").split(/::|\./u) };
  return null;
}

test("contributing.md names only paths and symbols the tree has", (t) => {
  if (!GUIDE || !existsSync(GUIDE)) {
    t.skip("docs/ isn't here (private; set KALORIINA_DOCS to check it)");
    return;
  }
  const roots = new Set(readdirSync(ROOT));
  const all = files("");
  const names = new Set(all.map((f) => f.split("/").at(-1)));
  for (const dir of readdirSync(DOCS, { recursive: true }))
    names.add(dir.split("/").at(-1));
  const corpus = all
    .filter((f) => TEXT.test(f))
    .map((f) => readFileSync(join(ROOT, f), "utf8"))
    .join("\n");
  const known = new Set(corpus.match(/[A-Za-z_]\w*/gu));
  const guide = readFileSync(GUIDE, "utf8").replaceAll(/```[\s\S]*?```/gu, "");
  const tokens = new Set([...guide.matchAll(/`([^`\n]+)`/gu)].map((m) => m[1]));
  const missing = [...tokens].filter((token) => {
    const c = claim(token, roots);
    if (!c) return false;
    if (c.path) return !existsSync(c.path);
    if (c.name) return !names.has(c.name);
    return c.words.some((w) => !known.has(w));
  });
  assert.ok(tokens.size > 50, `only ${tokens.size} backticked tokens read`);
  assert.deepEqual(
    missing,
    [],
    "named in contributing.md, absent from the tree",
  );
});
