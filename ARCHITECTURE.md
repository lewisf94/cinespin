# Architecture

Spinema is a static front end talking directly to Cloud Firestore — there is no
server of our own. Firestore plus its security rules **are** the backend. Every
browser signs in anonymously so the rules can require authentication.

## Data model (Firestore)

```
groups/{code}                         # code = 5-char share code (Kahoot-style)
  name: string
  createdAt, createdByName
  memberOrder: [memberId, ...]        # turn order = join order
  memberUids: [authUid, ...]          # Firebase anon-auth uids = membership (security rules)
  currentSpinnerIndex: number         # whose turn to spin (index into memberOrder)
  currentFilm: {                      # the film in play this week, or null
    movieId, title, addedByName, spinnerName, pickedAt, deadline
  } | null
  lastSpin: { seed, startedAt, durationMs, segments[], winnerIndex, spinnerName } | null
  resetRequest: {                     # unanimous-consent reset, or null
    startedBy, startedByName, startedAt, approvals: [memberId, ...]
  } | null

  members/{memberId}                  # memberId = random id kept in the browser
    name, uid, joinedAt               # uid = Firebase auth uid (for the rules)

  movies/{movieId}
    title, addedByName, addedByMemberId, addedAt
    status: "wheel" | "current" | "watched"
    pickedAt, watchedAt, deadline
    watchedBy: [memberId, ...]        # who confirmed they watched the current film

  ratings/{movieId__memberId}         # one per member per film
    movieId, memberId, uid, name, score (0.5-5), review, updatedAt
```

No login/accounts: identity is a random `memberId` + display name in
`localStorage` (`session.js`). The anonymous-auth `uid` is also recorded on join
(`memberUids` on the group; `uid` on member/rating docs) so the security rules
can lock each club to its own members.

## The weekly round

1. The member at `currentSpinnerIndex` spins (`commitSpin`). The winner becomes
   `currentFilm` (status `current`, `watchedBy: []`); `lastSpin` drives the same
   spin animation in every browser.
2. Each member clicks "I've watched it" (`markWatchedAck` → `arrayUnion` on the
   movie's `watchedBy`) and submits a rating (`saveRating`). Everyone else's
   ratings stay **sealed** in the UI until the round completes.
3. When **every current member is in `watchedBy` AND has a rating**,
   `finalizeRound` runs (an idempotent transaction): the film flips to
   `watched`, `currentFilm` clears, `currentSpinnerIndex` advances. That reveals
   all reviews (the film is now history) and unlocks the next spin.
   - **Single writer:** to avoid every browser racing the same transaction, only
     the **current spinner's** client auto-commits immediately; other clients
     wait `FALLBACK_MS` and step in only if the spinner didn't (e.g. they're
     away). So there's no contention in the common case and no softlock if the
     spinner is gone.
   - The current spinner can also `finalizeRound` early ("wrap up now") if
     someone is away.

The gating logic lives in `app.js` (`roundState`, plus the single-writer
auto-finalize in `render`).

## Group reset (unanimous)

`requestReset` writes `resetRequest` with the proposer pre-approved; `approveReset`
appends approvals; any `cancelReset` (decline/cancel) clears it. Once every member
has approved, `performReset` deletes all `movies` + `ratings` (in chunks of ≤15 so
each batch stays under the security rules' 20-`get()`-per-batch ceiling) and clears
the group's play state (keeping members and the code). The same **single-writer**
pattern as finalize applies — the proposer commits the wipe, others are the
fallback. Enforced client-side — fine for a friendly club, not a hostile-actor
guarantee.

## Live data & rendering

`app.js` opens four `onSnapshot` listeners (group doc, members, movies, ratings)
and re-renders on any change. Rendering is plain `innerHTML` templates + event
listeners; the film card, wheel/films/ratings tabs are rendered in `app.js`,
stats in `stats.js`.

## Themes

Three themes, each a full design system (layout, shapes, type, texture, and the
wheel), chosen per-user via `localStorage` + the `data-theme` attribute:

| id | label | feel |
|----|-------|------|
| `a24` | Default | stark editorial black & white, fine film grain |
| `festival` | Cinema | printed-programme paper, halftone + grain, double rules |
| `strokes` | Web 1.0 | Win95/GeoCities cobalt desktop, beveled windows, dither + scanlines |

A theme = a CSS `[data-theme="…"]` block in `styles.css` **and** a branch in
`wheelStyle()` in `wheel.js` (palette/ring/hub/pointer/labels). `theme.js` fires
`spinema:themechange`; `app.js` listens and re-renders so the canvas wheel
restyles live.

## Wheel rendering

`wheel.js` draws on a `<canvas>` sized to `devicePixelRatio` for crispness
(`setupHiDPI`) while drawing in logical coordinates, with `lineJoin: round` so
stroked labels don't spike. The spinner picks the winner up front; `commitSpin`
writes `lastSpin`, and every browser animates the same easing so it lands on that
segment. Sound is WebAudio; the win burst is canvas-confetti.

## Security model

`firestore.rules` locks each club to its own members. All access requires
`request.auth != null` (anonymous sign-in), and beyond that:

- **Membership = `memberUids`.** A club's members, movies and ratings are
  readable/writable only if `request.auth.uid` is in the group's `memberUids`
  list (checked via a `get()` on the group doc).
- **`get` yes, `list` no.** Anyone signed in may *read a single group doc by
  code* (needed to look one up in order to join, and for the live group
  listener) — but listing/enumerating all clubs is denied.
- **Join is constrained.** A non-member may update the group doc *only* to
  append their **own** uid (and their memberId to the rotation) — they can't
  add anyone else or touch any other field. So you can't read or alter a club
  you haven't joined.
- **Own rating only.** A member may create/update only the rating carrying
  their own `uid`. No client deletes of the group doc.

**Still client-trusted** (see `ROADMAP.md` #7/#8): the turn-rotation, finalize
and unanimous-reset *invariants* are enforced in the client, and a member could
over-delete their own club's movies/ratings. That's fine for a friendly club,
not a hostile-actor guarantee — moving those to a Cloud Function is the planned
hardening.

**Rollout:** the uid-recording client (this code) must ship **before** the new
rules are published, so existing members record a uid (`memberUids`) on their
next visit; otherwise they'd be locked out until they re-join. The rules are in
`firestore.rules` but do **not** auto-deploy — test them in the Firebase
Emulator, then paste into the console (Firestore → Rules → Publish).
