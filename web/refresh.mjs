// What a pull to refresh (pull.mjs) does: send what waits, ask the Android
// app for a Health Connect sync now, read the screen again, and say how
// it went.

import { flush } from "./api.mjs";
import { occupied, route } from "./nav.mjs";
import { items, syncStatus, syncText, wake } from "./outbox.mjs";
import { notify } from "./ui.mjs";

// Inside the app (its user agent says so; connections.mjs links its
// settings the same way).
const IN_APP = navigator.userAgent.includes("KaloriinaAndroid/");
// A sync sends the last 7 days: seconds on a home network. Past this the
// screen is read without waiting for it.
const SYNC_WAIT_MS = 30_000;

// The app's Health Connect sync, run now: its answer, the detail of the
// "kaloriina-sync" event it sends when the run ends (`{synced}`, `{error}`,
// `{note}`, or `{}` with no profile bound), or null when none came in time.
// The app takes `kaloriina-app://sync` only from this server's page, as it
// does its settings link.
function phoneSync() {
  return new Promise((resolve) => {
    const stop = new AbortController();
    // A promise settles once: the later of the two does nothing.
    const done = (detail) => {
      stop.abort();
      resolve(detail);
    };
    addEventListener("kaloriina-sync", (e) => done(e.detail ?? {}), {
      signal: stop.signal,
    });
    setTimeout(() => done(null), SYNC_WAIT_MS);
    location.assign("kaloriina-app://sync");
  });
}

// Only a screen with nothing open a re-read would lose.
export const refreshable = () => !occupied();

export async function refresh() {
  // As "Send now": what waits out a server error's backoff goes too.
  wake();
  await flush();
  // What this refresh couldn't send; a write the server refused before
  // stays on the pill and the Outbox, not in every refresh's answer.
  const unsent = syncText(items().filter((x) => !x.failed));
  const phone = IN_APP ? await phoneSync() : {};
  // Offline, a re-read would replace the screen with its error.
  if (!syncStatus().offline && refreshable()) await route();
  const problem = unsent ?? phone?.error;
  if (problem) notify(problem, { error: true });
  else if (phone === null) notify("Updated; the phone is still syncing");
  else notify(phone.note ?? (phone.synced ? "Synced" : "Updated"));
}
