// ============================================================================
//  Spinema — app orchestration: routing, live data, rendering, actions
// ============================================================================

import { isConfigured, db, doc, collection, onSnapshot } from "./firebase.js";
import {
  ensureAuth, getName, setName, getMemberId, getLastGroup, setLastGroup,
} from "./session.js";
import {
  createGroup, joinGroup, currentSpinnerId, normaliseCode,
  requestReset, approveReset, cancelReset, performReset,
} from "./groups.js";
import { addMovie, removeMovie, commitSpin, markWatchedAck, finalizeRound, setDeadline } from "./movies.js";
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
const fmt2 = (n) => (Math.round(n * 100) / 100).toFixed(2);

function countdownText(deadlineMs) {
  const diff = deadlineMs - Date.now();
  if (diff <= 0) return "Overdue";
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
let finalizingId = null; // guards against firing finalizeRound repeatedly
let resetting = false; // guards against firing performReset repeatedly

// ---- boot ------------------------------------------------------------------
async function init() {
  setMuted(localStorage.getItem("spinema_muted") === "1");
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
    localStorage.setItem("spinema_muted", isMuted() ? "1" : "0");
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
      icon.textContent = "Copied";
      setTimeout(() => { icon.textContent = "Copy"; }, 1200);
    }
  });

  document.querySelectorAll(".tab").forEach((btn) =>
    btn.addEventListener("click", () => switchTab(btn.dataset.tab))
  );

  // prefill join code from share link
  const g = new URLSearchParams(location.search).get("g");
  if (g) $("#join-code").value = normaliseCode(g);

  // redraw (the wheel especially) when the theme changes
  window.addEventListener("spinema:themechange", () => { try { render(); } catch (_) {} });

  // Web 1.0 window chrome: the title-bar [X] lives on the dialogs only, where it
  // is functional - it closes the name window and declines the reset window.
  // (Content cards keep a title bar but no [X].) We hit-test the corner because
  // the button is a CSS pseudo-element.
  document.addEventListener("click", (e) => {
    if (document.documentElement.getAttribute("data-theme") !== "strokes") return;
    const win = e.target.closest(".modal-box, .reset-box");
    if (!win) return;
    const r = win.getBoundingClientRect();
    if (!(e.clientX >= r.right - 30 && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.top + 28)) return;
    e.stopPropagation();
    if (win.closest("#name-modal")) {
      hide($("#name-modal"));
      if (namePromiseResolve) { namePromiseResolve(); namePromiseResolve = null; }
    } else if (win.classList.contains("reset-box")) {
      if (state.code) cancelReset(state.code);
    }
  });

  // Web 1.0 taskbar: a live clock and a working Start menu.
  const clockEl = $("#taskbar-clock");
  if (clockEl) {
    const tick = () => { clockEl.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
    tick();
    setInterval(tick, 10000);
  }
  const startBtn = $("#start-btn");
  if (startBtn) {
    const menu = document.createElement("div");
    menu.className = "start-menu hidden";
    menu.innerHTML = `
      <button data-act="theme">Change theme</button>
      <button data-act="leave">Leave club</button>
      <button data-act="about">About Spinema</button>`;
    document.body.appendChild(menu);
    startBtn.addEventListener("click", (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); });
    document.addEventListener("click", (e) => { if (e.target !== startBtn && !menu.contains(e.target)) menu.classList.add("hidden"); });
    menu.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (!act) return;
      menu.classList.add("hidden");
      if (act === "theme") $("#theme-btn").click();
      else if (act === "leave") { if (state.code) leaveGroup(); }
      else if (act === "about") alert("Spinema - a film-club wheel. Spin for the week's film, watch it, then rate. Built as a static site on Firebase.");
    });
  }
}

