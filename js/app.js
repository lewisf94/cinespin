// ============================================================================
//  CineWheel — app orchestration: routing, live data, rendering, actions
// ============================================================================

import { isConfigured, db, doc, collection, onSnapshot } from "./firebase.js";
import {
  ensureAuth, getName, setName, getMemberId, getLastGroup, setLastGroup,
} from "./session.js";
import { createGroup, joinGroup, currentSpinnerId, normaliseCode } from "./groups.js";
import { addMovie, removeMovie, commitSpin, markWatched, setDeadline } from "./movies.js";
import {
  renderIdleWheel, chooseWinnerIndex, maybePlaySpin, setMuted, isMuted, resumeAudio,
} from "./wheel.js";
import { buildStarRating, starsHtml, saveRating } from "./ratings.js";
import { renderStats } from "./stats.js";

// ---- tiny helpers ----------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const show = (el) => el && el.classList.remove("hidden");
const hide = (el) => el && el.classList.add("hidden");
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
const ms = (ts, fb = 0) =>
  !ts ? fb : typeof ts.toMillis === "function" ? ts.toMillis() : ts.seconds != null ? ts.seconds * 1000 : fb;

function countdownText(deadlineMs) {
  const diff = deadlineMs - Date.now();
  if (diff <= 0) return "⏰ Overdue";
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}
function dateInputValue(deadlineMs) {
  const d = new Date(deadlineMs);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d - off).toISOString().slice(0, 10);
}

// ---- state -----------------------------------------------------------------
const state = {
  code: null,
  group: null,
  members: [],
  movies: [],
  ratings: [],
  tab: "wheel",
  unsub: [],
};
let namePromiseResolve = null;

// ---- boot ------------------------------------------------------------------
async function init() {
  setMuted(localStorage.getItem("cinewheel_muted") === "1");
  updateMuteBtn();
  wireStaticUI();

  if (!isConfigured) {
    show($("#screen-config"));
    return;
  }
  try {
    await ensureAuth();
  } catch (e) {
    show($("#screen-config"));
    $("#config-extra").textContent = "Auth error: " + e.message;
    return;
  }

  if (!getName()) await promptName();

  const params = new URLSearchParams(location.search);
  const code = normaliseCode(params.get("g")) || getLastGroup();
  if (code) {
    try {
      await joinGroup(code);
      attachGroup(code);
    } catch (_) {
      setLastGroup(null);
      showLanding();
    }
  } else {
    showLanding();
  }

  setInterval(updateCountdown, 30000);
}

// ---- static UI wiring ------------------------------------------------------
function wireStaticUI() {
  $("#mute-btn").addEventListener("click", () => {
    setMuted(!isMuted());
    localStorage.setItem("cinewheel_muted", isMuted() ? "1" : "0");
    updateMuteBtn();
  });
  $("#who-am-i").addEventListener("click", () => promptName());
  $("#name-save").addEventListener("click", saveName);
  $("#name-input").addEventListener("keydown", (e) => e.key === "Enter" && saveName());
  $("#leave-btn").addEventListener("click", leaveGroup);

  $("#create-btn").addEventListener("click", handleCreate);
  $("#join-btn").addEventListener("click", () => handleJoin($("#join-code").value));
  $("#join-code").addEventListener("keydown", (e) => e.key === "Enter" && handleJoin($("#join-code").value));
  $("#new-group-name").addEventListener("keydown", (e) => e.key === "Enter" && handleCreate());

  $("#copy-code").addEventListener("click", () => {
    navigator.clipboard?.writeText(state.code);
    const icon = $("#copy-icon");
    if (icon) {
      icon.textContent = "✅";
      setTimeout(() => { icon.textContent = "📋"; }, 1200);
    }
  });

  document.querySelectorAll(".tab").forEach((btn) =>
    btn.addEventListener("click", () => switchTab(btn.dataset.tab))
  );

  // prefill join code from share link
  const g = new URLSearchParams(location.search).get("g");
  if (g) $("#join-code").value = normaliseCode(g);
}

function updateMuteBtn() {
  $("#mute-btn").textContent = isMuted() ? "🔇" : "🔊";
}

// ---- name modal ------------------------------------------------------------
function promptName() {
  $("#name-input").value = getName();
  show($("#name-modal"));
  $("#name-input").focus();
  return new Promise((resolve) => (namePromiseResolve = resolve));
}
async function saveName() {
  const v = $("#name-input").value.trim();
  if (!v) {
    $("#name-input").focus();
    return;
  }
  setName(v);
  hide($("#name-modal"));
  $("#who-am-i").textContent = "👤 " + v;
  if (state.code) {
    try { await joinGroup(state.code); } catch (_) {}
  }
  if (namePromiseResolve) {
    namePromiseResolve();
    namePromiseResolve = null;
  }
  render();
}

