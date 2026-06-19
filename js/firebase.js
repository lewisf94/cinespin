// ============================================================================
//  Firebase initialisation for Spinema
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
  arrayUnion,
  writeBatch,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

// Your web app's Firebase configuration.
const firebaseConfig = {
  apiKey: "AIzaSyDzN713jEcl5qKB7vsj9z0fLrda7v8TzQQ",
  authDomain: "cinewheel-79636.firebaseapp.com",
  projectId: "cinewheel-79636",
  storageBucket: "cinewheel-79636.firebasestorage.app",
  messagingSenderId: "456572534465",
  appId: "1:456572534465:web:988135022809e23e771e40",
};

// True once real values (not the placeholders) are filled in above.
export const isConfigured =
  !!firebaseConfig.apiKey &&
  !/REPLACE_ME|YOUR_API_KEY/i.test(firebaseConfig.apiKey) &&
  !!firebaseConfig.projectId;

// Only initialise when configured, so an unconfigured copy shows the setup
// screen instead of throwing at import time.
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
  arrayUnion,
  writeBatch,
  Timestamp,
};
