// Profile → Connections: readings that come in by themselves. openScale sync
// posts each weigh-in to this profile's webhook; you choose which openScale
// user is you. The Android app syncs Health Connect's active
// energy, steps and watch workouts.

import { api, get, loadProfiles, profileId, scoped } from "../api.mjs";
import { href, route } from "../nav.mjs";
import { noun, plural } from "../nutrients.mjs";
import {
  busy,
  choice,
  confirmDialog,
  field,
  h,
  notify,
  titleBar,
} from "../ui.mjs";

const SYNC = "/sync/openscale";
const HEALTH = "/sync/health";
const HOWTO = "https://github.com/tupakkatapa/kaloriina#android";

// "Alex (1)": openScale's name and id, as its own settings show them.
const who = (u) => `${u.username || "Unnamed"} (${u.id})`;

// "2 minutes ago", "yesterday".
export function ago(ms) {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const s = Math.round((ms - Date.now()) / 1000);
  for (const [unit, size] of [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ])
    if (Math.abs(s) >= size) return rtf.format(Math.round(s / size), unit);
  return "just now";
}

// The Profile menu's line for Connections.
export const connectionsLine = (s) =>
  s.bound_user
    ? `openScale: ${who(s.bound_user)}`
    : s.seen_users.length
      ? "openScale: choose your user"
      : "Sync your scale with openScale";

async function use(user, bound) {
  if (bound) {
    const ok = await confirmDialog(`Use ${who(user)} instead?`, {
      detail: `Readings of ${who(bound)} and the weights they set are removed. A full sync in openScale sync brings yours in.`,
      confirm: "Rebind",
    });
    if (!ok) return;
  }
  await api("PUT", scoped(SYNC), { user_id: user.id });
  await loadProfiles();
  notify(`openScale user ${who(user)} is you`);
  route();
}

async function disconnect() {
  const ok = await confirmDialog("Disconnect openScale?", {
    detail:
      "Kaloriina forgets which openScale user is you. Readings and weights stay; turn the webhook off in openScale sync.",
    confirm: "Disconnect",
  });
  if (!ok) return;
  await api("DELETE", scoped(SYNC));
  notify("Disconnected openScale");
  route();
}

// The users seen, each with a Use button (the bound one left out).
const userList = (s) =>
  h(
    "ul",
    { class: "menu card" },
    s.seen_users
      .filter((u) => u.id !== s.bound_user?.id)
      .map((u) =>
        h(
          "li",
          { class: "row" },
          h(
            "span",
            { class: "grow" },
            h("span", { class: "name" }, who(u)),
            u.ignored
              ? h(
                  "span",
                  { class: "muted" },
                  ` · ${plural(u.ignored, "reading")} in the last sync`,
                )
              : null,
          ),
          h(
            "button",
            {
              type: "button",
              "aria-label": `Use ${who(u)}`,
              onclick: busy(() => use(u, s.bound_user)),
            },
            "Use",
          ),
        ),
      ),
  );

// Which openScale user is you; nothing before any reading (lastReceived
// says so).
function binding(s) {
  if (!s.seen_users.length) return null;
  if (!s.bound_user)
    return [
      h("p", { class: "attention" }, "Choose which openScale user is you"),
      userList(s),
    ];
  const others = s.seen_users.filter((u) => u.id !== s.bound_user.id);
  const list = userList(s);
  list.hidden = true;
  return [
    h(
      "p",
      { class: "row" },
      h("span", { class: "grow" }, `Your openScale user: ${who(s.bound_user)}`),
      others.length
        ? h(
            "button",
            {
              type: "button",
              onclick: (e) => {
                list.hidden = false;
                e.currentTarget.remove();
              },
            },
            "Rebind",
          )
        : null,
    ),
    list,
    others
      .filter((u) => u.ignored)
      .map((u) =>
        h(
          "p",
          { class: "muted" },
          `Ignored ${plural(u.ignored, "reading")} from openScale user “${u.username || "Unnamed"}” (${u.id})`,
        ),
      ),
  ];
}

function lastReceived(s) {
  if (!s.last_seen)
    return h(
      "p",
      { class: "muted last-received" },
      "Nothing received yet: set up openScale sync below, then weigh yourself.",
    );
  const r = s.last_result;
  const counts = [
    r.applied ? `${plural(r.applied, "reading")} applied` : null,
    r.skipped ? `${plural(r.skipped, "reading")} skipped (invalid)` : null,
    r.ignored
      ? `${plural(r.ignored, "reading")} ignored (not your user)`
      : null,
  ].filter(Boolean);
  return h(
    "p",
    { class: "last-received" },
    `Last received ${ago(s.last_seen)}: ${counts.join(", ") || "nothing new"}`,
  );
}

// ------------------------------------------------------- Health Connect

// "Last sync 2 hours ago: 7 days, 3 workouts (Pixel 9)", with a hint when
// it's over a day old or two phones take turns.
function lastSync(s) {
  if (!s.last_seen)
    return h("p", { class: "muted last-sync" }, "Nothing synced yet");
  const r = s.last_result;
  const age = Date.now() - s.last_seen;
  return [
    h(
      "p",
      { class: "last-sync" },
      `Last sync ${ago(s.last_seen)}: ${plural(r.days, "day")}, ${plural(r.nights ?? 0, "night")}, ${plural(r.sessions, "workout")}${r.device ? ` (${r.device})` : ""}${r.skipped > 0 ? ` · ${plural(r.skipped, "item")} skipped (invalid)` : ""}`,
    ),
    age > 864e5
      ? h(
          "p",
          { class: "attention" },
          `No sync for ${plural(Math.floor(age / 864e5), "day")}. Open the app's Settings to see why.`,
        )
      : null,
    r.device && r.previous_device && r.device !== r.previous_device
      ? h(
          "p",
          { class: "attention" },
          `Synced from ${r.device} and ${r.previous_device}. Workouts aren't removed while two phones sync.`,
        )
      : null,
  ];
}

