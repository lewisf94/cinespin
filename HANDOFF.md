# Spinema — status & handoff

_A snapshot for picking up in a fresh chat/session. The living backlog is in
[ROADMAP.md](./ROADMAP.md); the technical reference is in
[ARCHITECTURE.md](./ARCHITECTURE.md); end-user setup is in [README.md](./README.md)._

**Last updated:** 2026-06-21.

## Where things stand

- **Live:** static site on GitHub Pages at <https://lewisf94.github.io/spinema/>.
  The repo was renamed `cinewheel` → `spinema`; the app uses **relative paths**,
  so the URL prefix doesn't matter.
- **Backend:** Firebase project **`cinewheel-79636`** — kept on purpose (it's an
  internal id, never shown to users; **do NOT rename it**). Config in `js/firebase.js`.
- **Code:** the whole prioritized roadmap (P0–P3) plus several P4 features are
  built and pushed to `main` and `claude/blissful-fermi-lqvvx1`.

## On now (live / enabled)

- **TMDB** metadata — title autocomplete, posters, year/runtime/genres,
  "where to watch", richer stats. The API key is set in `js/tmdb.js`.
- **PWA** (installable + offline shell), the **accessibility** pass,
  **single-writer** finalize/reset, **serverTimestamp ordering**, and
  **render coalescing** — all live and additive.

## Off by default (code is ready; flip when you want)

- **App Check** (#5) — set `recaptchaV3SiteKey` in `js/firebase.js`.
- **Cloud Functions** server-authoritative mode (#8) — set `useFunctions = true`
  in `js/firebase.js`, deploy `functions/`, publish `functions/firestore.rules`.
  Needs the Blaze plan. See `functions/README.md`.
- **Email-link portable identity** (#9) — enable the Email-link provider in the
  Firebase console (README step 5).

## Needs YOU (console actions — I can't reach your Firebase project)

1. **CRITICAL — publish the member-locked `firestore.rules`** in the Firebase
   console (Firestore → Rules → Publish). Until then the live database still runs
   the old permissive rules. Test in the emulator first; the uid-recording client
   is already live, so have everyone **re-join once** after publishing.
2. Optional, when wanted: enable App Check, the Email-link provider,
   anonymous-account auto-cleanup, an API-key HTTP-referrer restriction, and/or
   deploy the Cloud Functions. README + ROADMAP have the click-by-click.

## Still to build (details + reasoning in ROADMAP.md)

- **#17 ranked-choice vote mode** — needs product decisions first: replace the
  spin or run alongside it? which voting method? client- or function-tabulated?
- **#19 web push reminders** — needs FCM/VAPID keys + console setup.
- **#21 nice-to-haves** — live presence, per-film discussion threads, season recap.
- **Deferred:** #11 deeper read-cost refactor (archive split — wants emulator
  testing), #12 `count()` (N/A for this design). Render coalescing for #11 is done.

## Conventions to keep (don't regress)

- Commits authored **and** committed as **lewisf94**
  (`85638536+lewisf94@users.noreply.github.com`) — the real email must not appear.
- **No build step** for the front end (the optional `functions/` backend is a
  separate Node deploy and doesn't touch the static site).
- **No emojis** in the UI. Escape user input with the local `esc()` helper.
- Themes are per-user (localStorage), never in Firestore. Three only:
  `a24` (Default), `festival` (Cinema), `strokes` (Web 1.0).
- Develop on **`claude/blissful-fermi-lqvvx1`**; Pages serves **`main`**; keep
  both in sync. (After the repo rename, a sandbox git proxy may 503 when pushing
  to `main` via the old name — merge the branch into `main` on GitHub instead.)
