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

// Optional Firebase App Check (reCAPTCHA v3): anti-abuse defense-in-depth so
// only your real site can reach Firebase, even though the API key is public.
// OFF by default — leave this blank and nothing changes (the App Check SDK
// isn't even fetched, so there's zero cost until you turn it on). To enable:
// register the site in the Firebase console (App Check -> reCAPTCHA v3), paste
// the SITE key below, then start enforcement in "monitor" mode and flip to
// enforce once traffic looks clean. See README.md.
const recaptchaV3SiteKey = "";

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
  enableAppCheck(app);
  auth = getAuth(app);
  db = getFirestore(app);
}

// App Check is opt-in: only when a site key is set do we lazy-load its SDK and
// initialise it, so the default build pays nothing for a feature that's off.
function enableAppCheck(firebaseApp) {
  if (!recaptchaV3SiteKey) return;
  import("https://www.gstatic.com/firebasejs/12.15.0/firebase-app-check.js")
    .then(({ initializeAppCheck, ReCaptchaV3Provider }) =>
      initializeAppCheck(firebaseApp, {
        provider: new ReCaptchaV3Provider(recaptchaV3SiteKey),
        isTokenAutoRefreshEnabled: true,
      })
    )
    .catch((e) => console.error("App Check failed to initialise:", e));
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
