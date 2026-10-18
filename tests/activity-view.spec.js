import { expect, test } from "@playwright/test";
import {
  answer,
  exerciseIds,
  ownProfile,
  syncHealth,
  todayInApp,
  unique,
  workout,
} from "./helpers.js";

// An activity done, through the API.
async function done(request, pid, data) {
  const res = await request.post(`/api/profiles/${pid}/activities`, { data });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

// "2030-01-02" `n` days on.
const shift = (day, n) =>
  new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);

const enc = encodeURIComponent;

// The Activity tab's list of activities done.
const recent = (page) =>
  page.locator(".finder-section").filter({
    has: page.getByRole("heading", { name: "Activities", exact: true }),
  });

test("an activity opens read-only from its row: when, energy, source, its workout, sets per exercise with a record; the pencil edits it, Delete goes back to the list", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(1160, testInfo);
  const id = await exerciseIds(request);
  const pid = await ownProfile(page, request, `View ${tag}`);
  const w = await workout(request, {
    name: `Circuit ${tag}`,
    steps: [{ kind: "exercise", exercise_id: id("Push-up"), reps: 10 }],
  });
  // An earlier best of 8: today's 12 is a record.
  await done(request, pid, {
    day: shift(day, -1),
    name: w.name,
    workout_id: w.id,
    minutes: 20,
    sets: [{ exercise_id: id("Push-up"), reps: 8 }],
  });
  const s = await done(request, pid, {
    day,
    name: w.name,
    workout_id: w.id,
    minutes: 45,
    kcal: 300,
    start_at: `${day}T15:00:00Z`,
    sets: [
      { exercise_id: id("Push-up"), reps: 12 },
      { exercise_id: id("Low plank"), seconds: 30 },
      { exercise_id: id("Push-up"), reps: 12 },
      { exercise_id: id("Push-up"), reps: 10 },
      { exercise_id: id("Low plank"), seconds: 30 },
    ],
  });
  await page.goto("/#/activity");
  await recent(page).getByRole("link").first().click();
  const view = `#/activity/${s.id}?back=${enc("#/activity")}`;
  await expect(page).toHaveURL(
    new RegExp(`${view.replace(/\?/u, "\\?")}$`, "u"),
  );
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(w.name);
  // Read-only.
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  // Its type, day and clock span (Helsinki).
  await expect(page.locator(".activity-when")).toHaveText(
    /^Workout · \w{3}, \w{3}\s\d{1,2} · \d{2}:00–\d{2}:45$/u,
  );
  const facts = page.locator("dl.traits").first();
  await expect(facts.locator("dt")).toHaveText([
    "Duration",
    "Energy",
    "Source",
  ]);
  await expect(facts.locator("dd")).toHaveText([
    "45 min",
    /^active\s\d+\skcal · 300\stotal$/u,
    "Logged here",
  ]);
  // The workout it was done from.
  await expect(
    page.locator(".activity-workout").getByRole("link", { name: w.name }),
  ).toHaveAttribute("href", `#/workout/${w.id}?back=${enc(view)}`);
  // Sets per exercise, in the order first done, a record marked.
  const sets = page.locator(".activity-sets > li");
  await expect(sets).toHaveText([
    /^Push-up\s*Record\s*12, 12, 10 reps$/u,
    /^Low plank\s*30\ss, 30\ss$/u,
  ]);
  await expect(sets.first().getByRole("link")).toHaveAttribute(
    "href",
    `#/exercise/${id("Push-up")}`,
  );
  // The pencil edits it; Save comes back to the view.
  await page.getByRole("link", { name: "Edit activity" }).click();
  await expect(page).toHaveURL(
    new RegExp(`#/activity/${s.id}/edit\\?back=${enc(view)}$`, "u"),
  );
  await page.getByLabel("Name", { exact: true }).fill(`Circuit ${tag} B`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    `Circuit ${tag} B`,
  );
  await expect(page).toHaveURL(new RegExp(`#/activity/${s.id}\\?back=`, "u"));
  // Back returns to the list.
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page).toHaveURL(/#\/activity$/u);
  // Deleted from its editor, it goes where the view's Back led.
  await recent(page).getByRole("link").first().click();
  await page.getByRole("link", { name: "Edit activity" }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await answer(page, "Delete");
  await expect(page).toHaveURL(/#\/activity$/u);
});

test("a synced run's view: distance, pace, heart rate and Health Connect", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1161, testInfo);
  // A sync takes days up to today: a past one (the profile is the test's).
  const day = "2026-09-02";
  const pid = await ownProfile(page, request, `Synced ${tag}`);
  const res = await syncHealth(request, pid, {
    from: day,
    to: day,
    device: "Pixel 9",
    days: [],
    sessions: [
      {
        key: `run-${tag}`,
        day,
        start_at: `${day}T14:02:00Z`,
        end_at: `${day}T14:48:00Z`,
        type: 33,
        name: "Running",
        kcal: 410,
        distance_m: 8200,
        recording_method: 1,
        avg_hr: 142,
        max_hr: 171,
      },
    ],
  });
  expect(res.ok()).toBeTruthy();
  const [run] = await (
    await request.get(`/api/profiles/${pid}/activities?from=${day}&to=${day}`)
  ).json();
  await page.goto(`/#/day/${day}`);
  // The Diary's row: its type, the slim line, opening the view.
  const row = page.locator(".activity-card .log-row").first();
  await expect(row).not.toContainText("bpm");
  await row.getByRole("link").click();
  await expect(page).toHaveURL(
    new RegExp(`#/activity/${run.id}\\?back=${enc(`#/day/${day}`)}$`, "u"),
  );
  const facts = page.locator("dl.traits").first();
  await expect(facts.locator("dt")).toHaveText([
    "Duration",
    "Distance",
    "Pace",
    "Energy",
    "Heart rate",
    "Cardio load",
    "Source",
  ]);
  await expect(facts.locator("dd")).toHaveText([
    "46 min",
    "8.2 km",
    "5:37 /km",
    "active 410 kcal",
    "142 bpm avg, 171 max",
    // No night synced near it: no load (ADR 0034).
    "– · no resting heart rate that week",
    "Health Connect",
  ]);
  await expect(page.locator(".activity-sets")).toHaveCount(0);
});

