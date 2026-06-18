// ============================================================================
//  Movies: the wheel list, the spin result, and the watched flow
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
  Timestamp,
} from "./firebase.js";
import { getMemberId, getName } from "./session.js";

export async function addMovie(code, title) {
  const t = (title || "").trim();
  if (!t) return;
  await addDoc(collection(db, "groups", code, "movies"), {
    title: t,
    addedByName: getName(),
    addedByMemberId: getMemberId(),
    addedAt: serverTimestamp(),
    status: "wheel",
    pickedAt: null,
    watchedAt: null,
    deadline: null,
  });
}

// Remove a not-yet-watched movie from the wheel.
export async function removeMovie(code, movieId) {
  await deleteDoc(doc(db, "groups", code, "movies", movieId));
}

// Record the result of a spin. The wheel `segments` + `winnerIndex` are stored
// in lastSpin so every connected browser animates the exact same wheel, even
// though the winner immediately leaves the "wheel" status. currentFilm is the
// authoritative film-of-the-week (set straight away so late joiners still see
// it); lastSpin just drives the one-off animation overlay.
export async function commitSpin(code, segments, winnerIndex, spinnerName, deadlineDate) {
  const winner = segments[winnerIndex];
  const deadline = Timestamp.fromDate(deadlineDate);
  const now = Timestamp.now();
  const stamp = Date.now();

  await updateDoc(doc(db, "groups", code, "movies", winner.id), {
    status: "current",
    pickedAt: serverTimestamp(),
    deadline,
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
      durationMs: 6000,
      segments: segments.map((s) => ({ id: s.id, title: s.title })),
      winnerIndex,
      spinnerName: spinnerName || "",
    },
  });
}

// Adjust the watch-by deadline for the current film.
export async function setDeadline(code, movieId, date) {
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

// Mark the current film watched, clear it, and advance the turn to the next
// person in join order — all atomically.
export async function markWatched(code, movieId) {
  const groupRef = doc(db, "groups", code);
  await runTransaction(db, async (tx) => {
    const g = await tx.get(groupRef);
    const data = g.data();
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
