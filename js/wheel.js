// ============================================================================
//  The wheel: drawing, the satisfying spin animation, sound & confetti
// ----------------------------------------------------------------------------
//  Everyone watches the SAME spin: the spinner writes lastSpin {segments,
//  winnerIndex, seed} to Firestore; every browser then animates that exact
//  wheel via maybePlaySpin(). The winner is decided up front, so the easing
//  always lands dead-centre on the chosen segment.
// ============================================================================

const PALETTE = [
  "#e63946", "#f4a261", "#e9c46a", "#2a9d8f", "#457b9d",
  "#7209b7", "#f72585", "#3a86ff", "#06d6a0", "#ff9f1c",
  "#ef476f", "#118ab2", "#8338ec", "#fb5607", "#43aa8b",
];

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
  const n = segments.length;
  const cx = size / 2, cy = size / 2, r = size / 2 - 8;
  const seg = (2 * Math.PI) / n;
  ctx.clearRect(0, 0, size, size);

  for (let i = 0; i < n; i++) {
    const a0 = i * seg + rotation;
    const a1 = (i + 1) * seg + rotation;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a0, a1);
    ctx.closePath();
    ctx.fillStyle = PALETTE[i % PALETTE.length];
    ctx.fill();
    if (i === highlightIndex) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.fill();
      ctx.restore();
    }
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // label, drawn from the rim inward
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a0 + seg / 2);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.font = "600 15px system-ui, -apple-system, sans-serif";
    const title = segments[i].title || "";
    const label = title.length > 18 ? title.slice(0, 17) + "…" : title;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.strokeText(label, r - 14, 0);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, r - 14, 0);
    ctx.restore();
  }

  // hub
  ctx.beginPath();
  ctx.arc(cx, cy, 26, 0, 2 * Math.PI);
  ctx.fillStyle = "#1a1326";
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 3;
  ctx.stroke();
}

function drawPointer(ctx, size) {
  const cx = size / 2;
  ctx.save();
  ctx.fillStyle = "#ffd166";
  ctx.strokeStyle = "#1a1326";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - 18, 0);
  ctx.lineTo(cx + 18, 0);
  ctx.lineTo(cx, 36);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// Static wheel shown on the Wheel tab.
export function renderIdleWheel(canvas, movies) {
  const ctx = canvas.getContext("2d");
  const size = canvas.width;
  if (!movies.length) {
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 8, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = "#9b91ad";
    ctx.font = "16px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Add movies to fill the wheel", size / 2, size / 2);
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
      <div class="spin-caption">🎲</div>
    </div>`;
  document.body.appendChild(overlay);

  const canvas = overlay.querySelector(".spin-canvas");
  const caption = overlay.querySelector(".spin-caption");
  const ctx = canvas.getContext("2d");
  const size = canvas.width;
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
    caption.textContent = "🎬 " + (segments[winnerIndex].title || "");
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
