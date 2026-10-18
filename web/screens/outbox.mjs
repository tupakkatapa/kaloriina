// What waits to be sent: the sync pill in the tabs, the outbox
// screen behind it (send now, try again, discard) and a day's waiting rows.

import { flush, profileId } from "../api.mjs";
import { dateTimeAt } from "../dates.mjs";
import { go, href, leaving } from "../nav.mjs";
import {
  ATTEMPTS_MAX,
  items,
  next,
  remove,
  retry,
  syncStatus,
  syncText,
  waiting,
  wake,
} from "../outbox.mjs";
import { actionRow, entryRow, result } from "../rows.mjs";
import { busy, confirmDialog, empty, fill, h, titleBar } from "../ui.mjs";

// Keep the pill current and send what waits: at start, when the network
// returns, and every 30 s while something waits and the page is in sight.
export function startSync() {
  const pill = document.querySelector("#sync");
  pill.href = href.outbox();
  const badge = document.querySelector("#sync-badge");
  const render = () => {
    const list = items();
    const text = syncText(list);
    pill.hidden = !text;
    pill.textContent = text ?? "";
    badge.hidden = list.length === 0;
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

function row(item) {
  return actionRow(
    result({
      name: item.label,
      detail: h(
        "span",
        { class: item.failed ? "muted error" : "muted" },
        item.failed
          ? `Not sent: ${item.failed}`
          : `Saved ${dateTimeAt(item.queuedAt)}${item.attempts ? ` · tried ${item.attempts}×` : ""}`,
      ),
    }),
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
      list.length > 0
        ? h(
            "ul",
            { class: "results card" },
            list.map((x) => row(x)),
          )
        : empty("Nothing waits: the server has it all."),
      list.some((x) => !x.failed)
        ? h(
            "p",
            {},
            h(
              "button",
              {
                type: "button",
                class: "primary",
                onclick: busy(() => {
                  wake();
                  return flush();
                }),
              },
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

// A create shown where it lands, in its group or the Activity card.
const shownThere = (x) =>
  x.method === "POST" &&
  (x.path.endsWith("/entries") || x.path.endsWith("/activities"));

// The day's writes still on this device, but those shown where they land,
// as muted rows (label only, no actions); the day reloads once any is sent,
// to show it stored.
export function waitingSection(day) {
  const all = waiting(profileId, day);
  if (all.length === 0) return null;
  addEventListener(
    "outbox",
    () => {
      if (waiting(profileId, day).length !== all.length) go(location.hash);
    },
    { signal: leaving.signal },
  );
  const list = all.filter((x) => !shownThere(x));
  if (list.length === 0) return null;
  return h(
    "section",
    { class: "group waiting" },
    h("header", {}, h("h2", {}, "Waiting to send")),
    h(
      "ul",
      { class: "entries" },
      list.map((x) =>
        entryRow(
          { name: x.label, group: x.body?.group },
          { pending: x.failed ? "Not sent" : "Waiting to send" },
        ),
      ),
    ),
  );
}
