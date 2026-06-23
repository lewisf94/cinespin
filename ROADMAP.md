# Spinema — improvement roadmap

Backlog from the architecture / security / performance review (deep research, 2026-06).
**Target context:** PUBLIC app that could scale; **each club must be locked to its own
members.** Checked = done.

Items tagged **[console]** need Lewis to act in the Firebase console / CLI — I can't reach
your Firebase project from here. I write the code; you deploy.

---

## Feature requests — queue (2026-06, Lewis)

Working through these; **checked = shipped**. Pure front-end unless noted.

### Picking the film
- [x] **Spin only what everyone can stream** — toggle so the wheel/spin excludes films not on every member's services
- [ ] **Ranked-choice / approval vote mode** — alternative to the random spin *(needs a product decision: replace the spin or run alongside? which method?)*
- [ ] **Vote a film off the wheel** — anyone can flag a wheel film for removal; once **every member except the one who added it** has voted to remove, it's dropped. Same unanimous-consent pattern as the group reset; votes stored on the movie doc.

### Import
- [ ] **Import a Letterboxd watchlist** — upload the exported watchlist CSV (Letterboxd → Settings → Import & Export → Export), show the films with checkboxes (select all / pick a few), then add the chosen ones to the wheel (enriched via TMDB by title+year). Pure front-end (file input + CSV parse + `addMovie`).

### Social / engagement
- [ ] **Discussion thread per film** — comments/reactions on each watched film, unlocked once reviews reveal *(new Firestore subcollection + rules)*
- [ ] **Activity feed** — recent "X added / rated …"
- [x] **Taste compatibility** — who agrees / clashes most, from rating correlations

### Reminders
- [x] **Add-to-calendar (.ics)** for the watch-by deadline
- [ ] **Web push / email deadline nudges** *(needs FCM/VAPID keys + the optional Functions backend)*

### Richer film info (details popup)
- [ ] **Trailer + streaming inline** — "Watch trailer" (TMDB videos) + where-to-watch in the popup
- [ ] **TMDB recommendations** — "if you liked last week's pick…" on the Films tab

### Stats / wrap-up
- [ ] **Season recap ("Spinema Wrapped")** — shareable end-of-cycle summary card
- [x] **Per-film rating breakdown** — half-star histogram on each watched card

### Polish
- [x] **Spoiler tags** in reviews (`||spoiler||`, click-to-reveal)
- [ ] **Dark mode** option for themes

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
- [~] **3. Safe rollout** — *client shipped (steps 1 & the rules file are on `main`); publishing the
  rules is your console step.* Order: the uid-recording client is already live, so now publish
  `firestore.rules` in the console and have everyone re-join once. Locked-out members just re-join.
- [ ] **4. [console]** Turn on **anonymous-account auto-cleanup** (deletes anon accounts >30 days; stops
  them counting toward quota/billing).
- [x] **5. Add Firebase App Check (reCAPTCHA v3)** — *scaffolded; activation pending console*
  - off by default (blank `recaptchaV3SiteKey` in `js/firebase.js`), SDK lazy-loaded only when set,
    so zero cost until enabled; README step 7 has the setup
  - **[console + site key]** register the site, paste the key, run in **monitor** then **enforce**
- [ ] 6. (optional) Restrict the Web API key by HTTP referrer in Google Cloud (soft layer, not a boundary).

## P1 — Correctness & reliability

