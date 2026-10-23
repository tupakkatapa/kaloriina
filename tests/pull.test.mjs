// The pull-to-refresh rules (web/pull.mjs), without a browser.

import assert from "node:assert/strict";
import test from "node:test";

import {
  heading,
  MAX,
  mayStart,
  releases,
  stretch,
  THRESHOLD,
} from "../web/pull.mjs";

const at = { top: 0, touches: 1, desktop: false, ignored: false };

test("a pull starts only at the top, with one finger, on a phone", () => {
  assert.equal(mayStart(at), true);
  assert.equal(mayStart({ ...at, top: -4 }), true, "iOS bounce above the top");
  assert.equal(mayStart({ ...at, top: 1 }), false, "scrolled down");
  assert.equal(mayStart({ ...at, touches: 2 }), false);
  assert.equal(mayStart({ ...at, desktop: true }), false);
  assert.equal(mayStart({ ...at, ignored: true }), false, "a chart, a dialog");
});

test("down and mostly vertical is a pull; anything else never is", () => {
  assert.equal(heading(0, 5), null, "not moved enough to tell");
  assert.equal(heading(3, 20), "pull");
  assert.equal(heading(10, 14), "other", "too sideways");
  assert.equal(heading(-40, 5), "other", "a swipe");
  assert.equal(heading(0, -20), "other", "a scroll down the page");
});

test("the band follows by half, then stiffens toward its cap", () => {
  assert.equal(stretch(-30), 0);
  assert.equal(stretch(0), 0);
  assert.equal(stretch(60), 30);
  assert.equal(stretch(THRESHOLD * 2), THRESHOLD);
  let last = 0;
  for (let dy = 1; dy < 2000; dy += 7) {
    const s = stretch(dy);
    assert.ok(s >= last, `monotone at ${dy}`);
    assert.ok(s < MAX, `under the cap at ${dy}`);
    last = s;
  }
  assert.ok(stretch(THRESHOLD * 2 + 40) - THRESHOLD < 20, "resists past it");
});

test("released at the threshold, it refreshes; short of it, it doesn't", () => {
  assert.equal(releases(THRESHOLD), true);
  assert.equal(releases(THRESHOLD - 1), false);
  assert.equal(releases(stretch(150)), false, "a 150 px drag");
});
