// ============================================================================
//  CineClub — app orchestration: routing, live data, rendering, actions
// ============================================================================

import { isConfigured, db, doc, collection, onSnapshot } from "./firebase.js";
import {
  ensureAuth, getName, setName, getMemberId, getUid, getLastGroup, setLastGroup,
  isAccountSaved, getAccountEmail, sendAccountLink, isEmailSignInLink, completeEmailLinkSignIn,
} from "./session.js";
import {
  createGroup, joinGroup, currentSpinnerId, normaliseCode,
  requestReset, approveReset, cancelReset, performReset, setMyServices, kickMember, setStreamFilter, setWheelCap,
} from "./groups.js";
import { addMovie, removeMovie, commitSpin, markWatchedAck, finalizeRound, setDeadline, setMovieServices, voteRemoveMovie, postComment, deleteComment, startVote, submitBallot, cancelVote, commitVoteWinner, refreshMovieTmdbMeta } from "./movies.js";
import {
  renderIdleWheel, chooseWinnerIndex, maybePlaySpin, setMuted, isMuted, resumeAudio,
} from "./wheel.js";
import { buildStarRating, starsHtml, saveRating } from "./ratings.js";
import { pushAvailable, pushPermission, enablePush } from "./push.js";
import { renderStats } from "./stats.js";
import { tmdbEnabled, TMDB_STATEMENT, searchTitles, getDetails, getMovieDetail, getRecommendations, posterUrl, getWatchProviders, watchRegion, setWatchRegion, WATCH_REGIONS, STREAMING_SERVICES, canStream } from "./tmdb.js";

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
  comments: [],
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
// When the club opts to cap the wheel, show at most this many films (the oldest
// on the wheel) so a big list stays readable. Toggleable per club; see renderWheelTab.
const WHEEL_CAP = 20;
// TMDB terms prohibit caching their data for more than 6 months. We store
// tmdbFetchedAt when metadata is saved, then refresh stale docs in the background.
const TMDB_CACHE_MS = 6 * 30 * 24 * 60 * 60 * 1000; // 6 months
let tmdbRefreshDone = false; // run once per session, not on every render

