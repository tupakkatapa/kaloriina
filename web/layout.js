// Phone or desktop layout and light or dark theme, before the first paint (a
// classic script in <head>, so there's no flash of the wrong one). "auto"
// and "system" follow the window's width and the system's colours; the
// others force one. The Profile page stores the choices and fires
// "layoutchange" or "themechange". The tabs follow the layout: on a phone
// Diary sits in the middle (the page's order), a desktop sidebar starts
// with it; moved in the DOM, not with CSS `order`, so focus and screen
// readers go in the order shown. The keys "layout" and "theme" are
// prefs.mjs's LAYOUT_KEY and THEME_KEY (a classic script can't import).
(() => {
  const root = document.documentElement;
  const wide = matchMedia("(min-width: 64rem)");
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const order = () => {
    const diary = document.querySelector('.tabs a[data-tab="diary"]');
    const foods = document.querySelector('.tabs a[data-tab="foods"]');
    if (!diary || !foods) return;
    if (root.classList.contains("desktop")) diary.parentNode.prepend(diary);
    else foods.after(diary);
  };
  const apply = () => {
    const layout = localStorage.getItem("layout") ?? "auto";
    root.classList.toggle(
      "desktop",
      layout === "desktop" || (layout === "auto" && wide.matches),
    );
    order();
    const theme = localStorage.getItem("theme") ?? "system";
    root.classList.toggle(
      "dark",
      theme === "dark" || (theme === "system" && dark.matches),
    );
  };
  wide.addEventListener("change", apply);
  dark.addEventListener("change", apply);
  document.addEventListener("layoutchange", apply);
  document.addEventListener("themechange", apply);
  document.addEventListener("DOMContentLoaded", order);
  apply();
})();
