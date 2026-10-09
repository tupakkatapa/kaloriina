// Layout guard: every screen fits narrow phones and keeps controls
// comfortably tappable. Runs once (desktop project) at two phone widths and a
// desktop width.

import { test, expect } from "@playwright/test";
import { newProfile, ownProfile, todayInApp, unique } from "./helpers.js";

const WIDTHS = [320, 393, 1440];
const MIN_TAP = 44;

// Day 2045-06-15 lies outside every `unique()` slot of the UI specs, so its numbers stay its own.
// An openScale measurement on profile 1 (see the fixtures).
const reading = (id, userId, date) => ({
  id,
  userId,
  username: userId === 1 ? "Layout scale user with a long name" : "Anna",
  date,
  weight: userId === 1 ? 72.4 : 60,
  body_fat: 21.4,
  water: 55.2,
  muscle: 40.1,
});

async function fixtures(request) {
  const food = await (
    await request.post("/api/foods", {
      data: {
        name: "Layout oats with a deliberately long name to test wrapping",
        brand: "Layout brand",
        per100: { energy: 380, protein: 13, net_carbs: 60, fat: 7 },
        servings: [{ label: "bowl", grams: 60 }],
      },
    })
  ).json();
  const {
    entries: [entry],
  } = await (
    await request.post("/api/profiles/1/entries", {
      data: {
        day: "2045-06-15",
        group: "Consumed",
        food_id: food.id,
        grams: 60,
      },
    })
  ).json();
  const items = [{ food_id: food.id, grams: 120 }];
  const recipe = await (
    await request.post("/api/recipes", {
      data: {
        name: "Layout porridge",
        items,
        instructions: `Soak the oats overnight in a deliberately long line to test wrapping: ${"x".repeat(80)}\n\n2. Simmer.`,
      },
    })
  ).json();
  const meal = await (
    await request.post("/api/meals", {
      data: { name: "Layout breakfast", items },
    })
  ).json();
  await request.put("/api/profiles/1/weights/2045-06-15", {
    data: { kg: 72.4 },
  });
  await request.put("/api/profiles/1/notes/2020-06-15", {
    data: { text: "A deliberately long note to test how the Note wraps" },
  });
  await request.put("/api/profiles/1/weights/2020-06-15", {
    data: { kg: 72.4 },
  });
  await request.put("/api/profiles/1/measurements/2020-06-15/waist", {
    data: { value: 81.5 },
  });
  // A full check-in with long tags: the Log row and Body's section.
  await request.put("/api/profiles/1/check-ins/2020-06-15", {
    data: {
      mood: 4,
      energy: 3,
      stress: 2,
      tags: ["travel", "poor sleep", "a long tag, thirty characters"],
    },
  });
  const exercises = await (await request.get("/api/exercises")).json();
  const id = (name) => exercises.find((e) => e.name === name).id;
  const workout = await (
    await request.post("/api/workouts", {
      data: {
        name: "Layout workout with a deliberately long name to test wrapping",
        steps: [
          {
            kind: "repeat",
            name: "main",
            times: 3,
            steps: [
              {
                kind: "exercise",
                exercise_id: id("Bulgarian split squat"),
                reps: 8,
                kg: 20,
              },
              { kind: "rest", seconds: 60 },
            ],
          },
          { kind: "exercise", exercise_id: id("Side plank"), seconds: 30 },
        ],
      },
    })
  ).json();
  const session = await (
    await request.post("/api/profiles/1/sessions", {
      data: {
        day: "2045-06-15",
        workout_id: workout.id,
        name: workout.name,
        minutes: 25,
        sets: [{ exercise_id: id("Push-up"), reps: 12 }],
      },
    })
  ).json();
  // Every day of May 2020 logged: the month's daily charts and list; and
  // of April, more each day, so May's Highlights compare.
  for (let d = 1; d <= 31; d += 1)
    await request.post("/api/profiles/1/entries", {
      data: {
        day: `2020-05-${String(d).padStart(2, "0")}`,
        group: "Consumed",
        food_id: food.id,
        grams: 100 + d,
      },
    });
  for (let d = 1; d <= 30; d += 1)
    await request.post("/api/profiles/1/entries", {
      data: {
        day: `2020-04-${String(d).padStart(2, "0")}`,
        group: "Consumed",
        food_id: food.id,
        grams: 150,
      },
    });
  // A plan left on a past day: Training's ○ mark.
  await request.post("/api/profiles/1/plans", {
    data: { day: "2020-06-16", workout_id: workout.id },
  });
  // A tracker with a long name, counted on the past day (once per run).
  const HABIT = "Layout habit with a long name to test wrapping";
  const habit =
    (await (await request.get("/api/profiles/1/habits")).json()).find(
      (x) => x.name === HABIT,
    ) ??
    (await (
      await request.post("/api/profiles/1/habits", {
        data: { name: HABIT, unit: "pouches", goal_value: 5 },
      })
    ).json());
  await request.put(`/api/profiles/1/habits/${habit.id}/days/2020-06-15`, {
    data: { amount: 12 },
  });
  // openScale on profile 1: a bound user with a long name, another seen
  // and ignored, and scale days with body composition before the typed
  // weight above (so the profile's weight stays): Connections, the Log
  // card's scale line and hint, the weight chart's metric choice.
  const hook = "/api/profiles/1/sync/openscale";
  const sync = [
    reading(1, 1, "2020-06-13T05:00:00.000Z"),
    reading(2, 1, "2020-06-14T05:00:00.000Z"),
    reading(3, 2, "2020-06-14T06:00:00.000Z"),
  ];
  await request.post(hook, { data: { event: "insert", measurements: sync } });
  await request.put(hook, { data: { user_id: 1 } });
  await request.post(hook, { data: { event: "insert", measurements: sync } });
  // Health Connect on profile 1 from two phones: the Log card's activity
  // and Night lines and a long watch workout (a workout done) on
  // 2020-06-15, Body's Sleep section, Training's activity line, and
  // Connections' status with both devices.
  const nights = ["2020-06-13", "2020-06-14", "2020-06-15"].map((day) => ({
    day,
    active_kcal: 12345,
    steps: 123456,
    resting_hr: 54,
    hrv_ms: 48,
    asleep_min: 437,
    in_bed_min: 480,
    bedtime: "23:41",
    wake_time: "07:41",
    deep_min: 71,
    rem_min: 93,
    light_min: 273,
  }));
  const skiing = {
    key: "layout-1",
    day: "2020-06-15",
    start_at: "2020-06-15T14:02:00Z",
    end_at: "2020-06-15T16:48:00Z",
    type: 33,
    name: "Cross-country skiing with intervals and a long cool-down",
    kcal: 1410,
    distance_m: 42195,
  };
  for (const device of ["Pixel 9 Pro XL", "Galaxy S25 Ultra Enterprise"])
    await request.post("/api/profiles/1/sync/health", {
      data: {
        from: "2020-06-01",
        to: "2020-06-30",
        device,
        days: nights,
        sessions: [skiing],
      },
    });
  // A profile asking before adding watch workouts: two wait on the Log
  // card with Add and Dismiss.
  const asking = await newProfile(request, {
    name: `Layout ask ${crypto.randomUUID().slice(0, 8)}`,
    sex: "female",
    birth_date: "1990-01-01",
    height_cm: 165,
    weight_kg: 60,
  });
  await request.put(`/api/profiles/${asking.id}/sync/health/workouts`, {
    data: { mode: "ask" },
  });
  await request.post(`/api/profiles/${asking.id}/sync/health`, {
    data: {
      from: "2020-06-01",
      to: "2020-06-30",
      device: "Pixel 9 Pro XL",
      days: nights,
      sessions: [
        skiing,
        {
          ...skiing,
          key: "layout-2",
          start_at: "2020-06-15T18:00:00Z",
          end_at: "2020-06-15T18:40:00Z",
        },
      ],
    },
  });
  // A profile of its own with wide targets (energy "about" 3,000 kcal, so
  // 3,000–3,300 kcal inside) and food on the layout day: the diary's target
  // bars, Summary's nutrient table, Targets. Profile 1 keeps none, as
  // other specs read it untargeted.
  // Names are unique, and both tests of this file make one.
  const targeted = await newProfile(request, {
    name: `Layout targets ${crypto.randomUUID().slice(0, 8)}`,
    birth_date: "1990-01-01",
    height_cm: 190,
    weight_kg: 95,
  });
  const recommended = await (
    await request.get(`/api/profiles/${targeted.id}/targets`)
  ).json();
  await request.put(`/api/profiles/${targeted.id}/targets`, {
    data: {
      rev: targeted.rev,
      targets: recommended.map(({ metric, value }) => ({
        metric,
        value: metric === "energy" ? 3000 : value,
      })),
    },
  });
  await request.post(`/api/profiles/${targeted.id}/entries`, {
    data: {
      day: "2045-06-15",
      group: "Consumed",
      food_id: food.id,
      grams: 500,
    },
  });
  return {
    targeted: targeted.id,
    asking: asking.id,
    habit,
    food,
    entry,
    recipe,
    meal,
    workout,
    session,
    exercise: id("Push-up"),
  };
}

