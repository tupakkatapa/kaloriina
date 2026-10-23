// Preferences kept on this device (localStorage). layout.js, a classic
// script loaded before any module, reads LAYOUT_KEY and THEME_KEY by their
// literal names: keep the two in step.

export const LAYOUT_KEY = "layout";
export const THEME_KEY = "theme";

// The JSON kept under `key`, or `fallback` when there is none or it can't
// be read (a corrupt store reads as empty, never breaks a screen).
export function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

export const writeJson = (key, value) =>
  localStorage.setItem(key, JSON.stringify(value));

// Reminders in this browser (the evening check-in, a weigh-in after a
// week), on unless turned off.
const REMINDERS_KEY = "reminders";
export const remindersOn = () => readJson(REMINDERS_KEY, true) !== false;
export const setReminders = (on) => writeJson(REMINDERS_KEY, on);
