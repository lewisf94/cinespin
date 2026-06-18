// ============================================================================
//  Theme switcher — five live, switchable looks, remembered in localStorage.
//  Self-contained (no Firebase), so it also works on the setup screen. Each
//  look is defined entirely in CSS under [data-theme="…"]; this just toggles
//  the attribute on <html> and builds the picker popover.
// ============================================================================

const THEMES = [
  { id: "cinema",  name: "Cinema",         bg: "#0c0a0b", accent: "#e5b567" },
  { id: "minimal", name: "Minimal",        bg: "#ffffff", accent: "#16171a" },
  { id: "claude",  name: "Claude",         bg: "#f0eee6", accent: "#c96442" },
  { id: "web1",    name: "Early Internet", bg: "#c3c7cb", accent: "#0000cc" },
  { id: "synth",   name: "Synthwave",      bg: "#0e0a1f", accent: "#ff4fd8" },
];
const KEY = "cinewheel_theme";
const DEFAULT = "cinema";

function saved() {
  try { return localStorage.getItem(KEY) || DEFAULT; } catch (_) { return DEFAULT; }
}
function remember(id) { try { localStorage.setItem(KEY, id); } catch (_) {} }

function apply(id) {
  if (!THEMES.some((t) => t.id === id)) id = DEFAULT;
  document.documentElement.setAttribute("data-theme", id);
  const meta = document.querySelector('meta[name="theme-color"]');
  const t = THEMES.find((x) => x.id === id);
  if (meta && t) meta.setAttribute("content", t.bg);
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
