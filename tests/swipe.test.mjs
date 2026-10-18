// The swipe rules (web/swipe.mjs), without a browser: `node --test tests/`.

import assert from "node:assert/strict";
import test from "node:test";

import { classify, EDGE, MAX_MS, MIN_DX } from "../web/swipe.mjs";

const WIDTH = 400;
// One finger from (x, y) moved by (dx, dy) in `ms`.
const one = (dx, dy = 0, { x = 200, y = 300, ms = 200, ...rest } = {}) => ({
  width: WIDTH,
  scale: 1,
  maxTouches: 1,
  start: [{ x, y }],
  end: [{ x: x + dx, y: y + dy }],
  ms,
  ...rest,
});
// Two fingers 100 px apart, both moved by (dx, dy); `spread` widens the
// gap by that much.
const two = (dx, dy = 0, { spread = 0, ms = 200 } = {}) => ({
  width: WIDTH,
  scale: 1,
  maxTouches: 2,
  start: [
    { x: 150, y: 300 },
    { x: 250, y: 300 },
  ],
  end: [
    { x: 150 + dx - spread / 2, y: 300 + dy },
    { x: 250 + dx + spread / 2, y: 300 + dy },
  ],
  ms,
});

test("one finger left is forward, right is back", () => {
  assert.deepEqual(classify(one(-80)), { fingers: 1, dir: 1 });
  assert.deepEqual(classify(one(80)), { fingers: 1, dir: -1 });
});

test("short, slow or steep moves aren't swipes", () => {
  assert.equal(classify(one(MIN_DX - 1)), null);
  assert.deepEqual(classify(one(MIN_DX)), { fingers: 1, dir: -1 });
  assert.equal(classify(one(-80, 0, { ms: MAX_MS + 1 })), null);
  assert.deepEqual(classify(one(-80, 0, { ms: MAX_MS })), {
    fingers: 1,
    dir: 1,
  });
  // |dx| must be at least 1.5 × |dy|: a scroll that drifts sideways.
  assert.equal(classify(one(-90, 61)), null);
  assert.deepEqual(classify(one(-90, 60)), { fingers: 1, dir: 1 });
  assert.equal(classify(one(0, 200)), null);
});

test("a start near either edge is the system's (back), not ours", () => {
  assert.equal(classify(one(80, 0, { x: EDGE - 1 })), null);
  assert.equal(classify(one(-80, 0, { x: WIDTH - EDGE + 1 })), null);
  assert.deepEqual(classify(one(80, 0, { x: EDGE })), { fingers: 1, dir: -1 });
  assert.deepEqual(classify(one(-80, 0, { x: WIDTH - EDGE })), {
    fingers: 1,
    dir: 1,
  });
});

test("zoomed in, the page pans: no swipe", () => {
  assert.equal(classify(one(-80, 0, { scale: 1.5 })), null);
});

test("two fingers together are a two-finger swipe; a pinch isn't", () => {
  assert.deepEqual(classify(two(-80)), { fingers: 2, dir: 1 });
  assert.deepEqual(classify(two(80)), { fingers: 2, dir: -1 });
  // The gap changing by 15 % or more (of 100 px) is a pinch.
  assert.equal(classify(two(-80, 0, { spread: 15 })), null);
  assert.equal(classify(two(-80, 0, { spread: -15 })), null);
  assert.deepEqual(classify(two(-80, 0, { spread: 14 })), {
    fingers: 2,
    dir: 1,
  });
  assert.equal(classify(two(-50)), null);
});

test("three fingers, or fingers lost on the way, are nothing", () => {
  assert.equal(classify({ ...two(-80), maxTouches: 3 }), null);
  assert.equal(classify({ ...one(-80), maxTouches: 2 }), null);
});
