# CineWheel — project guide

CineWheel is a **film-club** web app: a group adds films to a wheel, takes turns
spinning to pick the week's film, sets a watch-by deadline, then everyone marks
it watched and leaves a (sealed) half-star rating + review. Reviews unseal and
the turn passes only once **every** member has watched **and** rated.

It's a **static site** — plain HTML/CSS/vanilla JS, **no build step** — backed by
**Firebase** (Cloud Firestore + Anonymous Auth), deployed on GitHub Pages.

- Live: https://lewisf94.github.io/CineWheel/
- Technical / data-model reference: [ARCHITECTURE.md](./ARCHITECTURE.md)
- Dev workflow & conventions: [CONTRIBUTING.md](./CONTRIBUTING.md)
- End-user Firebase setup: [README.md](./README.md)

## Run locally

ES modules need a real server (not `file://`):

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

You need a real Firebase web config in `js/firebase.js`, and in the Firebase
console: Firestore created, the rules from `firestore.rules` published, and
**Anonymous** sign-in enabled. See README.md for the click-by-click.

## Layout

| File | Responsibility |
|------|----------------|
| `index.html` | Markup shell: topbar, screens (config/landing/app), tabs, modals |
| `styles.css` | All styling — base + the three themes (`[data-theme]` blocks) + responsive |
| `js/firebase.js` | Firebase init and the **single re-export point** for the SDK + `isConfigured` |
| `js/session.js` | Per-browser identity (`memberId`, name) in `localStorage`; anonymous auth |
| `js/groups.js` | Create/join by code, turn rotation, unanimous group reset |
| `js/movies.js` | Wheel list, spin result, per-member watched acks, round finalize |
| `js/ratings.js` | Half-star widget, read-only stars, saving ratings |
| `js/wheel.js` | Canvas wheel (theme-aware), spin animation, WebAudio sound, confetti |
| `js/stats.js` | Client-side stats from movies + ratings + members |
| `js/theme.js` | Theme switcher (localStorage; fires `cinewheel:themechange`) |
| `js/app.js` | Orchestration: routing, live Firestore subscriptions, rendering, actions |
| `firestore.rules` | Security rules (auth required; group members read/write that group) |

## Conventions (please keep)

- **No build step.** No bundler, no framework. Plain ES modules.
- **One Firebase entry point.** Every module imports Firebase symbols from
  `./firebase.js` (which re-exports the SDK). Never import the gstatic SDK URLs
  elsewhere — add new SDK functions to the import **and** export list there.
- **No emojis** in the UI (deliberate). The `*` star glyph in ratings is fine.
- **Vanilla DOM.** Rendering is `innerHTML` templates + `addEventListener` in
  `app.js`. Escape user input with the local `esc()` helper before interpolating.
- **Themes are per-user** (localStorage `cinewheel_theme`), never in Firestore.
  Three only: `a24` (Default), `festival` (Cinema), `strokes` (Web 1.0). A theme
  is a CSS `[data-theme="…"]` block **plus** a matching branch in `wheelStyle()`
  in `wheel.js`.

## Checks (no test suite)

```bash
# parse-check every module (they import from URLs, so copy to .mjs first)
for f in js/*.js; do cp "$f" /tmp/c.mjs && node --check /tmp/c.mjs || echo "FAIL $f"; done
```

Then click through manually: create/join, add films, spin, mark watched, rate,
reveal, stats, and a reset — across all three themes, desktop + mobile.

## Deploy

GitHub Pages serves `main` at the root; pushing to `main` redeploys to
https://lewisf94.github.io/CineWheel/ within ~a minute. `.nojekyll` stops Pages
from ignoring the `js/` folder.
