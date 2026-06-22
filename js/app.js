// ============================================================================
//  Spinema — app orchestration: routing, live data, rendering, actions
// ============================================================================

import { isConfigured, db, doc, collection, onSnapshot } from "./firebase.js";
import {
  ensureAuth, getName, setName, getMemberId, getLastGroup, setLastGroup,
  isAccountSaved, getAccountEmail, sendAccountLink, isEmailSignInLink, completeEmailLinkSignIn,
} from "./session.js";
import {
  createGroup, joinGroup, currentSpinnerId, normaliseCode,
  requestReset, approveReset, cancelReset, performReset, setMyServices, kickMember,
} from "./groups.js";
import { addMovie, removeMovie, commitSpin, markWatchedAck, finalizeRound, setDeadline, setMovieServices } from "./movies.js";
import {
  renderIdleWheel, chooseWinnerIndex, maybePlaySpin, setMuted, isMuted, resumeAudio,
} from "./wheel.js";
import { buildStarRating, starsHtml, saveRating } from "./ratings.js";
import { renderStats } from "./stats.js";
import { tmdbEnabled, TMDB_STATEMENT, searchTitles, getDetails, posterUrl, getWatchProviders, watchRegion, setWatchRegion, WATCH_REGIONS, STREAMING_SERVICES, canStream } from "./tmdb.js";

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
let renderTimer = null; // coalesces bursts of listener-driven renders
// Single-writer fallback: the round's natural owner (spinner / reset proposer)
// commits immediately; every other client waits this long and only steps in if
// the owner didn't, so we don't have every browser racing the same transaction.
const FALLBACK_MS = 4000;

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

  // If we arrived from an email sign-in link, finish it before anything else so
  // the recovered uid is in place when we join (and can reclaim our seat).
  if (isEmailSignInLink()) {
    try {
      await completeEmailLinkSignIn(() => window.prompt("Confirm your email to finish signing in:"));
    } catch (e) {
      console.error("Email-link sign-in failed:", e);
    }
    const g = normaliseCode(new URLSearchParams(location.search).get("g") || "");
    history.replaceState(null, "", location.origin + location.pathname + (g ? "?g=" + g : ""));
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
  $("#account-btn").addEventListener("click", openAccountModal);
  $("#account-close").addEventListener("click", () => hide($("#account-modal")));
  wireProvidersModal();
  // Escape closes whichever modal is open.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#providers-modal").classList.contains("hidden")) {
      closeProvidersModal();
    } else if (!$("#account-modal").classList.contains("hidden")) {
      hide($("#account-modal"));
    } else if (!$("#name-modal").classList.contains("hidden")) {
      hide($("#name-modal"));
      if (namePromiseResolve) { namePromiseResolve(); namePromiseResolve = null; }
    }
  });
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

  // Invite link: the full URL with ?g=CODE, which auto-joins on open (the share
  // code still works for typing in by hand).
  $("#copy-link").addEventListener("click", () => {
    if (!state.code) return;
    const url = location.origin + location.pathname + "?g=" + encodeURIComponent(state.code);
    navigator.clipboard?.writeText(url);
    const btn = $("#copy-link");
    btn.textContent = "Link copied";
    setTimeout(() => { btn.textContent = "Invite link"; }, 1400);
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
    } else if (win.closest("#account-modal")) {
      hide($("#account-modal"));
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

// Announce round transitions to screen readers via the #sr-live region. Guarded
// so it speaks only on an actual change (render runs on every snapshot).
let lastAnnouncedFilm = null;
let lastTurnAnnounced = null;
function announceRound(cf) {
  const live = $("#sr-live");
  if (!live) return;
  if (cf) {
    if (cf.movieId !== lastAnnouncedFilm) {
      lastAnnouncedFilm = cf.movieId;
      lastTurnAnnounced = null;
      live.textContent = `This week's film: ${cf.title}${cf.spinnerName ? `, picked by ${cf.spinnerName}` : ""}.`;
    }
  } else {
    lastAnnouncedFilm = null;
    const spinnerId = currentSpinnerId(state.group);
    const key = spinnerId || "none";
    if (key !== lastTurnAnnounced) {
      lastTurnAnnounced = key;
      const spinner = state.members.find((m) => m.id === spinnerId);
      live.textContent = spinnerId === getMemberId()
        ? "It's your turn to spin."
        : `Waiting for ${spinner?.name || "the next person"} to spin.`;
    }
  }
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

// ---- account modal (optional portable identity) ----------------------------
function openAccountModal() {
  renderAccountBody();
  show($("#account-modal"));
}

function renderAccountBody() {
  const body = $("#account-body");
  if (isAccountSaved()) {
    body.innerHTML = `
      <h2>Account saved</h2>
      <p class="muted">You're signed in as <b>${esc(getAccountEmail())}</b>. Your club
        travels with you — open the app with this email on another device, or
        after clearing your browser, to pick up where you left off.</p>`;
    return;
  }
  body.innerHTML = `
    <h2>Save your account</h2>
    <p class="muted">No password. We'll email you a one-time link; open it and your
      club sticks to your account, so a new device or a cleared browser won't lose
      it. Totally optional.</p>
    <input id="account-email" type="email" placeholder="you@example.com" autocomplete="email" />
    <button id="account-send" class="btn primary">Email me a sign-in link</button>
    <p id="account-msg" class="muted small"></p>`;
  $("#account-send").addEventListener("click", handleSendLink);
  $("#account-email").addEventListener("keydown", (e) => e.key === "Enter" && handleSendLink());
  $("#account-email").focus();
}

async function handleSendLink() {
  const email = $("#account-email").value.trim();
  const msg = $("#account-msg");
  const btn = $("#account-send");
  msg.textContent = "";
  if (!email) { $("#account-email").focus(); return; }
  btn.disabled = true;
  try {
    await sendAccountLink(email);
    msg.textContent = "Sent — check your email for the sign-in link.";
  } catch (e) {
    msg.textContent = "Couldn't send: " + e.message;
    btn.disabled = false;
  }
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
  // The four listeners often fire together (initial load delivers all four; a
  // single action like a spin touches the group doc AND a movie). Coalesce the
  // resulting renders into one per turn of the event loop so we rebuild the DOM
  // once instead of up to four times. setTimeout(0) (not requestAnimationFrame)
  // so the auto-finalize/reset triggers in render() still fire in background
  // tabs, where rAF is paused.
  state.unsub.push(
    onSnapshot(doc(db, "groups", code), (snap) => {
      state.group = snap.exists() ? snap.data() : null;
      scheduleRender();
    })
  );
  state.unsub.push(
    onSnapshot(collection(db, "groups", code, "members"), (snap) => {
      state.members = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      scheduleRender();
    })
  );
  state.unsub.push(
    onSnapshot(collection(db, "groups", code, "movies"), (snap) => {
      state.movies = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      scheduleRender();
    })
  );
  state.unsub.push(
    onSnapshot(collection(db, "groups", code, "ratings"), (snap) => {
      state.ratings = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      scheduleRender();
    })
  );
}
function teardownSubs() {
  state.unsub.forEach((u) => { try { u(); } catch (_) {} });
  state.unsub = [];
  if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
}

// ---- ordering helpers ------------------------------------------------------
// serverTimestamp() reads back null on the writer's client until the server
// acks the write, so we fall back to Date.now() (NOT 0) — a freshly added /
// watched film then sorts as "newest" and holds its place instead of jumping
// to the start when the real timestamp lands. Keep the Date.now() fallback.
const wheelMovies = () =>
  state.movies.filter((m) => m.status === "wheel").sort((a, b) => ms(a.addedAt, Date.now()) - ms(b.addedAt, Date.now()));
const watchedMovies = () =>
  state.movies.filter((m) => m.status === "watched").sort((a, b) => ms(b.watchedAt, Date.now()) - ms(a.watchedAt, Date.now()));
const orderedMembers = () =>
  (state.group?.memberOrder || []).map((id) => state.members.find((m) => m.id === id)).filter(Boolean);
// memberOrder is the source of truth for who's *in* the club (so a kicked member
// stops counting everywhere, even before their member doc is gone).
const activeMemberIds = () => state.group?.memberOrder || [];

// The club admin (creator). Falls back to the first joiner for older groups
// created before adminMemberId was recorded.
const groupAdminId = () =>
  state.group?.adminMemberId || (state.group?.memberOrder || [])[0] || null;
const isAdmin = () => !!groupAdminId() && groupAdminId() === getMemberId();

// Where a round stands: who's watched, who's rated, and whether it's complete.
function roundState(cf) {
  const myId = getMemberId();
  const movie = state.movies.find((m) => m.id === cf.movieId);
  const watchedBy = movie?.watchedBy || [];
  const ids = activeMemberIds();
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

// Coalesce a burst of render requests into a single render next tick.
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, 0);
}

function render() {
  if (!state.code) return;
  $("#group-name").textContent = state.group?.name || "…";
  $("#group-code").textContent = state.code;
  $("#who-am-i").textContent = getName() || "Me";

  // Auto-finish the round once everyone has watched AND rated. Only one client
  // should commit it: the spinner does so at once; others wait FALLBACK_MS and
  // re-check, so they step in only if the spinner is away (no softlock, no race).
  const cf = state.group?.currentFilm;
  if (cf) {
    if (roundState(cf).complete && finalizingId !== cf.movieId) {
      finalizingId = cf.movieId;
      const fire = () => finalizeRound(state.code, cf.movieId)
        .catch(() => { if (finalizingId === cf.movieId) finalizingId = null; });
      if (currentSpinnerId(state.group) === getMemberId()) {
        fire();
      } else {
        setTimeout(() => {
          const live = state.group?.currentFilm;
          if (live && live.movieId === cf.movieId && roundState(live).complete) fire();
          else if (finalizingId === cf.movieId) finalizingId = null;
        }, FALLBACK_MS);
      }
    }
  } else {
    finalizingId = null;
  }

  // Group reset: show the consent banner, and wipe once everyone has approved.
  // Same single-writer pattern — the proposer commits; others are the fallback.
  renderResetBanner();
  const rr = state.group?.resetRequest;
  if (rr) {
    const ids = activeMemberIds();
    const all = ids.length > 0 && ids.every((id) => (rr.approvals || []).includes(id));
    if (all && !resetting) {
      resetting = true;
      const fire = () => performReset(state.code).catch(() => { resetting = false; });
      if (rr.startedBy === getMemberId()) {
        fire();
      } else {
        setTimeout(() => {
          const live = state.group?.resetRequest;
          if (live && ids.every((id) => (live.approvals || []).includes(id))) fire();
          else resetting = false;
        }, FALLBACK_MS);
      }
    }
  } else {
    resetting = false;
  }

  announceRound(state.group?.currentFilm);
  renderFilmCard();

  if (state.tab === "wheel") renderWheelTab();
  else if (state.tab === "movies") { if (!editingWithin($("#tab-movies"))) renderMoviesTab(); }
  else if (state.tab === "history") { if (!editingWithin($("#tab-history"))) renderHistoryTab(); }
  else if (state.tab === "stats") { renderStats($("#tab-stats"), state.movies, state.ratings, orderedMembers()); appendResetControl($("#tab-stats")); }

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
    const movie = state.movies.find((m) => m.id === cf.movieId) || {};
    const metaBits = filmMetaBits(movie);

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
      ${movie.posterPath ? `<img class="film-poster" src="${esc(posterUrl(movie.posterPath, "w185"))}" alt="" loading="lazy" />` : ""}
      <h1 class="film-title">${esc(cf.title)}</h1>
      ${metaBits ? `<div class="film-tmdb muted small">${esc(metaBits)}</div>` : ""}
      ${tmdbEnabled ? `<div id="watch-providers" class="watch-providers"></div><div id="who-can-watch" class="who-can-watch"></div>
      <button type="button" class="text-link edit-prov-link" data-edit-prov="${esc(cf.movieId)}">Streaming info wrong? Fix it</button>` : ""}
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

    if (tmdbEnabled) renderFilmAvailability(movie);

    const wb = $("#watched-btn");
    if (wb) wb.addEventListener("click", () => markWatchedAck(state.code, cf.movieId, myId));
    const rb = $("#rate-btn");
    if (rb) rb.addEventListener("click", () => {
      switchTab("history");
      // Bring the rating section to the top of the screen.
      requestAnimationFrame(() => {
        ($("#tab-history .pending-card") || $("#tab-history"))
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
    const ep = card.querySelector("[data-edit-prov]");
    if (ep) ep.addEventListener("click", () => openProvidersEditor(ep.dataset.editProv));
    if (isSpinner) {
      $("#deadline-input").addEventListener("change", (e) => {
        const d = new Date(e.target.value + "T20:00:00");
        if (!isNaN(d)) setDeadline(state.code, cf.movieId, d);
      });
      $("#force-finish").addEventListener("click", () => {
        if (confirm("Reveal everyone's reviews now and pass the turn to the next person?")) {
          // force = true: spinner's early wrap-up (server allows it before everyone's done).
          finalizeRound(state.code, cf.movieId, true);
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
  const adminId = groupAdminId();
  const iAmAdmin = isAdmin();
  const orderHtml = order
    .map((m) => {
      const admin = m.id === adminId ? `<span class="chip-admin" title="Club admin">admin</span>` : "";
      const kick = iAmAdmin && m.id !== myId
        ? `<button class="chip-kick" data-kick="${m.id}" data-kick-uid="${esc(m.uid || "")}" title="Remove ${esc(m.name || "member")}" aria-label="Remove ${esc(m.name || "member")}">×</button>`
        : "";
      return `<span class="turn-chip ${m.id === spinnerId ? "current" : ""}">${esc(m.name || "?")}${admin}${kick}</span>`;
    })
    .join('<span class="turn-arrow">→</span>');

  pane.innerHTML = `
    <div class="wheel-wrap">
      <canvas id="wheel-canvas" width="460" height="460" role="img" aria-label="Wheel of films"></canvas>
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

  pane.querySelectorAll("[data-kick]").forEach((b) =>
    b.addEventListener("click", () => {
      const m = state.members.find((x) => x.id === b.dataset.kick);
      const name = m?.name || "this member";
      if (confirm(`Remove ${name} from the club? They'll lose access and can't rejoin with the code.`)) {
        kickMember(state.code, b.dataset.kick, b.dataset.kickUid || m?.uid || "");
      }
    })
  );

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

  const me = state.members.find((m) => m.id === myId);
  const mySvcs = me && Array.isArray(me.services) ? me.services : [];

  const list = movies
    .map(
      (m) => `
      <li class="movie-row">
        ${posterThumb(m)}
        <span class="movie-main">
          <span class="movie-title">${esc(m.title)}${m.year ? ` <span class="muted small">(${esc(m.year)})</span>` : ""}</span>
          <span class="movie-by muted small">added by ${esc(m.addedByName || "?")}</span>
          ${tmdbEnabled ? `<span class="movie-avail small" data-mid="${m.id}"></span>` : ""}
        </span>
        ${tmdbEnabled ? `<button class="link-btn" data-edit-prov="${m.id}" title="Correct where to watch">Fix streaming</button>` : ""}
        ${m.addedByMemberId === myId ? `<button class="link-btn" data-remove="${m.id}" title="Remove">Remove</button>` : ""}
      </li>`
    )
    .join("");

  const region = watchRegion();
  const servicesCard = tmdbEnabled ? `
    <div class="card">
      <h3>My streaming services</h3>
      <p class="muted small">Pick what you subscribe to — Spinema uses it to show who can actually watch each film.</p>
      <div class="svc-grid">${STREAMING_SERVICES
        .map((s) => `<button type="button" class="svc-chip${mySvcs.includes(s.id) ? " on" : ""}" data-svc="${s.id}" aria-pressed="${mySvcs.includes(s.id)}">${esc(s.name)}</button>`)
        .join("")}</div>
      <label class="region-row muted small">Streaming region
        <select id="region-select">${WATCH_REGIONS
          .map((r) => `<option value="${r.code}"${r.code === region ? " selected" : ""}>${esc(r.name)}</option>`)
          .join("")}</select>
      </label>
      <p class="muted small">Where-to-watch is region-specific — set this to where you watch.</p>
    </div>` : "";

  pane.innerHTML = `
    ${servicesCard}
    <div class="card">
      <h3>Add a film to the wheel</h3>
      <div class="add-row">
        <input id="movie-input" placeholder="Film title…" maxlength="80" autocomplete="off" />
        <button class="btn primary" id="add-movie-btn">Add</button>
      </div>
      ${tmdbEnabled ? `<div id="tmdb-results" class="tmdb-results hidden"></div>
      <p class="muted small add-tip">Try to add films <b>everyone can stream</b> — the badge by each film shows who's covered.</p>
      <p class="tmdb-attribution muted small">${esc(TMDB_STATEMENT)}
        <a href="https://www.themoviedb.org" target="_blank" rel="noopener">TMDB</a></p>` : ""}
    </div>
    <div class="card">
      <h3>On the wheel <span class="muted">(${movies.length})</span></h3>
      <ul class="movie-list">${list || '<li class="muted">Nothing yet — add the first film.</li>'}</ul>
    </div>
  `;

  pane.querySelectorAll("[data-svc]").forEach((b) =>
    b.addEventListener("click", () => {
      const on = !b.classList.contains("on");
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
      const next = [...pane.querySelectorAll(".svc-chip.on")].map((x) => x.dataset.svc);
      setMyServices(state.code, myId, next);
    })
  );

  const regionSel = pane.querySelector("#region-select");
  if (regionSel) regionSel.addEventListener("change", () => {
    setWatchRegion(regionSel.value);
    providerCache = {}; // cached providers were region-specific — refetch
    render();
  });

  pane.querySelectorAll("[data-edit-prov]").forEach((b) =>
    b.addEventListener("click", () => openProvidersEditor(b.dataset.editProv))
  );

  if (tmdbEnabled) fillWheelAvailability(movies);

  const input = $("#movie-input");
  const addNow = async (meta = null) => {
    const t = input.value.trim();
    if (!t) return;
    input.value = "";
    input.blur();
    hideTmdbResults();
    // Typed-and-added (no autocomplete pick) still gets enriched: resolve the
    // title against TMDB so posters, "Where to watch" and the Watch-habits stats
    // light up for plain adds too. No-op if TMDB is off/unreachable (meta stays
    // null). The displayed title is always exactly what was typed.
    if (!meta && tmdbEnabled) {
      const hits = await searchTitles(t, 1);
      if (hits.length) meta = (await getDetails(hits[0].tmdbId)) || hits[0];
    }
    await addMovie(state.code, t, meta);
  };
  $("#add-movie-btn").addEventListener("click", () => addNow());
  input.addEventListener("keydown", (e) => e.key === "Enter" && addNow());
  pane.querySelectorAll("[data-remove]").forEach((b) =>
    b.addEventListener("click", () => removeMovie(state.code, b.dataset.remove))
  );
  if (tmdbEnabled) wireTmdbAutocomplete(input);
}

// Build a where-to-watch / who-can-watch label from a film's provider data.
// `withSvc` = members who've set their streaming services. Shared by the wheel
// list and the add-film autocomplete.
function availabilityLabel(data, withSvc) {
  if (!data) return { text: "", cls: "muted", title: "" };
  const names = data.providers.map((p) => p.name);
  if (!names.length) return { text: "Not on subscription streaming in your region", cls: "muted", title: "" };
  const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "");
  if (!withSvc.length) return { text: "Streaming on " + shown, cls: "muted", title: "" };
  const cant = withSvc.filter((mem) => !canStream(mem.services, names));
  return {
    text: `Streaming on ${shown} — ${cant.length ? `${withSvc.length - cant.length}/${withSvc.length}` : "everyone"} can watch`,
    cls: cant.length ? "warn" : "ok",
    title: cant.length ? "Can't watch: " + cant.map((mem) => mem.name || "Someone").join(", ") : "",
  };
}

const membersWithServices = () =>
  orderedMembers().filter((m) => Array.isArray(m.services) && m.services.length);

// Annotate each wheel film with where it streams, and — once members have set
// their streaming services — how many of them are covered. Lazy + cached per
// film. Runs for every film, services or not, so the info shows up right away.
async function fillWheelAvailability(movies) {
  const withSvc = membersWithServices();
  for (const m of movies) {
    const data = await filmProviders(m);
    const el = document.querySelector(`.movie-avail[data-mid="${m.id}"]`);
    if (!el) continue; // tab re-rendered
    const { text, cls, title } = availabilityLabel(data, withSvc);
    el.className = `movie-avail small ${cls}`;
    el.textContent = text;
    el.title = title;
  }
}

// Same idea for the add-film autocomplete dropdown: show what each result is
// streaming on and how many members are covered. Bails if the user types on
// (stale) so we don't write into a rebuilt dropdown.
async function fillAutocompleteAvailability(results, q, input) {
  const withSvc = membersWithServices();
  for (let i = 0; i < results.length; i++) {
    const data = await filmProviders({ tmdbId: results[i].tmdbId });
    const box = $("#tmdb-results");
    if (!box || input.value.trim() !== q) return; // user moved on
    const el = box.querySelector(`.tmdb-item-avail[data-ai="${i}"]`);
    if (!el) continue;
    const { text, cls, title } = availabilityLabel(data, withSvc);
    el.className = `tmdb-item-avail small ${cls}`;
    el.textContent = text;
    el.title = title;
  }
}

// ---- where-to-watch correction (club override of stale JustWatch data) ------
let editingProvMovieId = null;

// Open the editor for a film, pre-ticked from any existing club override or,
// failing that, JustWatch's current guess (which the user then corrects).
async function openProvidersEditor(movieId) {
  const movie = state.movies.find((m) => m.id === movieId);
  if (!movie) return;
  editingProvMovieId = movieId;
  $("#providers-modal-sub").textContent = movie.title || "";
  const grid = $("#providers-modal-grid");
  grid.innerHTML = `<span class="muted small">Loading…</span>`;
  show($("#providers-modal"));

  const preselected = Array.isArray(movie.serviceOverride)
    ? movie.serviceOverride
    : serviceIdsFromProviders(
        ((await filmProviders({ tmdbId: movie.tmdbId, title: movie.title })) || {}).providers?.map((p) => p.name) || []
      );
  if (editingProvMovieId !== movieId) return; // closed/changed while loading

  grid.innerHTML = STREAMING_SERVICES
    .map((s) => `<button type="button" class="svc-chip${preselected.includes(s.id) ? " on" : ""}" data-svc="${s.id}" aria-pressed="${preselected.includes(s.id)}">${esc(s.name)}</button>`)
    .join("");
  grid.querySelectorAll("[data-svc]").forEach((b) =>
    b.addEventListener("click", () => {
      const on = !b.classList.contains("on");
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    })
  );
}

function closeProvidersModal() {
  editingProvMovieId = null;
  hide($("#providers-modal"));
}

function wireProvidersModal() {
  $("#providers-save").addEventListener("click", () => {
    if (!editingProvMovieId) return;
    const ids = [...$("#providers-modal-grid").querySelectorAll(".svc-chip.on")].map((x) => x.dataset.svc);
    setMovieServices(state.code, editingProvMovieId, ids);
    closeProvidersModal();
  });
  $("#providers-reset").addEventListener("click", () => {
    if (!editingProvMovieId) return;
    setMovieServices(state.code, editingProvMovieId, null); // back to JustWatch
    closeProvidersModal();
  });
  $("#providers-close").addEventListener("click", closeProvidersModal);
}

function posterThumb(m, size = "w92") {
  const url = m.posterPath ? posterUrl(m.posterPath, size) : "";
  return url ? `<img class="poster-thumb" src="${esc(url)}" alt="" loading="lazy" />` : "";
}

// A film's TMDB id: stored on the doc, or resolved from its title (cached) so
// "Where to watch" / "Who can watch" still work for films added before TMDB
// enrichment. Returns null if TMDB is off or nothing matches. No DB write.
const tmdbIdByTitle = {};
async function filmTmdbId(movie) {
  if (movie.tmdbId) return movie.tmdbId;
  if (!tmdbEnabled || !movie.title) return null;
  const key = movie.title.trim().toLowerCase();
  if (key in tmdbIdByTitle) return tmdbIdByTitle[key];
  const hits = await searchTitles(movie.title, 1);
  return (tmdbIdByTitle[key] = hits.length ? hits[0].tmdbId : null);
}

// Watch providers for a film in the user's region, cached by tmdb id. TMDB
// sources this from JustWatch, which we credit and link in the UI. Keyed by
// tmdb id only, so it's reset (below) whenever the region changes.
let providerCache = {};
async function filmProviders(movie) {
  // A club-set override wins over (often stale/wrong) JustWatch data.
  if (Array.isArray(movie.serviceOverride)) {
    return {
      providers: movie.serviceOverride.map((id) => ({ name: SERVICE_NAME[id] || id, logo: "" })),
      link: "",
      source: "club",
    };
  }
  const id = await filmTmdbId(movie);
  if (!id) return null; // couldn't identify the film at all
  if (providerCache[id] === undefined) {
    providerCache[id] = await getWatchProviders(id, watchRegion());
  }
  // Normalise "identified, but no providers for this region" to an empty list
  // (distinct from null = unidentified) so callers can say so explicitly.
  return { ...(providerCache[id] || { providers: [], link: "" }), source: "justwatch" };
}

// Our streaming-service vocabulary, derived from STREAMING_SERVICES: an id->name
// lookup, and a best-guess mapping of raw TMDB provider names onto our ids (used
// to pre-fill the correction editor from JustWatch's current guess).
const SERVICE_NAME = Object.fromEntries(STREAMING_SERVICES.map((s) => [s.id, s.name]));
function serviceIdsFromProviders(names) {
  return STREAMING_SERVICES
    .filter((s) => (names || []).some((p) => s.match.some((t) => String(p).toLowerCase().includes(t))))
    .map((s) => s.id);
}

// "Where to watch" + "Who can watch" — injected into the film-of-the-week card.
async function renderFilmAvailability(movie) {
  const data = await filmProviders(movie);
  const provEl = $("#watch-providers");
  const whoEl = $("#who-can-watch");
  if (provEl) provEl.innerHTML = watchProvidersHtml(data);
  if (whoEl) whoEl.innerHTML = whoCanWatchHtml(data);
}

function watchProvidersHtml(data) {
  if (!data || !data.providers.length) return "";
  const attr = data.source === "club"
    ? `<div class="watch-attr muted small">Corrected by your club</div>`
    : `<div class="watch-attr muted small">Streaming data by JustWatch${data.link ? ` &middot; <a href="${esc(data.link)}" target="_blank" rel="noopener">details</a>` : ""}</div>`;
  return `
    <div class="watch-label muted small">Where to watch</div>
    <div class="watch-logos">${data.providers
      .slice(0, 6)
      .map((p) => p.logo
        ? `<img class="watch-logo" src="${esc(posterUrl(p.logo, "w45"))}" alt="${esc(p.name)}" title="${esc(p.name)}" loading="lazy" />`
        : `<span class="watch-name">${esc(p.name)}</span>`)
      .join("")}</div>
    ${attr}`;
}

// Cross-reference the film's providers with each member's saved services to say
// who can actually stream it. Members who haven't set their services are left
// out (we can't know) and nudged to add them on the Films tab.
function whoCanWatchHtml(data) {
  const providerNames = (data?.providers || []).map((p) => p.name);
  const withSvc = membersWithServices();
  if (!providerNames.length) {
    return `<div class="who-note muted small">No subscription streaming found for your region — it may be rental-only.</div>`;
  }
  if (!withSvc.length) {
    return `<div class="who-note muted small">Add your streaming services on the Films tab to see who can watch this.</div>`;
  }
  const can = [], cant = [];
  withSvc.forEach((m) => (canStream(m.services, providerNames) ? can : cant).push(m.name || "Someone"));
  let html = `<div class="who-label muted small">Who can watch</div>`;
  if (can.length) html += `<div class="who-row can"><b>Can watch:</b> ${can.map(esc).join(", ")}</div>`;
  if (cant.length) html += `<div class="who-row cant"><b>Not on their services:</b> ${cant.map(esc).join(", ")}</div>`;
  return html;
}

// "1994  ·  142m  ·  Drama, Crime" from whatever TMDB metadata a film has.
function filmMetaBits(m) {
  const bits = [];
  if (m.year) bits.push(String(m.year));
  if (typeof m.runtime === "number" && m.runtime > 0) bits.push(m.runtime + "m");
  if (Array.isArray(m.genres) && m.genres.length) bits.push(m.genres.slice(0, 3).join(", "));
  return bits.join("  ·  ");
}

function hideTmdbResults() {
  const r = $("#tmdb-results");
  if (r) { r.classList.add("hidden"); r.innerHTML = ""; }
}

let tmdbTimer = null;
// Debounced TMDB title autocomplete. The movies tab won't re-render while the
// input is focused (editingWithin guard), so the dropdown survives typing.
function wireTmdbAutocomplete(input) {
  input.addEventListener("input", () => {
    const q = input.value.trim();
    clearTimeout(tmdbTimer);
    if (q.length < 2) { hideTmdbResults(); return; }
    tmdbTimer = setTimeout(async () => {
      const results = await searchTitles(q);
      const box = $("#tmdb-results");
      if (!box || input.value.trim() !== q) return; // stale
      if (!results.length) { hideTmdbResults(); return; }
      box.innerHTML = results
        .map(
          (r, i) => `
        <button type="button" class="tmdb-item" data-i="${i}">
          ${r.posterPath
            ? `<img class="poster-thumb tiny" src="${esc(posterUrl(r.posterPath, "w92"))}" alt="" loading="lazy" />`
            : `<span class="poster-thumb tiny empty"></span>`}
          <span class="tmdb-item-main">
            <span class="tmdb-item-title">${esc(r.title)}${r.year ? ` <span class="muted small">(${esc(r.year)})</span>` : ""}</span>
            ${r.genres && r.genres.length ? `<span class="muted small">${esc(r.genres.slice(0, 3).join(", "))}</span>` : ""}
            <span class="tmdb-item-avail small muted" data-ai="${i}"></span>
          </span>
        </button>`
        )
        .join("");
      box.classList.remove("hidden");
      box.querySelectorAll(".tmdb-item").forEach((btn) =>
        btn.addEventListener("click", async () => {
          const r = results[+btn.dataset.i];
          input.value = "";
          input.blur();
          hideTmdbResults();
          const details = await getDetails(r.tmdbId);
          await addMovie(state.code, r.title, details || r);
        })
      );
      fillAutocompleteAvailability(results, q, input);
    }, 300);
  });
  // Hide the dropdown shortly after the field loses focus (after any result click).
  input.addEventListener("blur", () => setTimeout(hideTmdbResults, 150));
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
    ${posterThumb(movie, "w92")}
    <div class="watched-head">
      <h3>${esc(movie.title)}</h3>
      <div class="watched-avg">${scores.length ? starsHtml(Math.round(avgScore * 2) / 2) + ` <b>${fmt2(avgScore)}</b> <span class="muted small">(${scores.length})</span>` : '<span class="muted small">no ratings</span>'}</div>
    </div>
    <div class="muted small">added by ${esc(movie.addedByName || "?")}${filmMetaBits(movie) ? " · " + esc(filmMetaBits(movie)) : ""}</div>
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
  const ids = activeMemberIds();
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
