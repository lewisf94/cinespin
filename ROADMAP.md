# Spinema — improvement roadmap

Backlog from the architecture / security / performance review (deep research, 2026-06).
**Target context:** PUBLIC app that could scale; **each club must be locked to its own
members.** Checked = done.

Items tagged **[console]** need Lewis to act in the Firebase console / CLI — I can't reach
your Firebase project from here. I write the code; you deploy.

---

## P0 — Security (critical)

- [x] **1. Record the Firebase auth `uid` as the real identity** (foundation for member-locked rules)
  - store `memberUids: [uid]` on the group doc, `uid` on each member doc, `uid` on each rating
  - files: `js/session.js` (add `getUid`), `js/groups.js`, `js/ratings.js`
  - additive & safe under current rules; lets existing members record a uid on their next visit
- [x] **2. Rewrite `firestore.rules` to member-scoped access** — *written; publish pending (see #3)*
  - `get` allowed, **`list` denied** (no enumerating every club)
  - read/write a club only if `request.auth.uid in group.memberUids`
  - members can only write their **own** rating; can't delete others' data; can't hijack arbitrary clubs
  - constrain the "join" path (you may add only your own uid)
  - `performReset` now chunks deletes (≤15/batch) to stay under the rules' 20 get()/batch ceiling
  - **[console]** publish the rules — **test in the Firebase Emulator first**
- [ ] **3. Safe rollout** — ship step 1 first so members have a uid recorded, *then* publish step 2
  (so existing members aren't locked out). For this test app: re-join once after deploy.
- [ ] **4. [console]** Turn on **anonymous-account auto-cleanup** (deletes anon accounts >30 days; stops
  them counting toward quota/billing).
- [ ] **5. Add Firebase App Check (reCAPTCHA v3)** as anti-abuse defense-in-depth (monitor → enforce).
  **[console + site key]**
- [ ] 6. (optional) Restrict the Web API key by HTTP referrer in Google Cloud (soft layer, not a boundary).

## P1 — Correctness & reliability

- [x] **7. Single-writer finalize/reset** — the round owner (spinner / reset proposer) commits
  immediately; other clients wait `FALLBACK_MS` and only step in if the owner didn't. Kills the
  N-client transaction race (contention → `ABORTED`) with no softlock. (`js/app.js`.) A Cloud
  Function (#8) would make it authoritative.
- [ ] **8. Move privileged invariants server-side (Cloud Function)** — "turn passes only when everyone
  rated", "reset needs unanimity". **[Blaze plan + functions deploy; breaks 'no build step']** — opt-in.
- [ ] **9. Portable identity** — optional email-link sign-in linked onto the anonymous account
  (same uid; data survives a cache wipe / new device). `js/session.js` + small UI.
- [ ] **10. serverTimestamp ordering guard** — handle null-until-server with `metadata.hasPendingWrites`
  or a client-time fallback sort key so fresh items don't jump.

## P2 — Performance & cost

- [ ] **11. Fewer / narrower listeners** — consolidate the 4 `onSnapshot` listeners; consider a
  denormalized "group state" doc; `limit()` history.
- [ ] **12. `count()` aggregation for stats** instead of reading every doc.

## P3 — Architecture

- [ ] **13. Decision:** stay on Firebase, add a thin **Cloud Functions** layer for privileged ops
  (recommended) — vs status quo. (Ties to #7/#8.)

## P4 — Features

- [ ] **14. TMDB** — title autocomplete + posters / year / runtime / genres when adding films
  (requires TMDB logo + attribution).
- [ ] **15. "Where to watch"** (TMDB watch providers; per-item JustWatch attribution required).
- [ ] **16. Accessibility pass** across the 3 themes (contrast, focus rings, keyboard-operable star
  widget + modals, `aria-live` spin result).
- [ ] **17. Ranked-choice "vote" mode** as an alternative to spinning.
- [ ] **18. PWA** (manifest + service worker, offline shell).
- [ ] **19. Web push reminders** (deadline / your turn / reviews unsealed; iOS needs home-screen install).
- [ ] **20. Richer stats** from TMDB metadata (genre, hours, decade).
- [ ] 21. Nice-to-have: live lobby/presence, per-film discussion threads, season recap.

---

## Key sources
- Insecure auth-only rules: https://cloud.google.com/firestore/docs/security/insecure-rules
- Anonymous auth (cleanup, linking): https://firebase.google.com/docs/auth/web/anonymous-auth · https://firebase.blog/posts/2023/07/best-practices-for-anonymous-authentication/
- Rules conditions / membership / list-vs-get: https://firebase.google.com/docs/firestore/security/rules-conditions · https://firebase.google.com/docs/firestore/security/rules-query
- API keys are not secret: https://firebase.google.com/docs/projects/api-keys
- App Check: https://firebase.google.com/docs/app-check/web/recaptcha-provider
- Transactions (contention, idempotency): https://firebase.google.com/docs/firestore/transaction-data-contention · https://firebase.google.com/docs/firestore/manage-data/transactions
- Pricing / listener billing: https://firebase.google.com/pricing · https://docs.cloud.google.com/firestore/native/docs/billing-questions
- Email-link auth: https://firebase.google.com/docs/auth/web/email-link-auth
- TMDB attribution: https://www.themoviedb.org/about/logos-attribution