function updateMuteBtn() {
  $("#mute-btn").textContent = isMuted() ? "Muted" : "Sound";
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
  $("#who-am-i").textContent = v;
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
  $("#who-am-i").textContent = getName() || "Me";
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
  $("#who-am-i").textContent = getName() || "Me";
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

// Where a round stands: who's watched, who's rated, and whether it's complete.
function roundState(cf) {
  const myId = getMemberId();
  const movie = state.movies.find((m) => m.id === cf.movieId);
  const watchedBy = movie?.watchedBy || [];
  const ids = state.members.map((m) => m.id);
  const ratedIds = new Set(
    state.ratings.filter((r) => r.movieId === cf.movieId && r.score > 0).map((r) => r.memberId)
  );
  const total = ids.length;
  const watchedCount = ids.filter((id) => watchedBy.includes(id)).length;
  const ratedCount = ids.filter((id) => ratedIds.has(id)).length;
  return {
    total,
    watchedCount,
    ratedCount,
    iWatched: watchedBy.includes(myId),
    iRated: ratedIds.has(myId),
    allWatched: total > 0 && watchedCount === total,
    allRated: total > 0 && ratedCount === total,
    complete: total > 0 && watchedCount === total && ratedCount === total,
  };
}

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
  $("#who-am-i").textContent = getName() || "Me";

  // Auto-finish the round once everyone has watched AND rated.
  const cf = state.group?.currentFilm;
  if (cf) {
    if (roundState(cf).complete && finalizingId !== cf.movieId) {
      finalizingId = cf.movieId;
      finalizeRound(state.code, cf.movieId).catch(() => { finalizingId = null; });
    }
  } else {
    finalizingId = null;
  }

  // Group reset: show the consent banner, and wipe once everyone has approved.
  renderResetBanner();
  const rr = state.group?.resetRequest;
  if (rr) {
    const ids = state.members.map((m) => m.id);
    const all = ids.length > 0 && ids.every((id) => (rr.approvals || []).includes(id));
    if (all && !resetting) {
      resetting = true;
      performReset(state.code).catch(() => { resetting = false; });
    }
  } else {
    resetting = false;
  }

  renderFilmCard();

  if (state.tab === "wheel") renderWheelTab();
  else if (state.tab === "movies") { if (!editingWithin($("#tab-movies"))) renderMoviesTab(); }
  else if (state.tab === "history") { if (!editingWithin($("#tab-history"))) renderHistoryTab(); }
  else if (state.tab === "stats") { renderStats($("#tab-stats"), state.movies, state.ratings, state.members); appendResetControl($("#tab-stats")); }

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
    const rs = roundState(cf);
    const isSpinner = currentSpinnerId(state.group) === myId;

    let actions;
    if (!rs.iWatched) {
      actions = `<button class="btn primary" id="watched-btn">I've watched it</button>`;
    } else if (!rs.iRated) {
      actions = `<span class="ack-pill done">You've watched it</span><button class="btn" id="rate-btn">Rate it</button>`;
    } else {
      actions = `<span class="ack-pill done">Watched and rated</span>`;
    }

    card.innerHTML = `
      <div class="film-banner">This week's film</div>
      <h1 class="film-title">${esc(cf.title)}</h1>
      <div class="film-meta">
        <span>picked by <b>${esc(cf.spinnerName || "—")}</b></span>
        <span>added by <b>${esc(cf.addedByName || "—")}</b></span>
      </div>
      <div class="deadline-row">
        <span class="deadline-pill" id="countdown">${countdownText(countdownDeadline)}</span>
        <span class="muted small">watch by ${new Date(countdownDeadline).toLocaleDateString()}</span>
      </div>
      ${isSpinner ? `<div class="deadline-edit"><label class="small muted">Change deadline</label><input type="date" id="deadline-input" value="${dateInputValue(countdownDeadline)}"></div>` : ""}
      <div class="round-progress">
        <div class="rp-item"><div class="rp-count">${rs.watchedCount}<span class="of"> / ${rs.total}</span></div><div class="rp-label">Watched</div></div>
        <div class="rp-item"><div class="rp-count">${rs.ratedCount}<span class="of"> / ${rs.total}</span></div><div class="rp-label">Rated</div></div>
      </div>
      <div class="watch-actions">${actions}</div>
      <div class="reveal-note">Reviews stay sealed — and the next spin stays locked — until everyone has watched and rated.</div>
      ${isSpinner ? `<div class="force-line"><button class="text-link" id="force-finish">Wrap up now: reveal reviews and pass the turn</button></div>` : ""}
    `;

    const wb = $("#watched-btn");
    if (wb) wb.addEventListener("click", () => markWatchedAck(state.code, cf.movieId, myId));
    const rb = $("#rate-btn");
    if (rb) rb.addEventListener("click", () => switchTab("history"));
    if (isSpinner) {
      $("#deadline-input").addEventListener("change", (e) => {
        const d = new Date(e.target.value + "T20:00:00");
        if (!isNaN(d)) setDeadline(state.code, cf.movieId, d);
      });
      $("#force-finish").addEventListener("click", () => {
        if (confirm("Reveal everyone's reviews now and pass the turn to the next person?")) {
          finalizeRound(state.code, cf.movieId);
        }
      });
    }
  } else {
    countdownDeadline = null;
    const spinnerId = currentSpinnerId(state.group);
    const spinner = state.members.find((m) => m.id === spinnerId);
    const isMe = spinnerId === myId;
    const name = spinner?.name || "someone";
    card.innerHTML = `
      <div class="film-banner">No film picked yet</div>
      <h1 class="film-title">${isMe ? "It's your turn to spin" : `It's ${esc(name)}'s turn to spin`}</h1>
      <p class="muted">${isMe ? "Head to the wheel and give it a spin." : "Sit tight, or add more films to the wheel."}</p>
      <button class="btn ${isMe ? "primary" : ""}" id="goto-wheel">Go to the wheel</button>
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
        Spin
      </button>
      <p class="wheel-status">${wheelStatus(isMyTurn, movies.length, spinnerId)}</p>
    </div>
    ${order.length ? `<div class="turn-order"><div class="small">Turn order</div><div class="turn-chips">${orderHtml}</div></div>` : ""}
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
  if (state.group?.currentFilm) return "This week's film is still in play — finish watching and rating it first.";
  if (!count) return "Add films on the Films tab to fill the wheel.";
  const spinner = state.members.find((m) => m.id === spinnerId);
  if (isMyTurn) return `${count} film${count > 1 ? "s" : ""} ready — your spin.`;
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
        ${m.addedByMemberId === myId ? `<button class="link-btn" data-remove="${m.id}" title="Remove">Remove</button>` : ""}
      </li>`
    )
    .join("");

  pane.innerHTML = `
    <div class="card">
      <h3>Add a film to the wheel</h3>
      <div class="add-row">
        <input id="movie-input" placeholder="Film title…" maxlength="80" />
        <button class="btn primary" id="add-movie-btn">Add</button>
      </div>
    </div>
    <div class="card">
      <h3>On the wheel <span class="muted">(${movies.length})</span></h3>
      <ul class="movie-list">${list || '<li class="muted">Nothing yet — add the first film.</li>'}</ul>
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
  const cf = state.group?.currentFilm;
  const watched = watchedMovies();

  if (!cf && !watched.length) {
    pane.innerHTML = `<p class="muted center">No films watched yet. Once the club finishes this week's film, it appears here with everyone's ratings.</p>`;
    return;
  }

  pane.innerHTML = "";

  // The in-progress film: your rating is private until the whole club is in.
  if (cf) {
    const rs = roundState(cf);
    const card = document.createElement("div");
    card.className = "card pending-card";
    card.innerHTML = `
      <div class="sealed-banner">Sealed</div>
      <div class="watched-head">
        <h3>${esc(cf.title)}</h3>
        <span class="muted small">${rs.watchedCount}/${rs.total} watched · ${rs.ratedCount}/${rs.total} rated</span>
      </div>
      <p class="muted small">Everyone's reviews appear here the moment all members have watched and rated.</p>
      <div class="pending-rating"></div>
    `;
    pane.appendChild(card);

    const area = card.querySelector(".pending-rating");
    if (rs.iWatched) {
      mountRatingEditor(area, cf.movieId, myId, true);
    } else {
      area.innerHTML = `<p class="muted small">Mark this film as watched (on the card at the top) before you rate it.</p>
        <button class="btn small" id="pending-watched">I've watched it</button>`;
      card.querySelector("#pending-watched").addEventListener("click", () =>
        markWatchedAck(state.code, cf.movieId, myId)
      );
    }
  }

  // Finished films: fully revealed, newest first.
  watched.forEach((movie) => renderWatchedCard(pane, movie, myId));
}

