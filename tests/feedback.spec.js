// Profile → Feedback: a bug or an idea for whoever runs the instance,
// counted while it waits for `kaloriina feedback --pull`. Online only.

import { expect, test } from "@playwright/test";
import { unique } from "./helpers.js";

test("feedback is sent from Profile and counted while it waits", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(306, testInfo);
  const waiting = async () =>
    (await (await request.get("/api/feedback")).json()).open;
  const before = await waiting();
  await page.goto("/#/profile");
  await page.getByRole("link", { name: /^Feedback/u }).click();
  await expect(page.getByRole("heading", { name: "Feedback" })).toBeVisible();
  // The count is the server's: the other project's run may add to it.
  await expect(page.locator(".feedback-waiting")).toHaveText(/^\d+ waiting/u);
  await page.getByRole("radio", { name: "Idea" }).click();
  await page.getByLabel("Message").fill(`Meal photos ${tag}`);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("status").last()).toContainText("Sent");
  await expect(page.getByLabel("Message")).toHaveValue("");
  expect(await waiting()).toBeGreaterThan(before);
});
