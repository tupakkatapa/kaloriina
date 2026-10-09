// Shared by the UI specs: test data made through the API, and locators.

import { expect } from "@playwright/test";

// Per-test names, barcodes and days (see slots.mjs).
export { unique } from "./slots.mjs";

export const starts = (text) =>
  new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

export async function food(request, body) {
  const res = await request.post("/api/foods", { data: body });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

// Answer the in-app confirmation that is open (or about to open) by
// clicking `button` ("Delete", "Leave", "Cancel"…); returns its question.
export async function answer(page, button) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const asked = await dialog.getByRole("heading").textContent();
  await dialog.getByRole("button", { name: button, exact: true }).click();
  await expect(dialog).toBeHidden();
  return asked;
}

export async function entry(request, data, profile = 1) {
  const res = await request.post(`/api/profiles/${profile}/entries`, { data });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

// A profile made as the app makes one: the profile, then its weigh-in today
// (`weight_kg`, none when null), then the targets recommended once it has
// every measurement. Resolves to the profile as saved.
async function madeProfile(request, { weight_kg: kg = null, ...data }) {
  const res = await request.post("/api/profiles", { data });
  expect(res.ok()).toBeTruthy();
  const p = await res.json();
  if (kg !== null) {
    const put = await request.put(
      `/api/profiles/${p.id}/weights/${todayInApp()}`,
      { data: { kg } },
    );
    expect(put.ok()).toBeTruthy();
  }
  const recommended = await request.get(`/api/profiles/${p.id}/recommended`);
  if (recommended.ok()) {
    const put = await request.put(`/api/profiles/${p.id}/targets`, {
      data: {
        rev: p.rev,
        targets: (await recommended.json()).map(({ metric, value }) => ({
          metric,
          value,
        })),
      },
    });
    expect(put.ok()).toBeTruthy();
  }
  return (await request.get(`/api/profiles/${p.id}`)).json();
}

// Set one target (`null`: clear it), keeping the others the profile set.
export async function setTarget(request, pid, metric, value) {
  const { rev } = await (await request.get(`/api/profiles/${pid}`)).json();
  const list = await (await request.get(`/api/profiles/${pid}/targets`)).json();
  const res = await request.put(`/api/profiles/${pid}/targets`, {
    data: {
      rev,
      targets: [
        ...list
          .filter((t) => !t.default && t.metric !== metric)
          .map((t) => ({ metric: t.metric, value: t.value })),
        ...(value === null ? [] : [{ metric, value }]),
      ],
    },
  });
  expect(res.ok()).toBeTruthy();
}

// A profile of the test's own, current in the page: tests that change
// targets would otherwise race on the shared profile 1.
export async function ownProfile(page, request, name) {
  const { id } = await madeProfile(request, {
    name,
    sex: "female",
    birth_date: "1990-01-01",
    height_cm: 165,
    weight_kg: 60,
    activity: 1.6,
    goal_kg_per_week: 0,
  });
  await page.addInitScript(
    (pid) => localStorage.setItem("profile", String(pid)),
    id,
  );
  return id;
}

export const headline = (page) => page.locator(".headline strong");

// A day's totals in a summary response.
export const dayTotal = (d, energy) => ({ day: d, total: { energy } });

// Exercises by name, for workouts made through the API.
export async function exerciseIds(request) {
  const all = await (await request.get("/api/exercises")).json();
  return (name) => all.find((e) => e.name === name).id;
}

export async function workout(request, data) {
  const res = await request.post("/api/workouts", { data });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

// A step's one-line title, by its path ("1.0").
export const stepTitle = (page, path) =>
  page.locator(`[data-path="${path}"] > .step-head summary .name`);

// Pick an exercise in the open picker by searching for it.
export async function pickExercise(page, query, name) {
  await page.getByLabel("Search exercises").fill(query);
  await page
    .locator(".step-picker")
    .getByRole("button", { name: starts(name) })
    .click();
}

// A profile made through the API (not made current): `data` overrides the
// measurements (`weight_kg`: its weigh-in today).
export const newProfile = (request, data) =>
  madeProfile(request, {
    sex: "male",
    birth_date: "1985-01-01",
    height_cm: 180,
    weight_kg: 80,
    activity: 1.6,
    goal_kg_per_week: 0,
    ...data,
  });

// Today as the page sees it (the projects pin Helsinki time).
export const todayInApp = () =>
  new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Helsinki" });

// The server's real answer to a mocked request, with `patch` over it: an
// object spread over the real one, or a function `(real, url)` giving the
// answer. A mock so keeps every field the server sends, and its request must
// be one the server accepts.
async function realJson(route, patch) {
  const res = await route.fetch();
  expect(res.ok(), `${route.request().url()}: ${res.status()}`).toBeTruthy();
  const real = await res.json();
  return typeof patch === "function"
    ? patch(real, route.request().url())
    : { ...real, ...patch };
}

// Playwright's errors for a page or context that is gone. When a test ends,
// its context is closed before the page reads as closed, so `isClosed()`
// alone misses a request still in flight then.
const GONE = /has been closed|has been disposed/;

// Answer requests matching `pattern` with `realJson`'s patched answer. A
// request still in flight when the test ends (the screen reloading after
// its last check) finds the page gone: nobody waits for its answer.
export const mockJson = (page, pattern, patch) =>
  page.route(pattern, async (route) => {
    try {
      await route.fulfill({ json: await realJson(route, patch) });
    } catch (err) {
      if (!page.isClosed() && !GONE.test(err.message)) throw err;
    }
  });

// Answer the day `day` (any profile) with the real day and `patch` over it.
export const realDay = (page, day, patch) =>
  mockJson(page, `**/api/profiles/*/day/${day}`, patch);
