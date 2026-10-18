// Home Assistant (ADR 0024): the hook set in Profile → Connections, and the
// workout events the run screen and the session editor report. Nothing
// listens at the hook's address: the server says it couldn't connect.

import { expect, test } from "@playwright/test";
import { answer, exerciseIds, ownProfile, unique, workout } from "./helpers.js";

const NOBODY = "http://127.0.0.1:9";
const ha = (pid) => `/api/profiles/${pid}/hooks/home-assistant`;

test("Connections sets the Home Assistant hook, tests it and removes it", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(980, testInfo);
  const pid = await ownProfile(page, request, `Home ${tag}`);
  await page.goto("/#/connections");
  const card = page.locator(".home-assistant");
  await expect(
    page.getByRole("heading", { name: "Home Assistant" }),
  ).toBeVisible();
  await expect(card.getByRole("button", { name: "Send test" })).toHaveCount(0);

  // The id is a secret: hidden as typed, never offered from saved logins.
  await expect(card.getByLabel("Webhook ID")).toHaveAttribute(
    "type",
    "password",
  );
  await expect(card.getByLabel("Webhook ID")).toHaveAttribute(
    "autocomplete",
    "new-password",
  );
  // The events are the server's (meta.hook_events), in its order.
  const events = (await (await request.get("/api/meta")).json()).hook_events;
  await expect(card.locator("label.check")).toHaveText(
    events.map((e) => e.label),
  );
  await expect(
    card.getByRole("link", { name: "How to set up Home Assistant" }),
  ).toHaveAttribute("href", /#home-assistant$/u);
  await card.getByLabel("Home Assistant URL").fill(`${NOBODY}/`);
  await card.getByLabel("Webhook ID").fill(`kaloriina-${tag}`);
  await card.getByLabel("Workout started").check();
  await card.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toContainText("Saved");
  const saved = await (await request.get(ha(pid))).json();
  expect(saved).toEqual({
    url: NOBODY,
    events: ["workout_started"],
    last_result: null,
  });
  // The id is kept, never shown again.
  await expect(card.getByLabel("Webhook ID")).toHaveValue("");
  await expect(card.getByLabel("Webhook ID")).toHaveAttribute(
    "placeholder",
    /saved/iu,
  );
  await expect(card.getByLabel("Workout started")).toBeChecked();
  await expect(card.getByLabel("Workout finished")).not.toBeChecked();

  await card.getByRole("button", { name: "Send test" }).click();
  await expect(card.getByRole("status")).toContainText("couldn't connect");
  await page.reload();
  await expect(card.locator(".last-call")).toContainText("couldn't connect");

  // A wrong address is refused, and says why.
  await card.getByLabel("Home Assistant URL").fill("ftp://ha.lan");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByRole("status")).toContainText("http://");

  await card.getByRole("button", { name: "Remove" }).click();
  expect(await answer(page, "Remove")).toBe("Remove the Home Assistant hook?");
  await expect(card.getByRole("button", { name: "Send test" })).toHaveCount(0);
  expect(await (await request.get(ha(pid))).json()).toBeNull();
});

test("a run reports its start once and its finish, never its save", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(981, testInfo);
  const id = await exerciseIds(request);
  const pid = await ownProfile(page, request, `Hooked ${tag}`);
  const res = await request.put(ha(pid), {
    data: {
      url: NOBODY,
      webhook_id: "k1",
      events: ["workout_started", "workout_finished"],
    },
  });
  expect(res.ok()).toBeTruthy();
  const w = await workout(request, {
    name: `Hook ${tag}`,
    steps: [{ kind: "exercise", exercise_id: id("Pull-up"), reps: 5 }],
  });
  const events = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/hooks/home-assistant/events"))
      events.push(r.postDataJSON());
  });

  await page.goto(`/#/workout/${w.id}/run`);
  await expect(page.getByRole("button", { name: "Done" })).toBeVisible();
  await expect.poll(() => events.length).toBe(1);
  // Resumed after a reload: not started again.
  await page.reload();
  await expect(page.getByRole("button", { name: "Done" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(
    page.getByRole("heading", { name: "Workout done" }),
  ).toBeVisible();
  // The finish screen again after a reload: not finished again.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Workout done" }),
  ).toBeVisible();
  await page.getByLabel("Day").fill(day);
  await page.getByRole("button", { name: "Save to diary" }).click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
  // A session saved, from a run or by hand, tells the hook nothing.
  await page.goto(`/#/activity/new?day=${day}`);
  await page
    .getByRole("combobox", { name: "Workout", exact: true })
    .selectOption({ label: "Something else (a run, a ride…)" });
  await page.getByLabel("Name", { exact: true }).fill(`Walk ${tag}`);
  await page.getByLabel("Duration (min)").fill("30");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).not.toHaveURL(/#\/activity\/new/u);
  expect(events).toEqual([
    { event: "workout_started", workout: `Hook ${tag}` },
    { event: "workout_finished", workout: `Hook ${tag}` },
  ]);
});