// ---- routing ---------------------------------------------------------------
function showLanding() {
  teardownSubs();
  state.code = null;
  hide($("#screen-app"));
  hide($("#group-meta"));
  hide($("#leave-btn"));
  show($("#screen-landing"));
  $("#landing-error").textContent = "";
  $("#who-am-i").textContent = "👤 " + (getName() || "Me");
}

function attachGroup(code) {
  state.code = code;
  setLastGroup(code);
  const url = new URL(location.href);
  url.searchParams.set("g", code);
  history.replaceState(null, "", url);
  hide($("#screen-landing"));
  show($("#screen-app"));
  show($("#group-meta"));
  show($("#leave-btn"));
  $("#who-am-i").textContent = "👤 " + (getName() || "Me");
  teardownSubs();
  subscribe(code);
}

function leaveGroup() {
  teardownSubs();
  setLastGroup(null);
  const url = new URL(location.href);
  url.searchParams.delete("g");
  history.replaceState(null, "", url);
  state.group = null;
  state.members = [];
  state.movies = [];
  state.ratings = [];
  showLanding();
}

async function handleCreate() {
  $("#landing-error").textContent = "";
  if (!getName()) { await promptName(); if (!getName()) return; }
  try {
    const code = await createGroup($("#new-group-name").value);
    attachGroup(code);
  } catch (e) {
    $("#landing-error").textContent = e.message;
  }
}
async function handleJoin(raw) {
  $("#landing-error").textContent = "";
  const code = normaliseCode(raw);
  if (!code) return;
  if (!getName()) { await promptName(); if (!getName()) return; }
  try {
    await joinGroup(code);
    attachGroup(code);
  } catch (e) {
    $("#landing-error").textContent = e.message;
  }
}

// ---- live data -------------------------------------------------------------
function subscribe(code) {
  state.unsub.push(
    onSnapshot(doc(db, "groups", code), (snap) => {
      state.group = snap.exists() ? snap.data() : null;
      render();
    })
  );
  state.unsub.push(
    onSnapshot(collection(db, "groups", code, "members"), (snap) => {
      state.members = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    })
  );
  state.unsub.push(
    onSnapshot(collection(db, "groups", code, "movies"), (snap) => {
      state.movies = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    })
  );
  state.unsub.push(
    onSnapshot(collection(db, "groups", code, "ratings"), (snap) => {
      state.ratings = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    })
  );
}
function teardownSubs() {
  state.unsub.forEach((u) => { try { u(); } catch (_) {} });
  state.unsub = [];
}

// ---- ordering helpers ------------------------------------------------------
const wheelMovies = () =>
  state.movies.filter((m) => m.status === "wheel").sort((a, b) => ms(a.addedAt, Date.now()) - ms(b.addedAt, Date.now()));
const watchedMovies = () =>
  state.movies.filter((m) => m.status === "watched").sort((a, b) => ms(b.watchedAt, Date.now()) - ms(a.watchedAt, Date.now()));
const orderedMembers = () =>
  (state.group?.memberOrder || []).map((id) => state.members.find((m) => m.id === id)).filter(Boolean);

// ---- rendering -------------------------------------------------------------
function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  ["wheel", "movies", "history", "stats"].forEach((t) =>
    $("#tab-" + t).classList.toggle("hidden", t !== tab)
  );
  render();
}

function editingWithin(el) {
  const a = document.activeElement;
  return a && el.contains(a) && /INPUT|TEXTAREA/.test(a.tagName);
}

function render() {
  if (!state.code) return;
  $("#group-name").textContent = state.group?.name || "…";
  $("#group-code").textContent = state.code;
  $("#who-am-i").textContent = "👤 " + (getName() || "Me");

  renderFilmCard();

  if (state.tab === "wheel") renderWheelTab();
  else if (state.tab === "movies") { if (!editingWithin($("#tab-movies"))) renderMoviesTab(); }
  else if (state.tab === "history") { if (!editingWithin($("#tab-history"))) renderHistoryTab(); }
  else if (state.tab === "stats") renderStats($("#tab-stats"), state.movies, state.ratings, state.members);

  maybePlaySpin(state.group?.lastSpin);
}

