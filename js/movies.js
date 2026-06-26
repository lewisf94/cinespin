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
export async function startVote(code, memberId, name, shortlist) {
  await updateDoc(doc(db, "groups", code), {
    vote: {
      startedBy: memberId, startedByName: name || "", startedAt: Date.now(),
      shortlist: Array.isArray(shortlist) ? shortlist : [],
      ballots: {},
    },
  });
}
export async function submitBallot(code, memberId, movieIds) {
  await updateDoc(doc(db, "groups", code), {
    ["vote.ballots." + memberId]: Array.isArray(movieIds) ? movieIds : [],
  });
}
export async function cancelVote(code) {
  await updateDoc(doc(db, "groups", code), { vote: null });
}
export async function commitVoteWinner(code, winner, deadlineDate, spinnerName) {
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
        addedByName: winner.addedByName || "", spinnerName: spinnerName || "",
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
    text: t.slice(0, 1000),
    createdAt: serverTimestamp(),
  });
}
export async function deleteComment(code, commentId) {
  await deleteDoc(doc(db, "groups", code, "comments", commentId));
}

// Vote to drop a not-yet-picked film from the wheel. Idempotent (arrayUnion).
// The app removes the film once everyone except the adder has voted.
export async function voteRemoveMovie(code, movieId, memberId) {
  await updateDoc(doc(db, "groups", code, "movies", movieId), {
    removeVotes: arrayUnion(memberId),
  });
}

// Club-set "where to watch" override (service ids from STREAMING_SERVICES),
// correcting wrong/stale JustWatch data. Pass null to clear it and fall back to
// TMDB; pass [] to say "not on any subscription service".
export async function setMovieServices(code, movieId, serviceIds) {
  await updateDoc(doc(db, "groups", code, "movies", movieId), {
    serviceOverride: Array.isArray(serviceIds) ? serviceIds : null,
  });
}

// Record the result of a spin. The wheel `segments` + `winnerIndex` are stored
// in lastSpin so every connected browser animates the exact same wheel, even
// though the winner immediately leaves the "wheel" status. currentFilm is the
// authoritative film-of-the-week; lastSpin just drives the animation overlay.
// watchedBy starts empty and fills as each member confirms they've watched.
export async function commitSpin(code, segments, winnerIndex, spinnerName, deadlineDate) {
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
      addedByName: winner.addedByName || "",
      spinnerName: spinnerName || "",
      pickedAt: now,
      deadline,
    },
    lastSpin: {
      seed: stamp,
      startedAt: stamp,
      durationMs: 8500, // spin length — long enough to build a bit of tension
      segments: segments.map((s) => ({ id: s.id, title: s.title })),
      winnerIndex,
      spinnerName: spinnerName || "",
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
