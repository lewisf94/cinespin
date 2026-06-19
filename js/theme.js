// ============================================================================
//  Theme switcher — three complete design systems, remembered in localStorage.
//  Each look is defined entirely in CSS under [data-theme="…"] (plus a matching
//  wheel style in wheel.js). This module toggles the attribute on <html>, builds
//  the picker, and fires "spinema:themechange" so the app can redraw the wheel.
// ============================================================================

const THEMES = [
  { id: "a24",      name: "Default", bg: "#ffffff", accent: "#0a0a0a" },
  { id: "festival", name: "Cinema",  bg: "#ece2cd", accent: "#c2482e" },
  { id: "strokes",  name: "Web 1.0", bg: "#0a1aa8", accent: "#cc1f1f" },
];
const KEY = "spinema_theme";
const DEFAULT = "a24";

function saved() {
  try { return localStorage.getItem(KEY) || localStorage.getItem("cinewheel_theme") || DEFAULT; } catch (_) { return DEFAULT; }
}
function remember(id) { try { localStorage.setItem(KEY, id); } catch (_) {} }

function apply(id) {
  if (!THEMES.some((t) => t.id === id)) id = DEFAULT;
  document.documentElement.setAttribute("data-theme", id);
  const meta = document.querySelector('meta[name="theme-color"]');
  const t = THEMES.find((x) => x.id === id);
  if (meta && t) meta.setAttribute("content", t.bg);
  window.dispatchEvent(new CustomEvent("spinema:themechange", { detail: id }));
}

function buildPicker() {
  const btn = document.getElementById("theme-btn");
  if (!btn) return;

  const pop = document.createElement("div");
  pop.className = "theme-pop hidden";
  pop.innerHTML = THEMES.map(
    (t) => `
    <button class="theme-opt" data-theme-id="${t.id}">
      <span class="theme-swatch" style="background: linear-gradient(135deg, ${t.bg} 0 52%, ${t.accent} 52% 100%)"></span>
      <span class="theme-name">${t.name}</span>
    </button>`
  ).join("");
  document.body.appendChild(pop);

  const mark = () => {
    const cur = document.documentElement.getAttribute("data-theme");
    pop.querySelectorAll(".theme-opt").forEach((o) =>
      o.classList.toggle("active", o.dataset.themeId === cur)
    );
  };
  const place = () => {
    const r = btn.getBoundingClientRect();
    pop.style.top = `${r.bottom + 8}px`;
    pop.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  };
  const open = () => { place(); mark(); pop.classList.remove("hidden"); };
  const close = () => pop.classList.add("hidden");

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    pop.classList.contains("hidden") ? open() : close();
  });
  pop.addEventListener("click", (e) => {
    const opt = e.target.closest(".theme-opt");
    if (!opt) return;
    apply(opt.dataset.themeId);
    remember(opt.dataset.themeId);
    mark();
    close();
  });
  document.addEventListener("click", (e) => {
    if (e.target !== btn && !pop.contains(e.target)) close();
  });
  document.addEventListener("keydown", (e) => e.key === "Escape" && close());
  window.addEventListener("resize", () => { if (!pop.classList.contains("hidden")) place(); });
}

apply(saved());
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", buildPicker);
} else {
  buildPicker();
}