test("activity rows are a title over one line, open the view, and recent lists stop at 5 with All activities", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(1162, testInfo);
  const id = await exerciseIds(request);
  const pid = await ownProfile(page, request, `Rows ${tag}`);
  const often = await workout(request, {
    name: `Often ${tag}`,
    steps: [{ kind: "exercise", exercise_id: id("Push-up"), reps: 10 }],
  });
  const once = await workout(request, {
    name: `Once ${tag}`,
    steps: [{ kind: "exercise", exercise_id: id("Burpee"), reps: 10 }],
  });
  for (let n = 0; n < 6; n++)
    await done(request, pid, {
      day: shift(day, -n - 1),
      name: often.name,
      workout_id: often.id,
      minutes: 40,
      kcal: 300,
      sets: [{ exercise_id: id("Push-up"), reps: 10 }],
    });
  await done(request, pid, {
    day: shift(day, -10),
    name: once.name,
    workout_id: once.id,
    minutes: 20,
    sets: [{ exercise_id: id("Burpee"), reps: 10 }],
  });
  const walk = await done(request, pid, {
    day,
    name: "Walk",
    type: "walk",
    minutes: 33,
    kcal: 114,
    distance_m: 1420,
  });

  await page.goto("/#/activity");
  const list = recent(page);
  // One way in: the list's last row, not a header link.
  await expect(list.locator("header a")).toHaveCount(0);
  const rows = list.locator("li");
  await expect(rows).toHaveCount(6);
  const more = rows.last().getByRole("link");
  await expect(more).toHaveText("All activities");
  await expect(more).toHaveAttribute("href", "#/activities");
  // Newest first: the walk, its type alone, then the workout's.
  const first = rows.first().locator(".menu-row");
  await expect(first.locator(".name")).toHaveText("Walk");
  await expect(first.locator(".muted")).toHaveText(
    /^\w{3}\s\d{1,2} · 33\smin · 1\.42\skm · active\s(≈\s)?\d+\skcal$/u,
  );
  // Every row the same: the name alone as its title, its type on its view.
  await expect(rows.nth(1).locator(".name")).toHaveText(often.name);
  await expect(rows.nth(1).locator(".muted")).toHaveText(/^\w{3}\s\d/u);
  // Title over one line, a chevron; on a desktop the title has the row.
  for (const row of await rows.locator(".menu-row").all()) {
    const box = await row.evaluate((el) => {
      const name = el.querySelector(".name").getBoundingClientRect();
      const detail = el.querySelector(".muted");
      const d = detail?.getBoundingClientRect();
      const line = detail
        ? Number.parseFloat(getComputedStyle(detail).lineHeight)
        : 0;
      return {
        stacked: !detail || d.top >= name.bottom - 1,
        oneLine: !detail || d.height < line * 1.5,
        nameShare: name.width / el.getBoundingClientRect().width,
        chevron: Boolean(el.querySelector(".chevron")),
      };
    });
    expect(box).toEqual({
      stacked: true,
      oneLine: true,
      nameShare: expect.any(Number),
      chevron: true,
    });
    expect(box.nameShare).toBeGreaterThan(0.8);
  }
  await expect(list).not.toContainText("bpm");
  await expect(list).not.toContainText("total");
  // A row opens its view; Back comes back.
  await rows.first().getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`#/activity/${walk.id}\\?`, "u"));
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page).toHaveURL(/#\/activity$/u);
  await more.click();
  await expect(page).toHaveURL(/#\/activities$/u);
  await expect(page.locator(".menu-row")).toHaveCount(8);

  // An exercise's History: 5 days, then All activities with it.
  await page.goto(`/#/exercise/${id("Push-up")}`);
  const days = page.locator(".exercise-history > li");
  await expect(days).toHaveCount(6);
  await expect(days.first().getByRole("link")).toHaveAttribute(
    "href",
    new RegExp(`^#/activity/\\d+\\?back=`, "u"),
  );
  await days.last().getByRole("link", { name: "All activities" }).click();
  await expect(page).toHaveURL(
    new RegExp(`#/activities\\?exercise=${id("Push-up")}&back=`, "u"),
  );
  await expect(page.locator(".filtered")).toHaveText("Push-up");
  await expect(page.locator(".menu-row")).toHaveCount(6);
});