// Add watch workouts as they come, or ask; switching to auto adds the
// ones waiting, so a shown count is read again.
async function setWorkouts(mode, waiting) {
  try {
    await api("PUT", scoped(`${HEALTH}/workouts`), { mode });
    notify(
      mode === "auto"
        ? "Watch workouts are added"
        : "Watch workouts wait for you",
    );
    if (waiting > 0) route();
  } catch (err) {
    notify(err.message);
    route();
  }
}

// "2 watch workouts wait: see Workouts", a link there; null when none do.
const waitingLine = (n) =>
  n > 0
    ? h(
        "p",
        { class: "waiting" },
        h(
          "a",
          { href: href.workouts() },
          `${plural(n, "watch workout")} ${noun(n, "waits", "wait")}: see Workouts`,
        ),
      )
    : null;

async function removeSynced() {
  const ok = await confirmDialog("Remove synced data?", {
    detail:
      "Removes synced days, sleep and the workouts the app added. Workouts you logged keep the watch's details. The app sends it again on its next sync: stop syncing in the app first.",
    confirm: "Remove",
  });
  if (!ok) return;
  await api("DELETE", scoped(HEALTH));
  notify("Removed synced data");
  route();
}

// Inside the app (its user agent says so), a link to its settings naming
// this profile; the app checks it and asks before syncing to it.
// Elsewhere, where to get the app.
const appLink = () =>
  navigator.userAgent.includes("KaloriinaAndroid/")
    ? h(
        "p",
        {},
        h(
          "a",
          {
            class: "button",
            href: `kaloriina-app://settings?profile=${profileId}`,
          },
          "App settings",
        ),
      )
    : h(
        "p",
        {},
        h(
          "a",
          { href: HOWTO, target: "_blank", rel: "noopener" },
          "Install the Android app",
        ),
        " to sync from Health Connect.",
      );

const healthCard = (s, waiting) => [
  h("h2", {}, "Health Connect"),
  h(
    "div",
    { class: "card stack health" },
    h(
      "p",
      { class: "muted" },
      "Active energy, steps, sleep, heart rate and watch workouts from your phone, through Kaloriina's Android app. Watch workouts count as workouts done; the rest shows in the diary and Summary, never added to your targets.",
    ),
    field(
      "Synced workouts",
      choice({
        name: "synced-workouts",
        label: "Synced workouts",
        options: [
          ["auto", "Add automatically"],
          ["ask", "Ask me"],
        ],
        value: s.workouts,
        onChange: (mode) => setWorkouts(mode, waiting.length),
      }),
      {
        hint: "Walks your watch noticed on its own wait here until you add them.",
      },
    ),
    lastSync(s),
    waitingLine(waiting.length),
    appLink(),
    s.last_seen
      ? h(
          "p",
          {},
          h(
            "button",
            { type: "button", class: "danger", onclick: busy(removeSynced) },
            "Remove synced data",
          ),
        )
      : null,
  ),
];

export async function connections() {
  const [s, health, waiting] = await Promise.all([
    get(scoped(SYNC)),
    get(scoped(HEALTH)),
    get(scoped(`${HEALTH}/workouts`)),
  ]);
  const url = `${location.origin}/api/profiles/${profileId}${SYNC}`;
  const input = h("input", {
    readOnly: true,
    value: url,
    "aria-label": "Webhook URL",
    onfocus: (e) => e.target.select(),
  });
  const copy = busy(async () => {
    try {
      await navigator.clipboard.writeText(url);
      notify("Copied the webhook URL");
    } catch {
      input.focus();
      notify("Copy the selected URL");
    }
  });
  return h(
    "section",
    { class: "connections" },
    titleBar("Connections", href.profile()),
    h("h2", {}, "openScale"),
    h(
      "div",
      { class: "card stack" },
      h(
        "p",
        { class: "muted" },
        "Your scale's weigh-ins, through openScale sync's webhook.",
      ),
      h(
        "div",
        { class: "row" },
        input,
        h("button", { type: "button", onclick: copy }, "Copy"),
      ),
      lastReceived(s),
      binding(s),
      s.last_seen || s.bound_user
        ? h(
            "p",
            {},
            h(
              "button",
              { type: "button", class: "danger", onclick: busy(disconnect) },
              "Disconnect",
            ),
          )
        : null,
    ),
    h("h2", {}, "Set up"),
    h(
      "ol",
      { class: "card howto" },
      h(
        "li",
        {},
        "Install openScale sync next to openScale (F-Droid or Google Play).",
      ),
      h(
        "li",
        {},
        "In openScale sync, open Webhook, turn it on and paste the URL above.",
      ),
      h(
        "li",
        {},
        "Authorization header: what your HTTPS proxy's login needs (e.g. Basic …), or empty. The phone must trust the proxy's certificate.",
      ),
      h(
        "li",
        {},
        "Press Test, then weigh yourself, and choose which openScale user is you above.",
      ),
      h(
        "li",
        {},
        "Run a full sync in openScale sync to bring in your history.",
      ),
    ),
    healthCard(health, waiting),
  );
}
