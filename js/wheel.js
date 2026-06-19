// ============================================================================
//  The wheel: drawing, the satisfying spin animation, sound & confetti.
//  Drawing is THEME-AWARE — each theme gets its own palette, ring, hub, pointer
//  and label treatment (see wheelStyle), so the wheel is redesigned per theme.
// ============================================================================

function wheelStyle() {
  const t = document.documentElement.getAttribute("data-theme") || "a24";
  const styles = {
    // A24: stark black & white, alternating segments, thin minimal pointer
    a24: {
      alternate: ["#0a0a0a", "#ffffff"],
      segStroke: "#111111", segStrokeW: 1.5, ring: "#111111", ringW: 2,
      hubFill: "#0a0a0a", hubStroke: "#ffffff", hubR: 17,
      pointerFill: "#0a0a0a", pointerStroke: "#ffffff", pointerW: 14,
      labelFont: '800 14px "Archivo", system-ui, sans-serif', upper: true,
      emptyText: "#9a9a9a", emptyFill: "rgba(0,0,0,0.05)",
    },
    // Festival: limited risograph ink palette, thick ink rules, solid pointer
    festival: {
      palette: ["#c2482e", "#211c14", "#7d8a6a", "#a98b3e", "#6b6048", "#9c5a3c"],
      segStroke: "#211c14", segStrokeW: 2, ring: "#211c14", ringW: 3,
      hubFill: "#211c14", hubStroke: "#ece2cd", hubR: 18,
      pointerFill: "#c2482e", pointerStroke: "#211c14", pointerW: 18,
      labelFont: '600 15px "Oswald", system-ui, sans-serif', upper: true,
      labelColor: "#f6efdd", labelStroke: "#211c14",
      emptyText: "#6b6048", emptyFill: "rgba(33,28,20,0.06)",
    },
    // The Strokes: bright GeoCities clip-art colours, thick black outlines, chunky
    strokes: {
      palette: ["#ff2424", "#0000cc", "#00a000", "#ffd000", "#cc00cc", "#00a8c0", "#ff7e00"],
      segStroke: "#000000", segStrokeW: 3, ring: "#000000", ringW: 4,
      hubFill: "#000000", hubStroke: "#ffff00", hubR: 20,
      pointerFill: "#ffd000", pointerStroke: "#000000", pointerW: 22,
      labelFont: '700 15px "Pixelify Sans", "Courier New", monospace', upper: false,
      labelColor: "#ffffff", labelStroke: "#000000",
      emptyText: "#ffffff", emptyFill: "rgba(255,255,255,0.14)",
    },
  };
  return styles[t] || styles.a24;
}

function isDark(hex) {
  const c = hex.replace("#", "");
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b < 140;
}

// Size the canvas backing store to the device pixel ratio so the wheel is crisp
// on retina / mobile, while we keep drawing in logical (CSS-pixel) coordinates.
function setupHiDPI(canvas, logical) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(logical * dpr);
  canvas.height = Math.round(logical * dpr);
  canvas.style.width = logical + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

// ---- audio ----------------------------------------------------------------
let muted = false;
let audioCtx = null;

export function setMuted(v) { muted = !!v; }
export function isMuted() { return muted; }

export function resumeAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (_) {}
}

function tone(freq, dur, type, vol) {
  if (muted) return;
  try {
    resumeAudio();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + dur);
  } catch (_) {}
}

const tick = (freq) => tone(freq, 0.04, "square", 0.12);
function ding() {
  tone(880, 0.5, "triangle", 0.25);
  setTimeout(() => tone(1320, 0.55, "triangle", 0.2), 90);
}

function burstConfetti() {
  if (typeof window.confetti !== "function") return;
  window.confetti({ particleCount: 160, spread: 90, origin: { y: 0.6 } });
  setTimeout(() => window.confetti({ particleCount: 80, angle: 60, spread: 70, origin: { x: 0 } }), 150);
  setTimeout(() => window.confetti({ particleCount: 80, angle: 120, spread: 70, origin: { x: 1 } }), 300);
}

// ---- drawing ---------------------------------------------------------------
function drawWheel(ctx, size, segments, rotation, highlightIndex) {
  const s = wheelStyle();
  const n = segments.length;
  const cx = size / 2, cy = size / 2, r = size / 2 - 8;
  const seg = (2 * Math.PI) / n;
  ctx.clearRect(0, 0, size, size);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  for (let i = 0; i < n; i++) {
    const a0 = i * seg + rotation;
    const a1 = (i + 1) * seg + rotation;
    const fill = s.alternate ? s.alternate[i % s.alternate.length] : s.palette[i % s.palette.length];

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a0, a1);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (i === highlightIndex) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.fill();
      ctx.restore();
    }
    ctx.strokeStyle = s.segStroke;
    ctx.lineWidth = s.segStrokeW;
    ctx.stroke();

    // label, drawn from the rim inward
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a0 + seg / 2);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.font = s.labelFont;
    let title = segments[i].title || "";
    if (s.upper) title = title.toUpperCase();
    const label = title.length > 18 ? title.slice(0, 17) + "…" : title;

    let lc, ls;
    if (s.alternate) { lc = isDark(fill) ? "#ffffff" : "#0a0a0a"; ls = null; }
    else { lc = s.labelColor; ls = s.labelStroke; }
    if (ls) { ctx.lineWidth = 3; ctx.strokeStyle = ls; ctx.strokeText(label, r - 14, 0); }
    ctx.fillStyle = lc;
    ctx.fillText(label, r - 14, 0);
    ctx.restore();
  }

  // outer ring
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.strokeStyle = s.ring;
  ctx.lineWidth = s.ringW;
  ctx.stroke();

  // hub
  ctx.beginPath();
  ctx.arc(cx, cy, s.hubR, 0, 2 * Math.PI);
  ctx.fillStyle = s.hubFill;
  ctx.fill();
  ctx.strokeStyle = s.hubStroke;
  ctx.lineWidth = 3;
  ctx.stroke();
}

