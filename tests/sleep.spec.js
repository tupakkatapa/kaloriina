// Summary → Body with Health Connect's nights and heart: the Sleep tiles and
// calendar, and resting heart rate and HRV in the body chart.
// Every test uses a profile of its own; the week is 2026-08-31 (Mon) ..
// 2026-09-06.

import { expect, test } from "@playwright/test";
import {
  entry,
  food,
  ownProfile,
  postImport,
  syncHealth,
  unique,
} from "./helpers.js";

// A night from `bedtime` to 07:00 (Helsinki), asleep throughout: the
// server makes it of the session the phone keeps (helpers.js syncHealth).
const night = (day, bedtime) => ({
  day,
  bedtime,
  wake_time: "07:00",
  resting_hr: 54,
  hrv_ms: 48,
});

async function sync(request, pid, days) {
  const res = await syncHealth(request, pid, {
    from: "2026-08-31",
    to: "2026-09-06",
    device: "Pixel 9",
    days,
  });
  expect(res.status()).toBe(200);
}

test("Body shows the week's sleep after the chart, and heart in its switch", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(652, testInfo);
  const pid = await ownProfile(page, request, `Sleep ${tag}`);
  for (const [day, kg] of [
    ["2026-09-01", 61],
    ["2026-09-03", 60.6],
  ])
    await request.put(`/api/profiles/${pid}/weights/${day}`, { data: { kg } });
  // Bedtimes either side of midnight average midnight, ± 8 min.
  await sync(request, pid, [
    night("2026-09-01", "23:50"),
    night("2026-09-02", "00:00"),
    night("2026-09-03", "00:10"),
  ]);
  await page.goto("/#/summary/body/week/2026-08-31");
  const sleep = page.locator("section.sleep-summary");
  await expect(
    sleep.getByRole("list", { name: "Sleep" }).locator(".tile"),
  ).toHaveText([
    "7 h asleep a night",
    "00:00 average bedtime",
    "± 8 min bedtime spread",
    "07:00 average wake-up",
  ]);
  // After the weight chart.
  const order = await page
    .locator("section.weight, section.sleep-summary")
    .evaluateAll((list) => list.map((s) => s.className));
  expect(order[0]).toContain("weight");
  expect(order[1]).toContain("sleep-summary");
  // Each night on the day it ended; a day without one hatched.
  await expect(
    sleep.getByRole("link", {
      name: "Wed, Sep 2: 7 h asleep, 00:00–07:00 · 7 h in bed · 100 % efficiency, goal reached",
    }),
  ).toBeVisible();
  await expect(sleep.locator('td[data-day="2026-09-04"]')).toHaveClass(
    /\bnone\b/u,
  );
  // Exactly the 7 h goal: shaded as reaching it, as its ✓ says.
  await expect(sleep.locator('td[data-day="2026-09-02"]')).toHaveClass(
    /\bshade-3\b/u,
  );

  // Weight and what it makes in the Body chart; the device's heart in a
  // Heart chart of its own.
  await expect(
    page
      .locator("section.weight")
      .getByRole("radiogroup", { name: "Chart", exact: true })
      .getByRole("radio"),
  ).toHaveText(["Weight", "BMI", "Maintenance"]);
  const chart = page
    .locator("section.heart")
    .getByRole("radiogroup", { name: "Heart chart" });
  await expect(chart.getByRole("radio")).toHaveText(["RHR", "HRV"]);
  await chart.getByRole("radio", { name: "HRV" }).click();
  await expect(page.getByRole("heading", { name: "HRV by day" })).toBeVisible();
  await expect(
    page.getByRole("img", {
      name: "HRV by day: each day's value, faint, and the trend, in ms.",
    }),
  ).toBeVisible();
});

test("HRV without weigh-ins still charts", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(653, testInfo);
  const pid = await ownProfile(page, request, `Heart ${tag}`);
  await sync(request, pid, [
    { day: "2026-09-01", hrv_ms: 45 },
    { day: "2026-09-02", hrv_ms: 51 },
  ]);
  await page.goto("/#/summary/body/week/2026-08-31");
  await expect(page.getByRole("heading", { name: "HRV by day" })).toBeVisible();
  await expect(
    page.getByRole("img", {
      name: "HRV by day: each day's value, faint, and the trend, in ms.",
    }),
  ).toBeVisible();
  // The Body chart says it has nothing; the Heart chart stands alone.
  await expect(page.getByText("Nothing logged this week.")).toBeVisible();
  // Nothing else to switch to; no nights: Sleep says where they come from.
  await expect(page.getByRole("radiogroup", { name: "Chart" })).toHaveCount(0);
  await expect(page.locator("section.sleep-summary")).toHaveText(
    "SleepSleep comes from the Android app: set it up in Connections.",
  );
  await expect(
    page
      .locator("section.sleep-summary")
      .getByRole("link", { name: "Connections" }),
  ).toHaveAttribute("href", "#/connections");
});

