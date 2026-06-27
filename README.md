# CineClub

**Live app → <https://thecineclub.co.uk>**

A film-club wheel for groups of friends. Add films to a wheel, take turns each
week spinning to pick what to watch, set a watch-by deadline, then rate (in
half-stars) and review what you watched — reviews stay sealed until the whole
club is in, with stats along the way.

- **No sign-up** — people just enter a name.
- **Multiple groups** — create a group, share its 5-letter code (Kahoot-style),
  and each group's data is kept separate.
- **Saved forever & shared live** — everything is stored in Firebase, so people
  can leave and come back to the same info, and updates appear in real time.
- **See who can watch** — say which streaming services you have, and each film
  shows who can actually stream it (needs the optional TMDB key, below).
- **Three themes** — Default, Cinema and a Web 1.0 throwback; pick per-browser.
- **Installable** — add it to your phone/desktop home screen (PWA).

---

## How it works

1. **Start a club** (you get a share code) or **join** with a friend's code.
2. **Add films** to the wheel — each is tagged with who added it.
3. The person **whose turn it is** (turn order = the order people joined) spins
   the wheel. Everyone watching sees the same spin.
4. The result becomes the **Film of the Week** with a **7-day deadline**
   (the spinner can change the date).
5. Each member **marks it watched** and leaves a **private** half-star rating
   and review — nobody sees anyone else's review yet.
