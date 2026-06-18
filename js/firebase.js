// ============================================================================
//  Firebase initialisation for CineWheel
// ----------------------------------------------------------------------------
//  This is the ONLY file you need to edit to connect your own Firebase project.
//  Follow README.md (steps 1–6) to get these values, then paste them below.
// ============================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  serverTimestamp,
  runTransaction,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

// ╔══════════════════════════════════════════════════════════════════════╗
// ║  👇  PASTE YOUR FIREBASE CONFIG HERE  (README.md → step 2)             ║
// ╚══════════════════════════════════════════════════════════════════════╝
const firebaseConfig = {
  apiKey: "REPLACE_ME",
  authDomain: "REPLACE_ME.firebaseapp.com",
  projectId: "REPLACE_ME",
  storageBucket: "REPLACE_ME.appspot.com",
  messagingSenderId: "REPLACE_ME",
  appId: "REPLACE_ME",
};

// True only once every REPLACE_ME above has been swapped for a real value.
export const isConfigured = !Object.values(firebaseConfig).some((v) =>
  String(v).includes("REPLACE_ME")
);

let app, auth, db;
if (isConfigured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
}

// Re-export everything the rest of the app needs, so other modules import from
// one place and we never mismatch SDK versions.
export {
  app,
  auth,
  db,
  signInAnonymously,
  onAuthStateChanged,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  serverTimestamp,
  runTransaction,
  Timestamp,
};
