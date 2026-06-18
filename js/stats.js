// ============================================================================
//  Stats: everything computed client-side from movies + ratings + members
// ============================================================================

import { starsHtml } from "./ratings.js";

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const stdev = (a) => {
  if (a.length < 2) return 0;
  const m = avg(a);
  return Math.sqrt(avg(a.map((x) => (x - m) ** 2)));
};
const fmt = (n) => (Math.round(n * 100) / 100).toFixed(2);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

export function renderStats(container, movies, ratings, members) {
  const watched = movies.filter((m) => m.status === "watched");
  const onWheel = movies.filter((m) => m.status === "wheel");
  const nameOf = Object.fromEntries(members.map((m) => [m.id, m.name || "Someone"]));
  const titleOf = Object.fromEntries(movies.map((m) => [m.id, m.title]));
  const addedByOf = Object.fromEntries(movies.map((m) => [m.id, m.addedByMemberId]));

  // group scores by member (given) and by movie (received)
  const givenBy = {};
  const scoresFor = {};
  const receivedBy = {};
  ratings.forEach((r) => {
    (givenBy[r.memberId] ||= []).push(r.score);
    (scoresFor[r.movieId] ||= []).push(r.score);
    const owner = addedByOf[r.movieId];
    if (owner) (receivedBy[owner] ||= []).push(r.score);
  });

  // headline tiles
  const tiles = [
    { label: "Films watched", value: watched.length, icon: "🍿" },
    { label: "On the wheel", value: onWheel.length, icon: "🎡" },
    { label: "People", value: members.length, icon: "👥" },
    { label: "Ratings given", value: ratings.length, icon: "⭐" },
  ];

  // most generous / harshest (need at least one rating)
  const raters = members
    .map((m) => ({ name: m.name || "Someone", scores: givenBy[m.id] || [] }))
    .filter((r) => r.scores.length > 0)
    .map((r) => ({ name: r.name, a: avg(r.scores), n: r.scores.length }));
  const generous = raters.length ? raters.reduce((a, b) => (b.a > a.a ? b : a)) : null;
  const harsh = raters.length ? raters.reduce((a, b) => (b.a < a.a ? b : a)) : null;

  // film leaderboard (watched + has ratings)
  const board = watched
    .map((m) => ({ title: m.title, scores: scoresFor[m.id] || [] }))
    .filter((m) => m.scores.length > 0)
    .map((m) => ({ title: m.title, a: avg(m.scores), n: m.scores.length, sd: stdev(m.scores) }))
    .sort((x, y) => y.a - x.a);

  const divisive = board.filter((m) => m.n >= 2).slice().sort((x, y) => y.sd - x.sd)[0] || null;

  // per-person table
  const perPerson = members
    .map((m) => {
      const given = givenBy[m.id] || [];
      const received = receivedBy[m.id] || [];
      const added = movies.filter((mv) => mv.addedByMemberId === m.id).length;
      return {
        name: m.name || "Someone",
        added,
        given: given.length ? avg(given) : null,
        received: received.length ? avg(received) : null,
      };
    })
    .sort((a, b) => (b.given ?? -1) - (a.given ?? -1));

  let html = `<div class="stats-tiles">`;
  tiles.forEach((t) => {
    html += `<div class="tile"><div class="tile-icon">${t.icon}</div><div class="tile-value">${t.value}</div><div class="tile-label">${t.label}</div></div>`;
  });
  html += `</div>`;

  // superlatives
  html += `<div class="superlatives">`;
  if (generous)
    html += superlative("🫶", "Most generous", `${esc(generous.name)}`, `${fmt(generous.a)} avg`);
  if (harsh && raters.length > 1)
    html += superlative("🔪", "Harshest critic", `${esc(harsh.name)}`, `${fmt(harsh.a)} avg`);
  if (board[0])
    html += superlative("🏆", "Top rated film", `${esc(board[0].title)}`, `${fmt(board[0].a)} ★`);
  if (board.length > 1)
    html += superlative("💩", "Lowest rated", `${esc(board[board.length - 1].title)}`, `${fmt(board[board.length - 1].a)} ★`);
  if (divisive)
    html += superlative("⚔️", "Most divisive", `${esc(divisive.title)}`, `±${fmt(divisive.sd)}`);
  html += `</div>`;

  // leaderboard
  if (board.length) {
    html += `<div class="card"><h3>🎬 Film leaderboard</h3><ol class="leaderboard">`;
    board.forEach((m) => {
      html += `<li><span class="lb-title">${esc(m.title)}</span> ${starsHtml(Math.round(m.a * 2) / 2)} <span class="lb-score">${fmt(m.a)} (${m.n})</span></li>`;
    });
    html += `</ol></div>`;
  }

  // per-person
  if (members.length) {
    html += `<div class="card"><h3>👥 Per person</h3><table class="people-table">
      <thead><tr><th>Name</th><th>Added</th><th>Avg given</th><th>Avg received</th></tr></thead><tbody>`;
    perPerson.forEach((p) => {
      html += `<tr><td>${esc(p.name)}</td><td>${p.added}</td><td>${p.given == null ? "—" : fmt(p.given)}</td><td>${p.received == null ? "—" : fmt(p.received)}</td></tr>`;
    });
    html += `</tbody></table><p class="muted small">“Avg received” = average score on films that person added.</p></div>`;
  }

  if (!watched.length && !ratings.length) {
    html += `<p class="muted center">No data yet — spin the wheel, watch a film, and rate it to see stats appear here. 📈</p>`;
  }

  container.innerHTML = html;
}

function superlative(icon, label, who, detail) {
  return `<div class="superlative"><div class="sup-icon">${icon}</div><div class="sup-body"><div class="sup-label">${label}</div><div class="sup-who">${who}</div><div class="sup-detail">${detail}</div></div></div>`;
}
