// What waits to be sent: the sync pill in the tabs, the outbox
// screen behind it (send now, try again, discard) and a day's waiting rows.

import { flush, profileId } from "../api.mjs";
import { go, href, leaving } from "../nav.mjs";
import {
  ATTEMPTS_MAX,
  items,
  next,
  remove,
  retry,
  syncStatus,
  waiting,
} from "../outbox.mjs";
import { groupLabel } from "../nutrients.mjs";
import { busy, confirmDialog, fill, h, titleBar } from "../ui.mjs";

// The pill's words, or null when all is sent and the server answers.
function syncText(list = items(), status = syncStatus()) {
  const failed = list.filter((x) => x.failed).length;
  const pending = list.length - failed;
  if (status.signIn && pending) return "Sign in again";
  if (failed) return `${failed} failed`;
  if (pending) return `${pending} waiting`;
  if (status.offline || !navigator.onLine) return "Offline";
  return null;
}

// Keep the pill current and send what waits: at start, when the network
// returns, and every 30 s while something waits and the page is in sight.
export function startSync() {
  const pill = document.getElementById("sync");
  const badge = document.getElementById("sync-badge");
  const render = () => {
    const list = items();
    const text = syncText(list);
    pill.hidden = !text;
    pill.textContent = text ?? "";
    badge.hidden = !list.length;
    badge.textContent = String(list.length);
  };
  addEventListener("outbox", render);
  addEventListener("offline", render);
  addEventListener("online", () => {
    render();
    flush();
  });
  setInterval(() => {
    if (document.visibilityState === "visible" && next()) flush();
  }, 30_000);
  render();
  flush();
}

const when = (iso) =>
  new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

function row(item) {
  return h(
    "li",
    { class: "row-with-action" },
    h(
      "div",
      { class: "result" },
      h("span", { class: "name" }, item.label),
      h(
        "span",
        { class: item.failed ? "muted error" : "muted" },
        item.failed
          ? `Not sent: ${item.failed}`
          : `Saved ${when(item.queuedAt)}${item.attempts ? ` · tried ${item.attempts}×` : ""}`,
      ),
    ),
    // Failed on server errors only (not a refusal): it may go through now.
    item.failed && item.attempts >= ATTEMPTS_MAX
      ? h(
          "button",
          {
            type: "button",
            class: "button",
            "aria-label": `Try again ${item.label}`,
            onclick: busy(async () => {
              retry(item.key);
              await flush();
            }),
          },
          "Try again",
        )
      : null,
    h(
      "button",
      {
        type: "button",
        class: "button",
        "aria-label": `Discard ${item.label}`,
        onclick: async () => {
          if (
            await confirmDialog(`Discard "${item.label}"?`, {
              detail: "It never reached the server; it's gone for good.",
              confirm: "Discard",
            })
          )
            remove(item.key);
        },
      },
      "Discard",
    ),
  );
}

export function outboxScreen() {
  const body = h("div", { class: "stack" });
  const paint = () => {
    const list = items();
    const status = syncStatus();
    fill(
      body,
      status.signIn
        ? h(
            "p",
            { class: "error", role: "alert" },
            "The server answered with a login page. Reload the app and sign in, then send again.",
          )
        : null,
      list.length
        ? h("ul", { class: "results card" }, list.map(row))
        : h("p", { class: "muted" }, "Nothing waits: the server has it all."),
      list.some((x) => !x.failed)
        ? h(
            "p",
            {},
            h(
              "button",
              { type: "button", class: "primary", onclick: busy(flush) },
              "Send now",
            ),
          )
        : null,
    );
  };
  addEventListener("outbox", paint, { signal: leaving.signal });
  paint();
  return h("section", {}, titleBar("Waiting to send", href.today()), body);
}

// The day's writes still on this device, as muted rows (label only, no
// actions); the day reloads once they're sent, to show them stored.
export function waitingSection(day) {
  const list = waiting(profileId, day);
  if (!list.length) return null;
  addEventListener(
    "outbox",
    () => {
      if (waiting(profileId, day).length !== list.length) go(location.hash);
    },
    { signal: leaving.signal },
  );
  return h(
    "section",
    { class: "group waiting" },
    h("header", {}, h("h2", {}, "Waiting to send")),
    h(
      "ul",
      { class: "entries" },
      list.map((x) =>
        h(
          "li",
          { class: "entry" },
          h(
            "div",
            { class: "entry-main" },
            h("span", { class: "name" }, x.label),
            h(
              "span",
              { class: "muted" },
              [
                x.body?.group ? groupLabel(x.body.group) : null,
                x.failed ? "Not sent" : "Waiting to send",
              ]
                .filter(Boolean)
                .join(" · "),
            ),
          ),
        ),
      ),
    ),
  );
}