const routes = ({
  food,
  entry,
  recipe,
  meal,
  workout,
  session,
  exercise,
  habit,
  targeted,
  asking,
}) => [
  "/#/",
  "/#/day/2045-06-15",
  "/#/add/2045-06-15/Consumed",
  `/#/log/2045-06-15/Consumed/${food.id}`,
  // A recipe with instructions (one long unbroken line).
  `/#/log/2045-06-15/Consumed/${recipe.id}`,
  `/#/log-meal/2045-06-15/Consumed/${meal.id}`,
  "/#/scan/2045-06-15/Consumed",
  `/#/entry/${entry.id}`,
  `/#/session/${session.id}`,
  "/#/session/new?day=2045-06-15",
  "/#/foods",
  "/#/scan",
  `/#/log/${food.id}`,
  "/#/food/new",
  `/#/food/${food.id}`,
  "/#/recipe/new",
  `/#/recipe/${recipe.id}`,
  `/#/log-meal/${meal.id}`,
  "/#/meal/new",
  `/#/meal/${meal.id}`,
  "/#/targets",
  "/#/workouts",
  "/#/workout/new",
  `/#/workout/${workout.id}`,
  `/#/workout/${workout.id}/run`,
  "/#/sessions",
  "/#/exercises",
  `/#/exercise/${exercise}`,
  `/#/exercise/${exercise}/edit`,
  "/#/exercise/new",
  // Summary: each subtab (the 2045 day has food, a weight and a session).
  "/#/summary/food/week/2045-06-15",
  "/#/summary/food/month/2045-06-15",
  "/#/summary/food/year/2045-06-15",
  // A month of daily points (every day of May 2020 logged), with
  // Highlights and a comparison tile against April.
  "/#/summary/food/month/2020-05-15",
  "/#/summary/body/week/2045-06-15",
  "/#/summary/training/week/2045-06-15",
  "/#/summary/training/month/2045-06-15",
  "/#/summary/training/year/2045-06-15",
  "/#/profile",
  "/#/profile/1",
  "/#/profile/new",
  "/#/outbox",
  `/#/food/${food.id}/merge`,
  "/#/food/new?barcode=4000000000001&notfound=1",
  "/#/sources/energy?from=2045-06-15&to=2045-06-21",
  "/#/plan/2045-06-15",
  `/#/day/2045-06-15?select=${entry.id}`,
  // A Log card with a weight, measurements, a check-in, a note and a habit
  // (they can't be written ahead).
  "/#/day/2020-06-15",
  // Habits: Profile → Habits, a tracker's editor, and the calendar with a
  // counted day (the day above carries the Log card's tracker row).
  "/#/habits",
  "/#/habit/new",
  `/#/habit/${habit.id}`,
  "/#/summary/habits/week/2020-06-15",
  "/#/summary/habits/month/2020-06-15",
  "/#/summary/habits/year/2020-06-15",
  // Body with the scale's readings, measurements and a note; Training with
  // a past (missed) plan.
  "/#/summary/body/month/2020-06-15",
  // Body's check-ins in a week and a year.
  "/#/summary/body/week/2020-06-15",
  "/#/summary/body/year/2020-06-15",
  "/#/summary/training/month/2020-06-15",
  // Profile → Connections, bound, with Health Connect from two phones; a scale
  // day (composition, no ✕).
  "/#/connections",
  "/#/day/2020-06-14",
  // [address, profile]: the profile with wide targets.
  ...[
    "/#/day/2045-06-15",
    "/#/summary/food/month/2045-06-15",
    "/#/targets",
    "/#/profile",
  ].map((address) => [address, targeted]),
  // Ask mode: watch workouts waiting on the Log card.
  ["/#/day/2020-06-15", asking],
  // Body with sleep and heart only on a week of its own.
  ["/#/summary/body/week/2020-06-15", asking],
];