// ---- boot ------------------------------------------------------------------
async function init() {
  setMuted(localStorage.getItem("cineclub_muted") === "1");
  updateMuteBtn();
  wireStaticUI();

  if (!isConfigured) {
    show($("#screen-config"));
    return;
  }
  try {
    await ensureAuth();
  } catch (e) {
    // We're past the isConfigured check, so this is a runtime failure (network /
    // App Check), not a setup one — show the friendly banner over the landing.
    showLanding();
    showConnError(friendlyConnMessage(e) || "Couldn't connect to CineClub — please try reloading.");
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
    localStorage.setItem("cineclub_muted", isMuted() ? "1" : "0");
    updateMuteBtn();
  });
  $("#who-am-i").addEventListener("click", () => promptName());
  $("#name-save").addEventListener("click", saveName);
  $("#name-input").addEventListener("keydown", (e) => e.key === "Enter" && saveName());
  $("#account-btn").addEventListener("click", openAccountModal);
  $("#account-close").addEventListener("click", () => hide($("#account-modal")));
  wireProvidersModal();
  wireImportModal();
  $("#movie-modal-close").addEventListener("click", closeMovieModal);
  $("#recap-close").addEventListener("click", () => hide($("#recap-modal")));
  // Escape closes whichever modal is open.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#import-modal").classList.contains("hidden")) {
      hide($("#import-modal"));
    } else if (!$("#recap-modal").classList.contains("hidden")) {
      hide($("#recap-modal"));
    } else if (!$("#movie-modal").classList.contains("hidden")) {
      closeMovieModal();
    } else if (!$("#providers-modal").classList.contains("hidden")) {
      closeProvidersModal();
    } else if (!$("#account-modal").classList.contains("hidden")) {
      hide($("#account-modal"));
    } else if (!$("#name-modal").classList.contains("hidden")) {
      hide($("#name-modal"));
      if (namePromiseResolve) { namePromiseResolve(); namePromiseResolve = null; }
    }
  });
  $("#leave-btn").addEventListener("click", leaveGroup);

  // Mobile: the right-hand utility chips collapse behind the "Menu" button.
  const menuBtn = $("#menu-btn");
  const topbarRight = $("#topbar-right");
  if (menuBtn && topbarRight) {
    const closeMenu = () => {
      topbarRight.classList.remove("open");
      menuBtn.setAttribute("aria-expanded", "false");
    };
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = topbarRight.classList.toggle("open");
      menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    // Selecting a chip closes the menu — except Theme, which opens its own
    // popover anchored to the (still-visible) button.
    topbarRight.addEventListener("click", (e) => {
      if (e.target.closest("#theme-btn")) return;
      if (e.target.closest("button")) closeMenu();
    });
    // A tap anywhere outside, or Escape, closes it.
    document.addEventListener("click", (e) => {
      if (menuBtn.contains(e.target) || topbarRight.contains(e.target)) return;
      closeMenu();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
  }

  // Reveal a ||spoiler|| on click or Enter/Space.
  document.addEventListener("click", (e) => {
    const sp = e.target.closest?.(".spoiler");
    if (sp) sp.classList.add("revealed");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const sp = e.target.closest?.(".spoiler:not(.revealed)");
    if (sp) { e.preventDefault(); sp.classList.add("revealed"); }
  });

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
  window.addEventListener("cineclub:themechange", () => { try { render(); } catch (_) {} });

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
      <button data-act="about">About CineClub</button>`;
    document.body.appendChild(menu);
    startBtn.addEventListener("click", (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); });
    document.addEventListener("click", (e) => { if (e.target !== startBtn && !menu.contains(e.target)) menu.classList.add("hidden"); });
    menu.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (!act) return;
      menu.classList.add("hidden");
      if (act === "theme") $("#theme-btn").click();
      else if (act === "leave") { if (state.code) leaveGroup(); }
      else if (act === "about") alert("CineClub - a film-club wheel. Spin for the week's film, watch it, then rate. Built as a static site on Firebase.");
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
      const sn = memberName(cf.spinnerMemberId, cf.spinnerName);
      live.textContent = `This week's film: ${cf.title}${sn ? `, picked by ${sn}` : ""}.`;
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
        after clearing your browser, to pick up where you left off.</p>
      ${remindersHtml()}`;
    wireReminders();
    return;
  }
  body.innerHTML = `
    <h2>Save your account</h2>
    <p class="muted">No password. We'll email you a one-time link; open it and your
      club sticks to your account, so a new device or a cleared browser won't lose
      it. Totally optional.</p>
    <input id="account-email" type="email" placeholder="you@example.com" autocomplete="email" />
    <button id="account-send" class="btn primary">Email me a sign-in link</button>
    <p id="account-msg" class="muted small"></p>
    ${remindersHtml()}`;
  $("#account-send").addEventListener("click", handleSendLink);
  $("#account-email").addEventListener("keydown", (e) => e.key === "Enter" && handleSendLink());
  wireReminders();
  $("#account-email").focus();
}

// Web Push opt-in (only shown when reminders are turned on for this build).
function remindersHtml() {
  if (!pushAvailable()) return "";
  const perm = pushPermission();
  if (perm === "granted") {
    return `<hr><h2>Reminders</h2>
      <p class="muted">Reminders are on for this device — you'll get a nudge as the
        watch-by deadline approaches.</p>`;
  }
  if (perm === "denied") {
    return `<hr><h2>Reminders</h2>
      <p class="muted">Notifications are blocked for this site in your browser
        settings. Allow them there to get deadline reminders.</p>`;
  }
  return `<hr><h2>Reminders</h2>
    <p class="muted">Get a push notification on this device as the watch-by
      deadline approaches. Optional.</p>
    <button id="push-enable" class="btn">Turn on reminders</button>
    <p id="push-msg" class="muted small"></p>`;
}

function wireReminders() {
  const btn = $("#push-enable");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const msg = $("#push-msg");
    btn.disabled = true;
    if (msg) msg.textContent = "";
    try {
      const ok = await enablePush(state.code, getMemberId());
      if (ok) {
        renderAccountBody();
      } else {
        if (msg) msg.textContent = "Reminders weren't turned on (permission declined).";
        btn.disabled = false;
      }
    } catch (e) {
      if (msg) msg.textContent = "Couldn't turn on reminders: " + e.message;
      btn.disabled = false;
    }
  });
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
    msg.textContent = "Sent — check your email, including your spam folder. If it's in spam, mark it \"Not spam\" so the link becomes clickable.";
  } catch (e) {
    const code = e && e.code;
    const friendly = code === "auth/operation-not-allowed"
      ? "email sign-in isn't enabled for this app yet (the admin needs to turn on the Email-link provider in Firebase)."
      : code === "auth/invalid-email"
      ? "that doesn't look like a valid email address."
      : code === "auth/unauthorized-continue-uri" || code === "auth/unauthorized-domain"
      ? "this site isn't on the app's authorised domains in Firebase yet."
      : (e && e.message) || "something went wrong.";
    msg.textContent = "Couldn't send — " + friendly;
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
  tmdbRefreshDone = false; // reset so a fresh session check runs for this group
  state.code = code;
  ejecting = false;
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

// Tear down the club, drop the URL/last-group, and return to landing. `message`
// (if any) is shown on the landing screen — used when we were kicked, not when
// we left voluntarily.
function ejectFromClub(message) {
  teardownSubs();
  setLastGroup(null);
  const url = new URL(location.href);
  url.searchParams.delete("g");
  history.replaceState(null, "", url);
  state.group = null;
  state.members = [];
  state.movies = [];
  state.ratings = [];
  state.comments = [];
  showLanding();
  if (message) $("#landing-error").textContent = message;
}

function leaveGroup() {
  ejectFromClub("");
}

// Has the admin removed us? A kick records our memberId in `bannedMemberIds`
// (and our uid in `bannedUids`). We still receive group-doc snapshots (single-
// doc get is open to any signed-in user), but our members/movies/ratings reads
// are now denied — so eject cleanly instead of freezing on a half-loaded club.
let ejecting = false;
function checkKicked() {
  const g = state.group;
  if (!g || ejecting) return false;
  const kicked = (g.bannedMemberIds || []).includes(getMemberId())
    || (g.bannedUids || []).includes(getUid());
  if (kicked) {
    ejecting = true;
    ejectFromClub("You've been removed from this club.");
    return true;
  }
  return false;
}

async function handleCreate() {
  $("#landing-error").textContent = "";
  if (!getName()) { await promptName(); if (!getName()) return; }
  try {
    const code = await createGroup($("#new-group-name").value);
    attachGroup(code);
  } catch (e) {
    $("#landing-error").textContent = friendlyConnMessage(e) || e.message;
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
    $("#landing-error").textContent = friendlyConnMessage(e) || e.message;
  }
}

// ---- live data -------------------------------------------------------------
// ---- backend-trouble messaging ---------------------------------------------
// Map a Firestore/Auth error to a friendly explanation when the backend is
// unreachable, over its free daily quota, or blocking this browser (App Check),
// so the app shows a clear banner instead of silently freezing. "" = no nicer
// message than the raw one (callers fall back to err.message).
function friendlyConnMessage(err) {
  const code = (err && err.code) || "";
  if (code === "resource-exhausted")
    return "CineClub's hit its free daily limit — it'll be back tomorrow. Thanks for the interest!";
  if (code === "unavailable" || code === "deadline-exceeded" || code === "internal" || code === "aborted")
    return "Can't reach CineClub right now — check your connection and try again in a moment.";
  if (code === "unauthenticated" || code === "permission-denied" || code.indexOf("app-check") !== -1)
    return "Couldn't verify this browser. If you're on a strict ad/privacy blocker, a VPN, or private mode, try turning those off or use a different browser.";
  return "";
}
function showConnError(msg) {
  const el = $("#conn-banner");
  if (!el || !msg) return;
  el.textContent = msg;
  show(el);
}
function clearConnError() { hide($("#conn-banner")); }

function subscribe(code) {
  // The four listeners often fire together (initial load delivers all four; a
  // single action like a spin touches the group doc AND a movie). Coalesce the
  // resulting renders into one per turn of the event loop so we rebuild the DOM
  // once instead of up to four times. setTimeout(0) (not requestAnimationFrame)
  // so the auto-finalize/reset triggers in render() still fire in background
  // tabs, where rAF is paused.
  // A kick removes us from memberUids, so the subcollection listeners start
  // failing with permission-denied. Don't swallow it: confirm we were kicked
  // and eject. (The group-doc listener keeps working — single-doc get is open —
  // and is the usual trigger via checkKicked() in render; this is the backstop.)
  // Surface backend trouble (over free quota / unreachable) and App-Check blocks
  // as a friendly banner instead of a silently frozen app. permission-denied on a
  // SUBcollection means membership/kick (handled by checkKicked); on the open
  // group-doc get it can only mean App Check blocked this browser.
  const onSubErr = (err) => {
    if (err?.code === "permission-denied") { checkKicked(); return; }
    showConnError(friendlyConnMessage(err));
  };
  const onGroupErr = (err) => showConnError(friendlyConnMessage(err));
  state.unsub.push(
    onSnapshot(doc(db, "groups", code), (snap) => {
      clearConnError();                 // a successful read = backend reachable
      state.group = snap.exists() ? snap.data() : null;
      scheduleRender();
    }, onGroupErr)
  );
  state.unsub.push(
    onSnapshot(collection(db, "groups", code, "members"), (snap) => {
      state.members = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      scheduleRender();
    }, onSubErr)
  );
  state.unsub.push(
    onSnapshot(collection(db, "groups", code, "movies"), (snap) => {
      state.movies = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      scheduleRender();
      refreshStaleTmdbMetadata(); // fire-and-forget; guarded by tmdbRefreshDone
    }, onSubErr)
  );
  state.unsub.push(
    onSnapshot(collection(db, "groups", code, "ratings"), (snap) => {
      state.ratings = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      scheduleRender();
    }, onSubErr)
  );
  state.unsub.push(
    onSnapshot(collection(db, "groups", code, "comments"), (snap) => {
      state.comments = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      scheduleRender();
    }, onSubErr)
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

// Resolve a member's display name from the member-locked subcollection by id.
// Names are no longer denormalised onto the (world-readable) group doc, so we look
// them up here. `fb` covers the brief window before the members listener populates
// (and any legacy denormalised name still on an in-flight doc).
const memberName = (id, fb = "") => (id && state.members.find((m) => m.id === id)?.name) || fb;

// The club admin (creator). Falls back to the first joiner for older groups
// created before adminMemberId was recorded.
const groupAdminId = () =>
  state.group?.adminMemberId || (state.group?.memberOrder || [])[0] || null;
const isAdmin = () => !!groupAdminId() && groupAdminId() === getMemberId();

// Vote-off: a wheel film is dropped once everyone EXCEPT its adder has voted to
// remove it. Any client may fire the delete (deleteDoc is idempotent); the
// removingIds guard stops a single client spamming it.
const removingIds = new Set();
function removeVoteInfo(movie) {
  const needed = activeMemberIds().filter((id) => id !== movie.addedByMemberId);
  const votes = movie.removeVotes || [];
  return { needed, votes, count: needed.filter((id) => votes.includes(id)).length };
}
function maybeRemoveVotedFilms() {
  if (activeMemberIds().length < 2) return;
  state.movies.forEach((m) => {
    if (m.status !== "wheel" || removingIds.has(m.id)) return;
    const { needed, votes } = removeVoteInfo(m);
    if (needed.length && needed.every((id) => votes.includes(id))) {
      removingIds.add(m.id);
      removeMovie(state.code, m.id).catch(() => removingIds.delete(m.id));
    }
  });
}

// Resolve an approval vote once everyone's voted: single-writer (the spinner
// commits; others step in after a delay) so we don't race the transaction.
let resolvingVote = false;
function maybeResolveVote() {
  const v = state.group?.vote;
  if (!v || state.group?.currentFilm) { resolvingVote = false; return; }
  const ids = activeMemberIds();
  const ballots = v.ballots || {};
  const allVoted = ids.length > 0 && ids.every((id) => Array.isArray(ballots[id]));
  if (!allVoted || resolvingVote) return;
  const w = voteWinner();
  if (!w) return;
  resolvingVote = true;
  const fire = () => commitVoteWinner(state.code, w, new Date(Date.now() + 7 * 86400000), v.startedBy || "")
    .catch(() => { resolvingVote = false; });
  if (currentSpinnerId(state.group) === getMemberId()) fire();
  else setTimeout(() => {
    if (state.group?.vote && !state.group?.currentFilm) fire(); else resolvingVote = false;
  }, FALLBACK_MS);
}

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
  if (checkKicked()) return;
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

  maybeRemoveVotedFilms();
  maybeResolveVote();
  announceRound(state.group?.currentFilm);
  renderFilmCard();

  if (state.tab === "wheel") renderWheelTab();
  else if (state.tab === "movies") { if (!editingWithin($("#tab-movies"))) renderMoviesTab(); }
  else if (state.tab === "history") { if (!editingWithin($("#tab-history"))) renderHistoryTab(); }
  else if (state.tab === "stats") { const sc = $("#tab-stats"); renderStats(sc, state.movies, state.ratings, orderedMembers(), getMemberId()); appendStatsRecs(sc); appendRecapButton(sc); appendResetControl(sc); }

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
        <span>picked by <b>${esc(memberName(cf.spinnerMemberId, cf.spinnerName) || "—")}</b></span>
        <span>added by <b>${esc(movie.addedByName || cf.addedByName || "—")}</b></span>
      </div>
      <div class="deadline-row">
        <span class="deadline-pill" id="countdown">${countdownText(countdownDeadline)}</span>
        <span class="muted small">watch by ${new Date(countdownDeadline).toLocaleDateString()}</span>
      </div>
      <div class="cal-row"><span class="muted small">Add deadline to:</span> <button type="button" class="text-link" id="add-cal">Apple / Outlook</button> <a class="text-link" id="add-gcal" target="_blank" rel="noopener">Google</a></div>
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
      // Scroll the page so the rating (pending) card sits at the top, just below
      // the sticky header (whose height varies — it wraps on mobile).
      requestAnimationFrame(() => {
        const el = $("#tab-history .pending-card");
        if (!el) return;
        const header = document.querySelector(".topbar");
        const offset = (header ? header.offsetHeight : 60) + 10;
        window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - offset, behavior: "smooth" });
      });
    });
    const ep = card.querySelector("[data-edit-prov]");
    if (ep) ep.addEventListener("click", () => openProvidersEditor(ep.dataset.editProv));
    const cal = $("#add-cal");
    if (cal) cal.addEventListener("click", () => addToCalendar(cf.title, countdownDeadline));
    const gcal = $("#add-gcal");
    if (gcal) gcal.href = gcalUrl(cf.title, countdownDeadline);
    // Tap the poster or title for the full details popup.
    if (tmdbEnabled) {
      card.querySelectorAll(".film-poster, .film-title").forEach((el) => {
        el.classList.add("tappable");
        el.setAttribute("role", "button");
        el.setAttribute("tabindex", "0");
        el.title = "More about this film";
        el.addEventListener("click", () => openMovieDetail(movie));
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openMovieDetail(movie); }
        });
      });
    }
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
    const wCount = wheelMovies().length;
    const canSpin = wCount >= 2;
    const btnLabel = canSpin ? "Go to the wheel" : wCount === 1 ? "Add more films to the wheel" : "Add films to the wheel";
    const subtext = wCount === 0
      ? "No films on the wheel yet — add some to get started."
      : wCount === 1
        ? "Add at least one more film before you can spin."
        : isMe ? "Head to the wheel and give it a spin." : "Sit tight, or add more films to the wheel.";
    card.innerHTML = `
      <div class="film-banner">No film picked yet</div>
      <h1 class="film-title">${isMe ? "It's your turn to spin" : `It's ${esc(name)}'s turn to spin`}</h1>
      <p class="muted">${subtext}</p>
      <button class="btn ${isMe || !canSpin ? "primary" : ""}" id="goto-wheel">${btnLabel}</button>
    `;
    $("#goto-wheel").addEventListener("click", () => {
      switchTab(canSpin ? "wheel" : "movies");
      requestAnimationFrame(() => {
        const tabs = document.querySelector(".tabs");
        if (tabs) tabs.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }
}

function renderWheelTab() {
  const pane = $("#tab-wheel");
  const myId = getMemberId();
  const spinnerId = currentSpinnerId(state.group);
  const isMyTurn = spinnerId === myId && !state.group?.currentFilm;
  const filterOn = tmdbEnabled && !!state.group?.streamFilter;
  const capOn = state.group?.wheelCapped !== false; // default: capped, so a big wheel stays readable
  let movies = wheelMovies();
  const allCount = movies.length;
  if (filterOn) {
    ensureCoverage(movies);                              // async; re-renders when ready
    movies = movies.filter((m) => filmEligible(m) !== false); // keep eligible + still-loading
  }
  const hiddenCount = allCount - movies.length;          // hidden by the stream filter
  // Cap the wheel (after filtering) so it doesn't turn into a cluttered ring of
  // slivers. movies is oldest-first, so the longest-waiting films stay on; the
  // rest rotate in as these get watched and leave the wheel.
  let capHidden = 0;
  if (capOn && movies.length > WHEEL_CAP) {
    capHidden = movies.length - WHEEL_CAP;
    movies = movies.slice(0, WHEEL_CAP);
  }

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

  const vote = state.group?.vote;
  if (vote && !state.group?.currentFilm) {
    renderVoting(pane, vote, movies, myId, spinnerId, orderHtml);
    return;
  }

  pane.innerHTML = `
    <div class="wheel-wrap">
      <canvas id="wheel-canvas" width="460" height="460" role="img" aria-label="Wheel of films"></canvas>
    </div>
    <div class="wheel-controls">
      <button class="btn primary big" id="spin-btn" ${isMyTurn && movies.length ? "" : "disabled"}>
        Spin
      </button>
      <p class="wheel-status">${(filterOn && allCount && !movies.length)
        ? "No films everyone can stream — add some, or turn off the filter."
        : wheelStatus(isMyTurn, movies.length, spinnerId)}</p>
      ${tmdbEnabled ? `<label class="stream-filter"><input type="checkbox" id="stream-filter-toggle"${filterOn ? " checked" : ""}> Only spin films everyone can stream</label>${filterOn && hiddenCount ? `<p class="muted small filter-note">${hiddenCount} hidden — not everyone can stream ${hiddenCount > 1 ? "them" : "it"}.</p>` : ""}` : ""}
      ${allCount > WHEEL_CAP ? `<label class="stream-filter wheel-cap"><input type="checkbox" id="wheel-cap-toggle"${capOn ? " checked" : ""}> Limit the wheel to ${WHEEL_CAP} films</label>${capOn && capHidden ? `<p class="muted small filter-note">Showing ${WHEEL_CAP} of ${WHEEL_CAP + capHidden} — the rest rotate in as films get watched.</p>` : ""}` : ""}
      ${isMyTurn && movies.length >= 2 ? `<div class="vote-start"><button class="btn" id="start-vote-btn">Don't want to leave it to chance? Vote instead</button></div>` : ""}
    </div>
    ${order.length ? `<div class="turn-order"><div class="small">Turn order</div><div class="turn-chips">${orderHtml}</div></div>` : ""}
  `;

  renderIdleWheel($("#wheel-canvas"), movies);

  const sf = $("#stream-filter-toggle");
  if (sf) sf.addEventListener("change", () => setStreamFilter(state.code, sf.checked));

  const cap = $("#wheel-cap-toggle");
  if (cap) cap.addEventListener("change", () => setWheelCap(state.code, cap.checked));

  const sv = $("#start-vote-btn");
  if (sv) sv.addEventListener("click", () => startVote(state.code, myId, getName(), sampleShortlist(movies)));

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
      // Immediate feedback: the spin overlay is driven by the Firestore write
      // landing, so on a slow connection there'd otherwise be a dead beat between
      // the tap and anything happening.
      spinBtn.textContent = "Spinning…";
      const segs = movies.map((m) => ({ id: m.id, title: m.title, addedByName: m.addedByName }));
      const winner = chooseWinnerIndex(segs.length);
      const deadline = new Date(Date.now() + 7 * 86400000);
      try {
        await commitSpin(state.code, segs, winner, getMemberId(), deadline);
      } catch (e) {
        alert("Spin failed: " + e.message);
        spinBtn.textContent = "Spin";
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

// ---- approval voting (alternative to the spin) -----------------------------
const SHORTLIST = 6;
// A random sample of film ids — so a big wheel becomes a short, votable list.
function sampleShortlist(movies, n = SHORTLIST) {
  const arr = movies.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.min(n, arr.length)).map((m) => m.id);
}
// Tally approvals over the shortlist; most-approved wins (ties -> shortlist
// order, which is identical on every client, so the winner is deterministic).
function voteWinner() {
  const vote = state.group?.vote;
  if (!vote) return null;
  const byId = Object.fromEntries(wheelMovies().map((m) => [m.id, m]));
  const shortlist = (vote.shortlist || []).map((id) => byId[id]).filter(Boolean);
  if (!shortlist.length) return null;
  const counts = {};
  Object.values(vote.ballots || {}).forEach((arr) => (arr || []).forEach((id) => (counts[id] = (counts[id] || 0) + 1)));
  let best = shortlist[0], bestN = counts[shortlist[0].id] || 0;
  shortlist.forEach((m) => { const n = counts[m.id] || 0; if (n > bestN) { best = m; bestN = n; } });
  return best;
}

function renderVoting(pane, vote, movies, myId, spinnerId, orderHtml) {
  const isSpinner = spinnerId === myId;
  const byId = Object.fromEntries(wheelMovies().map((m) => [m.id, m]));
  const shortlist = (vote.shortlist || []).map((id) => byId[id]).filter(Boolean);
  const ballots = vote.ballots || {};
  const myBallot = ballots[myId];
  const iVoted = Array.isArray(myBallot);
  const counts = {};
  Object.values(ballots).forEach((arr) => (arr || []).forEach((id) => (counts[id] = (counts[id] || 0) + 1)));
  const ids = activeMemberIds();
  const votedCount = ids.filter((id) => Array.isArray(ballots[id])).length;

  const rows = shortlist.map((m) => {
    const checked = iVoted ? myBallot.includes(m.id) : false;
    return `<li><label class="vote-row">
      <input type="checkbox" class="vote-ck" data-vid="${m.id}"${checked ? " checked" : ""}>
      <span class="vote-title">${esc(m.title)}${m.year ? ` <span class="muted small">(${esc(m.year)})</span>` : ""}</span>
      <span class="vote-count" title="approvals">${counts[m.id] || 0}</span>
    </label></li>`;
  }).join("");

  const voteStarter = memberName(vote.startedBy, vote.startedByName);
  pane.innerHTML = `
    <div class="card vote-card">
      <div class="film-banner">Vote for the week's film</div>
      <p class="muted small">A shortlist of ${shortlist.length}${voteStarter ? `, drawn by ${esc(voteStarter)}` : ""} — tick every film you'd be happy to watch. Most approvals wins.</p>
      <ul class="vote-list">${rows || '<li class="muted">No films available.</li>'}</ul>
      <div class="vote-actions">
        <button class="btn primary" id="vote-submit">${iVoted ? "Update my picks" : "Submit my picks"}</button>
        <span class="muted small">${votedCount}/${ids.length} voted</span>
      </div>
      ${isSpinner ? `<div class="vote-admin">
        <button class="text-link" id="vote-shuffle">Shuffle shortlist</button>
        <button class="text-link" id="vote-close">Close &amp; pick winner</button>
        <button class="text-link" id="vote-cancel">Cancel vote</button>
      </div>` : ""}
    </div>
    ${orderHtml ? `<div class="turn-order"><div class="small">Turn order</div><div class="turn-chips">${orderHtml}</div></div>` : ""}
  `;

  $("#vote-submit").addEventListener("click", () => {
    const picks = [...pane.querySelectorAll(".vote-ck:checked")].map((c) => c.dataset.vid);
    submitBallot(state.code, myId, picks);
  });
  if (isSpinner) {
    $("#vote-shuffle").addEventListener("click", () => startVote(state.code, myId, getName(), sampleShortlist(movies)));
    $("#vote-close").addEventListener("click", () => {
      const w = voteWinner();
      if (w && confirm(`Close the vote and pick "${w.title}" (the most approved) now?`)) {
        commitVoteWinner(state.code, w, new Date(Date.now() + 7 * 86400000), vote.startedBy || getMemberId());
      }
    });
    $("#vote-cancel").addEventListener("click", () => { if (confirm("Cancel this vote and go back to the wheel?")) cancelVote(state.code); });
  }
  pane.querySelectorAll("[data-kick]").forEach((b) =>
    b.addEventListener("click", () => {
      const m = state.members.find((x) => x.id === b.dataset.kick);
      if (confirm(`Remove ${m?.name || "this member"} from the club?`)) kickMember(state.code, b.dataset.kick, b.dataset.kickUid || m?.uid || "");
    })
  );
}

function renderMoviesTab() {
  const pane = $("#tab-movies");
  const myId = getMemberId();
  const movies = wheelMovies();

  const me = state.members.find((m) => m.id === myId);
  const mySvcs = me && Array.isArray(me.services) ? me.services : [];

  const list = movies
    .map((m) => {
      const iAmAdder = m.addedByMemberId === myId;
      const { needed, votes, count } = removeVoteInfo(m);
      const iVoted = votes.includes(myId);
      const voteCtl = !iAmAdder
        ? `<button class="link-btn voteoff" data-voteoff="${m.id}"${iVoted ? " disabled" : ""} title="Vote to remove this film">${iVoted ? `Voted off (${count}/${needed.length})` : `Vote off${count ? ` (${count}/${needed.length})` : ""}`}</button>`
        : (count ? `<span class="muted small voteoff-note" title="Removed once everyone else votes">${count}/${needed.length} voted off</span>` : "");
      return `
      <li class="movie-row">
        ${posterThumb(m)}
        <span class="movie-main">
          <span class="movie-title">${esc(m.title)}${m.year ? ` <span class="muted small">(${esc(m.year)})</span>` : ""}</span>
          <span class="movie-by muted small">added by ${esc(m.addedByName || "?")}</span>
          ${tmdbEnabled ? `<span class="movie-avail small" data-mid="${m.id}"></span>` : ""}
        </span>
        ${tmdbEnabled ? `<button class="link-btn" data-edit-prov="${m.id}" title="Correct where to watch">Fix streaming</button>` : ""}
        ${voteCtl}
        ${iAmAdder ? `<button class="link-btn" data-remove="${m.id}" title="Remove">Remove</button>` : ""}
      </li>`;
    })
    .join("");

  const region = watchRegion();
  const servicesCard = tmdbEnabled ? `
    <div class="card">
      <h3>My streaming services</h3>
      <p class="muted small">Pick what you subscribe to — CineClub uses it to show who can actually watch each film.</p>
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
      <p class="muted small add-tip">Try to add films <b>everyone can stream</b> — the badge by each film shows who's covered.</p>` : ""}
      <p class="muted small import-row">Have a Letterboxd watchlist? <label class="text-link" for="lb-file">Import the CSV</label><input id="lb-file" type="file" accept=".csv,text/csv" hidden></p>
      <details class="lb-help muted small">
        <summary>How do I get the CSV?</summary>
        <ol>
          <li><b>Use a web browser, not the Letterboxd phone app</b> — the export option only exists on the website (letterboxd.com).</li>
          <li>Sign in, then open <b>Settings</b> &rarr; <b>Advanced</b>, scroll to the bottom and click <b>Export Your Data</b>. Confirm in the popup — it saves a <code>.zip</code> to your device.</li>
          <li><b>Unzip it</b> (tap/double-click the <code>.zip</code>) and open the folder inside. You want the file named <code>watchlist.csv</code>.</li>
          <li>Back here, click <b>Import the CSV</b> above and choose <b>that <code>watchlist.csv</code> file</b> — not the <code>.zip</code>, and not the other CSVs in the folder.</li>
        </ol>
        <p class="lb-tip">Stuck on &ldquo;waiting for download&rdquo;? It's a Letterboxd quirk — try a desktop browser (Chrome/Firefox), turn off ad-blockers/extensions for the site and don't use private mode, then check your Downloads folder.</p>
      </details>
      ${tmdbEnabled ? `<p class="tmdb-attribution muted small">
        <a href="https://www.themoviedb.org" target="_blank" rel="noopener" aria-label="The Movie Database">
          <img src="assets/tmdb-logo.svg" alt="TMDB" class="tmdb-logo" />
        </a>
        ${esc(TMDB_STATEMENT)}</p>` : ""}
    </div>
    <div class="card">
      <h3>On the wheel <span class="muted">(${movies.length})</span></h3>
      <ul class="movie-list">${list || '<li class="muted">Nothing yet — add the first film.</li>'}</ul>
    </div>
    <div id="tmdb-recs"></div>
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
  pane.querySelectorAll("[data-voteoff]").forEach((b) =>
    b.addEventListener("click", () => voteRemoveMovie(state.code, b.dataset.voteoff, myId))
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
    if (meta?.tmdbId) renderRecommendations(meta);
  };
  $("#add-movie-btn").addEventListener("click", () => addNow());
  input.addEventListener("keydown", (e) => e.key === "Enter" && addNow());
  pane.querySelectorAll("[data-remove]").forEach((b) =>
    b.addEventListener("click", () => removeMovie(state.code, b.dataset.remove))
  );
  if (tmdbEnabled) wireTmdbAutocomplete(input);

  const lb = $("#lb-file");
  if (lb) lb.addEventListener("change", () => {
    const file = lb.files && lb.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { openImport(parseLetterboxd(String(reader.result || ""))); lb.value = ""; };
    reader.readAsText(file);
  });

  // "More like…" recommendations, based on the most recently added film.
  if (tmdbEnabled) {
    const base = state.movies
      .filter((m) => m.tmdbId)
      .sort((a, b) => ms(b.addedAt, 0) - ms(a.addedAt, 0))[0];
    if (base) renderRecommendations(base);
  }
}

// ---- Letterboxd import ------------------------------------------------------
// Minimal CSV parser (handles quoted fields with commas and "" escapes).
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') { inQ = true; }
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") { field += c; }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function parseLetterboxd(text) {
  const rows = parseCsv(text).filter((r) => r.length && r.some((c) => c.trim()));
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const ni = header.indexOf("name"), yi = header.indexOf("year");
  if (ni === -1) return []; // not a Letterboxd export
  return rows.slice(1)
    .map((r) => ({ name: (r[ni] || "").trim(), year: yi >= 0 ? (r[yi] || "").trim() : "" }))
    .filter((f) => f.name);
}

