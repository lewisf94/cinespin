# Architecture

CineWheel is a static front end talking directly to Cloud Firestore — there is no
server of our own. Firestore plus its security rules **are** the backend. Every
browser signs in anonymously so the rules can require authentication.

## Data model (Firestore)

```
groups/{code}                         # code = 5-char share code (Kahoot-style)
  name: string
  createdAt, createdByName
  memberOrder: [memberId, ...]        # turn order = join order
  currentSpinnerIndex: number         # whose turn to spin (index into memberOrder)
  currentFilm: {                      # the film in play this week, or null
    movieId, title, addedByName, spinnerName, pickedAt, deadline
  } | null
  lastSpin: { seed, startedAt, durationMs, segments[], winnerIndex, spinnerName } | null
  resetRequest: {                     # unanimous-consent reset, or null
    startedBy, startedByName, startedAt, approvals: [memberId, ...]
  } | null

  members/{memberId}                  # memberId = random id kept in the browser
    name, joinedAt

  movies/{movieId}
    title, addedByName, addedByMemberId, addedAt
    status: "wheel" | "current" | "watched"
    pickedAt, watchedAt, deadline
    watchedBy: [memberId, ...]        # who confirmed they watched the current film

  ratings/{movieId__memberId}         # one per member per film
    movieId, memberId, name, score (0.5-5), review, updatedAt
```

No login/accounts: identity is a random `memberId` + display name in
`localStorage` (`session.js`). Anonymous auth exists only so the rules can block
the open internet.

## The weekly round

1. The member at `currentSpinnerIndex` spins (`commitSpin`). The winner becomes
   `currentFilm` (status `current`, `watchedBy: []`); `lastSpin` drives the same
   spin animation in every browser.
2. Each member clicks "I've watched it" (`markWatchedAck` → `arrayUnion` on the
   movie's `watchedBy`) and submits a rating (`saveRating`). Everyone else's
   ratings stay **sealed** in the UI until the round completes.
3. When **every current member is in `watchedBy` AND has a rating**, a client
   calls `finalizeRound` (an idempotent transaction): the film flips to
   `watched`, `currentFilm` clears, `currentSpinnerIndex` advances. That reveals
   all reviews (the film is now history) and unlocks the next spin.
   - The current spinner can `finalizeRound` early ("wrap up now") if someone is
     away, so the group never softlocks.

The gating logic lives in `app.js` (`roundState`, plus the auto-finalize in
`render`).

## Group reset (unanimous)

`requestReset` writes `resetRequest` with the proposer pre-approved; `approveReset`
appends approvals; any `cancelReset` (decline/cancel) clears it. Once every member
has approved, `performReset` batch-deletes all `movies` + `ratings` and clears the
group's play state (keeping members and the code). Enforced client-side — fine for
a friendly club, not a hostile-actor guarantee.

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
`cinewheel:themechange`; `app.js` listens and re-renders so the canvas wheel
restyles live.

## Wheel rendering

`wheel.js` draws on a `<canvas>` sized to `devicePixelRatio` for crispness
(`setupHiDPI`) while drawing in logical coordinates, with `lineJoin: round` so
stroked labels don't spike. The spinner picks the winner up front; `commitSpin`
writes `lastSpin`, and every browser animates the same easing so it lands on that
segment. Sound is WebAudio; the win burst is canvas-confetti.

## Security model

`firestore.rules`: all access requires `request.auth != null`; within a group,
any authenticated user who knows the code can read/write that group's data
(Kahoot-PIN trust model). No client deletes of group docs.