// Count the page's requests in flight (until their bodies are read).
const countRequests = () => {
  window.inflight = 0;
  const send = window.fetch;
  window.fetch = (...args) => {
    window.inflight += 1;
    return send(...args).then(
      (res) =>
        res
          .clone()
          .arrayBuffer()
          .catch(() => null)
          .then(() => {
            window.inflight -= 1;
            return res;
          }),
      (err) => {
        window.inflight -= 1;
        throw err;
      },
    );
  };
};

// The screen is drawn: no request in flight for a few frames running. Between
// two "#/" addresses only the hash changes, so "networkidle" would still hold
// from the screen before.
async function settled(page) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => {
    window.quiet = 0;
  });
  await page.waitForFunction(
    () => {
      window.quiet = window.inflight === 0 ? window.quiet + 1 : 0;
      return window.quiet >= 3;
    },
    null,
    { polling: "raf" },
  );
}

test("every screen fits phones and a desktop, with tappable controls", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "one run is enough");
  // Every route at three widths: slow, and slower under load.
  test.slow();
  const made = await fixtures(request);
  await page.addInitScript(countRequests);
  const problems = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    let shown = null;
    for (const item of routes(made)) {
      const [route, profile = 1] = [item].flat();
      await page.goto(route);
      // The profile is read once per page load.
      if (profile !== shown) {
        await page.evaluate(
          (id) => localStorage.setItem("profile", String(id)),
          profile,
        );
        await page.reload();
        shown = profile;
      }
      await settled(page);
      const found = await page.evaluate((minTap) => {
        const out = [];
        const doc = document.scrollingElement;
        if (doc.scrollWidth > window.innerWidth)
          out.push(
            `overflows: ${doc.scrollWidth}px > ${window.innerWidth}px at ${
              // The innermost element sticking out names the culprit.
              [...document.querySelectorAll("main *")]
                .filter(
                  (e) =>
                    e.getBoundingClientRect().right > window.innerWidth + 0.5,
                )
                .map(
                  (e) =>
                    `${e.tagName.toLowerCase()}.${e.className} "${e.textContent.trim().slice(0, 30)}"`,
                )
                .at(-1)
            }`,
          );
        // A table stays within its container (none scrolls on its own).
        for (const t of document.querySelectorAll("main table"))
          if (
            t.getBoundingClientRect().right >
            t.parentElement.getBoundingClientRect().right + 0.5
          )
            out.push(`table sticks out: ${t.className}`);
        const controls = [
          ...document.querySelectorAll(
            "button, .button, nav a, input:not([type=checkbox]), select",
          ),
          // A link on its own (not in a sentence) is a control too.
          ...[...document.querySelectorAll("main a")].filter(
            (a) => a.parentElement.textContent.trim() === a.textContent.trim(),
          ),
        ];
        for (const el of controls) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue; // hidden or folded
          if (r.height < minTap - 0.5) {
            const name =
              el.getAttribute("aria-label") ||
              el.textContent.trim() ||
              el.tagName;
            out.push(`small (${Math.round(r.height)}px): ${name.slice(0, 30)}`);
          }
        }
        // CSS `display` must never override the hidden attribute.
        for (const el of document.querySelectorAll("[hidden]"))
          if (el.getBoundingClientRect().height > 0)
            out.push(
              `hidden but shown: ${el.tagName.toLowerCase()}.${el.className}`,
            );
        for (const form of document.querySelectorAll("form")) {
          const primaries = form.querySelectorAll(":scope .primary").length;
          if (primaries > 1) out.push(`form with ${primaries} primary buttons`);
        }
        return out;
      }, MIN_TAP);
      for (const p of found) problems.push(`${width}px ${route}: ${p}`);
    }
  }
  expect(problems).toEqual([]);
});