// A Chart.js colour's alpha: rgba(r, g, b, a), else opaque.
const alpha = (c) => Number(/,\s*([\d.]+)\)$/u.exec(c)?.[1] ?? 1);

test("HRV by day: each day faint, the trend the line", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(780, testInfo);
  const pid = await ownProfile(page, request, `Trend ${tag}`);
  await sync(request, pid, [
    { day: "2026-09-01", hrv_ms: 45 },
    { day: "2026-09-02", hrv_ms: 51 },
    { day: "2026-09-03", hrv_ms: 48 },
  ]);
  await page.goto("/#/summary/body/week/2026-08-31");
  const img = page.getByRole("img", {
    name: "HRV by day: each day's value, faint, and the trend, in ms.",
  });
  // The days faint and easy to tap; the trend a solid line.
  await expect
    .poll(async () =>
      (
        await img.evaluate((canvas) =>
          window.Chart?.getChart(canvas)?.data.datasets.map((d) => ({
            label: d.label,
            data: d.data,
            line: d.showLine !== false,
            color: d.backgroundColor,
            hit: d.pointHitRadius ?? 1,
          })),
        )
      )?.map(({ color, hit, ...d }) => ({
        ...d,
        faint: alpha(color) < 0.6,
        touchable: hit >= 8,
      })),
    )
    .toEqual([
      {
        label: "HRV",
        data: [45, 51, 48],
        line: false,
        faint: true,
        touchable: true,
      },
      {
        label: "HRV trend",
        data: [45, 48, 48],
        line: true,
        faint: false,
        touchable: false,
      },
    ]);
});

// Every calendar is shaded from `--hue`; Body's had none, so its
// darkest cells were transparent (white text on the page).
const filled = (cell) =>
  cell.evaluate((td) => getComputedStyle(td).backgroundColor);

test("an s4 cell has a colour", async ({ page, request }, testInfo) => {
  const { tag } = unique(880, testInfo);
  const pid = await ownProfile(page, request, `Long night ${tag}`);
  await sync(request, pid, [
    {
      ...night("2026-09-01", "22:00"),
      asleep_min: 540,
      in_bed_min: 560,
    },
  ]);
  await request.put(`/api/profiles/${pid}/check-ins/2026-09-01`, {
    data: { mood: 5 },
  });
  await page.goto("/#/summary/body/week/2026-08-31");
  for (const section of ["section.sleep-summary", "section.check-ins"]) {
    const cell = page.locator(`${section} td[data-day="2026-09-01"]`);
    await expect(cell).toHaveClass(/\bshade-4\b/u);
    expect(await filled(cell)).not.toBe("rgba(0, 0, 0, 0)");
  }
});

// On Stress the calm day is the dark one, and the legend says so.
test("stress shades calm days darkest", async ({ page, request }, testInfo) => {
  const { tag } = unique(881, testInfo);
  const pid = await ownProfile(page, request, `Calm ${tag}`);
  for (const [day, stress] of [
    ["2026-09-01", 1],
    ["2026-09-02", 5],
  ])
    await request.put(`/api/profiles/${pid}/check-ins/${day}`, {
      data: { stress },
    });
  await page.goto("/#/summary/body/week/2026-08-31");
  const section = page.locator("section.check-ins");
  await expect(section.locator('td[data-day="2026-09-01"]')).toHaveClass(
    /\bshade-4\b/u,
  );
  await expect(section.locator('td[data-day="2026-09-02"]')).toHaveClass(
    /\bshade-1\b/u,
  );
  await expect(section.locator(".cal-legend")).toHaveText(
    "Nothing logged4–5 stressed321 calm",
  );
});

// An empty Body keeps every section's heading with its way in.
test("an empty Body says where each section comes from", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(882, testInfo);
  await ownProfile(page, request, `Empty ${tag}`);
  await page.goto("/#/summary/body/week/2026-08-31");
  for (const [section, hint] of [
    [
      "sleep-summary",
      "Sleep comes from the Android app: set it up in Connections.",
    ],
    ["check-ins", "Log a check-in from the Diary's Log card."],
    ["measurements", "Log a measurement from the Diary's Log card."],
    ["notes", "Write a note from the Diary's Log card."],
  ])
    await expect(page.locator(`section.${section} p`)).toHaveText(hint);
});

