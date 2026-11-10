// What a pull to refresh (pull.mjs) does: send what waits, read the screen
// again from the server, and say how it went. The phone's Health Connect
// sync isn't part of it: it runs on resume and from the app's Settings.

import { flush } from "./api.mjs";
import { occupied, route } from "./nav.mjs";
import { items, syncStatus, syncText, wake } from "./outbox.mjs";
import { notify } from "./ui.mjs";

// Only a screen with nothing open a re-read would lose.
export const refreshable = () => !occupied();

// The loading bar runs for all of it, the send included.
export async function refresh() {
  const app = document.querySelector("#app");
  app.setAttribute("aria-busy", "true");
  try {
    // As "Send now": what waits out a server error's backoff goes too.
    wake();
    await flush();
    // What this refresh couldn't send; a write the server refused before
    // stays on the pill and the Outbox, not in every refresh's answer.
    const unsent = syncText(items().filter((x) => !x.failed));
    // Offline, a re-read would replace the screen with its error; one
    // showing an error already may as well try.
    const failedShown = document.querySelector("#app .failed-screen") !== null;
    if ((failedShown || !syncStatus().offline) && refreshable()) await route();
    if (unsent) notify(unsent, { error: true });
    else notify("Updated");
  } finally {
    app.removeAttribute("aria-busy");
  }
}
