// ============================================================================
//  Stats: everything computed client-side from films + ratings + members
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
  const addedByOf = Object.fromEntries(movies.map((m) => [m.id, m.addedByMemberId]));

  // Optional TMDB-metadata aggregates (only meaningful once films carry them).
  const withRuntime = watched.filter((m) => typeof m.runtime === "number" && m.runtime > 0);
  const totalMins = withRuntime.reduce((s, m) => s + m.runtime, 0);
  const genreCounts = {};
  watched.forEach((m) => (m.genres || []).forEach((g) => (genreCounts[g] = (genreCounts[g] || 0) + 1)));
  const topGenres = Object.entries(genreCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const decadeCounts = {};
  watched.forEach((m) => {
    const y = parseInt(m.year, 10);
    if (!isNaN(y)) { const d = Math.floor(y / 10) * 10; decadeCounts[d] = (decadeCounts[d] || 0) + 1; }
  });
  const decades = Object.entries(decadeCounts).sort((a, b) => a[0] - b[0]);

  // group scores by member (given) and by film (received)
  const givenBy = {};
  const scoresFor = {};
  const receivedBy = {};
  ratings.forEach((r) => {
    (givenBy[r.memberId] ||= []).push(r.score);
    (scoresFor[r.movieId] ||= []).push(r.score);
    const owner = addedByOf[r.movieId];
    if (owner) (receivedBy[owner] ||= []).push(r.score);
  });

  const tiles = [
    { label: "Films watched", value: watched.length },
    { label: "On the wheel", value: onWheel.length },
    { label: "Members", value: members.length },
    { label: "Ratings given", value: ratings.length },
  ];

  const raters = members
    .map((m) => ({ name: m.name || "Someone", scores: givenBy[m.id] || [] }))
    .filter((r) => r.scores.length > 0)
    .map((r) => ({ name: r.name, a: avg(r.scores), n: r.scores.length }));
  const generous = raters.length ? raters.reduce((a, b) => (b.a > a.a ? b : a)) : null;
  const harsh = raters.length ? raters.reduce((a, b) => (b.a < a.a ? b : a)) : null;

  const board = watched
    .map((m) => ({ title: m.title, scores: scoresFor[m.id] || [] }))
    .filter((m) => m.scores.length > 0)
    .map((m) => ({ title: m.title, a: avg(m.scores), n: m.scores.length, sd: stdev(m.scores) }))
    .sort((x, y) => y.a - x.a);

  const divisive = board.filter((m) => m.n >= 2).slice().sort((x, y) => y.sd - x.sd)[0] || null;

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
    html += `<div class="tile"><div class="tile-value">${t.value}</div><div class="tile-label">${t.label}</div></div>`;
  });
  html += `</div>`;

  const sups = [];
  if (generous) sups.push(superlative("Most generous", esc(generous.name), `${fmt(generous.a)} avg`));
  if (harsh && raters.length > 1) sups.push(superlative("Harshest critic", esc(harsh.name), `${fmt(harsh.a)} avg`));
  if (board[0]) sups.push(superlative("Top rated film", esc(board[0].title), `${fmt(board[0].a)} ★`));
  if (board.length > 1) sups.push(superlative("Lowest rated", esc(board[board.length - 1].title), `${fmt(board[board.length - 1].a)} ★`));
  if (divisive) sups.push(superlative("Most divisive", esc(divisive.title), `±${fmt(divisive.sd)}`));
  if (sups.length) html += `<div class="superlatives">${sups.join("")}</div>`;

  if (board.length) {
    html += `<div class="card"><h3>Film leaderboard</h3><ol class="leaderboard">`;
    board.forEach((m) => {
      html += `<li><span class="lb-title">${esc(m.title)}</span> ${starsHtml(Math.round(m.a * 2) / 2)} <span class="lb-score">${fmt(m.a)} (${m.n})</span></li>`;
    });
    html += `</ol></div>`;
  }

  if (members.length) {
    html += `<div class="card"><h3>Per person</h3><table class="people-table">
      <thead><tr><th>Name</th><th>Added</th><th>Avg given</th><th>Avg received</th></tr></thead><tbody>`;
    perPerson.forEach((p) => {
      html += `<tr><td>${esc(p.name)}</td><td>${p.added}</td><td>${p.given == null ? "—" : fmt(p.given)}</td><td>${p.received == null ? "—" : fmt(p.received)}</td></tr>`;
    });
    html += `</tbody></table><p class="muted small">"Avg received" = average score on films that person added.</p></div>`;
  }

  if (totalMins > 0 || topGenres.length || decades.length) {
    html += `<div class="card"><h3>Watch habits</h3>`;
    if (totalMins > 0) {
      html += `<p class="meta-line"><b>${hoursMins(totalMins)}</b> of films watched`;
      if (withRuntime.length) html += ` &middot; averaging <b>${Math.round(totalMins / withRuntime.length)} min</b>`;
      html += `</p>`;
    }
    if (topGenres.length) {
      html += `<p class="meta-line"><span class="muted small">Top genres</span><br>${topGenres
        .map(([g, n]) => `${esc(g)} <span class="muted">(${n})</span>`)
        .join("  &middot;  ")}</p>`;
    }
    if (decades.length) {
      html += `<p class="meta-line"><span class="muted small">By decade</span><br>${decades
        .map(([d, n]) => `${d}s <span class="muted">(${n})</span>`)
        .join("  &middot;  ")}</p>`;
    }
    html += `</div>`;
  }

  if (!watched.length && !ratings.length) {
    html += `<p class="muted center">No data yet. Spin the wheel, watch a film, and rate it to see the numbers appear here.</p>`;
  }

  container.innerHTML = html;
}

function hoursMins(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

function superlative(label, who, detail) {
  return `<div class="superlative"><div class="sup-label">${label}</div><div class="sup-who">${who}</div><div class="sup-detail">${detail}</div></div>`;
}