let importFilms = [];
function openImport(films) {
  importFilms = films;
  const body = $("#import-body");
  if (!films.length) {
    body.innerHTML = `<p class="muted">No films found. Make sure you unzipped the Letterboxd export and chose the <b>watchlist.csv</b> file inside — not the <code>.zip</code> itself.</p>`;
    show($("#import-modal"));
    return;
  }
  body.innerHTML = `
    <label class="import-all"><input type="checkbox" id="import-select-all" checked> Select all (${films.length})</label>
    <ul class="import-list">${films
      .map((f, i) => `<li><label><input type="checkbox" class="import-ck" data-i="${i}" checked><span class="imp-ttl">${esc(f.name)}${f.year ? ` <span class="muted small">(${esc(f.year)})</span>` : ""}</span></label></li>`)
      .join("")}</ul>`;
  show($("#import-modal"));
  $("#import-select-all").addEventListener("change", (e) => {
    body.querySelectorAll(".import-ck").forEach((c) => { c.checked = e.target.checked; });
  });
}
function wireImportModal() {
  $("#import-close").addEventListener("click", () => hide($("#import-modal")));
  $("#import-add").addEventListener("click", async () => {
    const picks = [...$("#import-body").querySelectorAll(".import-ck:checked")].map((c) => importFilms[+c.dataset.i]).filter(Boolean);
    const btn = $("#import-add");
    if (!picks.length) { hide($("#import-modal")); return; }
    btn.disabled = true;
    btn.textContent = `Adding 0/${picks.length}…`;
    for (let i = 0; i < picks.length; i++) {
      const f = picks[i];
      let meta = null;
      if (tmdbEnabled) {
        const hits = await searchTitles(f.name, 6);
        const hit = (f.year && hits.find((h) => String(h.year) === String(f.year))) || hits[0];
        if (hit) meta = (await getDetails(hit.tmdbId)) || hit;
      }
      await addMovie(state.code, f.name, meta);
      btn.textContent = `Adding ${i + 1}/${picks.length}…`;
    }
    btn.disabled = false;
    btn.textContent = "Add selected";
    hide($("#import-modal"));
  });
}