test("a desktop gets a sidebar; the diary stays one column", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "one run is enough");
  await fixtures(request);
  const consumed = () =>
    page
      .locator("section.group", {
        has: page.getByRole("heading", { name: "Eaten" }),
      })
      .boundingBox();
  for (const [width, sidebar] of [
    [1440, true],
    [393, false],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#/day/2045-06-15");
    // The layout follows the width once the media query has caught up.
    await expect(page.locator("html.desktop")).toHaveCount(sidebar ? 1 : 0);
    await expect(page.getByRole("heading", { name: "Eaten" })).toBeVisible();
    const tabs = await page
      .getByRole("navigation", { name: "Main" })
      .boundingBox();
    const main = await page.locator("main").boundingBox();
    if (sidebar) {
      expect(tabs.x + tabs.width).toBeLessThanOrEqual(main.x);
      expect(tabs.y).toBeLessThan(200);
    } else {
      expect(tabs.y).toBeGreaterThan(800);
    }
    // Targets above the groups at every width.
    const targets = await page.locator(".targets.main").boundingBox();
    expect(targets.y + targets.height).toBeLessThanOrEqual(
      (await consumed()).y,
    );
  }

  // Only the Summary charts sit side by side on a desktop.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/summary/week/2045-06-15");
  const energy = await page
    .getByRole("img", { name: /^Energy by/ })
    .boundingBox();
  const macros = await page
    .getByRole("img", { name: /^Macros by/ })
    .boundingBox();
  expect(energy.x + energy.width).toBeLessThanOrEqual(macros.x);
});