6. Once **everyone has watched and rated**, all reviews **reveal at once**, the
   film moves to the **Ratings** tab, the turn passes, and the next spin
   unlocks. (The spinner can wrap up early if someone's away.)
7. The **Stats** tab shows averages, most generous / harshest critic, top &
   most divisive films, and more.

---

## One-time setup (~5–10 minutes)

CineClub is a static site, so it needs a free **Firebase** project to store the
shared data. You only do this once.

### 1. Create a Firebase project
1. Go to **<https://console.firebase.google.com>** and sign in with a Google account.
2. Click **Add project**, give it any name (e.g. `cineclub`), and continue.
   You can disable Google Analytics when asked.

### 2. Register a Web App and copy the config
1. On the project home, click the **Web icon `</>`** ("Add app").
2. Give it a nickname (e.g. `cineclub-web`) and click **Register app**.
   (You do **not** need Firebase Hosting.)
3. You'll see a `firebaseConfig` object like this — keep this tab open:
   ```js
   const firebaseConfig = {
     apiKey: "AIza…",
     authDomain: "cineclub-xxxx.firebaseapp.com",
     projectId: "cineclub-xxxx",
     storageBucket: "cineclub-xxxx.appspot.com",
     messagingSenderId: "1234567890",
     appId: "1:1234567890:web:abcdef…",
   };
   ```
   > These values are **safe to put in public code** — Firebase security is
   > enforced by the rules below, not by hiding these keys.

### 3. Create the Firestore database
1. In the left menu: **Build → Firestore Database → Create database**.
2. Choose a location near you and create it. (Production mode is fine — we set
   rules next.)

### 4. Publish the security rules
1. In Firestore, open the **Rules** tab.
2. Delete what's there and paste the entire contents of
   [`firestore.rules`](./firestore.rules), then click **Publish**.

These rules make each club **private to its members** (the Firebase uids that
have joined) — nobody can read, edit, or enumerate a club they haven't joined.
*Upgrading an existing deployment?* Ship the current app code **first** (so
everyone records a uid by re-joining once), then publish the rules — otherwise
members without a recorded uid are locked out until they re-join. See the header
of [`firestore.rules`](./firestore.rules) and `ARCHITECTURE.md`.

### 5. Turn on Anonymous sign-in
1. Left menu: **Build → Authentication → Get started**.
2. Open the **Sign-in method** tab → **Add new provider** → **Anonymous** →
   enable it → **Save**.
   *(This signs everyone in invisibly so the rules work — there's still no login
   screen for your friends.)*
3. *(Optional)* For the **"Save your account"** button (keep your club across
   devices / a cleared browser), also add the **Email/Password** provider and,
   inside it, tick **Email link (passwordless sign-in)** → **Save**. *(If sending
   a link errors with `auth/operation-not-allowed`, this toggle is off.)*
4. *(If you did step 3)* Add your live domain to the allow-list:
   **Authentication → Settings → Authorized domains → Add domain →**
   `lewisf94.github.io`. This is **not** there by default — only
   `localhost`, `*.firebaseapp.com` and `*.web.app` are — so without it the
   emailed link is refused on the live site (`auth/unauthorized-continue-uri`).
   Skip steps 3–4 and everything else still works; the button just won't send links.
   - *(Optional)* Firebase may suggest enabling **Sign in with Google**. The app
     doesn't use it, so turning it on alone changes nothing — leave it off unless
     you want a Google sign-in button added to the code.
   - **Heads-up on deliverability:** Firebase sends these links from a generic
     `noreply@cinewheel-79636.firebaseapp.com` address that isn't authenticated for
     your domain, so they **often land in spam** — and mail clients *disable the
     link* inside spam messages, so it looks like "no link". Tell members to check
     spam and mark it **"Not spam"** (then the link works). For reliable inbox
     delivery, set up **custom SMTP** with your own domain under
     **Authentication → Templates → (pencil) → Customize SMTP settings**; the
     sender name/subject can be tweaked on that same Templates screen.
   - **Brand the email:** the sign-in message takes the app name from your
     project's **public-facing name** (defaults to the project id, e.g.
     `cinewheel-79636`). Set it under **Project Settings → General →
     Public-facing name** (e.g. `CineClub`) so the email reads "Sign in to
     CineClub…" instead of the raw id. The sender *address* still shows the
     project id unless you use custom SMTP (above).
   - **If you restrict the Web API key by HTTP referrer** (the optional hardening
     in step 9 / ROADMAP #6) you **must also allow the auth handler's domain**, or
     the sign-in link 403s with `API_KEY_HTTP_REFERRER_BLOCKED`. In **Google Cloud
     Console → APIs & Services → Credentials → (your browser key) → Website
     restrictions**, include `https://cinewheel-79636.firebaseapp.com/*` and
     `https://cinewheel-79636.web.app/*` alongside `https://lewisf94.github.io/*`.

### 6. Paste your config into the app
1. Open [`js/firebase.js`](./js/firebase.js).
2. Replace the placeholder `firebaseConfig` (the block with `REPLACE_ME`) with
   the one you copied in step 2.
3. Save.

### 7. (Optional) Harden with App Check
Defense-in-depth so only your real site — not a script with your public API
key — can call Firebase. Skippable; the security rules are the real boundary.
1. Google reCAPTCHA admin → create a **reCAPTCHA v3** site for your domain
   (add `localhost` too if testing locally) → copy the **site key**.
2. Firebase console: **Build → App Check → Apps →** register your web app with
   the reCAPTCHA v3 provider.
3. Paste the site key into `recaptchaV3SiteKey` in
   [`js/firebase.js`](./js/firebase.js).
4. In App Check, keep Firestore in **Monitor** mode at first; once the metrics
   show your real traffic is verified, switch it to **Enforce**.

### 8. (Optional) Web push deadline reminders
A push notification as the watch-by deadline nears, for members who opt in.
Skippable; everything works without it. Needs the **Blaze** plan (scheduled
Cloud Functions) — there's a generous free tier, but a card on file.
1. Firebase console: **Project settings → Cloud Messaging → Web Push
   certificates → Generate key pair** → copy the **public key**.
2. Paste it into `messagingVapidKey` in [`js/firebase.js`](./js/firebase.js).
   (The repo already has `firebase-messaging-sw.js` at the root — keep the
   Firebase config in it in sync with `js/firebase.js` if you ever change it.)
3. Deploy the reminder function: from `functions/`, `npm install` then
   `firebase deploy --only functions:sendDeadlineReminders` (it runs daily and
   pushes to members who haven't watched yet). See [`functions/README.md`](./functions/README.md).
4. In the app: **Account → Turn on reminders** on each device you want notified.
   iOS only delivers Web Push to apps **installed to the home screen** (see PWA
   below), so install it there first.

---

## Put it online with GitHub Pages

1. Commit and push these files to the **`main`** branch of your repository.
2. On GitHub: **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**.
4. Pick branch **`main`**, folder **`/ (root)`**, and **Save**.
5. After a minute your site is live at:
   **`https://lewisf94.github.io/cineclub/`**

Share that link (or the in-app club code) with your friends and you're set.

---

## Run it locally first (optional)

Because the app uses JavaScript modules, open it through a local web server
(not by double-clicking the file). With your Firebase config already filled in:

```bash
cd cineclub
python3 -m http.server 8000
# then open http://localhost:8000
```

Open a second browser/tab and join with the same code to see real-time sync and
test the spin together.

---

## Install it (PWA)

CineClub ships a web manifest + service worker, so phones and desktops can
**install it to the home screen** (browser menu → *Install* / *Add to Home
Screen*) and it launches full-screen with an app icon. The shell is cached for
instant loads; live data still needs a connection (it's a realtime app). To
force clients onto fresh assets after a big change, bump `CACHE` in `sw.js`.

## Tech notes

- Plain HTML/CSS/JavaScript — **no build step**.
- Firebase Firestore (data) + Anonymous Auth (gates writes), loaded from the
  Firebase CDN.
- Data model lives under `groups/{code}` with `members`, `movies`, and
  `ratings` subcollections.
- The wheel is canvas-drawn; the winner is chosen first and the easing always
  lands on it. The spinner broadcasts the spin so everyone animates the same
  result.

### Film posters, metadata & streaming (optional, via TMDB)
Built in, and **enabled on the live site** (a key is set in `js/tmdb.js`); it's
**off only if you blank that key** in your own copy. With a free
[TMDB](https://www.themoviedb.org) API key you get:

- **Title autocomplete with posters** in the "Add a film" box; picking a result
  stores the year, runtime and genres (shown on the cards and in **Stats →
  Watch habits**). Typing a title and pressing **Add** still enriches it — the
  title is matched against TMDB automatically.
- **"Where to watch"** under each film (and on the film-of-the-week card) — the
  streaming providers for your region. The region is auto-detected (from your
  browser locale, falling back to your timezone) and can be overridden on the
  **Films** tab if it guesses wrong.
- **"Who can watch"** — each member picks the streaming services they subscribe
  to (on the **Films** tab); CineClub cross-references them with where each film
  is streaming and shows who's covered, with a per-film badge on the wheel so you
  can favour films **everyone** can watch.

Setup:
1. Create a free TMDB account → **Settings → API** → copy the **API Key (v3
   auth)**.
2. Paste it into `TMDB_API_KEY` at the top of [`js/tmdb.js`](./js/tmdb.js), then
   commit + push.

With no key, the box stays a plain title input — nothing here runs and no TMDB
requests are made. The key ships in the client (like the Firebase key), which is
fine for TMDB's non-commercial use. The app shows TMDB's required attribution,
and credits **JustWatch** for the where-to-watch data, wherever those appear.
