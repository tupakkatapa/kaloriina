// The palette (web/style.css): the four macro colours, the four Highlight
// tones and the four sleep stages, light and dark, checked as numbers:
// `node --test tests/`.
// Contrast is WCAG's against the card surface; distance is CIEDE2000 in
// CIELAB, under protan, deutan and tritan dichromacy (Machado et al. 2009).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { contrast, deltaE2000, lab } from "./colormath.mjs";

const css = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");

// Every custom property a theme's `:root` blocks set, in order (dark:
// light's, then `:root.dark`'s), `var(--x)` resolved.
function theme(dark) {
  const vars = {};
  const blocks = [...css.matchAll(/^:root(\.dark)?\s*\{([^}]*)\}/gmu)].filter(
    (m) => !m[1] || dark,
  );
  for (const [, , body] of blocks)
    for (const [, name, value] of body.matchAll(/(--[\w-]+):\s*([^;]+);/gu))
      vars[name] = value.trim();
  const resolve = (v) => {
    const ref = v.match(/^var\((--[\w-]+)\)$/u);
    return ref ? resolve(vars[ref[1]]) : v;
  };
  return (name) => resolve(vars[name]);
}

const MACROS = ["--energy", "--protein", "--carbs", "--fat"];
const TONES = [
  "--tone-fact",
  "--tone-correlation",
  "--tone-tip",
  "--tone-warning",
];
const STAGES = [
  "--stage-awake",
  "--stage-rem",
  "--stage-light",
  "--stage-deep",
];
const MODES = [
  ["light", theme(false)],
  ["dark", theme(true)],
];

const pairs = (list) =>
  list.flatMap((a, i) => list.slice(i + 1).map((b) => [a, b]));

test("every macro, tone and stage colour reads against the card, light and dark", () => {
  for (const [mode, v] of MODES)
    for (const name of [...MACROS, ...TONES, ...STAGES]) {
      assert.match(v(name), /^#[0-9a-f]{6}$/u, `${mode} ${name}`);
      const c = contrast(v(name), v("--surface"));
      assert.ok(c >= 3, `${mode} ${name} ${v(name)}: ${c.toFixed(2)}:1`);
    }
});

test("the macros stay apart for every eye: ΔE2000 ≥ 20 under each dichromacy", () => {
  for (const [mode, v] of MODES)
    for (const kind of [null, "protan", "deutan", "tritan"])
      for (const [a, b] of pairs(MACROS)) {
        const d = deltaE2000(lab(v(a), kind), lab(v(b), kind));
        assert.ok(
          d >= 20,
          `${mode} ${kind ?? "normal"} ${a}/${b}: ${d.toFixed(1)}`,
        );
      }
});

test("energy isn't the accent, carbs aren't amber, tones aren't macros", () => {
  for (const [mode, v] of MODES) {
    assert.notEqual(v("--energy"), v("--accent"), mode);
    // Amber: a CIELAB hue of 60–95°.
    const [, a, b] = lab(v("--carbs"));
    const hue = (Math.atan2(b, a) * 180) / Math.PI;
    assert.ok(hue < 60 || hue > 95, `${mode} carbs hue ${hue.toFixed(0)}°`);
    for (const tone of TONES)
      for (const other of [...MACROS, ...TONES.filter((t) => t !== tone)]) {
        const d = deltaE2000(lab(v(tone)), lab(v(other)));
        assert.ok(d >= 15, `${mode} ${tone}/${other}: ${d.toFixed(1)}`);
      }
  }
});

// The hypnogram in the macros' colours: one style
// across the app.
test("the sleep stages are the macro colours: awake energy, REM protein, light carbs, deep fat", () => {
  for (const [mode, v] of MODES)
    STAGES.forEach((stage, i) =>
      assert.equal(v(stage), v(MACROS[i]), `${mode} ${stage}`),
    );
});

test("the sleep stages stay apart: ΔE2000 ≥ 20, and ≥ 15 under each dichromacy", () => {
  for (const [mode, v] of MODES)
    for (const kind of [null, "protan", "deutan", "tritan"])
      for (const [a, b] of pairs(STAGES)) {
        const d = deltaE2000(lab(v(a), kind), lab(v(b), kind));
        assert.ok(
          d >= (kind ? 15 : 20),
          `${mode} ${kind ?? "normal"} ${a}/${b}: ${d.toFixed(1)}`,
        );
      }
});

// sRGB `a` mixed `share` (0–1) into `b`, as CSS color-mix(in srgb) does.
const mixed = (a, b, share) =>
  `#${[1, 3, 5]
    .map((i) =>
      Math.round(
        parseInt(a.slice(i, i + 2), 16) * share +
          parseInt(b.slice(i, i + 2), 16) * (1 - share),
      )
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

test("every Summary calendar tile's words read at AA on every hue, light and dark (U3-4)", () => {
  const HUES = ["--accent", "--sleep", "--habit", "--alcohol", "--caffeine"];
  for (const [mode, v] of MODES) {
    const pct = (name) => Number.parseFloat(v(name)) / 100;
    // Shades 1–2 carry the text colour, 3 its own, 4 the surface's.
    const shades = [
      [pct("--cal-mix-1"), v("--fg")],
      [pct("--cal-mix-2"), v("--fg")],
      [pct("--cal-mix-3"), v("--cal-ink-3")],
      [1, v("--surface")],
    ];
    for (const hue of HUES)
      shades.forEach(([share, ink], i) => {
        const bg = mixed(v(hue), v("--surface"), share);
        const c = contrast(ink, bg);
        assert.ok(c >= 4.5, `${mode} ${hue} shade-${i + 1}: ${c.toFixed(2)}:1`);
      });
  }
});