function renderWatchedCard(pane, movie, myId) {
  const movieRatings = state.ratings.filter((r) => r.movieId === movie.id);
  const scores = movieRatings.map((r) => r.score);
  const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

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
      <div class="watched-avg">${scores.length ? starsHtml(Math.round(avgScore * 2) / 2) + ` <b>${fmt2(avgScore)}</b> <span class="muted small">(${scores.length})</span>` : '<span class="muted small">no ratings</span>'}</div>
    </div>
    <div class="muted small">added by ${esc(movie.addedByName || "?")}</div>
    <div class="ratings-list">${others || ""}</div>
    <div class="my-rating-mount"></div>
  `;
  pane.appendChild(card);
  mountRatingEditor(card.querySelector(".my-rating-mount"), movie.id, myId, false);
}

// Star widget + review box + save, used for both the sealed current film and
// finished films. `sealed` only changes the confirmation wording.
function mountRatingEditor(container, movieId, myId, sealed) {
  const mine = state.ratings.find((r) => r.movieId === movieId && r.memberId === myId);
  container.innerHTML = `
    <div class="my-rating">
      <div class="small muted">Your rating</div>
      <div class="my-rating-stars"></div>
      <textarea class="review-input" placeholder="Add a short review or comment…" maxlength="500">${esc(mine?.review || "")}</textarea>
      <button class="btn small save-rating">${mine ? "Update" : "Save"} rating</button>
      <span class="save-note small"></span>
    </div>
  `;
  const widget = buildStarRating(mine?.score || 0);
  container.querySelector(".my-rating-stars").appendChild(widget);
  container.querySelector(".save-rating").addEventListener("click", async () => {
    const score = widget.getValue();
    if (!score) {
      container.querySelector(".save-note").textContent = "Pick a star rating first.";
      return;
    }
    const review = container.querySelector(".review-input").value;
    await saveRating(state.code, movieId, score, review);
    container.querySelector(".save-note").textContent = sealed
      ? "Saved — sealed until everyone's in."
      : "Saved.";
  });
}

// ---- group reset (unanimous consent) ---------------------------------------
function renderResetBanner() {
  const el = $("#reset-banner");
  if (!el) return;
  const rr = state.group?.resetRequest;
  if (!rr) { el.classList.add("hidden"); el.innerHTML = ""; return; }

  const myId = getMemberId();
  const ids = state.members.map((m) => m.id);
  const approvals = rr.approvals || [];
  const approvedCount = ids.filter((id) => approvals.includes(id)).length;
  const iApproved = approvals.includes(myId);
  const mine = rr.startedBy === myId;

  el.classList.remove("hidden");
  el.innerHTML = `
    <div class="reset-box">
      <div class="reset-head">${mine ? "You proposed resetting the club" : esc(rr.startedByName || "Someone") + " wants to reset the club"}</div>
      <p class="reset-desc">This clears every film, rating and review and starts the club fresh — members and the club code stay. It only happens once <b>everyone</b> approves.</p>
      <div class="reset-progress">Approved ${approvedCount} / ${ids.length}</div>
      <div class="reset-actions">
        ${iApproved ? `<span class="ack-pill done">You approved</span>` : `<button class="btn primary small" id="reset-approve">Approve reset</button>`}
        <button class="btn small" id="reset-decline">${mine ? "Cancel request" : "Decline"}</button>
      </div>
    </div>`;

  const ap = $("#reset-approve");
  if (ap) ap.addEventListener("click", () => approveReset(state.code, myId));
  $("#reset-decline").addEventListener("click", () => cancelReset(state.code));
}

function appendResetControl(pane) {
  if (state.group?.resetRequest) return; // the banner is already handling it
  const div = document.createElement("div");
  div.className = "card danger-zone";
  div.innerHTML = `
    <h3>Reset club</h3>
    <p class="muted small">Clear every film, rating and review and start the club fresh. The club and its members stay. Nothing happens until <b>every</b> member approves.</p>
    <button class="btn small" id="request-reset">Request reset…</button>
  `;
  pane.appendChild(div);
  $("#request-reset").addEventListener("click", () => {
    if (confirm("Ask everyone to approve resetting the club? Nothing is deleted until all members approve.")) {
      requestReset(state.code, getMemberId(), getName());
    }
  });
}

init();