let countdownDeadline = null;
function updateCountdown() {
  const el = $("#countdown");
  if (el && countdownDeadline) el.textContent = countdownText(countdownDeadline);
}

function renderFilmCard() {
  const card = $("#film-card");
  const cf = state.group?.currentFilm;
  const myId = getMemberId();

  if (cf) {
    countdownDeadline = ms(cf.deadline, Date.now());
    const canEditDeadline = currentSpinnerId(state.group) === myId;
    card.innerHTML = `
      <div class="film-banner">🎬 This week's film</div>
      <h1 class="film-title">${esc(cf.title)}</h1>
      <div class="film-meta">
        <span>🎯 picked by <b>${esc(cf.spinnerName || "—")}</b></span>
        <span>➕ added by <b>${esc(cf.addedByName || "—")}</b></span>
      </div>
      <div class="deadline-row">
        <span class="deadline-pill" id="countdown">${countdownText(countdownDeadline)}</span>
        <span class="muted small">watch by ${new Date(countdownDeadline).toLocaleDateString()}</span>
      </div>
      ${canEditDeadline ? `<div class="deadline-edit"><label class="small muted">Change deadline:</label><input type="date" id="deadline-input" value="${dateInputValue(countdownDeadline)}"></div>` : ""}
      <button class="btn primary" id="watched-btn">✅ Mark as watched</button>
    `;
    $("#watched-btn").addEventListener("click", async () => {
      if (!confirm(`Mark "${cf.title}" as watched? This passes the turn to the next person.`)) return;
      await markWatched(state.code, cf.movieId);
    });
    if (canEditDeadline) {
      $("#deadline-input").addEventListener("change", (e) => {
        const d = new Date(e.target.value + "T20:00:00");
        if (!isNaN(d)) setDeadline(state.code, cf.movieId, d);
      });
    }
  } else {
    countdownDeadline = null;
    const spinnerId = currentSpinnerId(state.group);
    const spinner = state.members.find((m) => m.id === spinnerId);
    const isMe = spinnerId === myId;
    const name = spinner?.name || "someone";
    card.innerHTML = `
      <div class="film-banner">🎡 No film picked yet</div>
      <h1 class="film-title">${isMe ? "It's your turn to spin!" : `It's ${esc(name)}'s turn to spin`}</h1>
      <p class="muted">${isMe ? "Head to the wheel and give it a spin." : "Sit tight — or add more movies to the wheel."}</p>
      <button class="btn ${isMe ? "primary" : ""}" id="goto-wheel">🎡 Go to the wheel</button>
    `;
    $("#goto-wheel").addEventListener("click", () => switchTab("wheel"));
  }
}

function renderWheelTab() {
  const pane = $("#tab-wheel");
  const myId = getMemberId();
  const spinnerId = currentSpinnerId(state.group);
  const isMyTurn = spinnerId === myId && !state.group?.currentFilm;
  const movies = wheelMovies();

  const order = orderedMembers();
  const orderHtml = order
    .map((m) => `<span class="turn-chip ${m.id === spinnerId ? "current" : ""}">${esc(m.name || "?")}</span>`)
    .join('<span class="turn-arrow">→</span>');

  pane.innerHTML = `
    <div class="wheel-wrap">
      <canvas id="wheel-canvas" width="460" height="460"></canvas>
    </div>
    <div class="wheel-controls">
      <button class="btn primary big" id="spin-btn" ${isMyTurn && movies.length ? "" : "disabled"}>
        🎰 SPIN
      </button>
      <p class="wheel-status muted">${wheelStatus(isMyTurn, movies.length, spinnerId)}</p>
    </div>
    ${order.length ? `<div class="turn-order"><div class="small muted">Turn order</div><div class="turn-chips">${orderHtml}</div></div>` : ""}
  `;

  renderIdleWheel($("#wheel-canvas"), movies);

  const spinBtn = $("#spin-btn");
  if (isMyTurn && movies.length) {
    spinBtn.addEventListener("click", async () => {
      resumeAudio();
      spinBtn.disabled = true;
      const segs = movies.map((m) => ({ id: m.id, title: m.title, addedByName: m.addedByName }));
      const winner = chooseWinnerIndex(segs.length);
      const deadline = new Date(Date.now() + 7 * 86400000);
      try {
        await commitSpin(state.code, segs, winner, getName(), deadline);
      } catch (e) {
        alert("Spin failed: " + e.message);
        spinBtn.disabled = false;
      }
    });
  }
}

