// ============================================================================
//  Session: who am I on this browser?
// ----------------------------------------------------------------------------
//  No login. We keep a stable, random memberId + a display name in
//  localStorage so the browser remembers you, and we sign in anonymously so
//  Firestore security rules can block the open internet.
// ============================================================================

import { auth, signInAnonymously, onAuthStateChanged, isConfigured } from "./firebase.js";

const MEMBER_ID_KEY = "spinema_member_id";
const NAME_KEY = "spinema_name";
const LAST_GROUP_KEY = "spinema_last_group";

// One-time migration: copy any legacy "cinewheel_" localStorage keys to the new
// "spinema_" names so existing browsers keep their identity, name and last group.
try {
  const old = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.indexOf("cinewheel_") === 0) old.push(k);
  }
  old.forEach((k) => {
    const nk = "spinema_" + k.slice(10);
    if (localStorage.getItem(nk) === null) localStorage.setItem(nk, localStorage.getItem(k));
  });
} catch (_) {}

export function getMemberId() {
  let id = localStorage.getItem(MEMBER_ID_KEY);
  if (!id) {
    id =
      "m_" +
      (crypto.randomUUID
        ? crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2));
    localStorage.setItem(MEMBER_ID_KEY, id);
  }
  return id;
}

export function getName() {
  return localStorage.getItem(NAME_KEY) || "";
}

export function setName(name) {
  localStorage.setItem(NAME_KEY, (name || "").trim());
}

export function getLastGroup() {
  return localStorage.getItem(LAST_GROUP_KEY) || "";
}

export function setLastGroup(code) {
  if (code) localStorage.setItem(LAST_GROUP_KEY, code);
  else localStorage.removeItem(LAST_GROUP_KEY);
}

let authPromise = null;

// Resolves (once) when anonymous auth is ready. Cached so it only runs once.
export function ensureAuth() {
  if (authPromise) return authPromise;
  authPromise = new Promise((resolve, reject) => {
    if (!isConfigured) {
      reject(new Error("Firebase is not configured yet."));
      return;
    }
    onAuthStateChanged(auth, (user) => {
      if (user) resolve(user);
    });
    signInAnonymously(auth).catch(reject);
  });
  return authPromise;
}
