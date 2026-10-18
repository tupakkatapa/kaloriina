// Every dialog is one modal(): Esc closes it, so does its own close button,
// and focus goes back to what opened it. Every test uses a profile of its
// own.

import { expect, test } from "@playwright/test";
import { entry, food, ownProfile, unique } from "./helpers.js";

// Opens the dialog `name` with `opener`, closes it with Esc, then again
// with the button `close`; each time focus is back on the opener.
async function closes(page, opener, name, close) {
  const dialog = page.getByRole("dialog", { name });
  for (const how of ["Escape", close]) {
    await opener.click();
    await expect(dialog).toBeVisible();
    if (how === "Escape") await page.keyboard.press("Escape");
    else await dialog.getByRole("button", { name: how, exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(opener).toBeFocused();
  }
}

test("a confirm closes with Esc and Cancel, focus back on its button", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(57, testInfo);
  const pid = await ownProfile(page, request, `Confirm ${tag}`);
  const res = await request.post(`/api/profiles/${pid}/habits`, {
    data: { name: "Snus", unit: "pouches" },
  });
  expect(res.status()).toBe(201);
  const { id } = await res.json();
  await page.goto(`/#/habit/${id}`);
  await closes(
    page,
    page.getByRole("button", { name: "Delete" }),
    "Delete Snus?",
    "Cancel",
  );
});

test("a form dialog closes with Esc and Cancel, focus back on its row", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(58, testInfo);
  await ownProfile(page, request, `Form ${tag}`);
  await page.goto(`/#/add/${day}/Eaten`);
  await closes(
    page,
    page
      .locator(".finder-results > ul")
      .getByRole("button", { name: /^Water\b/u }),
    "Water to Eaten",
    "Cancel",
  );
});

test("the Log sheet closes with Esc and Done, focus back on + Log", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(59, testInfo);
  await ownProfile(page, request, `Sheet ${tag}`);
  await page.goto(`/#/day/${day}`);
  await closes(
    page,
    page.getByRole("button", { name: /^Log on /u }),
    "Log",
    "Done",
  );
});

test("an expanded chart closes with Esc and ✕, focus back on Expand", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(60, testInfo);
  const pid = await ownProfile(page, request, `Expand ${tag}`);
  const f = await food(request, {
    name: `Rice ${tag}`,
    per100: { energy: 350 },
  });
  for (const day of ["2025-03-04", "2025-03-05"])
    await entry(
      request,
      { day, group: "Eaten", food_id: f.id, grams: 400 },
      pid,
    );
  await page.goto("/#/summary/food/week/2025-03-04");
  await closes(
    page,
    page.getByRole("button", { name: "Expand chart" }).first(),
    /^Energy by day/u,
    "Close",
  );
});

// An 8 × 8 orange JPEG.
const JPEG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCuAkTb/9k=";

test("a photo closes with Esc and Close, focus back on its thumbnail", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(576, testInfo);
  const pid = await ownProfile(page, request, `Photo ${tag}`);
  const res = await request.post(
    `/api/profiles/${pid}/photos?day=${day}&group=Eaten`,
    {
      headers: { "Content-Type": "image/jpeg" },
      data: Buffer.from(JPEG, "base64"),
    },
  );
  expect(res.status()).toBe(201);
  await page.goto(`/#/day/${day}`);
  await closes(
    page,
    page.getByRole("button", { name: "Open photo 1 of 1, Eaten" }),
    "Photo 1 of 1, Eaten",
    "Close",
  );
});