function drawPointer(ctx, size) {
  const s = wheelStyle();
  const cx = size / 2;
  const w = s.pointerW;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.fillStyle = s.pointerFill;
  ctx.strokeStyle = s.pointerStroke;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - w, 0);
  ctx.lineTo(cx + w, 0);
  ctx.lineTo(cx, w * 2);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// Static wheel shown on the Wheel tab.
export function renderIdleWheel(canvas, movies) {
  const s = wheelStyle();
  const size = 460;
  const ctx = setupHiDPI(canvas, size);
  if (!movies.length) {
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = s.emptyFill;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 8, 0, 2 * Math.PI);
    ctx.fill();
    ctx.strokeStyle = s.ring;
    ctx.lineWidth = s.ringW;
    ctx.stroke();
    ctx.fillStyle = s.emptyText;
    ctx.font = "16px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Add films to fill the wheel", size / 2, size / 2);
    return;
  }
  drawWheel(ctx, size, movies.map((m) => ({ id: m.id, title: m.title })), 0, -1);
  drawPointer(ctx, size);
}

export function chooseWinnerIndex(n) {
  return Math.floor(Math.random() * n);
}

// ---- the spin animation overlay -------------------------------------------
function playSpinOverlay(spin, onDone) {
  const segments = spin.segments || [];
  const n = segments.length;
  if (n === 0) { onDone?.(); return; }
  const winnerIndex = Math.min(Math.max(spin.winnerIndex || 0, 0), n - 1);
  const duration = spin.durationMs || 6000;

  const overlay = document.createElement("div");
  overlay.className = "spin-overlay";
  overlay.innerHTML = `
    <div class="spin-stage">
      <div class="spin-pointer-label">spinning the wheel…</div>
      <canvas class="spin-canvas" width="520" height="520"></canvas>
      <div class="spin-caption"></div>
    </div>`;
  document.body.appendChild(overlay);

  const canvas = overlay.querySelector(".spin-canvas");
  const caption = overlay.querySelector(".spin-caption");
  const size = 500;
  const ctx = setupHiDPI(canvas, size);
  const seg = (2 * Math.PI) / n;

  // Land the winner's centre under the top pointer (-90°), plus full spins.
  const pointer = -Math.PI / 2;
  const baseCentre = (winnerIndex + 0.5) * seg;
  const spins = 5 + (Math.floor((spin.seed || 0) / 137) % 3); // deterministic flair
  let aligned = pointer - baseCentre;
  aligned = ((aligned % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const target = spins * 2 * Math.PI + aligned;

  const startTime = performance.now();
  let lastBoundary = 0;
  resumeAudio();

  function frame(now) {
    const t = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - t, 5); // easeOutQuint — slow, satisfying settle
    const rotation = eased * target;
    drawWheel(ctx, size, segments, rotation, t >= 1 ? winnerIndex : -1);
    drawPointer(ctx, size);

    const boundary = Math.floor(rotation / seg);
    if (boundary !== lastBoundary) {
      tick(900 + (1 - t) * 500);
      navigator.vibrate?.(8);
      lastBoundary = boundary;
    }

    if (t < 1) requestAnimationFrame(frame);
    else finish();
  }

  function finish() {
    ding();
    navigator.vibrate?.([20, 40, 90]);
    caption.textContent = segments[winnerIndex].title || "";
    caption.classList.add("win");
    burstConfetti();
    setTimeout(() => {
      overlay.classList.add("closing");
      setTimeout(() => { overlay.remove(); onDone?.(); }, 600);
    }, 1700);
  }

  requestAnimationFrame(frame);
}

// Play the spin once per unique seed, and only if it's happening right now
// (so reloading the page later doesn't replay an old spin).
let lastPlayedSeed = null;
export function maybePlaySpin(lastSpin, onDone) {
  if (!lastSpin || !lastSpin.seed) { onDone?.(); return; }
  if (lastSpin.seed === lastPlayedSeed) { onDone?.(); return; }
  lastPlayedSeed = lastSpin.seed;
  const age = Date.now() - (lastSpin.startedAt || 0);
  if (age > (lastSpin.durationMs || 6000) + 5000) { onDone?.(); return; }
  playSpinOverlay(lastSpin, onDone);
}