test("+ Log → Nap logs a nap by hand that counts as sleep and can be removed", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(311, testInfo);
  await ownProfile(page, request, `Nap ${tag}`);
  await page.goto("/#/day/2026-09-02");
  await page.getByRole("button", { name: /^Log on /u }).click();
  await page.getByRole("button", { name: "Nap" }).click();
  const dialog = page.getByRole("dialog", { name: /Nap on/u });
  await dialog.getByLabel("Fell asleep").fill("13:00");
  await dialog.getByLabel("Woke up").fill("13:25");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").last()).toContainText(
    "Logged a 25 min nap",
  );
  // The Sleep card holds it: counted asleep, its row there to remove.
  const card = page.locator(".sleep-card");
  await expect(card.locator(".sleep-total")).toHaveText("25 min");
  await expect(page.locator(".log-card .nap")).toHaveCount(0);
  const nap = card.locator(".log-row").filter({
    has: page.locator(".kind", { hasText: /^Nap$/u }),
  });
  await expect(nap).toContainText("13:00–13:25");
  await nap.getByRole("button", { name: "Remove nap 13:00–13:25" }).click();
  await expect(card).toHaveCount(0);
});

// The night of Sep 1–2 in Helsinki (UTC+3): 00:00–07:00, an awakening at
// 02:00, the spans' day the wake day.
const staged = {
  ...night("2026-09-02", "00:00"),
  avg_hr: 68,
  min_hr: 48,
  max_hr: 141,
  sleep_avg_hr: 55,
  stages: [
    ["2026-09-01T21:00:00Z", "2026-09-01T22:30:00Z", "deep"],
    ["2026-09-01T22:30:00Z", "2026-09-01T23:00:00Z", "awake"],
    ["2026-09-01T23:00:00Z", "2026-09-02T01:00:00Z", "rem"],
    ["2026-09-02T01:00:00Z", "2026-09-02T04:00:00Z", "light"],
  ].map(([start, end, stage]) => ({ start, end, stage })),
};

// The Diary's Sleep card on the day.
const sleepCard = (page) => page.locator(".sleep-card");

test("the Sleep card is the night at a glance, static: no expand, no details", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(720, testInfo);
  const pid = await ownProfile(page, request, `Stages ${tag}`);
  // A synced nap without stages: only its time in bed is known.
  await sync(request, pid, [
    {
      ...staged,
      naps: [
        {
          key: `synced-nap-${tag}`,
          start_at: "2026-09-02T12:00:00Z",
          end_at: "2026-09-02T12:40:00Z",
        },
      ],
    },
  ]);
  // A nap logged by hand beside the night: asleep throughout.
  await request.post(`/api/profiles/${pid}/naps`, {
    data: {
      uid: `nap-${tag}`,
      day: "2026-09-02",
      start_at: "2026-09-02T10:00:00Z",
      end_at: "2026-09-02T10:25:00Z",
    },
  });
  await page.goto("/#/day/2026-09-02");
  const card = sleepCard(page);
  // Sleep and Heart are the card's and Summary's now, not the Log's.
  await expect(page.locator(".log-card :is(.night, .heart)")).toHaveCount(0);
  // The night's time asleep (naps listed under it), its line,
  // bedtime and wake-up.
  await expect(card.locator("h2")).toHaveText("Sleep");
  await expect(card.locator(".sleep-total")).toHaveText("6 h 30 min");
  const line = card.getByRole("img", {
    name: /^Sleep stages from 00:00 to 07:00/u,
  });
  await expect(line).toHaveAccessibleName(
    "Sleep stages from 00:00 to 07:00: awake 30 min, REM 2 h, light 3 h, deep 1 h 30 min.",
  );
  await expect(line.locator(".night-span")).toHaveCount(4);
  await expect(card.locator(".night-ends > span")).toHaveText([
    "00:00",
    "07:00",
  ]);
  // Static: nothing expands, no facts list; the night's
  // facts are Summary → Body's. Only the hand nap's ✕ is a control.
  await expect(card.locator("details, summary")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Expand chart" })).toHaveCount(
    0,
  );
  await expect(card.getByRole("list", { name: "Night" })).toHaveCount(0);
  await expect(card.getByRole("button")).toHaveText([""]);
  // Both naps listed; only the hand one's ✕ (the synced one goes where it
  // came from).
  const naps = card.locator(".log-row");
  await expect(naps).toHaveCount(2);
  await expect(naps.first()).toContainText("13:00–13:25");
  await expect(
    naps.first().getByRole("button", { name: "Remove nap 13:00–13:25" }),
  ).toBeVisible();
  await expect(naps.last()).toContainText("15:00–15:40");
  await expect(naps.last().getByRole("button")).toHaveCount(0);
});

