// Summary's energy model: resting energy's source over a period, the
// balance led by a maintenance measured from the weight trend
// with burned second and named, Activity's burned over Food's days,
// and estimates said in 50 kJ steps. Every test uses a profile
// of its own, its days in the past.

import { expect, test } from "@playwright/test";
import { entry, food, ownProfile, unique } from "./helpers.js";

const balanceLine = (page) => page.locator(".balance-line");

// The parts of `line` (" · " between them; a trailing ", …" its own) that
// break across lines: each part's text, where its boxes sit on more than
// one line.
const brokenParts = (line) =>
  line.evaluate((p) => {
    const text = p.firstChild;
    const out = [];
    let at = 0;
    for (const part of text.data.split(/ · |, /u)) {
      const start = text.data.indexOf(part, at);
      at = start + part.length;
      const r = document.createRange();
      r.setStart(text, start);
      r.setEnd(text, at);
      const tops = new Set(
        [...r.getClientRects()].map((b) => Math.round(b.top)),
      );
      if (tops.size > 1) out.push(part);
    }
    return out;
  });
const balanceTiles = (page) =>
  page.getByRole("list", { name: /^Energy balance over /u }).locator(".tile");

// A basal metabolic rate as the phone keeps it raw, Samsung Health's.
const bmr = (id, day, kcal) => {
  const at = `${day}T06:00:00Z`;
  return {
    kind: "BasalMetabolicRate",
    id,
    start: at,
    data: {
      time: at,
      zone_offset: "Z",
      kcal_per_day: kcal,
      metadata: { data_origin: "com.sec.android.app.shealth" },
    },
  };
};

// 500 g of a 400 kcal/100 g food (2,000 kcal) eaten on each of `days`.
async function eat(request, pid, tag, days) {
  const f = await food(request, {
    name: `Stew ${tag}`,
    per100: { energy: 400 },
  });
  for (const day of days)
    await entry(
      request,
      { day, group: "Eaten", food_id: f.id, grams: 500 },
      pid,
    );
}

test("the balance names resting energy's sources over a period mixing them (owner item 4)", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1138, testInfo);
  // Female, 165 cm, 60 kg: Mifflin–St Jeor 1,295 kcal a day at 35.
  const pid = await ownProfile(page, request, `Mix ${tag}`);
  await request.put(`/api/profiles/${pid}/weights/2025-03-01`, {
    data: { kg: 60 },
  });
  await eat(request, pid, tag, ["2025-03-04", "2025-03-05"]);
  // Health Connect's resting from the 5th on: the 4th is Mifflin's.
  const sent = await request.post(`/api/profiles/${pid}/sync/health/records`, {
    data: {
      device: "Galaxy S24",
      records: [bmr(`bmr-${tag}`, "2025-03-05", 1505)],
    },
  });
  expect(sent.ok()).toBeTruthy();
  await page.goto("/#/summary/food/week/2025-03-04");
  await expect(balanceTiles(page).first()).toHaveText(
    /^≈\s1,400\skcal\s*resting \(BMR\) a day$/u,
  );
  await expect(balanceTiles(page).first()).toHaveAccessibleDescription(
    /: from Health Connect on 1 of 2 days, else Mifflin–St Jeor\.$/u,
  );
  // The next week, carried from the 5th (up to 6 days): its app named.
  await eat(request, pid, `${tag}b`, ["2025-03-10"]);
  await page.goto("/#/summary/food/week/2025-03-10");
  await expect(balanceTiles(page).first()).toHaveAccessibleDescription(
    /: from Health Connect \(Samsung Health\)\.$/u,
  );
});

test("a measured maintenance leads the balance; burned is second, named; Activity averages Food's days (UX11-5)", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1139, testInfo);
  const pid = await ownProfile(page, request, `Trend ${tag}`);
  // Losing 0.04 kg a day on 2,000 kcal: maintenance ≈ 2,000 + 308.
  for (const [day, kg] of [
    ["2025-03-05", 60],
    ["2025-03-15", 59.6],
    ["2025-03-25", 59.2],
  ])
    await request.put(`/api/profiles/${pid}/weights/${day}`, { data: { kg } });
  const days = Array.from(
    { length: 28 },
    (_, i) => `2025-03-${String(i + 1).padStart(2, "0")}`,
  );
  await eat(request, pid, tag, days);
  // A phone: the line wraps between its parts, never inside one.
  await page.setViewportSize({ width: 393, height: 851 });
  await page.goto("/#/summary/food/month/2025-03-15");
  await expect(balanceLine(page)).toHaveText(
    /^Eaten\s2,000 · Maintenance\s≈\s2,310 · Deficit\s≈\s310\skcal\sa\sday, from\syour\sweight\strend$/u,
  );
  expect(await brokenParts(balanceLine(page))).toEqual([]);
  // The energy model's burned, second and named, with its own gap.
  await expect(page.locator(".energy-sources")).toHaveText(
    /^Burned by the energy model ≈ [\d,]+\skcal a day \(from resting energy, digesting, an estimate of everyday movement and your activities \(no active energy from a device\)\): surplus\s≈\s[\d,]+\skcal\sa\sday\.$/u,
  );
  // Activity's burned is over the same days: the 28 with food.
  await page.goto("/#/summary/activity/month/2025-03-15");
  const burned = page
    .locator(".movement-summary .tile")
    .filter({ hasText: "burned a day" });
  await expect(burned).toHaveText(/^≈ [\d,]+\skcal burned a day$/u);
  await expect(burned).toHaveAccessibleDescription(
    /over the 28 days with food logged/u,
  );
});

test("a kJ device says the balance's estimates in 50 kJ steps (QUAL11-N2)", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1140, testInfo);
  const pid = await ownProfile(page, request, `Joules ${tag}`);
  await page.addInitScript(() => localStorage.setItem("energy-unit", "kJ"));
  await page.setViewportSize({ width: 393, height: 851 });
  await request.put(`/api/profiles/${pid}/weights/2025-03-01`, {
    data: { kg: 60 },
  });
  await eat(request, pid, tag, ["2025-03-04", "2025-03-05"]);
  await page.goto("/#/summary/food/week/2025-03-04");
  const line = await balanceLine(page).textContent();
  const burned = Number(
    /Burned\s≈\s([\d,]+)/u.exec(line)[1].replaceAll(",", ""),
  );
  const gap = Number(
    /≈\s([\d,]+)\skJ\sa\sday/u.exec(line)[1].replaceAll(",", ""),
  );
  expect(burned % 50, line).toBe(0);
  expect(gap % 50, line).toBe(0);
  // A phone: the line wraps between its parts, never inside one.
  expect(await brokenParts(balanceLine(page))).toEqual([]);
});