test("a workout's History: titled by day, one line, no sets, opening the activity's view; 5, then All activities of it", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(1163, testInfo);
  const id = await exerciseIds(request);
  const pid = await ownProfile(page, request, `History ${tag}`);
  const often = await workout(request, {
    name: `Often ${tag}`,
    steps: [{ kind: "exercise", exercise_id: id("Push-up"), reps: 10 }],
  });
  const once = await workout(request, {
    name: `Once ${tag}`,
    steps: [{ kind: "exercise", exercise_id: id("Burpee"), reps: 10 }],
  });
  for (let n = 0; n < 6; n++)
    await done(request, pid, {
      day: shift(day, -n - 1),
      name: often.name,
      workout_id: often.id,
      minutes: 40,
      kcal: 300,
      sets: [{ exercise_id: id("Push-up"), reps: 10 }],
    });
  await done(request, pid, {
    day,
    name: once.name,
    workout_id: once.id,
    minutes: 20,
    sets: [{ exercise_id: id("Burpee"), reps: 10 }],
  });

  await page.goto(`/#/workout/${often.id}`);
  const history = page.locator(".workout-history > li");
  await expect(history).toHaveCount(6);
  // Each titled by its day (the page is the workout's), over its brief
  // line; no sets (they're its view's).
  await expect(history.first().locator(".name")).toHaveText(
    /^\w{3}, \w{3}\s\d{1,2}$/u,
  );
  await expect(history.first().locator(".muted")).toHaveText(
    /^40\smin · active\s\d+\skcal$/u,
  );
  await expect(page.locator(".workout-history")).not.toContainText("reps");
  await expect(history.first().getByRole("link")).toHaveAttribute(
    "href",
    new RegExp(`^#/activity/\\d+\\?back=${enc(`#/workout/${often.id}`)}$`, "u"),
  );
  // A row opens its activity's view, back to the workout.
  await history.first().getByRole("link").click();
  await expect(page).toHaveURL(/#\/activity\/\d+\?back=/u);
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page).toHaveURL(new RegExp(`#/workout/${often.id}$`, "u"));
  await history.last().getByRole("link", { name: "All activities" }).click();
  await expect(page).toHaveURL(
    new RegExp(`#/activities\\?workout=${often.id}&back=`, "u"),
  );
  await expect(page.locator(".filtered")).toHaveText(often.name);
  await expect(page.locator(".menu-row")).toHaveCount(6);
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page).toHaveURL(new RegExp(`#/workout/${often.id}$`, "u"));
  // Done once: no more to show.
  await page.goto(`/#/workout/${once.id}`);
  await expect(page.locator(".workout-history > li")).toHaveCount(1);
  await expect(page.getByRole("link", { name: "All activities" })).toHaveCount(
    0,
  );
});

test("the Diary's Activity card: a logged activity opens its view, Back returns to the day in the Diary; a plan opens its workout", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1164, testInfo);
  // Plans go at most a year ahead: a day soon (the profile is the test's).
  const day = shift(todayInApp(), 3);
  const id = await exerciseIds(request);
  const pid = await ownProfile(page, request, `Card ${tag}`);
  const w = await workout(request, {
    name: `Planned ${tag}`,
    steps: [{ kind: "exercise", exercise_id: id("Burpee"), reps: 10 }],
  });
  const plan = await request.post(`/api/profiles/${pid}/plans`, {
    data: { day, workout_id: w.id },
  });
  expect(plan.ok(), await plan.text()).toBeTruthy();
  const s = await done(request, pid, {
    day,
    name: `Did ${tag}`,
    minutes: 30,
    kcal: 200,
    sets: [],
  });
  const back = enc(`#/day/${day}`);
  await page.goto(`/#/day/${day}`);
  const card = page.locator(".activity-card");
  await expect(
    card.getByRole("link", { name: `Planned ${tag}` }),
  ).toHaveAttribute("href", `#/workout/${w.id}?back=${back}`);
  await card
    .getByRole("link", { name: new RegExp(`^Did ${tag}`, "u") })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`#/activity/${s.id}\\?back=${back}$`, "u"),
  );
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    `Did ${tag}`,
  );
  const diaryTab = page.locator('.tabs a[data-tab="diary"]');
  await expect(diaryTab).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
  await expect(diaryTab).toHaveAttribute("aria-current", "page");
});