// The hypnogram's tooltip: the stage under the pointer, its span and how
// long, and the time there.
const tip = (card) => card.locator(".night-tip");

test("the hypnogram is in the macros' colours, as tall as a bar chart reads", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1036, testInfo);
  const pid = await ownProfile(page, request, `Colours ${tag}`);
  await sync(request, pid, [staged]);
  await page.goto("/#/day/2026-09-02");
  const line = sleepCard(page).getByRole("img", {
    name: /^Sleep stages from/u,
  });
  // The macros' colours: awake energy, REM protein, light carbs, deep fat.
  const colours = await line.evaluate((el) => {
    const css = (prop, value) => {
      const probe = document.createElement("i");
      probe.style.color = value;
      el.append(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    };
    return Object.fromEntries(
      ["awake", "rem", "light", "deep"].map((k) => [
        k,
        [
          getComputedStyle(el.querySelector(`.stage-${k}`)).backgroundColor,
          css(
            "color",
            `var(--${{ awake: "energy", rem: "protein", light: "carbs", deep: "fat" }[k]})`,
          ),
        ],
      ]),
    );
  });
  for (const [k, [span, macro]] of Object.entries(colours))
    expect(span, k).toBe(macro);
  // The nutrition bars' look: half a rem thick, pill ends, on a track.
  const span = line.locator(".night-span").first();
  expect(await span.evaluate((el) => getComputedStyle(el).borderRadius)).toBe(
    "999px",
  );
  expect((await span.boundingBox()).height).toBe(8);
  await expect(line.locator(".night-lane")).toHaveCount(4);
  // About 40 % taller than the 44 px it was.
  expect((await line.boundingBox()).height).toBeGreaterThanOrEqual(61);
});

test("the hypnogram says the stage under the pointer, a hold, or the arrow keys", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1037, testInfo);
  const pid = await ownProfile(page, request, `Scrub ${tag}`);
  await sync(request, pid, [staged]);
  await page.goto("/#/day/2026-09-02");
  const card = sleepCard(page);
  const line = card.getByRole("img", { name: /^Sleep stages from/u });
  const guide = card.locator(".night-guide");
  await expect(guide).toBeHidden();
  await expect(tip(card)).toHaveAttribute("aria-live", "polite");
  await expect(tip(card)).toHaveText("");
  // One mechanism: no SVG titles to announce twice.
  await expect(card.locator("title")).toHaveCount(0);
  await line.scrollIntoViewIfNeeded();
  const box = await line.boundingBox();
  const at = (share) => ({
    x: box.x + box.width * share,
    y: box.y + box.height / 2,
  });
  if (testInfo.project.use.hasTouch) {
    // A hold at 03:00 (REM); the tooltip goes with the finger's release.
    const cdp = await page.context().newCDPSession(page);
    const { x, y } = at(3 / 7);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    await page.waitForTimeout(600);
    await expect(tip(card)).toHaveText("REM02:00–04:00 · 2 h03:00");
    await expect(guide).toBeVisible();
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(guide).toBeHidden();
  } else {
    // 01:45, a quarter into the night of 00:00–07:00: the awakening.
    const { x, y } = at(0.25);
    await page.mouse.move(x, y);
    await expect(tip(card)).toHaveText("Awake01:30–02:00 · 30 min01:45");
    await expect(guide).toBeVisible();
    const g = await guide.boundingBox();
    expect(Math.abs(g.x - x)).toBeLessThan(2);
    await page.mouse.move(x, box.y + box.height + 80);
    await expect(guide).toBeHidden();
    await expect(tip(card)).toHaveText("");
  }
  // The keys step span by span.
  await line.focus();
  await page.keyboard.press("ArrowRight");
  await expect(tip(card)).toHaveText("Deep00:00–01:30 · 1 h 30 min");
  await expect(guide).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(tip(card)).toHaveText("Awake01:30–02:00 · 30 min");
  await page.keyboard.press("ArrowLeft");
  await expect(tip(card)).toHaveText("Deep00:00–01:30 · 1 h 30 min");
  await page.keyboard.press("Escape");
  await expect(tip(card)).toHaveText("");
});

