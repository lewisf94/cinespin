// ============================================================================
//  Groups: create / join by code (Kahoot-style), members & turn rotation
// ============================================================================

import {
  db,
  doc,
  collection,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  serverTimestamp,
  runTransaction,
  arrayUnion,
  writeBatch,
} from "./firebase.js";
import { getMemberId, getName } from "./session.js";

// Unambiguous alphabet — no 0/O, 1/I to avoid confusion when sharing codes.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomCode(len = 5) {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return s;
}

export function normaliseCode(code) {
  return (code || "").trim().toUpperCase();
}

// Create a brand-new group; returns its share code.
export async function createGroup(groupName) {
  const memberId = getMemberId();
  const name = getName();

  let code = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = randomCode();
    const snap = await getDoc(doc(db, "groups", candidate));
    if (!snap.exists()) {
      code = candidate;
      break;
    }
  }
  if (!code) throw new Error("Couldn't generate a free code — please try again.");

  await setDoc(doc(db, "groups", code), {
    name: (groupName || "").trim() || "Film Club",
    createdAt: serverTimestamp(),
    createdByName: name,
    memberOrder: [memberId],
    currentSpinnerIndex: 0,
    currentFilm: null,
    lastSpin: null,
  });
  await setDoc(doc(db, "groups", code, "members", memberId), {
    name,
    joinedAt: serverTimestamp(),
  });
  return code;
}

// Join an existing group by code. Also used to refresh your name on return.
export async function joinGroup(rawCode) {
  const code = normaliseCode(rawCode);
  const memberId = getMemberId();
  const name = getName();
  const groupRef = doc(db, "groups", code);

  const snap = await getDoc(groupRef);
  if (!snap.exists()) throw new Error("No group found with that code.");

  // Upsert our member record (keeps name fresh on every join).
  await setDoc(
    doc(db, "groups", code, "members", memberId),
    { name, joinedAt: serverTimestamp() },
    { merge: true }
  );

  // Append to the rotation only if we're new to this group.
  await runTransaction(db, async (tx) => {
    const g = await tx.get(groupRef);
    const order = g.data().memberOrder || [];
    if (!order.includes(memberId)) {
      tx.update(groupRef, { memberOrder: [...order, memberId] });
    }
  });
  return code;
}

// Whose turn is it to spin? Returns the memberId, or null if no members yet.
export function currentSpinnerId(group) {
  const order = group?.memberOrder || [];
  if (order.length === 0) return null;
  const raw = group.currentSpinnerIndex || 0;
  const i = ((raw % order.length) + order.length) % order.length;
  return order[i];
}

// Update this group's display name.
export async function renameGroup(code, newName) {
  await updateDoc(doc(db, "groups", code), { name: (newName || "").trim() || "Film Club" });
}

// ---- group reset (requires unanimous approval) -----------------------------
// A member proposes a reset; it only actually happens once EVERY current member
// has approved. Anyone declining (or the proposer cancelling) clears it.

export async function requestReset(code, memberId, name) {
  await updateDoc(doc(db, "groups", code), {
    resetRequest: {
      startedBy: memberId,
      startedByName: name || "",
      startedAt: Date.now(),
      approvals: [memberId], // the proposer approves by definition
    },
  });
}

// Add my approval (only if a request is still open).
export async function approveReset(code, memberId) {
  const ref = doc(db, "groups", code);
  await runTransaction(db, async (tx) => {
    const rr = (await tx.get(ref)).data()?.resetRequest;
    if (!rr) return;
    const approvals = Array.from(new Set([...(rr.approvals || []), memberId]));
    tx.update(ref, { resetRequest: { ...rr, approvals } });
  });
}

// Decline / cancel — clears the whole request.
export async function cancelReset(code) {
  await updateDoc(doc(db, "groups", code), { resetRequest: null });
}

// Wipe the club's films, ratings and history; keep members and the code.
// Run once everyone has approved. Idempotent enough for our needs.
export async function performReset(code) {
  const [moviesSnap, ratingsSnap] = await Promise.all([
    getDocs(collection(db, "groups", code, "movies")),
    getDocs(collection(db, "groups", code, "ratings")),
  ]);
  const batch = writeBatch(db);
  moviesSnap.forEach((d) => batch.delete(d.ref));
  ratingsSnap.forEach((d) => batch.delete(d.ref));
  batch.update(doc(db, "groups", code), {
    currentFilm: null,
    lastSpin: null,
    currentSpinnerIndex: 0,
    resetRequest: null,
  });
  await batch.commit();
}
