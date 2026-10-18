// Photos: the camera on a group's Add screen, the group's thumbnail strip
// (only once it has photos), the full view and Delete. Online only.

import { expect, test } from "@playwright/test";
import { ownProfile, unique } from "./helpers.js";

// An upload that never reaches the server.
const drop = (route) => route.abort("internetdisconnected");

// A real 2400 × 1800 PNG drawn in the page, as a camera would hand over a
// big image: the app shrinks it to a JPEG.
const bigImage = (page) =>
  page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 2400;
    c.height = 1800;
    const g = c.getContext("2d");
    g.fillStyle = "#c63";
    g.fillRect(0, 0, 2400, 1800);
    const blob = await new Promise((r) => {
      c.toBlob(r, "image/png");
    });
    return [...new Uint8Array(await blob.arrayBuffer())];
  });

test("a photo taken on the Add screen shows in its group, opens and deletes", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(309, testInfo);
  const pid = await ownProfile(page, request, `Photos ${tag}`);
  await page.goto(`/#/day/${day}`);
  const eaten = page.locator("section.group").filter({
    has: page.getByRole("heading", { name: "Eaten" }),
  });
  await expect(eaten.locator(".photo-strip")).toHaveCount(0);

  await page.goto(`/#/add/${day}/Eaten`);
  const uploads = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/photos?")) uploads.push(r);
  });
  await page.getByLabel("Add a photo to Eaten").setInputFiles({
    name: "plate.png",
    mimeType: "image/png",
    buffer: Buffer.from(await bigImage(page)),
  });
  await expect(page.getByRole("status").last()).toContainText(
    "Added a photo to Eaten",
  );
  // Sent shrunk, as a JPEG body.
  expect(uploads).toHaveLength(1);
  expect(uploads[0].headers()["content-type"]).toBe("image/jpeg");
  const listed = await (
    await request.get(`/api/profiles/${pid}/day/${day}`)
  ).json();
  expect(listed.photos).toHaveLength(1);
  expect(listed.photos[0].size).toBeLessThan(400_000);

  const thumb = eaten.getByRole("button", {
    name: "Open photo 1 of 1, Eaten",
  });
  await expect(thumb.locator("img")).toHaveJSProperty("complete", true);
  expect(await thumb.locator("img").evaluate((img) => img.naturalWidth)).toBe(
    1600,
  );
  await thumb.click();
  const view = page.getByRole("dialog", { name: "Photo 1 of 1, Eaten" });
  await expect(view.getByRole("img")).toBeVisible();
  await view.getByRole("button", { name: "Delete" }).click();
  await page
    .getByRole("dialog", { name: "Delete this photo?" })
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(page.getByRole("status").last()).toContainText(
    "Deleted the photo",
  );
  await expect(eaten.locator(".photo-strip")).toHaveCount(0);
});

test("a photo never waits offline", async ({ page, request }, testInfo) => {
  const { day, tag } = unique(310, testInfo);
  await ownProfile(page, request, `Photos offline ${tag}`);
  await page.goto(`/#/add/${day}/Eaten`);
  const image = Buffer.from(await bigImage(page));
  await page.route("**/photos?*", (route) =>
    route.abort("internetdisconnected"),
  );
  await page.getByLabel("Add a photo to Eaten").setInputFiles({
    name: "plate.png",
    mimeType: "image/png",
    buffer: image,
  });
  await expect(page.locator(".photo-add .error")).toContainText(
    "Can't reach the server",
  );
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("outbox") ?? "[]"),
    ),
  ).toEqual([]);
});

test("photo_button_offline_disabled_and_retry: under the search, off offline, a failed shot kept", async ({
  page,
  context,
  request,
}, testInfo) => {
  const { day, tag } = unique(368, testInfo);
  const pid = await ownProfile(page, request, `Photos retry ${tag}`);
  // Not offered where nothing is eaten yet.
  await page.goto(`/#/add/${day}/Planned`);
  await expect(
    page.getByRole("searchbox", { name: "Search foods" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Photo", exact: true }),
  ).toHaveCount(0);

  await page.goto(`/#/add/${day}/Eaten`);
  const photo = page.getByRole("button", { name: "Photo", exact: true });
  await expect(photo).toBeVisible();
  // Below the search row, not above it.
  expect(
    await page.evaluate(() => {
      const bar = document.querySelector(".search-bar");
      const add = document.querySelector(".photo-add");
      return Boolean(
        bar.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }),
  ).toBe(true);
  await expect(photo.locator("svg")).toHaveCount(1);
  await context.setOffline(true);
  await expect(photo).toBeDisabled();
  await expect(page.locator(".photo-add")).toContainText(
    "Photos need a connection",
  );
  await context.setOffline(false);
  await expect(photo).toBeEnabled();
  await expect(page.locator(".photo-add")).not.toContainText(
    "Photos need a connection",
  );

  // The upload fails: the shot is kept, and Retry sends it.
  const image = Buffer.from(await bigImage(page));
  await page.route("**/photos?*", drop);
  await page.getByLabel("Add a photo to Eaten").setInputFiles({
    name: "plate.png",
    mimeType: "image/png",
    buffer: image,
  });
  await expect(page.locator(".photo-add .error")).toContainText(
    "Can't reach the server",
  );
  await page.unroute("**/photos?*", drop);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("status").last()).toContainText(
    "Added a photo to Eaten",
  );
  const listed = await (
    await request.get(`/api/profiles/${pid}/day/${day}`)
  ).json();
  expect(listed.photos).toHaveLength(1);
});