// ---- recommendations --------------------------------------------------------
async function renderRecommendations(base) {
  const recs = await getRecommendations(base.tmdbId);
  const el = $("#tmdb-recs");
  if (!el) return; // tab changed
  const have = new Set();
  state.movies.forEach((m) => { if (m.tmdbId) have.add(String(m.tmdbId)); have.add((m.title || "").toLowerCase()); });
  const list = recs.filter((r) => !have.has(String(r.tmdbId)) && !have.has((r.title || "").toLowerCase())).slice(0, 6);
  if (!list.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<div class="card"><h3>More like <em>${esc(base.title)}</em></h3>
    <div class="rec-grid">${list
      .map((r, i) => `<button class="rec" data-rec="${i}" title="Add to wheel">
        ${r.posterPath ? `<img class="rec-poster" src="${esc(posterUrl(r.posterPath, "w92"))}" alt="" loading="lazy" />` : `<span class="rec-poster empty"></span>`}
        <span class="rec-title">${esc(r.title)}${r.year ? ` <span class="muted small">(${esc(r.year)})</span>` : ""}</span>
        <span class="rec-add">+ Add</span>
      </button>`)
      .join("")}</div></div>`;
  el.querySelectorAll(".rec").forEach((b) =>
    b.addEventListener("click", async () => {
      const r = list[+b.dataset.rec];
      b.disabled = true;
      const details = await getDetails(r.tmdbId);
      await addMovie(state.code, r.title, details || r);
    })
  );
}

// Background refresh of TMDB metadata older than 6 months (TMDB terms §1.C).
// Runs once per session after the group loads; silently skips on any error.
async function refreshStaleTmdbMetadata() {
  if (!tmdbEnabled || tmdbRefreshDone || !state.code) return;
  tmdbRefreshDone = true;
  const now = Date.now();
  const stale = state.movies.filter((m) =>
    m.tmdbId && (!m.tmdbFetchedAt || now - ms(m.tmdbFetchedAt, 0) > TMDB_CACHE_MS)
  ).slice(0, 5); // cap at 5 per session to stay well within rate limits
  for (const movie of stale) {
    try {
      const fresh = await getDetails(movie.tmdbId);
      if (fresh) await refreshMovieTmdbMeta(state.code, movie.id, fresh);
    } catch (_) {}
  }
}

// Personalised recs for the stats tab: fetch suggestions based on the current
// member's top-rated films and append them as a card below the other stats.
async function appendStatsRecs(container) {
  if (!tmdbEnabled) return;
  const myId = getMemberId();
  const movieById = Object.fromEntries(state.movies.map((m) => [m.id, m]));

  // Take the member's top-scored films that have a TMDB id, up to 3 seeds.
  const seeds = [...state.ratings]
    .filter((r) => r.memberId === myId)
    .sort((a, b) => b.score - a.score)
    .map((r) => movieById[r.movieId])
    .filter((m) => m && m.tmdbId)
    .slice(0, 3);

  if (!seeds.length) return;

  // Films already in the club (on wheel or watched) — exclude from suggestions.
  const have = new Set();
  state.movies.forEach((m) => {
    if (m.tmdbId) have.add(String(m.tmdbId));
    have.add((m.title || "").toLowerCase());
  });

  // Fetch recs for each seed in parallel, then merge and deduplicate.
  const allRecs = await Promise.all(seeds.map((m) => getRecommendations(m.tmdbId, 10)));
  const seen = new Set();
  const list = [];
  for (const recs of allRecs) {
    for (const r of recs) {
      if (!have.has(String(r.tmdbId)) && !have.has((r.title || "").toLowerCase()) && !seen.has(r.tmdbId)) {
        seen.add(r.tmdbId);
        list.push(r);
        if (list.length >= 6) break;
      }
    }
    if (list.length >= 6) break;
  }

  if (!list.length || !container.isConnected) return;

  const basedOn = seeds.map((m) => m.title).join(", ");
  const card = document.createElement("div");
  card.className = "card stats-recs";
  card.innerHTML = `<h3>Suggested for you</h3>
    <p class="muted small">Based on your ratings of <em>${esc(basedOn)}</em></p>
    <div class="rec-grid">${list.map((r, i) => `<button class="rec" data-rec="${i}" title="Add to wheel">
      ${r.posterPath ? `<img class="rec-poster" src="${esc(posterUrl(r.posterPath, "w92"))}" alt="" loading="lazy" />` : `<span class="rec-poster empty"></span>`}
      <span class="rec-title">${esc(r.title)}${r.year ? ` <span class="muted small">(${esc(r.year)})</span>` : ""}</span>
      <span class="rec-add">+ Add</span>
    </button>`).join("")}</div>`;
  card.querySelectorAll(".rec").forEach((b) =>
    b.addEventListener("click", async () => {
      const r = list[+b.dataset.rec];
      b.disabled = true;
      const details = await getDetails(r.tmdbId);
      await addMovie(state.code, r.title, details || r);
    })
  );
  container.appendChild(card);
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

// ---- movie details popup ----------------------------------------------------
let movieDetailReq = 0;

async function openMovieDetail(movie) {
  if (!tmdbEnabled) return;
  const token = ++movieDetailReq;
  const body = $("#movie-modal-body");
  body.innerHTML = `<p class="muted">Loading…</p>`;
  show($("#movie-modal"));
  const id = await filmTmdbId(movie);
  const d = id ? await getMovieDetail(id) : null;
  if (token !== movieDetailReq) return; // closed or superseded while loading
  if (!d) {
    body.innerHTML = `<h2 id="movie-modal-title">${esc(movie.title || "Film")}</h2>
      <p class="muted">Couldn't find extra details for this film.</p>`;
    return;
  }
  body.innerHTML = movieDetailHtml(d, movie);
  // Inline "where to watch" — fetched after the main details land.
  const data = await filmProviders(movie);
  if (token !== movieDetailReq) return;
  const we = $("#movie-modal-watch");
  if (we) we.innerHTML = watchProvidersHtml(data);
}

