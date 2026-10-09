// Phone or desktop layout, before the first paint (a classic script in <head>,
// so there's no flash of the wrong one). "auto" follows the window width;
// "phone" and "desktop" force one. The Profile page stores the choice and
// fires "layoutchange".
(() => {
  const wide = matchMedia("(min-width: 64rem)");
  const apply = () => {
    const choice = localStorage.getItem("layout") ?? "auto";
    document.documentElement.classList.toggle(
      "desktop",
      choice === "desktop" || (choice === "auto" && wide.matches),
    );
  };
  wide.addEventListener("change", apply);
  document.addEventListener("layoutchange", apply);
  apply();
})();