test("the layout can be forced per device from the Profile page", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "one run is enough");
  const tabsY = async () =>
    (await page.getByRole("navigation", { name: "Main" }).boundingBox()).y;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/profile");
  const layout = page.getByRole("radiogroup", {
    name: "Layout on this device",
  });
  await expect(layout.getByRole("radio", { name: "Auto" })).toBeChecked();
  expect(await tabsY()).toBeLessThan(200);
  // Phone on a wide window: bottom tabs, and it sticks after a reload.
  await layout.getByRole("radio", { name: "Phone" }).click();
  await expect.poll(tabsY).toBeGreaterThan(800);
  await page.reload();
  expect(await tabsY()).toBeGreaterThan(800);
  // Desktop on a narrow window.
  await page.setViewportSize({ width: 393, height: 800 });
  await layout.getByRole("radio", { name: "Desktop" }).click();
  await expect.poll(tabsY).toBeLessThan(200);
  await layout.getByRole("radio", { name: "Auto" }).click();
  await expect.poll(tabsY).toBeGreaterThan(700);
});

// How a Log row's kind reads: size, colour and column width.
const kindStyle = (locator) =>
  locator.evaluate((el) => {
    const s = getComputedStyle(el);
    return [s.fontSize, s.color, el.getBoundingClientRect().width];
  });

// How many lines an element's text takes: one rect per line box.
const lines = (locator) =>
  locator.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return new Set([...range.getClientRects()].map((r) => Math.round(r.top)))
      .size;
  });

