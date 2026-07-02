# CineClub — status & handoff

_A snapshot for picking up in a fresh chat/session. The living backlog is in
[ROADMAP.md](./ROADMAP.md); the technical reference is in
[ARCHITECTURE.md](./ARCHITECTURE.md); end-user setup is in [README.md](./README.md)._

**Last updated:** 2026-07-02.

## Naming — three different names, all on purpose

This trips people up, so read it first:

| Thing | Name | Notes |
|-------|------|-------|
| **Brand** (what users see) | **CineClub** | Was "CineSpin" (clashed with an existing app + domain), before that "Spinema" / "cinewheel". Reads as Cine·Club. |
| **GitHub repo** | **`cineclub`** | Renamed from `cinespin` to match the brand (2026-06-27). `thecineclub.co.uk` fronts it. |
| **Firebase project** | **`cinewheel-79636`** | **Do NOT rename** — internal id, never shown to users; renaming breaks the config. |
| **localStorage keys** | `cineclub_*` | Renamed from `cinespin_*` with the CineClub rebrand — no migration (test-only, as with prior renames); existing browsers just re-enter their name once. |

The app uses **relative paths** everywhere (no hardcoded domain/path), and the
live site is the **domain root** `thecineclub.co.uk` (not a `/repo/` subpath), so
the Pages path changing had no effect on the app.

### Repo-rename `cinespin` → `cineclub` — DONE (2026-06-27)