- [x] **7. Single-writer finalize/reset** — the round owner (spinner / reset proposer) commits
  immediately; other clients wait `FALLBACK_MS` and only step in if the owner didn't. Kills the
  N-client transaction race (contention → `ABORTED`) with no softlock. (`js/app.js`.) A Cloud
  Function (#8) would make it authoritative.
- [x] **8. Move privileged invariants server-side (Cloud Functions)** — *built; deploy pending* —
  callable functions in `functions/` own every shared-state write (spin, set deadline, mark watched,
  finalize, request/approve/cancel reset). Turn passes only when everyone watched+rated; reset wipes
  only on unanimous approval (atomically, inside `approveReset`); you can only mark yourself watched;
  only the spinner spins. **OFF by default** (`useFunctions=false` in `js/firebase.js`; Functions SDK
  lazy-loaded) so the live app is unchanged until you opt in. **[Blaze + `firebase deploy --only
  functions`, flip the flag, publish `functions/firestore.rules`]** — guide in `functions/README.md`.
- [x] **9. Portable identity** — *built; needs the Email-link provider enabled in console* — optional
  "Save your account" (email-link) that links onto the anonymous account in place (same uid), and on a
  new device / cleared browser recovers that uid; `joinGroup` then reclaims your existing seat instead
  of duplicating you. `session.js` + an Account modal. Inert until used. **[console: enable Email link
  provider]** (README step 5).
- [x] **10. serverTimestamp ordering guard** — the wheel/history sorts already fall back to
  `Date.now()` (not `0`) while `serverTimestamp()` is null-until-acked, so fresh items sort as
  "newest" and don't jump when the real value lands. Locked in with a comment so it isn't regressed.

## P2 — Performance & cost

- [~] **11. Fewer / narrower listeners** — *renders coalesced* (`scheduleRender`, `setTimeout(0)`) so a
  burst of the four listeners rebuilds the DOM once, not four times. The deeper read-cost win
  (live-listen only the current round's ratings + load the archive on demand, or a denormalized
  group-state doc) is **documented but deferred** — it reshapes the data flow and wants emulator
  testing before touching the live app; small clubs are fine as-is. (`js/app.js`, ARCHITECTURE.)
- [n/a] **12. `count()` aggregation for stats** — not worth it for this design: the stats need the
  actual ratings/movies (scores, reviews, genres), which the live listeners already load, so an extra
  server-side `count()` query would add reads, not save them. Revisit only alongside #11's archive
  split (where the full history is no longer in memory).

## P3 — Architecture

- [x] **13. Decision:** stay on Firebase + a thin, **optional** Cloud Functions layer for privileged
  ops (built in #8). Off by default to preserve the zero-backend static deploy; opt in for hard
  guarantees. The static front end stays no-build either way.

## P4 — Features

- [x] **14. TMDB** — *built; needs a free key* — title autocomplete + posters in the add-film box;
  picking a result stores year/runtime/genres (shown on the film card, wheel list and history).
  Off by default (blank `TMDB_API_KEY` in `js/tmdb.js`, no requests until set); required attribution
  shown in-app. **[get a free TMDB v3 key]** (README). Genre/runtime now feed richer stats (#20).
- [x] **15. "Where to watch"** — the film-of-the-week card shows streaming providers (TMDB watch
  providers for the browser's region), fetched once per film and cached, with the required JustWatch
  credit + link. Only for TMDB-added films; hidden when there's no data. (`js/tmdb.js`, `js/app.js`.)
- [x] **16. Accessibility pass** — consistent `:focus-visible` rings on every control, keyboard-operable
  half-star widget (focus previews like hover) with group semantics, dialog roles + `aria-modal` +
  Escape-to-close on modals, an `aria-live` region announcing the pick / whose turn, a labelled wheel
  canvas, and a `prefers-reduced-motion` guard. (Deeper per-theme contrast tuning can still follow.)
- [ ] **17. Ranked-choice "vote" mode** as an alternative to spinning.
- [x] **18. PWA** — `manifest.webmanifest` + generated maskable icons + a service worker (`sw.js`):
  installable to a home screen, instant cached shell, offline fallback. The SW only touches
  same-origin GETs (network-first HTML, stale-while-revalidate assets), so Firebase/TMDB are never
  intercepted. Bump `CACHE` in `sw.js` to force-refresh assets.
- [ ] **19. Web push reminders** (deadline / your turn / reviews unsealed; iOS needs home-screen install).
- [x] **20. Richer stats** from TMDB metadata — a "Watch habits" card (total hours + average length,
  top genres, films by decade) that appears on the Stats tab only once watched films carry TMDB
  metadata (#14). Degrades to nothing when absent. (`js/stats.js`.)
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
