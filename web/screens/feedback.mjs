// Profile → Feedback: a bug or an idea for whoever runs this Kaloriina,
// read with `kaloriina feedback --pull`. Online only (never queued); the
// count is what waits to be pulled, from every profile.

import { api, get, meta } from "../api.mjs";
import { href } from "../nav.mjs";
import {
  busy,
  choice,
  errorBox,
  field,
  fill,
  h,
  notify,
  titleBar,
} from "../ui.mjs";

const waitingText = (n) => `${n} waiting to be read`;

export async function feedbackScreen() {
  let { open } = await get("/feedback");
  const kind = choice({
    name: "kind",
    label: "Kind",
    options: [
      ["bug", "Bug"],
      ["feature", "Idea"],
    ],
    value: "bug",
  });
  const text = h("textarea", {
    name: "text",
    required: true,
    rows: 6,
    maxLength: meta.limits.feedback_text,
  });
  const waiting = h(
    "p",
    { class: "muted feedback-waiting" },
    waitingText(open),
  );
  const status = h("div", { role: "status" });
  const form = h(
    "form",
    {
      class: "stack",
      onsubmit: busy(async (e) => {
        e.preventDefault();
        fill(status);
        try {
          await api("POST", "/feedback", {
            kind: kind.value,
            text: text.value,
          });
        } catch (err) {
          fill(status, errorBox(err));
          return;
        }
        text.value = "";
        open += 1;
        waiting.textContent = waitingText(open);
        notify("Sent: thanks.");
      }),
    },
    field("Kind", kind),
    field("Message", text, {
      hint: "What happened and what you expected, or what would help.",
    }),
    status,
    h("div", { class: "actions" }, h("button", { class: "primary" }, "Send")),
  );
  return h(
    "section",
    {},
    titleBar("Feedback", href.profile()),
    h(
      "p",
      { class: "muted" },
      "Goes to whoever runs this Kaloriina. Write no health details you wouldn't share with them.",
    ),
    form,
    waiting,
  );
}