- Pages survived the rename — custom domain `thecineclub.co.uk` with Enforce HTTPS stayed set. ✅
- No Firebase / DNS / reCAPTCHA / API-key changes needed. ✅
- Doc references updated (`README.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `support/index.html`, this file). ✅

## Where things stand

- **Live:** <https://thecineclub.co.uk> — custom domain **fully set up and working** (Fasthosts DNS → GitHub Pages, custom domain + Enforce HTTPS, repo-root `CNAME`). `lewisf94.github.io/cineclub/` redirects to it.
- **Domain migration (2026-06-27) — DONE.** Three console lists were updated so the new domain works, all keyed on `thecineclub.co.uk` (+ `www`): Firebase Auth **Authorized domains**, the reCAPTCHA v3 key's **Domains** (App Check), and the Firebase **API-key HTTP-referrer** allowlist. That last one was the final blocker — anon sign-in is rejected from any referrer not on the list, which surfaced as the generic "Couldn't connect" banner.
- **Backend:** Firebase project `cinewheel-79636` (Firestore + Anonymous Auth + Email-link sign-in). Config in `js/firebase.js`.
- **Code:** all of the prioritized roadmap (P0–P4) plus the 2026-06 feature queue, security hardening, and the 2026-07 UI/UX/perf/security review (see ROADMAP.md's "UI / UX / performance / security review" section, items R-1..R-16) are built and on `main`.

## On now (live / enabled)

- **TMDB** metadata — title autocomplete, posters, year/runtime/genres, "where to watch", richer stats. Key in `js/tmdb.js`.
- **Features:** approval **vote mode** + **vote-a-film-off**, **Letterboxd CSV import**, per-film **discussion comments** (revealed with reviews), **activity feed**, **taste compatibility**, **add-to-calendar (.ics)**, **trailers + recommendations**, **season recap** ("CineClub Wrapped"), **per-film rating histogram**, **spoiler tags**, **dark mode**, themed **stream-filter** pill.
- **PWA** (installable + offline shell), accessibility pass (now including a modal focus-trap, R-13), single-writer finalize/reset, serverTimestamp ordering, render coalescing, **Firestore offline persistence** (R-7 — the last-synced club loads instantly / works offline, not just the app shell) — all live.
- **Joining now requires approval (R-3, was SH-3).** A brand-new uid can no longer add itself just by knowing the code — it files a `joinRequests/{uid}` doc, and any existing member approves or declines it (new "Waiting to be let in" screen + a banner on the app screen for members). Returning members (uid already recognised, e.g. via the portable-identity email-link flow) are unaffected. **Needs the updated `firestore.rules` published** (see "Needs YOU" below) — until then the live DB still runs the old self-join rule.
- **Security (client/code side):** uid-recorded identity, **kicked-member live ejection** (a kicked member is cleanly returned to the landing screen), the join-approval flow above. Member-locked rules + hardening are written (see "Needs YOU").
- **Vendored confetti** (`js/vendor/confetti.browser.js`) instead of a jsDelivr CDN script — no third-party request, covered by the SW precache/offline shell. Same for dropping the old 796 KB `favicon.svg` (turned out to be a rasterized PNG wearing an SVG costume) in favour of the existing adaptive PNG icon.

## Off by default (code is ready; flip when you want)

- **App Check** (SH-1) — set `recaptchaV3SiteKey` in `js/firebase.js`, register the site, monitor → enforce.
- **Cloud Functions** server-authoritative mode — set `useFunctions = true` in `js/firebase.js`, deploy `functions/`, publish `functions/firestore.rules`. Needs Blaze. See `functions/README.md`.
  - **SH-9 is now fixed** — vote/vote-to-remove/service-override all have callables and branch correctly; turning this mode on no longer breaks them.
  - **Also fixed while reviewing scale-readiness:** `kickMember` had no callable at all (same bug class as SH-9 — would have silently broken the admin kick button under this mode). Now added, and it upgrades the invariant too: the function actually checks the caller is the admin server-side, where the client-trusted mode only hides the button in the UI.
  - **One known smaller gap remains:** a wheel movie's delete stays "any member" even in this mode (needed by self-remove + automatic vote-off, which fires from whichever member's browser notices consensus first) — properly restricting that to "adder, or verified vote-off consensus" needs one more callable. See ROADMAP R-5 for detail. Not urgent; movie/rating deletes elsewhere are already fully locked down by this mode.
- **Web push deadline reminders** — scaffolded (`js/push.js`, `firebase-messaging-sw.js`, scheduled `sendDeadlineReminders` function). OFF until a **VAPID key** is set in `js/firebase.js` (`messagingVapidKey`). Needs Blaze + deploy. README step 8.

## Needs YOU (console actions — I can't reach the Firebase project)

1. **CRITICAL — publish the rules (again — they changed for the join-approval flow).** Paste `firestore.rules` into Firebase → Firestore → Rules → Publish. The live DB still runs the **old rules** until you do, so neither the original member-lock + hardening (SH-2/4/6/8) nor the new join-approval requirement (R-3) are enforced yet. **Emulator-test first.** The uid-recording client is live, so have everyone **re-join once** after publishing. Note the behaviour change: after publishing, a brand-new person needs an existing member online to approve their join — make sure at least one member checks the club after sharing an invite. If you've deployed `functions/` + `useFunctions=true`, publish `functions/firestore.rules` instead (also updated with the same join-approval change, plus the vote/kick fixes above).
2. **Email template still says "cinewheel-79636".** Fix: Firebase → Project Settings → General → **Public-facing name** → set to **CineClub** → Save. (The sign-in-link email isn't a directly-editable template; it uses this name. Sender address stays `@cinewheel-79636.firebaseapp.com` unless you set up custom SMTP.)
3. **App Check is on.** reCAPTCHA v3 key live in `js/firebase.js`, **enforced for Cloud Firestore**; Authentication is still in **Monitor** (fine to leave, or enforce later once the new domain shows sustained 100% verified). The **API-key HTTP-referrer** restriction is set and includes `thecineclub.co.uk` + `www`. Remaining optional: anonymous-account auto-cleanup (SH-5).
4. **Email-link sign-in** works and `thecineclub.co.uk` is now in **Authorized domains**. ✅
5. **Legal pages** — operator name set to **Lewis**, contact `hello@thecineclub.co.uk`, governing law *England & Wales*. ✅
6. **Confirm `hello@thecineclub.co.uk` forwarding delivers.** The legal pages point users there — send a test email and check it lands in the Gmail inbox (Fasthosts free forward → `hellocineclub@gmail.com`).

## Still open / next candidates (details in ROADMAP.md)

- **Movie-delete consensus check** — one more Cloud Function (`removeMovie`, mirroring `commitVoteWinner`'s tally-it-yourself pattern) to fully lock down wheel-film deletes under server-authoritative mode to "adder, or real vote-off consensus." See ROADMAP R-5.
- **Rejoin-after-ban, fully** — the join-approval flow (R-3) means a banned member's fresh anonymous identity now needs a human's yes, but isn't cryptographically prevented from asking again under an unfamiliar name. Fully closing it needs a verified identity (email) on every join, which conflicts with the app's "no sign-up" design — accepted trade-off, not an oversight.
- **Deferred:** read-cost refactor (archive split — wants emulator testing); it's fine for small clubs as-is.
- **Optional polish:** new app icon/favicon if you want a "CC"/CineClub mark (current icon is a film-reel).

## Conventions to keep (don't regress)

- Commit straight to **`main`** (no feature branches, no PRs unless asked) — Pages serves `main`. The cloud harness suggests a `claude/…` branch; that's **overridden** — land on `main`.
- Commits authored **and** committed as **Lewis** (`85638536+lewisf94@users.noreply.github.com`).
- **No build step** for the front end (the optional `functions/` backend is a separate Node deploy).
- **No emojis** in the UI. Escape user input with the local `esc()` helper.
- Themes are per-user (localStorage), never in Firestore. Three only: `a24` (Default), `festival` (Cinema), `strokes` (Web 1.0), each with a light/dark `[data-mode]`.
- **One Firebase entry point** (`js/firebase.js` re-exports the SDK) — never import gstatic SDK URLs elsewhere.