function wheelStatus(isMyTurn, count, spinnerId) {
  if (state.group?.currentFilm) return "A film is already in play this week.";
  if (!count) return "Add movies on the Movies tab to fill the wheel.";
  const spinner = state.members.find((m) => m.id === spinnerId);
  if (isMyTurn) return `${count} film${count > 1 ? "s" : ""} ready — your spin!`;
  return `Waiting for ${esc(spinner?.name || "the next person")} to spin.`;
}

function renderMoviesTab() {
  const pane = $("#tab-movies");
  const myId = getMemberId();
  const movies = wheelMovies();

  const list = movies
    .map(
      (m) => `
      <li class="movie-row">
        <span class="movie-title">${esc(m.title)}</span>
        <span class="movie-by muted small">added by ${esc(m.addedByName || "?")}</span>
        ${m.addedByMemberId === myId ? `<button class="link-btn" data-remove="${m.id}" title="Remove">✕</button>` : ""}
      </li>`
    )
    .join("");

  pane.innerHTML = `
    <div class="card">
      <h3>Add a movie to the wheel</h3>
      <div class="add-row">
        <input id="movie-input" placeholder="Film title…" maxlength="80" />
        <button class="btn primary" id="add-movie-btn">Add</button>
      </div>
    </div>
    <div class="card">
      <h3>On the wheel <span class="muted">(${movies.length})</span></h3>
      <ul class="movie-list">${list || '<li class="muted">Nothing yet — add the first film!</li>'}</ul>
    </div>
  `;

  const input = $("#movie-input");
  const addNow = async () => {
    const t = input.value.trim();
    if (!t) return;
    input.value = "";
    input.blur();
    await addMovie(state.code, t);
  };
  $("#add-movie-btn").addEventListener("click", addNow);
  input.addEventListener("keydown", (e) => e.key === "Enter" && addNow());
  pane.querySelectorAll("[data-remove]").forEach((b) =>
    b.addEventListener("click", () => removeMovie(state.code, b.dataset.remove))
  );
}

function renderHistoryTab() {
  const pane = $("#tab-history");
  const myId = getMemberId();
  const watched = watchedMovies();

  if (!watched.length) {
    pane.innerHTML = `<p class="muted center">No films watched yet. Once you mark this week's film watched, it'll appear here for everyone to rate. ⭐</p>`;
    return;
  }

  pane.innerHTML = "";
  watched.forEach((movie) => {
    const movieRatings = state.ratings.filter((r) => r.movieId === movie.id);
    const scores = movieRatings.map((r) => r.score);
    const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const mine = movieRatings.find((r) => r.memberId === myId);

    const others = movieRatings
      .map(
        (r) => `
        <div class="rating-line">
          <span class="rating-name">${esc(r.name || "Someone")}</span>
          ${starsHtml(r.score)}
          ${r.review ? `<div class="review">${esc(r.review)}</div>` : ""}
        </div>`
      )
      .join("");

    const card = document.createElement("div");
    card.className = "card watched-card";
    card.innerHTML = `
      <div class="watched-head">
        <h3>${esc(movie.title)}</h3>
        <div class="watched-avg">${scores.length ? starsHtml(Math.round(avgScore * 2) / 2) + ` <b>${(Math.round(avgScore * 100) / 100).toFixed(2)}</b> <span class="muted small">(${scores.length})</span>` : '<span class="muted small">no ratings yet</span>'}</div>
      </div>
      <div class="muted small">added by ${esc(movie.addedByName || "?")}</div>
      <div class="ratings-list">${others || ""}</div>
      <div class="my-rating">
        <div class="small muted">Your rating</div>
        <div class="my-rating-stars"></div>
        <textarea class="review-input" placeholder="Add a short review or comment…" maxlength="500">${esc(mine?.review || "")}</textarea>
        <button class="btn small save-rating">${mine ? "Update" : "Save"} rating</button>
        <span class="save-note muted small"></span>
      </div>
    `;
    pane.appendChild(card);

    const widget = buildStarRating(mine?.score || 0);
    card.querySelector(".my-rating-stars").appendChild(widget);
    card.querySelector(".save-rating").addEventListener("click", async () => {
      const score = widget.getValue();
      if (!score) {
        card.querySelector(".save-note").textContent = "Pick a star rating first.";
        return;
      }
      const review = card.querySelector(".review-input").value;
      await saveRating(state.code, movie.id, score, review);
      card.querySelector(".save-note").textContent = "Saved ✓";
    });
  });
}

init();
