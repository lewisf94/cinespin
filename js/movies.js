// ============================================================================
//  Films: the wheel list, the spin result, and the watch + finish flow
// ============================================================================

import {
  db,
  doc,
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  runTransaction,
  arrayUnion,
  Timestamp,
  useFunctions,
  callFunction,
} from "./firebase.js";
import { getMemberId, getName, getUid } from "./session.js";

// `meta` is optional TMDB metadata (tmdbId, year, posterPath, runtime, genres).
export async function addMovie(code, title, meta = null) {
  const t = (title || "").trim();
  if (!t) return;
  const data = {
    title: t,
    addedByName: getName(),
    addedByMemberId: getMemberId(),
    addedAt: serverTimestamp(),
    status: "wheel",
    pickedAt: null,
    watchedAt: null,
    deadline: null,
  };
  if (meta) {
    if (meta.tmdbId) data.tmdbId = meta.tmdbId;
    if (meta.year) data.year = String(meta.year);
    if (meta.posterPath) data.posterPath = meta.posterPath;
    if (typeof meta.runtime === "number") data.runtime = meta.runtime;
    if (Array.isArray(meta.genres) && meta.genres.length) data.genres = meta.genres;
    data.tmdbFetchedAt = serverTimestamp();
  }
  await addDoc(collection(db, "groups", code, "movies"), data);
}

// Remove a not-yet-picked film from the wheel.
export async function removeMovie(code, movieId) {
  await deleteDoc(doc(db, "groups", code, "movies", movieId));
}

// ---- approval voting: an alternative to the spin ---------------------------
// The current spinner opens a vote; everyone ticks the films they'd watch; the
// film with the most approvals becomes the week's pick (no wheel animation).
// These five (plus voteRemoveMovie/setMovieServices below) route through
// Cloud Functions when useFunctions is on — see functions/index.js. Until this
// was added (SH-9), turning on server-authoritative mode silently broke voting.
export async function startVote(code, memberId, name, shortlist) {
  const list = Array.isArray(shortlist) ? shortlist : [];
  if (useFunctions) {
    await callFunction("startVote", { code, shortlist: list });
    return;
  }
  await updateDoc(doc(db, "groups", code), {
    vote: {
      // Only the starter's member id — names are resolved from the member-locked
      // subcollection at render, so they don't leak via the world-readable group doc.
      startedBy: memberId, startedAt: Date.now(),
      shortlist: list,
      ballots: {},
    },
  });
}
export async function submitBallot(code, memberId, movieIds) {
  const picks = Array.isArray(movieIds) ? movieIds : [];
  if (useFunctions) {
    await callFunction("submitBallot", { code, movieIds: picks });
    return;
  }
  await updateDoc(doc(db, "groups", code), {
    ["vote.ballots." + memberId]: picks,
  });
}
export async function cancelVote(code) {
  if (useFunctions) {
    await callFunction("cancelVote", { code });
    return;
  }
  await updateDoc(doc(db, "groups", code), { vote: null });
}
// `winner`/`deadlineDate`/`spinnerMemberId` are only used in client-trusted
// mode — in server-authoritative mode the function independently tallies the
// ballots itself (the winner is meaningful, unlike the spin's randomness, so
// it isn't trusted from whichever client's fallback timer happens to fire).
export async function commitVoteWinner(code, winner, deadlineDate, spinnerMemberId) {
  if (useFunctions) {
    await callFunction("commitVoteWinner", { code });
    return;
  }
  const deadline = Timestamp.fromDate(deadlineDate);
  const now = Timestamp.now();
  await runTransaction(db, async (tx) => {
    const groupRef = doc(db, "groups", code);
    const g = (await tx.get(groupRef)).data() || {};
    if (!g.vote || g.currentFilm) return; // already resolved by someone else
    tx.update(doc(db, "groups", code, "movies", winner.id), {
      status: "current", pickedAt: serverTimestamp(), deadline, watchedBy: [],
    });
    tx.update(groupRef, {
      currentFilm: {
        movieId: winner.id, title: winner.title,
        spinnerMemberId: spinnerMemberId || "", // id not name — see commitSpin
        pickedAt: now, deadline,
      },
      vote: null,
    });
  });
}

// ---- per-film discussion (comments revealed with the reviews) --------------
export async function postComment(code, movieId, text) {
  const t = (text || "").trim();
  if (!t) return;
  await addDoc(collection(db, "groups", code, "comments"), {
    movieId,
    memberId: getMemberId(),
    uid: getUid(),
    name: getName(),
    text: t.slice(0, 2000),
    createdAt: serverTimestamp(),
  });
}
export async function deleteComment(code, commentId) {
  await deleteDoc(doc(db, "groups", code, "comments", commentId));
}

// Vote to drop a not-yet-picked film from the wheel. Idempotent (arrayUnion).
// The app removes the film once everyone except the adder has voted. In
// server-authoritative mode the function adds ONLY the caller (like
// markWatched) — memberId here is only used in client-trusted mode.
export async function voteRemoveMovie(code, movieId, memberId) {
  if (useFunctions) {
    await callFunction("voteRemoveMovie", { code, movieId });
    return;
  }
  await updateDoc(doc(db, "groups", code, "movies", movieId), {
    removeVotes: arrayUnion(memberId),
  });
}