function fmtRuntime(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

function movieDetailHtml(d, movie) {
  const poster = d.posterPath
    ? `<img class="movie-detail-poster" src="${esc(posterUrl(d.posterPath, "w185"))}" alt="" />` : "";
  const meta = [
    d.year || "",
    typeof d.runtime === "number" && d.runtime > 0 ? fmtRuntime(d.runtime) : "",
    d.genres && d.genres.length ? d.genres.slice(0, 3).join(", ") : "",
  ].filter(Boolean).map(esc).join("  ·  ");
  const rating = d.voteAverage ? `<div class="muted small">TMDB ${d.voteAverage.toFixed(1)}/10</div>` : "";
  const tagline = d.tagline ? `<p class="movie-tagline muted">${esc(d.tagline)}</p>` : "";
  const trailer = d.trailerKey
    ? `<p class="movie-trailer"><a class="btn small" href="https://www.youtube.com/watch?v=${esc(d.trailerKey)}" target="_blank" rel="noopener">Watch trailer</a></p>` : "";
  const overview = d.overview
    ? `<p class="movie-overview">${esc(d.overview)}</p>`
    : `<p class="muted">No description available.</p>`;
  const director = d.directors && d.directors.length
    ? `<p class="movie-credits"><b>Director:</b> ${d.directors.map(esc).join(", ")}</p>` : "";
  const cast = d.cast && d.cast.length
    ? `<p class="movie-credits"><b>Cast:</b> ${d.cast.map(esc).join(", ")}</p>` : "";
  return `
    <div class="movie-detail-head">
      ${poster}
      <div class="movie-detail-meta">
        <h2 id="movie-modal-title">${esc(d.title || movie.title || "")}</h2>
        ${meta ? `<div class="muted small">${meta}</div>` : ""}
        ${rating}
        ${tagline}
        ${trailer}
      </div>
    </div>
    ${overview}
    ${director}
    ${cast}
    <div id="movie-modal-watch" class="watch-providers"></div>
    <p class="muted small movie-attr">Details from TMDB.</p>`;
}

function closeMovieModal() {
  movieDetailReq++; // invalidate any in-flight load
  hide($("#movie-modal"));
}

// ---- season recap ("CineClub Wrapped") --------------------------------------
function appendRecapButton(pane) {
  if (!state.movies.some((m) => m.status === "watched")) return; // nothing yet
  const div = document.createElement("div");
  div.className = "recap-cta center";
  div.innerHTML = `<button class="btn small" id="open-recap">Season recap</button>`;
  pane.insertBefore(div, pane.firstChild);
  $("#open-recap").addEventListener("click", () => { $("#recap-body").innerHTML = recapHtml(); show($("#recap-modal")); });
}

function recapHtml() {
  const watched = state.movies.filter((m) => m.status === "watched");
  const members = orderedMembers();
  const ratings = state.ratings;
  const titleOf = Object.fromEntries(state.movies.map((m) => [m.id, m.title]));
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

  const scoresFor = {}, givenBy = {};
  ratings.forEach((r) => {
    (scoresFor[r.movieId] ||= []).push(r.score);
    if (r.score > 0) (givenBy[r.memberId] ||= []).push(r.score);
  });
  const board = watched
    .map((m) => ({ title: m.title, a: mean(scoresFor[m.id] || []), n: (scoresFor[m.id] || []).length }))
    .filter((m) => m.n).sort((x, y) => y.a - x.a);
  const totalMins = watched.reduce((s, m) => s + (typeof m.runtime === "number" ? m.runtime : 0), 0);
  const genreCounts = {};
  watched.forEach((m) => (m.genres || []).forEach((g) => (genreCounts[g] = (genreCounts[g] || 0) + 1)));
  const topGenre = Object.entries(genreCounts).sort((a, b) => b[1] - a[1])[0];
  const raters = members
    .map((m) => ({ name: m.name || "Someone", a: mean(givenBy[m.id] || []), n: (givenBy[m.id] || []).length }))
    .filter((r) => r.n);
  const generous = raters.length ? raters.reduce((a, b) => (b.a > a.a ? b : a)) : null;
  const favs = members.map((m) => {
    const mine = ratings.filter((r) => r.memberId === m.id && r.score > 0);
    if (!mine.length) return null;
    const top = mine.reduce((a, b) => (b.score > a.score ? b : a));
    return { name: m.name || "Someone", title: titleOf[top.movieId] || "a film", score: top.score };
  }).filter(Boolean);

  return `
    <h2 id="recap-modal-title">CineClub recap</h2>
    <p class="recap-big">${watched.length} film${watched.length === 1 ? "" : "s"}${totalMins ? ` &middot; ${fmtRuntime(totalMins)} watched` : ""}</p>
    ${topGenre ? `<p class="muted">Most-watched genre: <b>${esc(topGenre[0])}</b></p>` : ""}
    ${board[0] ? `<p><b>Top rated:</b> ${esc(board[0].title)} <span class="muted">(${fmt2(board[0].a)}★)</span></p>` : ""}
    ${board.length > 1 ? `<p><b>Lowest rated:</b> ${esc(board[board.length - 1].title)} <span class="muted">(${fmt2(board[board.length - 1].a)}★)</span></p>` : ""}
    ${generous ? `<p><b>Most generous critic:</b> ${esc(generous.name)} <span class="muted">(${fmt2(generous.a)} avg)</span></p>` : ""}
    ${favs.length ? `<h3>Everyone's favourite</h3><ul class="recap-favs">${favs.map((f) => `<li>${esc(f.name)}: <b>${esc(f.title)}</b> ${f.score}★</li>`).join("")}</ul>` : ""}
    <p class="muted small">A snapshot of the club so far.</p>`;
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

// "Can everyone (who's set services) stream this film?" — cached by a signature
// of members' services + region, so it self-invalidates when those change. The
// network part is already cached in providerCache.
const coverageCache = {};
function svcSignature() {
  return membersWithServices()
    .map((m) => m.id + ":" + (m.services || []).slice().sort().join("+"))
    .sort().join("|") + "@" + watchRegion();
}
function filmEligible(movie) {
  if (!membersWithServices().length) return true; // no services set -> no constraint
  return coverageCache[svcSignature() + "::" + movie.id]; // true | false | undefined (loading)
}
async function ensureCoverage(movies) {
  const withSvc = membersWithServices();
  if (!withSvc.length) return;
  const sig = svcSignature();
  let changed = false;
  for (const m of movies) {
    const key = sig + "::" + m.id;
    if (key in coverageCache) continue;
    const data = await filmProviders(m);
    const names = (data?.providers || []).map((p) => p.name);
    coverageCache[key] = names.length ? withSvc.every((mem) => canStream(mem.services, names)) : false;
    changed = true;
  }
  if (changed) scheduleRender();
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

// Escape a review, then turn ||spoiler|| markup into click-to-reveal spans.
function renderReview(text) {
  return esc(text).replace(/\|\|([^|]+)\|\|/g,
    '<span class="spoiler" tabindex="0" role="button" aria-label="Hidden spoiler, click to reveal">$1</span>');
}

// A compact half-star histogram (½…5) of a film's scores.
function ratingHistogram(scores) {
  if (scores.length < 2) return "";
  const buckets = Array(10).fill(0);
  scores.forEach((s) => { const i = Math.round(s * 2) - 1; if (i >= 0 && i < 10) buckets[i]++; });
  const max = Math.max(...buckets, 1);
  const bars = buckets
    .map((c, i) => `<span class="hist-bar" style="height:${Math.round((c / max) * 100)}%" title="${(i + 1) / 2}★: ${c}"></span>`)
    .join("");
  return `<div class="rating-hist"><div class="hist-bars">${bars}</div><div class="hist-axis muted small"><span>½</span><span>5★</span></div></div>`;
}

// Calendar event for the watch-by deadline.
function icsEsc(s) { return String(s).replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n"); }
function icsStamp(ms) { return new Date(ms).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z"; }
function buildIcs(title, deadlineMs) {
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//CineClub//EN", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    "UID:cineclub-" + deadlineMs + "@" + (state.code || "club"),
    "DTSTAMP:" + icsStamp(Date.now()),
    "DTSTART:" + icsStamp(deadlineMs - 60 * 60 * 1000),
    "DTEND:" + icsStamp(deadlineMs),
    "SUMMARY:" + icsEsc("Watch: " + title),
    "DESCRIPTION:" + icsEsc("CineClub film-club pick — watch and rate before the deadline."),
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
}
const isIOS = () =>
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
// One-tap add: on iOS open the event straight in Calendar (a data: URL is
// handled natively — no Files detour); elsewhere download the .ics.
function addToCalendar(title, deadlineMs) {
  if (!deadlineMs) return;
  const ics = buildIcs(title, deadlineMs);
  if (isIOS()) {
    // iOS: NAVIGATE to the calendar URL (Safari hands it to Calendar). A
    // download-style link instead drops it into Files, which is the friction
    // we're avoiding.
    window.location.href = "data:text/calendar;charset=utf-8," + encodeURIComponent(ics);
    return;
  }
  const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "cineclub-" + (title || "film").replace(/[^a-z0-9]+/gi, "-").toLowerCase() + ".ics";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function gcalUrl(title, deadlineMs) {
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: "Watch: " + title,
    dates: icsStamp(deadlineMs - 60 * 60 * 1000) + "/" + icsStamp(deadlineMs),
    details: "CineClub film-club pick — watch and rate before the deadline.",
  });
  return "https://calendar.google.com/calendar/render?" + p.toString();
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
        ${r.review ? `<div class="review">${renderReview(r.review)}</div>` : ""}
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
    ${ratingHistogram(scores)}
    <div class="ratings-list">${others || ""}</div>
    <div class="my-rating-mount"></div>
    ${commentsHtml(movie.id, myId)}
  `;
  pane.appendChild(card);
  mountRatingEditor(card.querySelector(".my-rating-mount"), movie.id, myId, false);
  wireComments(card, movie.id, myId);
}

// Discussion thread for a finished film (revealed alongside the reviews).
function commentsHtml(movieId, myId) {
  const cmts = state.comments
    .filter((c) => c.movieId === movieId)
    .sort((a, b) => ms(a.createdAt, Date.now()) - ms(b.createdAt, Date.now()));
  const list = cmts.map((c) => `
    <div class="cmt">
      <span class="cmt-name">${esc(c.name || "Someone")}</span>
      <span class="cmt-text">${renderReview(c.text || "")}</span>
      ${c.memberId === myId ? `<button class="link-btn cmt-del" data-delcmt="${c.id}" title="Delete">delete</button>` : ""}
    </div>`).join("");
  return `
    <div class="comments">
      <h4 class="cmt-h">Discussion ${cmts.length ? `<span class="muted small">(${cmts.length})</span>` : ""}</h4>
      <div class="cmt-list">${list || '<p class="muted small">No comments yet — start the conversation.</p>'}</div>
      <div class="cmt-form">
        <input class="cmt-input" type="text" maxlength="1000" placeholder="Add a comment…" />
        <button class="btn small cmt-post">Post</button>
      </div>
    </div>`;
}

function wireComments(card, movieId, myId) {
  const input = card.querySelector(".cmt-input");
  const post = () => {
    const v = input.value.trim();
    if (!v) return;
    postComment(state.code, movieId, v);
    input.value = "";
  };
  card.querySelector(".cmt-post").addEventListener("click", post);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); post(); } });
  card.querySelectorAll("[data-delcmt]").forEach((b) =>
    b.addEventListener("click", () => deleteComment(state.code, b.dataset.delcmt))
  );
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
      <div class="muted small spoiler-hint">Wrap spoilers in ||double bars|| to hide them until tapped.</div>
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
      <div class="reset-head">${mine ? "You proposed resetting the club" : esc(memberName(rr.startedBy, rr.startedByName) || "Someone") + " wants to reset the club"}</div>
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