test("a night without spans says why", async ({ page, request }, testInfo) => {
  const { tag } = unique(869, testInfo);
  const pid = await ownProfile(page, request, `Old app ${tag}`);
  // What an older app synced, kept in a file: the stage minutes, no spans.
  const file = await (await request.get(`/api/profiles/${pid}/export`)).json();
  file.profile.name = `Old app file ${tag}`;
  file.device_days = [
    {
      day: "2026-09-02",
      in_bed_min: 450,
      asleep_min: 420,
      bedtime: "00:00",
      wake_time: "07:00",
      deep_min: 90,
      rem_min: 120,
      light_min: 200,
    },
  ];
  const made = await postImport(request, "/api/profiles/import", file);
  expect(made.status()).toBe(201);
  const { id } = await made.json();
  await page.addInitScript(
    (restored) => localStorage.setItem("profile", String(restored)),
    id,
  );
  await page.goto("/#/day/2026-09-02");
  const card = sleepCard(page);
  const bar = card.getByRole("img", { name: /^Sleep stages:/u });
  await expect(bar).toHaveAccessibleName(
    "Sleep stages: deep 1 h 30 min, REM 2 h, light 3 h 20 min.",
  );
  const widths = await bar
    .locator(".stage-share")
    .evaluateAll((list) =>
      list.map((el) => Math.round(Number.parseFloat(el.style.width))),
    );
  expect(widths).toEqual([22, 29, 49]);
  // Each stage's minutes are the bar's tooltip (web/tips.mjs): hover,
  // focus or a tap.
  await expect(bar).toHaveAccessibleDescription(
    /^Deep 1\sh 30\smin REM 2\sh Light 3\sh 20\smin$/u,
  );
  await expect(card.locator(".night-ends > span")).toHaveText([
    "00:00",
    "07:00",
  ]);
  await expect(card.getByRole("button")).toHaveCount(0);
  await expect(card.locator("details")).toHaveCount(0);
  await expect(card).toContainText(
    "No stage timeline for this night: “Resync a year” in the Android app fills it in.",
  );
});

test("a calendar day opens the Diary", async ({ page, request }, testInfo) => {
  const { tag } = unique(721, testInfo);
  const pid = await ownProfile(page, request, `Day tap ${tag}`);
  await sync(request, pid, [staged]);
  // Something eaten for Food's calendar, its water Habits' (hydration).
  const soup = await food(request, {
    name: `Soup ${tag}`,
    per100: { energy: 60, water: 90 },
  });
  await entry(
    request,
    { day: "2026-09-02", group: "Eaten", food_id: soup.id, grams: 300 },
    pid,
  );
  for (const tab of ["food", "body", "activity", "habits"]) {
    await page.goto(`/#/summary/${tab}/week/2026-08-31`);
    await page
      .locator('td[data-day="2026-09-02"]')
      .first()
      .getByRole("link")
      .click();
    await expect(page, tab).toHaveURL(/#\/day\/2026-09-02$/u);
    await expect(page.locator(".log-card")).toBeVisible();
  }
});

test("a night's facts are in its calendar day on Summary → Body", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1043, testInfo);
  const pid = await ownProfile(page, request, `Facts ${tag}`);
  await sync(request, pid, [staged]);
  await request.post(`/api/profiles/${pid}/naps`, {
    data: {
      uid: `nap-${tag}`,
      day: "2026-09-02",
      start_at: "2026-09-02T10:00:00Z",
      end_at: "2026-09-02T10:25:00Z",
    },
  });
  await page.goto("/#/summary/body/week/2026-08-31");
  // The Diary's Sleep card is static; the night's facts live here, on
  // hover (title) and for a screen reader (the link's name).
  const facts =
    "Wed, Sep 2: 6 h 30 min asleep, 00:00–07:00 · 7 h in bed · " +
    "93 % efficiency · deep 1 h 30 min (23 %) · REM 2 h (31 %) · " +
    "light 3 h (46 %) · heart rate asleep 55 bpm · + 25 min nap";
  const day = page
    .locator("section.sleep-summary")
    .locator('td[data-day="2026-09-02"]')
    .getByRole("link");
  await expect(day).toHaveAccessibleName(facts);
  await expect(day).toHaveAttribute(
    "title",
    new RegExp(
      `^${facts.replaceAll(/[()+]/gu, "\\$&").replaceAll(" ", "\\s")}$`,
      "u",
    ),
  );
});