// Club-set "where to watch" override (service ids from STREAMING_SERVICES),
// correcting wrong/stale JustWatch data. Pass null to clear it and fall back to
// TMDB; pass [] to say "not on any subscription service".
export async function setMovieServices(code, movieId, serviceIds) {
  const ids = Array.isArray(serviceIds) ? serviceIds : null;
  if (useFunctions) {
    await callFunction("setMovieServices", { code, movieId, serviceIds: ids });
    return;
  }
  await updateDoc(doc(db, "groups", code, "movies", movieId), {
    serviceOverride: ids,
  });
}

// Record the result of a spin. The wheel `segments` + `winnerIndex` are stored
// in lastSpin so every connected browser animates the exact same wheel, even
// though the winner immediately leaves the "wheel" status. currentFilm is the
// authoritative film-of-the-week; lastSpin just drives the animation overlay.
// watchedBy starts empty and fills as each member confirms they've watched.
export async function commitSpin(code, segments, winnerIndex, spinnerMemberId, deadlineDate) {
  if (useFunctions) {
    await callFunction("commitSpin", {
      code,
      segments: segments.map((s) => ({ id: s.id, title: s.title, addedByName: s.addedByName || "" })),
      winnerIndex,
      deadlineMs: deadlineDate.getTime(),
    });
    return;
  }
  const winner = segments[winnerIndex];
  const deadline = Timestamp.fromDate(deadlineDate);
  const now = Timestamp.now();
  const stamp = Date.now();

  await updateDoc(doc(db, "groups", code, "movies", winner.id), {
    status: "current",
    pickedAt: serverTimestamp(),
    deadline,
    watchedBy: [],
  });
  await updateDoc(doc(db, "groups", code), {
    currentFilm: {
      movieId: winner.id,
      title: winner.title,
      // Store the spinner's member id, not their name. The group doc is readable
      // by any signed-in user (needed to look a club up by code), so a denormalised
      // name would leak; names are resolved from the member-locked subcollection
      // at render. addedBy is resolved from the (member-locked) movie doc.
      spinnerMemberId: spinnerMemberId || "",
      pickedAt: now,
      deadline,
    },
    lastSpin: {
      seed: stamp,
      startedAt: stamp,
      durationMs: 11500, // spin length — a long, drawn-out settle to build tension
      segments: segments.map((s) => ({ id: s.id, title: s.title })),
      winnerIndex,
    },
  });
}

// Adjust the watch-by deadline for the current film.
export async function setDeadline(code, movieId, date) {
  if (useFunctions) {
    await callFunction("setDeadline", { code, movieId, deadlineMs: date.getTime() });
    return;
  }
  const deadline = Timestamp.fromDate(date);
  await updateDoc(doc(db, "groups", code, "movies", movieId), { deadline });
  await runTransaction(db, async (tx) => {
    const groupRef = doc(db, "groups", code);
    const g = await tx.get(groupRef);
    const cf = g.data().currentFilm;
    if (cf && cf.movieId === movieId) {
      tx.update(groupRef, { currentFilm: { ...cf, deadline } });
    }
  });
}

// Record that THIS member has watched the current film. Idempotent.
export async function markWatchedAck(code, movieId, memberId) {
  if (useFunctions) {
    // The server adds the caller (by their auth uid), ignoring memberId.
    await callFunction("markWatched", { code, movieId });
    return;
  }
  await updateDoc(doc(db, "groups", code, "movies", movieId), {
    watchedBy: arrayUnion(memberId),
  });
}

// Finish the round: move the film into history (which reveals everyone's
// reviews), clear the film-of-the-week, and advance the turn to the next
// person. Idempotent and transactional, so it's safe even if several browsers
// trigger it at the same moment, or after it has already happened.
export async function finalizeRound(code, movieId, force = false) {
  if (useFunctions) {
    // The server enforces "everyone watched and rated" (or spinner force).
    await callFunction("finalizeRound", { code, movieId, force });
    return;
  }
  const groupRef = doc(db, "groups", code);
  await runTransaction(db, async (tx) => {
    const g = await tx.get(groupRef);
    const data = g.data();
    if (!data || !data.currentFilm || data.currentFilm.movieId !== movieId) return;
    const order = data.memberOrder || [];
    const nextIndex = order.length
      ? ((data.currentSpinnerIndex || 0) + 1) % order.length
      : 0;
    tx.update(doc(db, "groups", code, "movies", movieId), {
      status: "watched",
      watchedAt: serverTimestamp(),
    });
    tx.update(groupRef, { currentFilm: null, currentSpinnerIndex: nextIndex });
  });
}

// Refresh TMDB metadata on a movie doc to comply with the TMDB 6-month cache
// limit. Writes only the fields that change plus a fresh tmdbFetchedAt stamp.
export async function refreshMovieTmdbMeta(code, movieId, meta) {
  const data = { tmdbFetchedAt: serverTimestamp() };
  if (meta.year) data.year = String(meta.year);
  if (meta.posterPath) data.posterPath = meta.posterPath;
  if (typeof meta.runtime === "number") data.runtime = meta.runtime;
  if (Array.isArray(meta.genres) && meta.genres.length) data.genres = meta.genres;
  await updateDoc(doc(db, "groups", code, "movies", movieId), data);
}
