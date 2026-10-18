// Actions: a write, then where it leads and what it says (a toast, Undo):
// kept on this device when offline, logged, copied. Above the router
// (web/nav.mjs), which holds only the addresses and the screens' lifecycle.

import {
  api,
  createId,
  get,
  isQueued,
  meta,
  scoped,
  stored,
  uid,
} from "./api.mjs";
import { isNil } from "./format.mjs";
import { go, goDay, href } from "./nav.mjs";
import { busy, h, notify, undoable } from "./ui.mjs";

// After a write opted into the outbox: when it was kept on this device
// (ApiError "queued"), its day opens (or re-renders, when shown) and says
// so; any other error stands.
export function keptHere(err, day) {
  if (!isQueued(err)) throw err;
  goDay(day);
  notify(err.message);
}

// Run `write` (a queued `api()` call): true when stored; kept on this
// device, `day` shows it (`keptHere`) and it's false; any other error stands.
export async function storedOrKept(write, day) {
  const done = await stored(write);
  if (done === true) return true;
  keptHere(done.queued, day);
  return false;
}

// Each write queued: true when all were stored, else `{queued}`
// (one kept on this device says so for all; the rest still go out).
export async function writeAll(writes) {
  let kept = null;
  for (const { method, path, body, label } of writes) {
    const done = await stored(() =>
      api(method, path, body, { queue: true, label }),
    );
    kept = done.queued ?? kept;
  }
  return kept ? { queued: kept } : true;
}

// Undo of a log: its entries removed through the outbox, then their day
// (kept on this device, it says so). A series one started stops first
// (online only: a series' edit doesn't wait).
export async function undoLog(day, entries) {
  const done = await writeAll(
    entries.flatMap((e) => [
      ...(e.repeat
        ? [
            {
              method: "PATCH",
              path: scoped(`/entries/${e.id}`),
              body: { repeat: null },
            },
          ]
        : []),
      {
        method: "DELETE",
        path: scoped(`/entries/${e.id}`),
        label: `Undo log ${e.name}`,
      },
    ]),
  );
  await go(href.day(day));
  if (done !== true) notify(done.queued.message);
}

// Logged now: back to the day, with Undo.
export function logged(day, group, what, entries) {
  go(href.day(day));
  undoable(`Added ${what} to ${group}`, () => undoLog(day, entries));
}

// "Pull day (copy)": a copy's name, cut to fit the name limit.
const COPY_SUFFIX = " (copy)";
export const copied = (name) =>
  `${name.slice(0, meta.limits.name - COPY_SUFFIX.length)}${COPY_SUFFIX}`;

// Copy: `post(uid)` makes a new one (or null, having said why not), opened
// at `to(copy)`: from an editor, of what its `shell()` holds, the original
// keeping what it has saved; from a view (`shell` null), of what's saved.
// Each press is a copy of its own (its own `uid`). `label` the button's
// word.
export const copyButton = (post, shell, to, label = "Copy") =>
  h(
    "button",
    {
      type: "button",
      onclick: busy(async () => {
        const copy = await post(uid());
        if (!copy) return;
        shell?.().markClean();
        await go(to(copy));
        notify(`Copied as ${copy.name}`);
      }),
    },
    label,
  );

// A view's Copy of saved food, recipe (`/foods/{id}`) or meal
// (`/meals/{id}`) at `path`, by `kind` ("Copy recipe"): the server copies
// it as saved, and `to(copy)` opens.
export const serverCopy = (path, kind, to) =>
  copyButton(
    (key) => api("POST", `${path}/copy`, { uid: key }),
    null,
    to,
    `Copy ${kind}`,
  );

// Copy in an editor: a new one, "<name> (copy)", of what its form holds
// when Copy is pressed, `body(change())`: `change` is read then too.
export const copyForm = (path, body, shell, to, change = () => ({})) =>
  copyButton(
    (key) => {
      const form = body(change());
      return api("POST", path, {
        ...form,
        name: copied(form.name),
        archived: false,
        rev: undefined,
        uid: key,
      });
    },
    shell,
    to,
  );

// Empty, null and missing: one "nothing" to `holds`.
const blank = (v) => isNil(v) || v === "";

// Whether record `got` holds what form `sent` saves: each value sent, as
// stored (numbers to rounding; empty, null and missing alike). A field the
// record doesn't have (a create's `day`) isn't one it holds.
export function holds(got, sent, top = true) {
  if (blank(sent) || blank(got)) return blank(sent) && blank(got);
  if (typeof sent === "number")
    return (
      typeof got === "number" &&
      Math.abs(got - sent) <= 1e-9 * Math.max(1, Math.abs(sent))
    );
  if (Array.isArray(sent))
    return (
      Array.isArray(got) &&
      got.length === sent.length &&
      sent.every((v, i) => holds(got[i], v, false))
    );
  if (typeof sent === "object")
    return (
      typeof got === "object" &&
      Object.entries(sent).every(
        ([k, v]) =>
          ["rev", "uid"].includes(k) ||
          (top && !(k in got)) ||
          holds(got[k], v, false),
      )
    );
  return got === sent;
}

// A form's Save that writes one record however often it's sent:
// `write(body, id)` creates at `path` (`id` null) or updates `at(id)`.
// The form's create `uid` is made when it opens and replaced once a create
// is answered; a create sent again (its answer lost) answers the record it
// made, which the form is then saved over unless it holds it already, and
// this form's later saves update that one. An update sent again finds its
// revision taken (409 stale): read back with `read(id)`, a record that
// holds the form is the save's.
export function saveOnce(
  path,
  at = (id) => `${path}/${id}`,
  read = (id) => get(at(id)),
) {
  const key = createId();
  let made = null;
  const put = async (id, body) => {
    try {
      return await api("PUT", at(id), body);
    } catch (err) {
      if (err.code !== "stale") throw err;
      const now = await read(id).catch(() => null);
      if (now && holds(now, body)) return now;
      throw err;
    }
  };
  return async (body, id = null) => {
    if (made && (id === null || id === made.id)) {
      made = await put(made.id, { ...body, rev: made.rev });
      return made;
    }
    if (id !== null) return put(id, body);
    made = await api("POST", path, { ...body, uid: key.get() });
    key.done();
    if (!holds(made, body))
      made = await put(made.id, { ...body, rev: made.rev });
    return made;
  };
}
