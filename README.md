# Spinema

A film-club wheel for groups of friends. Add films to a wheel, take turns each
week spinning to pick what to watch, set a watch-by deadline, then rate (in
half-stars) and review what you watched — reviews stay sealed until the whole
club is in, with stats along the way.

- **No sign-up** — people just enter a name.
- **Multiple groups** — create a group, share its 5-letter code (Kahoot-style),
  and each group's data is kept separate.
- **Saved forever & shared live** — everything is stored in Firebase, so people
  can leave and come back to the same info, and updates appear in real time.

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

Spinema is a static site, so it needs a free **Firebase** project to store the
shared data. You only do this once.

### 1. Create a Firebase project
1. Go to **<https://console.firebase.google.com>** and sign in with a Google account.
2. Click **Add project**, give it any name (e.g. `spinema`), and continue.
   You can disable Google Analytics when asked.

### 2. Register a Web App and copy the config
1. On the project home, click the **Web icon `</>`** ("Add app").
2. Give it a nickname (e.g. `spinema-web`) and click **Register app**.
   (You do **not** need Firebase Hosting.)
3. You'll see a `firebaseConfig` object like this — keep this tab open:
   ```js
   const firebaseConfig = {
     apiKey: "AIza…",
     authDomain: "spinema-xxxx.firebaseapp.com",
     projectId: "spinema-xxxx",
     storageBucket: "spinema-xxxx.appspot.com",
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

---

## Put it online with GitHub Pages

1. Commit and push these files to the **`main`** branch of your repository.
2. On GitHub: **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**.
4. Pick branch **`main`**, folder **`/ (root)`**, and **Save**.
5. After a minute your site is live at:
   **`https://lewisf94.github.io/spinema/`**

Share that link (or the in-app club code) with your friends and you're set.

---

## Run it locally first (optional)

Because the app uses JavaScript modules, open it through a local web server
(not by double-clicking the file). With your Firebase config already filled in:

```bash
cd spinema
python3 -m http.server 8000
# then open http://localhost:8000
```

Open a second browser/tab and join with the same code to see real-time sync and
test the spin together.

---

## Tech notes

- Plain HTML/CSS/JavaScript — **no build step**.
- Firebase Firestore (data) + Anonymous Auth (gates writes), loaded from the
  Firebase CDN.
- Data model lives under `groups/{code}` with `members`, `movies`, and
  `ratings` subcollections.
- The wheel is canvas-drawn; the winner is chosen first and the easing always
  lands on it. The spinner broadcasts the spin so everyone animates the same
  result.

### Want film posters? (optional, later)
The data model already has `posterUrl`/`year` fields. You could wire up the free
[TMDB API](https://www.themoviedb.org/settings/api) to auto-fill them when a
movie is added.
