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

// myMemberId: the current browser member — used for the "your take vs the group" section.
export function renderStats(container, movies, ratings, members, myMemberId) {
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

  // Scores from everyone except the current member — used for the contrarian comparison.
  const otherScores = {};
  ratings.filter((r) => r.memberId !== myMemberId).forEach((r) => {
    (otherScores[r.movieId] ||= []).push(r.score);
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
        sd: given.length >= 2 ? stdev(given) : null,
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

  // Rating distribution — bar chart across all half-star buckets.
  const HALF_STARS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
  const dist = {};
  HALF_STARS.forEach((s) => (dist[s] = 0));
  ratings.forEach((r) => { if (dist[r.score] !== undefined) dist[r.score]++; });
  const maxDist = Math.max(...Object.values(dist), 1);
  if (ratings.length > 0) {
    html += `<div class="card"><h3>Rating distribution</h3><div class="rating-dist">`;
    [...HALF_STARS].reverse().forEach((s) => {
      const count = dist[s];
      const pct = Math.round((count / maxDist) * 100);
      const label = Number.isInteger(s) ? `${s}★` : `${s}★`;
      html += `<div class="dist-row">
        <span class="dist-label muted small">${esc(label)}</span>
        <div class="dist-bar-wrap"><div class="dist-bar" style="width:${pct}%"></div></div>
        <span class="dist-count muted small">${count || ""}</span>
      </div>`;
    });
    html += `</div></div>`;
  }

  if (board.length) {
    html += `<div class="card"><h3>Film leaderboard</h3><ol class="leaderboard">`;
    board.forEach((m) => {
      html += `<li><span class="lb-title">${esc(m.title)}</span> ${starsHtml(Math.round(m.a * 2) / 2)} <span class="lb-score">${fmt(m.a)} (${m.n})</span></li>`;
    });
    html += `</ol></div>`;
  }

  if (members.length) {
    html += `<div class="card"><h3>Per person</h3><table class="people-table">
      <thead><tr><th>Name</th><th>Added</th><th>Avg given</th><th title="How consistently they rate — lower spread = more predictable">Spread</th><th>Avg received</th></tr></thead><tbody>`;
    perPerson.forEach((p) => {
      html += `<tr>
        <td>${esc(p.name)}</td>
        <td>${p.added}</td>
        <td>${p.given == null ? "—" : fmt(p.given)}</td>
        <td>${p.sd == null ? "—" : `±${fmt(p.sd)}`}</td>
        <td>${p.received == null ? "—" : fmt(p.received)}</td>
      </tr>`;
    });
    html += `</tbody></table>
      <p class="muted small">"Avg received" = average score on films that person added. "Spread" = how consistently they rate (±stars from their own average).</p>
    </div>`;
  }

  // Your take vs the group — films where the current member diverged most from everyone else.
  if (myMemberId) {
    const myScores = {};
    ratings.filter((r) => r.memberId === myMemberId).forEach((r) => (myScores[r.movieId] = r.score));
    const contrarian = watched
      .map((m) => {
        const mine = myScores[m.id];
        if (mine == null) return null;
        const others = otherScores[m.id];
        if (!others || !others.length) return null;
        const groupAvg = avg(others);
        const gap = mine - groupAvg;
        if (Math.abs(gap) < 0.5) return null;
        return { title: m.title, mine, group: groupAvg, gap };
      })
      .filter(Boolean)
      .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
      .slice(0, 4);
    if (contrarian.length >= 2) {
      html += `<div class="card"><h3>Your take vs the group</h3>`;
      contrarian.forEach((c) => {
        const sign = c.gap > 0 ? "+" : "";
        html += `<p class="meta-line"><b>${esc(c.title)}</b> — you gave ${fmt(c.mine)}★, others avg ${fmt(c.group)}★ <span class="muted small">(${sign}${fmt(c.gap)})</span></p>`;
      });
      html += `</div>`;
    }
  }

  // Taste compatibility: average half-star gap between each pair of members on
  // the films they BOTH rated (needs ≥2 shared films to count).
  const byMember = {};
  ratings.forEach((r) => { (byMember[r.memberId] ||= {})[r.movieId] = r.score; });
  const nameOf = Object.fromEntries(members.map((m) => [m.id, m.name || "Someone"]));
  const mids = members.map((m) => m.id);
  const pairs = [];
  for (let i = 0; i < mids.length; i++) {
    for (let j = i + 1; j < mids.length; j++) {
      const a = byMember[mids[i]] || {}, b = byMember[mids[j]] || {};
      const common = Object.keys(a).filter((mv) => mv in b);
      if (common.length < 2) continue;
      pairs.push({
        a: nameOf[mids[i]], b: nameOf[mids[j]], n: common.length,
        gap: avg(common.map((mv) => Math.abs(a[mv] - b[mv]))),
      });
    }
  }
  if (pairs.length) {
    const closest = pairs.reduce((x, y) => (y.gap < x.gap ? y : x));
    const farthest = pairs.reduce((x, y) => (y.gap > x.gap ? y : x));
    html += `<div class="card"><h3>Taste matches</h3>`;
    html += `<p class="meta-line"><b>Most in sync:</b> ${esc(closest.a)} &amp; ${esc(closest.b)} <span class="muted">(${fmt(closest.gap)}★ apart over ${closest.n})</span></p>`;
    if (pairs.length > 1 && farthest !== closest) {
      html += `<p class="meta-line"><b>Biggest clash:</b> ${esc(farthest.a)} &amp; ${esc(farthest.b)} <span class="muted">(${fmt(farthest.gap)}★ apart over ${farthest.n})</span></p>`;
    }
    html += `</div>`;
  }

  // Genre avg scores — which genres the club rates highest/lowest (needs ≥2 films per genre).
  const genreScores = {};
  watched.forEach((m) => {
    const scores = scoresFor[m.id];
    if (!scores || !m.genres || !m.genres.length) return;
    const filmAvg = avg(scores);
    m.genres.forEach((g) => (genreScores[g] ||= []).push(filmAvg));
  });
  const genreAvgs = Object.entries(genreScores)
    .filter(([, s]) => s.length >= 2)
    .map(([g, s]) => ({ genre: g, avg: avg(s), n: s.length }))
    .sort((a, b) => b.avg - a.avg);

  // Decade avg scores — which era the club rates highest (needs ≥2 films per decade).
  const decadeScores = {};
  watched.forEach((m) => {
    const y = parseInt(m.year, 10);
    const scores = scoresFor[m.id];
    if (isNaN(y) || !scores) return;
    const d = Math.floor(y / 10) * 10;
    (decadeScores[d] ||= []).push(avg(scores));
  });
  const decadeAvgs = Object.entries(decadeScores)
    .filter(([, s]) => s.length >= 2)
    .map(([d, s]) => ({ decade: Number(d), avg: avg(s), n: s.length }))
    .sort((a, b) => b.avg - a.avg);

  if (totalMins > 0 || topGenres.length || decades.length || genreAvgs.length || decadeAvgs.length) {
    html += `<div class="card"><h3>Watch habits</h3>`;
    if (totalMins > 0) {
      html += `<p class="meta-line"><b>${hoursMins(totalMins)}</b> of films watched`;
      if (withRuntime.length) html += ` &middot; averaging <b>${Math.round(totalMins / withRuntime.length)} min</b>`;
      html += `</p>`;
    }
    if (topGenres.length) {
      html += `<p class="meta-line"><span class="muted small">Top genres (by count)</span><br>${topGenres
        .map(([g, n]) => `${esc(g)} <span class="muted">(${n})</span>`)
        .join("  &middot;  ")}</p>`;
    }
    if (genreAvgs.length) {
      html += `<p class="meta-line"><span class="muted small">Highest rated genre</span><br>`;
      html += `${esc(genreAvgs[0].genre)} <span class="muted">${fmt(genreAvgs[0].avg)}★ avg over ${genreAvgs[0].n} films</span>`;
      if (genreAvgs.length > 1) {
        const worst = genreAvgs[genreAvgs.length - 1];
        html += ` &middot; <span class="muted small">lowest:</span> ${esc(worst.genre)} <span class="muted">${fmt(worst.avg)}★</span>`;
      }
      html += `</p>`;
    }
    if (decades.length) {
      html += `<p class="meta-line"><span class="muted small">By decade (films watched)</span><br>${decades
        .map(([d, n]) => `${d}s <span class="muted">(${n})</span>`)
        .join("  &middot;  ")}</p>`;
    }
    if (decadeAvgs.length) {
      html += `<p class="meta-line"><span class="muted small">Highest rated era</span><br>`;
      html += `${decadeAvgs[0].decade}s <span class="muted">${fmt(decadeAvgs[0].avg)}★ avg over ${decadeAvgs[0].n} films</span>`;
      if (decadeAvgs.length > 1) {
        const worst = decadeAvgs[decadeAvgs.length - 1];
        html += ` &middot; <span class="muted small">lowest:</span> ${worst.decade}s <span class="muted">${fmt(worst.avg)}★</span>`;
      }
      html += `</p>`;
    }
    html += `</div>`;
  }

  // Wheel wait times — how long each film has been waiting to be spun.
  const now = Date.now();
  const wheelWaiting = onWheel
    .filter((m) => m.addedAt)
    .map((m) => ({ title: m.title, days: Math.floor((now - tms(m.addedAt)) / 86400000) }))
    .sort((a, b) => b.days - a.days);
  if (wheelWaiting.length) {
    const avgWait = Math.round(avg(wheelWaiting.map((m) => m.days)));
    html += `<div class="card"><h3>Wheel wait times</h3>`;
    if (wheelWaiting[0].days > 0) {
      html += `<p class="meta-line"><b>Longest waiting:</b> ${esc(wheelWaiting[0].title)} <span class="muted">(${wheelWaiting[0].days} day${wheelWaiting[0].days !== 1 ? "s" : ""})</span></p>`;
    }
    if (wheelWaiting.length > 1) {
      html += `<p class="meta-line"><span class="muted small">Average time on the wheel: ${avgWait} day${avgWait !== 1 ? "s" : ""} across ${wheelWaiting.length} film${wheelWaiting.length !== 1 ? "s" : ""}</span></p>`;
    }
    html += `</div>`;
  }

  // Recent activity, newest first, from films added/finished and ratings given.
  const titleOf = Object.fromEntries(movies.map((m) => [m.id, m.title]));
  const events = [];
  movies.forEach((m) => {
    if (m.addedAt) events.push({ t: tms(m.addedAt), text: `${esc(m.addedByName || "Someone")} added <b>${esc(m.title)}</b>` });
    if (m.status === "watched" && m.watchedAt) events.push({ t: tms(m.watchedAt), text: `<b>${esc(m.title)}</b> finished — reviews revealed` });
  });
  ratings.forEach((r) => {
    events.push({ t: tms(r.updatedAt), text: `${esc(r.name || "Someone")} rated <b>${esc(titleOf[r.movieId] || "a film")}</b> ${fmt(r.score)}★` });
  });
  const recent = events.filter((e) => e.t > 0).sort((a, b) => b.t - a.t).slice(0, 8);
  if (recent.length) {
    html += `<div class="card"><h3>Recent activity</h3><ul class="activity">`;
    recent.forEach((e) => { html += `<li>${e.text} <span class="muted small">${ago(e.t)}</span></li>`; });
    html += `</ul></div>`;
  }

  if (!watched.length && !ratings.length) {
    html += `<p class="muted center">No data yet. Spin the wheel, watch a film, and rate it to see the numbers appear here.</p>`;
  }

  container.innerHTML = html;
}

// Firestore Timestamp / {seconds} -> ms (0 if not yet acked by the server).
function tms(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  return ts.seconds != null ? ts.seconds * 1000 : 0;
}
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d ago` : new Date(ms).toLocaleDateString();
}

function hoursMins(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

function superlative(label, who, detail) {
  return `<div class="superlative"><div class="sup-label">${label}</div><div class="sup-who">${who}</div><div class="sup-detail">${detail}</div></div>`;
}
