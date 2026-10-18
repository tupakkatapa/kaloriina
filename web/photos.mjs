// Photos on a day and group (ADR 0022): shrunk here to a JPEG at most
// 1600 px a side (quality 0.8, ~300 KB; drawing it drops EXIF), sent as
// the request body. Online only: a photo never waits in the outbox. The
// camera button that adds one lives here too.

import { api, scoped, uid } from "./api.mjs";
import { go, href, leaving } from "./nav.mjs";
import { busy, CAMERA, errorBox, fill, h, icon, notify } from "./ui.mjs";

const SIDE_MAX = 1600;
const QUALITY = 0.8;

// `file` (an image the camera or picker gave) as a JPEG Blob.
async function shrink(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, SIDE_MAX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Couldn't read the image.")),
      "image/jpeg",
      QUALITY,
    );
  });
}

// Store `file` on `day` in `group`: the Photo.
async function addPhoto(day, group, file) {
  const blob = await shrink(file);
  const q = new URLSearchParams({ day, group, uid: uid() });
  return api("POST", scoped(`/photos?${q}`), blob);
}

// Where a photo's bytes are: by its uid, which a restore can't hand out
// again (revalidated on each view, so a deleted one is gone).
export const photoSrc = (photo) => `/api${scoped(`/photos/${photo.uid}`)}`;

export const deletePhoto = (photo) =>
  api("DELETE", scoped(`/photos/${photo.uid}`));

// "Photo", under Eaten's search: the camera (or a picked image) onto the
// day, which opens with it. Online only, so offline it's off and says why;
// a failed upload keeps the shot for Retry.
export function photoButton(day, group) {
  const { signal } = leaving;
  const status = h("p", { role: "status" });
  const offline = h("span", { class: "muted" }, "Photos need a connection");
  const send = async (file) => {
    try {
      await addPhoto(day, group, file);
    } catch (err) {
      fill(
        status,
        errorBox(err),
        h(
          "button",
          { type: "button", onclick: busy(() => send(file)) },
          "Retry",
        ),
      );
      return;
    }
    await go(href.day(day));
    notify(`Added a photo to ${group}`);
  };
  const input = h("input", {
    type: "file",
    accept: "image/*",
    capture: "environment",
    class: "sr-only",
    tabIndex: -1,
    "aria-label": `Add a photo to ${group}`,
    onchange: () => {
      const [file] = input.files;
      input.value = "";
      if (file) send(file);
    },
  });
  const button = h(
    "button",
    { type: "button", class: "secondary", onclick: () => input.click() },
    icon(CAMERA),
    "Photo",
  );
  const paint = () => {
    button.disabled = input.disabled = !navigator.onLine;
    if (button.disabled) fill(status, offline);
    else if (offline.isConnected) fill(status);
  };
  addEventListener("online", paint, { signal });
  addEventListener("offline", paint, { signal });
  paint();
  return h("div", { class: "photo-add" }, input, button, status);
}
