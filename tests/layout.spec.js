// Layout guard: every screen fits narrow phones and keeps controls
// comfortably tappable. Runs once (desktop project) at two phone widths and a
// desktop width.

import { expect, test } from "@playwright/test";
import {
  fixedToday,
  newProfile,
  ownProfile,
  syncHealth,
  todayInApp,
  unique,
} from "./helpers.js";

// One today for the whole test, in the page and here.
test.beforeEach(({ page }) => fixedToday(page));

const WIDTHS = [320, 393, 1440];
const MIN_TAP = 44;

// Day 2045-06-15 lies outside every `unique()` slot of the UI specs, so its
// numbers stay its own. An openScale measurement on profile 1 (see the
// fixtures).
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

// An 8 × 8 orange JPEG.
const JPEG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCuAkTb/9k=";

// A sleep stage span on `day` (UTC "HH:MM").
const stageSpan = (day, from, to, stage) => ({
  start: `${day}T${from}:00Z`,
  end: `${day}T${to}:00Z`,
  stage,
});

async function fixtures(request) {
  const food = await (
    await request.post("/api/foods", {
      data: {
        name: "Layout oats with a deliberately long name to test wrapping",
        brand: "Layout brand",
        // Every health cue: lights, the energy split and (for a profile
        // with targets) six nutrients per 100 kcal.
        per100: {
          energy: 380,
          protein: 13,
          net_carbs: 60,
          fat: 7,
          saturated: 1.2,
          sugars: 1,
          sodium: 6,
          fiber: 10,
          iron: 4.5,
          magnesium: 130,
          zinc: 3,
          b1: 0.5,
          phosphorus: 100,
          folate: 50,
        },
        servings: [{ label: "bowl", grams: 60 }],
        // Typed per its bowl: the editor reads "Values per bowl" (its
        // weight known, so the lights still show).
        basis: { serving: "bowl", estimated: false },
      },
    })
  ).json();
  const {
    entries: [entry],
  } = await (
    await request.post("/api/profiles/1/entries", {
      data: {
        day: "2045-06-15",
        group: "Eaten",
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
        notes: `Soak the oats overnight in a deliberately long line to test wrapping: ${"x".repeat(80)}\n\n2. Simmer.`,
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
    await request.post("/api/profiles/1/activities", {
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
        group: "Eaten",
        food_id: food.id,
        grams: 100 + d,
      },
    });
  for (let d = 1; d <= 30; d += 1)
    await request.post("/api/profiles/1/entries", {
      data: {
        day: `2020-04-${String(d).padStart(2, "0")}`,
        group: "Eaten",
        food_id: food.id,
        grams: 150,
      },
    });
  // A plan left on a past day: Activity's ○ mark.
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
  // and Night lines and a long device workout (a workout done) on
  // 2020-06-15, Body's Sleep section, Activity's activity line, and
  // Connections' status with both devices; each night's stages and heart
  // for Body's Day.
  const nights = ["2020-06-13", "2020-06-14", "2020-06-15"].map((day) => ({
    day,
    avg_hr: 168,
    min_hr: 48,
    max_hr: 199,
    sleep_avg_hr: 55,
    stages: [
      stageSpan(day, "00:00", "01:10", "deep"),
      stageSpan(day, "01:10", "01:12", "awake"),
      stageSpan(day, "01:12", "02:45", "rem"),
      stageSpan(day, "02:45", "04:41", "light"),
    ],
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
    await syncHealth(request, 1, {
      from: "2020-06-01",
      to: "2020-06-30",
      device,
      days: nights,
      sessions: [skiing],
    });
  // A profile asking before adding device activities: two wait on the Log
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
  await syncHealth(request, asking.id, {
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
  const {
    entries: [eaten],
  } = await (
    await request.post(`/api/profiles/${targeted.id}/entries`, {
      data: {
        day: "2045-06-15",
        group: "Eaten",
        food_id: food.id,
        grams: 500,
      },
    })
  ).json();
  // A daily item (its long name in a due row and its editor): on its own
  // profile, as it shows on every later day.
  const { repeat: daily } = await (
    await request.patch(`/api/profiles/${targeted.id}/entries/${eaten.id}`, {
      data: { repeat: { start: "2045-06-15" } },
    })
  ).json();
  // A photo in Eaten (its thumbnail strip).
  const photo = await request.post(
    `/api/profiles/${targeted.id}/photos?day=2045-06-15&group=Eaten`,
    {
      headers: { "Content-Type": "image/jpeg" },
      data: Buffer.from(JPEG, "base64"),
    },
  );
  expect(photo.status()).toBe(201);
  return {
    targeted: targeted.id,
    daily,
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
  daily,
}) => [
  "/#/",
  "/#/day/2045-06-15",
  "/#/add/2045-06-15/Eaten",
  `/#/log/2045-06-15/Eaten/${food.id}`,
  // A recipe with notes (one long unbroken line).
  `/#/log/2045-06-15/Eaten/${recipe.id}`,
  `/#/log-meal/2045-06-15/Eaten/${meal.id}`,
  "/#/scan/2045-06-15/Eaten",
  `/#/entry/${entry.id}`,
  `/#/activity/${session.id}`,
  `/#/activity/${session.id}/edit`,
  "/#/activity/new?day=2045-06-15",
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
  "/#/activity",
  "/#/workout/new",
  `/#/workout/${workout.id}`,
  `/#/workout/${workout.id}/edit`,
  `/#/workout/${workout.id}/run`,
  "/#/activities",
  `/#/activities?workout=${workout.id}`,
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
  "/#/summary/activity/week/2045-06-15",
  "/#/summary/activity/month/2045-06-15",
  "/#/summary/activity/year/2045-06-15",
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
  // Body with the scale's readings, measurements and a note; Activity with
  // a past (missed) plan.
  "/#/summary/body/month/2020-06-15",
  // Body's check-ins in a week and a year.
  "/#/summary/body/week/2020-06-15",
  "/#/summary/body/year/2020-06-15",
  "/#/summary/activity/month/2020-06-15",
  // Each subtab's Day: Body's hypnogram and heart, Food's intake, Activity's
  // sessions, Habits' values against goals.
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
    // All time, Records and Feedback.
    "/#/stats",
    "/#/records",
    "/#/feedback",
    // Health cues with nutrient density against its targets.
    `/#/log/2045-06-15/Eaten/${food.id}`,
    `/#/log-meal/2045-06-15/Eaten/${meal.id}`,
    `/#/food/${food.id}`,
    `/#/recipe/${recipe.id}`,
    `/#/meal/${meal.id}`,
    // A daily item due in Planned, and its editor.
    "/#/day/2045-06-16",
    `/#/entry/daily-${daily.id}-2045-06-16`,
  ].map((address) => [address, targeted]),
  // Ask mode: device workouts waiting on the Log card.
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
async function drawn(page) {
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
      await drawn(page);
      // Health cues fold their density away: open, it must fit too.
      await page.evaluate(() => {
        for (const d of document.querySelectorAll("details.density"))
          d.open = true;
      });
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
          // Hidden or folded.
          if (r.width === 0 || r.height === 0) continue;
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

test("a desktop gets a sidebar; the diary one column, in the phone's order", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "one run is enough");
  await fixtures(request);
  const eaten = () =>
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
    // One column at every width, read in one order: the
    // numbers, the food groups, then the Sleep and Log cards.
    await expect(page.locator(".split")).toHaveCount(0);
    const targets = await page.locator(".targets.main").boundingBox();
    const group = await eaten();
    const log = await page.locator(".log-card").boundingBox();
    expect(targets.y + targets.height).toBeLessThanOrEqual(group.y);
    expect(group.y + group.height).toBeLessThanOrEqual(log.y);
    expect(Math.round(targets.x)).toBe(Math.round(group.x));
    expect(Math.round(targets.width)).toBe(Math.round(group.width));
  }

  // On a desktop the Diary's Other nutrients fold sets its categories in
  // two columns, each whole.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/day/2045-06-15");
  await page.locator("summary", { hasText: "Other nutrients" }).click();
  const groups = page.locator(".all-targets .category-group");
  await expect(groups.first()).toBeVisible();
  const lefts = await groups.evaluateAll((list) =>
    list.map((g) => Math.round(g.getBoundingClientRect().left)),
  );
  expect(new Set(lefts).size).toBe(2);
});

// One page width: every desktop screen's section fills the
// same column, list screens and the Summary's tabs included.
test("every desktop screen is one page width", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "one run is enough");
  test.slow();
  const made = await fixtures(request);
  await page.addInitScript(countRequests);
  await page.setViewportSize({ width: 1280, height: 900 });
  const widths = new Map();
  for (const item of routes(made)) {
    const [route, profile = 1] = [item].flat();
    if (profile !== 1) continue;
    // A fresh load each: the run screen keeps a hash change from leaving.
    await page.goto("about:blank");
    await page.goto(route);
    await drawn(page);
    const width = await page.evaluate(() =>
      Math.round(document.querySelector("main > section").offsetWidth),
    );
    widths.set(route, width);
  }
  const column = [...widths.values()][0];
  expect(column).toBe(960);
  expect([...widths].filter(([, w]) => w !== column)).toEqual([]);
  // The Summary's tab strip spans the page too.
  await page.goto("about:blank");
  await page.goto("/#/summary/food/week/2045-06-15");
  const strip = await page.locator(".subtabs").boundingBox();
  const section = await page.locator("main > section").boundingBox();
  expect(Math.round(strip.width)).toBe(Math.round(section.width));
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
    name: "Layout in this browser",
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
      await request.post(`${base}/activities`, {
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
      await request.post(`${base}/activities`, {
        data: { day, name: "Walk", minutes: 30, kcal: 90 },
      })
    ).ok(),
  ).toBeTruthy();
  const meal = await (
    await request.post("/api/foods", {
      data: { name: `Big meal ${tag}`, per100: { energy: 900 } },
    })
  ).json();
  for (const group of ["Eaten", "Planned"])
    await request.post(`${base}/entries`, {
      data: { day, group, food_id: meal.id, grams: 120 },
    });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/#/");
  await expect(page.locator(".log-card .log-rows")).toBeVisible();

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

  // "2,160 kcal with planned" moves whole, its "·" drawn before it (see
  // spacing.spec.js): none is left dangling at a line's end.
  const planned = page.locator(".headline:not(.total) > span").last();
  await expect(planned).toHaveText(/^\d.*with planned$/u);
  expect(await lines(planned)).toBe(1);
  await expect(page.locator(".headline:not(.total) > span").nth(-2)).toHaveText(
    /eaten$/u,
  );
});

test("the check-in scale is a segmented control", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "one run is enough");
  const { tag } = unique(810, testInfo);
  await ownProfile(page, request, `Scale ${tag}`);
  await page.goto("/#/");
  await page.getByRole("button", { name: /^Log on /u }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Check-in/u })
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

// A serving's amount fits six digits, in a recipe's items and a food's
// servings alike, on the narrowest phone too.
test("amount fields fit six digits", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "one run is enough");
  const { tag } = unique(934, testInfo);
  const food = await (
    await request.post("/api/foods", {
      data: {
        name: `Six digits ${tag}`,
        per100: { energy: 100 },
        servings: [{ label: "Slice", grams: 30 }],
      },
    })
  ).json();
  const recipe = await (
    await request.post("/api/recipes", {
      data: {
        name: `Six digit recipe ${tag}`,
        items: [{ food_id: food.id, serving: "Slice", quantity: 1 }],
      },
    })
  ).json();
  const fields = [
    [`/#/recipe/${recipe.id}`, `Six digits ${tag} quantity`],
    [`/#/food/${food.id}`, "Serving grams"],
  ];
  for (const width of [320, 393, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    for (const [route, label] of fields) {
      await page.goto(route);
      const input = page.getByLabel(label, { exact: true }).first();
      // Measured, then put back: leaving a changed form would ask.
      const fit = await input.evaluate((el) => {
        const was = el.value;
        el.value = "123456";
        const out = [
          el.scrollWidth,
          el.clientWidth,
          document.scrollingElement.scrollWidth,
          window.innerWidth,
        ];
        el.value = was;
        return out;
      });
      expect(fit[0], `${width}px ${route}`).toBeLessThanOrEqual(fit[1]);
      expect(fit[2], `${width}px ${route}`).toBeLessThanOrEqual(fit[3]);
    }
  }
});

// WCAG 2 contrast of two sRGB colours (0–255).
const luminance = (c) => {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (x, y) => {
  const [a, b] = [luminance(x), luminance(y)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

test("label chips keep contrast in both themes", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "one run is enough");
  const { tag } = unique(565, testInfo);
  // Unhealthy and Healthy in the rows and on each food's own screen.
  for (const [name, per100] of [
    // Sat. fat and salt score it Unhealthy (ADR 0033).
    [
      "fat",
      {
        energy: 400,
        protein: 30,
        fat: 30,
        saturated: 12,
        sugars: 1,
        sodium: 1500,
      },
    ],
    [
      "lean",
      {
        energy: 110,
        protein: 23,
        fat: 1.5,
        saturated: 0.4,
        sugars: 0,
        sodium: 60,
      },
    ],
  ]) {
    const res = await request.post("/api/foods", {
      data: { name: `Contrast chips ${name} ${tag}`, per100 },
    });
    expect(res.ok()).toBeTruthy();
  }
  const check = async (chips) => {
    for (const dark of [false, true]) {
      await page.evaluate(
        (on) => document.documentElement.classList.toggle("dark", on),
        dark,
      );
      const colours = await chips.evaluateAll((els) => {
        // Any CSS colour (color-mix gives `color(srgb …)`) as sRGB 0–255,
        // through a canvas. A transparent chip is read on its page.
        const ctx = document.createElement("canvas").getContext("2d");
        const rgb = (css) => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = css;
          ctx.fillRect(0, 0, 1, 1);
          return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
        };
        return els.map((el) => {
          let e = el;
          while (
            e.parentElement &&
            getComputedStyle(e).backgroundColor === "rgba(0, 0, 0, 0)"
          )
            e = e.parentElement;
          return [
            el.textContent,
            rgb(getComputedStyle(el).color),
            rgb(getComputedStyle(e).backgroundColor),
          ];
        });
      });
      for (const [chip, fg, bg] of colours)
        expect(
          contrast(fg, bg),
          `${chip} (${dark ? "dark" : "light"})`,
        ).toBeGreaterThanOrEqual(4.5);
    }
  };
  await page.goto("/#/foods");
  await page.getByLabel("Search foods").fill(`Contrast chips ${tag}`);
  const rows = page.locator(".result .light");
  await expect(rows).toHaveText(["Unhealthy", "Healthy"]);
  await check(rows);
  await page
    .getByRole("button", {
      name: new RegExp(`^Contrast chips lean ${tag}`, "u"),
    })
    .click();
  // A food's own view: its verdict alone.
  const own = page.locator(".lights.labels .light");
  await expect(own).toHaveText(["Healthy"]);
  await check(own);
  // A row shows only the verdict: the negatives (red) on their food's own
  // screen.
  await page.goBack();
  await page.getByLabel("Search foods").fill(`Contrast chips ${tag}`);
  await page
    .getByRole("button", {
      name: new RegExp(`^Contrast chips fat ${tag}`, "u"),
    })
    .click();
  await expect(own.first()).toHaveText("Unhealthy");
  await check(own);
});

// Phones at 320, 360 and 412 px in a Finnish browser (its longer dates and
// grouped numbers): no page scrolls sideways, even with long unbroken words;
// tile values, the active tab's label and the week title show whole, the ›
// stays on screen; Highlighted's compact bars stack label over value.
test("phone widths: tiles, the active tab, the week title and long words fit", async ({
  browser,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "one run is enough");
  const context = await browser.newContext({ locale: "fi-FI" });
  const page = await context.newPage();
  const { tag } = unique(245, testInfo);
  const pid = await ownProfile(page, request, `Fi ${tag}`);
  const base = `/api/profiles/${pid}`;
  const day = todayInApp();
  const long = `Täysjyväkaurapuuromarjasekoitus${"x".repeat(60)}${tag}`;
  const f = await (
    await request.post("/api/foods", {
      data: { name: long, per100: { energy: 900, fat: 100 } },
    })
  ).json();
  for (let i = 0; i < 4; i += 1)
    expect(
      (
        await request.post(`${base}/entries`, {
          data: { day, group: "Eaten", food_id: f.id, grams: 2400 },
        })
      ).ok(),
    ).toBeTruthy();
  expect(
    (
      await request.post(`${base}/activities`, {
        data: { day, name: long, minutes: 615, kcal: 4000 },
      })
    ).ok(),
  ).toBeTruthy();

  // Polled: fonts and late lists settle (until F's `expectFits` lands).
  const fits = (what) =>
    expect
      .poll(() => page.evaluate(() => document.scrollingElement.scrollWidth), {
        message: `${what} scrolls sideways`,
      })
      .toBeLessThanOrEqual(page.viewportSize().width);
  const clipped = (selector) =>
    page
      .locator(selector)
      .evaluateAll((list) =>
        list
          .filter((el) => el.scrollWidth > el.clientWidth + 0.5)
          .map((el) => el.textContent),
      );

  for (const width of [320, 360, 412]) {
    await page.setViewportSize({ width, height: 800 });
    for (const [route, ready] of [
      ["/#/", page.getByText(long).first()],
      ["/#/activity", page.getByText(long).first()],
      ["/#/activities", page.getByText(long).first()],
      ["/#/stats", page.locator(".tile-value").first()],
    ]) {
      await page.goto(route);
      await expect(ready).toBeVisible();
      await fits(`${width} ${route}`);
      expect(await clipped(".tile-value"), `${width} ${route}`).toEqual([]);
    }
    // Highlighted (the targets card's page 2): label over value, always.
    await page.goto("/#/");
    await page.locator(".pager > .dot").nth(1).click();
    const jagged = await page
      .locator(".targets-page.grid .target-label")
      .evaluateAll((labels) =>
        labels
          .filter(
            (l) =>
              l.lastElementChild.getBoundingClientRect().top <=
              l.firstElementChild.getBoundingClientRect().top,
          )
          .map((l) => l.textContent),
      );
    expect(jagged.length, `${width}`).toBe(0);
    expect(
      await page.locator(".targets-page.grid .target-label").count(),
    ).toBeGreaterThan(0);

    await page.goto(`/#/summary/food/week/${day}`);
    await expect(page.locator(".period-title")).toBeVisible();
    await fits(`${width} week`);
    expect(await clipped(".tiles .tile-value"), `${width} week`).toEqual([]);
    expect(
      await clipped(".tabs a[aria-current] > span:last-child"),
      `${width} tab`,
    ).toEqual([]);
    const next = await page
      .getByRole("link", { name: "Next week" })
      .boundingBox();
    expect(next.x + next.width, `${width} ›`).toBeLessThanOrEqual(width);
  }
  await context.close();
});

const ok = async (res) => expect((await res).ok()).toBeTruthy();

// Every value in the Log, Activity and nap rows and Eaten's day totals
// starts at one left edge, the trackers' counts too.
test("Log, Activity, nap and Eaten totals values share one left edge", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1080, testInfo);
  const pid = await ownProfile(page, request, `Edge ${tag}`);
  const base = `/api/profiles/${pid}`;
  const day = new Date(Date.parse(todayInApp()) - 2 * 864e5)
    .toISOString()
    .slice(0, 10);
  const all = await (await request.get("/api/exercises")).json();
  const w = await (
    await request.post("/api/workouts", {
      data: {
        name: `Full body ${tag}`,
        steps: [
          {
            kind: "exercise",
            exercise_id: all.find((e) => e.name === "Push-up").id,
            reps: 5,
          },
        ],
      },
    })
  ).json();
  await ok(request.post(`${base}/plans`, { data: { day, workout_id: w.id } }));
  await ok(
    request.post(`${base}/activities`, {
      data: { day, type: "walk", name: "Walk", minutes: 30, sets: [] },
    }),
  );
  await ok(request.put(`${base}/weights/${day}`, { data: { kg: 81.9 } }));
  await ok(
    request.put(`${base}/measurements/${day}/waist`, { data: { value: 80 } }),
  );
  await ok(request.put(`${base}/notes/${day}`, { data: { text: "Tired" } }));
  // Beer: Eaten's Hydration and From food rows.
  const beer = await (
    await request.post("/api/foods", {
      data: {
        name: `Beer ${tag}`,
        per100: { water: 90, alcohol: 4, sodium: 40 },
      },
    })
  ).json();
  await ok(
    request.post(`${base}/entries`, {
      data: { day, group: "Eaten", food_id: beer.id, grams: 500 },
    }),
  );
  const snus = await (
    await request.post(`${base}/habits`, {
      data: { name: "Snus", unit: "pouches" },
    })
  ).json();
  await ok(
    request.put(`${base}/habits/${snus.id}/days/${day}`, {
      data: { amount: 3 },
    }),
  );
  await ok(
    request.post(`${base}/naps`, {
      data: {
        uid: `nap-${tag}`,
        day,
        start_at: `${day}T11:00:00Z`,
        end_at: `${day}T11:25:00Z`,
      },
    }),
  );
  for (const width of [393, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/#/day/${day}`);
    await expect(page.locator(".log-card .log-row").first()).toBeVisible();
    const lefts = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          ":is(.log-card, .activity-card, .sleep-card, .day-totals) .log-row > .result > :first-child, .log-card .habit-row .count",
        ),
      ].map((el) => [el.textContent, el.getBoundingClientRect().left]),
    );
    expect(lefts.length, `${width}px`).toBeGreaterThanOrEqual(9);
    const xs = lefts.map(([, x]) => x);
    expect(
      Math.max(...xs) - Math.min(...xs),
      `${width}px: ${JSON.stringify(lefts)}`,
    ).toBeLessThanOrEqual(1);
  }
});