test("one-word names stay on one line", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "one run is enough");
  const { tag } = unique(800, testInfo);
  const pid = await ownProfile(page, request, `Words ${tag}`);
  const base = `/api/profiles/${pid}`;
  const day = todayInApp();
  for (const name of ["Reading", "Snus"])
    expect(
      (
        await request.post(`${base}/habits`, { data: { name, unit: "pages" } })
      ).ok(),
    ).toBeTruthy();
  expect(
    (
      await request.post(`${base}/sessions`, {
        data: { day, name: "Afternoon", minutes: 30, kcal: 90 },
      })
    ).ok(),
  ).toBeTruthy();
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/#/");
  for (const name of ["Reading", "Snus", "Afternoon"]) {
    const el = page.locator(".log-rows .name", { hasText: name }).first();
    await expect(el).toBeVisible();
    expect(await lines(el), name).toBe(1);
  }
});

test("at 320 px: tab labels whole, Log rows one layout, the headline wraps between parts", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "one run is enough");
  const { tag } = unique(809, testInfo);
  const pid = await ownProfile(page, request, `Narrow ${tag}`);
  const base = `/api/profiles/${pid}`;
  const day = todayInApp();
  const res = await request.post(`${base}/habits`, {
    data: { name: "Reading", unit: "pages" },
  });
  expect(res.ok()).toBeTruthy();
  expect(
    (
      await request.post(`${base}/sessions`, {
        data: { day, name: "Walk", minutes: 30, kcal: 90 },
      })
    ).ok(),
  ).toBeTruthy();
  const meal = await (
    await request.post("/api/foods", {
      data: { name: `Big meal ${tag}`, per100: { energy: 900 } },
    })
  ).json();
  for (const group of ["Consumed", "Planned"])
    await request.post(`${base}/entries`, {
      data: { day, group, food_id: meal.id, grams: 120 },
    });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/#/");
  await expect(page.locator(".log-rows")).toBeVisible();

  // Every fixed tab label shows whole (the profile tab is a name).
  const clipped = await page
    .locator(".tabs a:not([data-tab=profile]) > span:last-child")
    .evaluateAll((list) =>
      list
        .filter((s) => s.scrollWidth > s.clientWidth)
        .map((s) => s.textContent),
    );
  expect(clipped).toEqual([]);

  // A tracker's name is its row's kind; a workout's details sit under its
  // name, left-aligned.
  expect(await kindStyle(page.locator(".log-rows .habit-row .name"))).toEqual(
    await kindStyle(page.locator(".log-row .kind").first()),
  );
  const walk = page.locator(".log-row > a.result", { hasText: "Walk" });
  const [name, details] = await Promise.all([
    walk.locator(".name").boundingBox(),
    walk.locator(".muted").boundingBox(),
  ]);
  expect(details.x).toBe(name.x);
  expect(details.y).toBeGreaterThan(name.y);

  // "· 2,160 kcal with planned" never starts a line with its "·".
  const planned = page.locator(".headline > span").last();
  await expect(planned).toContainText("with planned");
  expect(await lines(planned)).toBe(1);
  await expect(page.locator(".headline > span").nth(-2)).toHaveText(/·\s*$/);
});

test("the check-in scale is a segmented control", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "one run is enough");
  const { tag } = unique(810, testInfo);
  await ownProfile(page, request, `Scale ${tag}`);
  await page.goto("/#/");
  await page.getByRole("button", { name: "+ Log" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Check-in/ })
    .click();
  const scale = page.locator(".switch.scale").first();
  await expect(scale).toBeVisible();
  // A tray behind the five, and each option shaped before it's pressed.
  const tray = await scale.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  expect(tray).not.toBe("rgba(0, 0, 0, 0)");
  const buttons = await scale
    .locator(".button")
    .evaluateAll((list) => list.map((b) => b.getBoundingClientRect().width));
  expect(buttons).toHaveLength(5);
  expect(Math.max(...buttons) - Math.min(...buttons)).toBeLessThan(1);
});