// The Activity card at a phone's width: each headline part whole, no line
// led by its "·" (the Diary headline's rule), and a plan's two-word name on
// one line beside Start, ✕ and ✓.
test("Activity card at 393 px: headline parts whole, a plan's name one line", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1095, testInfo);
  const pid = await ownProfile(page, request, `Narrow card ${tag}`);
  const base = `/api/profiles/${pid}`;
  const day = todayInApp();
  const all = await (await request.get("/api/exercises")).json();
  const w = await (
    await request.post("/api/workouts", {
      data: {
        name: "Full body",
        steps: [
          {
            kind: "exercise",
            exercise_id: all.find((e) => e.name === "Push-up").id,
            reps: 5,
          },
        ],
      },
    })
  ).json();
  await ok(request.post(`${base}/plans`, { data: { day, workout_id: w.id } }));
  await ok(
    request.post(`${base}/sync/health`, {
      data: {
        from: day,
        to: day,
        device: "Pixel 9",
        days: [{ day, active_kcal: 420, steps: 8412 }],
        sessions: [],
      },
    }),
  );
  await page.setViewportSize({ width: 393, height: 800 });
  await page.goto("/#/");
  const parts = page.locator(".activity-card header .headline > span");
  await expect(parts).toHaveCount(2);
  for (const part of await parts.all())
    expect(await lines(part), await part.textContent()).toBe(1);
  // The "·" is drawn, not text; a part starting a line has it clipped.
  expect(await parts.last().textContent()).not.toMatch(/·/u);
  const name = page.locator(".activity-card .log-row.planned .result .name");
  await expect(name).toHaveText("Full body");
  expect(await lines(name)).toBe(1);
  // Its controls all there, the tick at the row's right as a food's.
  const row = page.locator(".activity-card .log-row.planned");
  await expect(row.locator(".actions > *")).toHaveCount(3);
  const [r, tick] = await Promise.all([
    row.boundingBox(),
    row.getByRole("button", { name: /^Log .* done$/u }).boundingBox(),
  ]);
  expect(Math.round(r.x + r.width - (tick.x + tick.width))).toBe(0);
  // Start as compact as in any row: a tap wide, give or take its word.
  const start = await row.getByRole("link", { name: /^Start /u }).boundingBox();
  expect(start.width).toBeLessThan(80);
});
