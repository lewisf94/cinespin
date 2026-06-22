// ============================================================================
//  TMDB (The Movie Database) — optional film metadata when adding to the wheel
// ----------------------------------------------------------------------------
//  OFF by default. Paste a free TMDB API key below and the "Add a film" box
//  gains title autocomplete with posters; picking a result also stores the
//  year, runtime and genres on the film (used by the cards and stats). With no
//  key, everything still works as a plain title input — nothing here runs and
//  no network calls are made.
//
//  Get a free key: https://www.themoviedb.org/settings/api  (use the v3 "API
//  Key"). Note it's shipped in the client, like the Firebase key — fine for
//  TMDB's non-commercial use; you can rotate/limit it any time.
//
//  Attribution (required by TMDB and shown in the UI): this product uses the
//  TMDB API but is not endorsed or certified by TMDB. https://www.themoviedb.org
// ============================================================================

const TMDB_API_KEY = "f000eb911a380f5abc35f9cdcee19412"; // TMDB v3 API key; blank disables TMDB

const API = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p/";

export const tmdbEnabled = !!TMDB_API_KEY;
export const TMDB_STATEMENT =
  "This product uses the TMDB API but is not endorsed or certified by TMDB.";

// Stable TMDB movie-genre ids, so search results (which carry only ids) can show
// names without an extra request.
const GENRES = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime",
  99: "Documentary", 18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History",
  27: "Horror", 10402: "Music", 9648: "Mystery", 10749: "Romance",
  878: "Science Fiction", 10770: "TV Movie", 53: "Thriller", 10752: "War",
  37: "Western",
};

// Build a poster URL from a TMDB poster_path (or "" if there isn't one).
export function posterUrl(path, size = "w154") {
  return path ? IMG + size + path : "";
}

function yearOf(dateStr) {
  return dateStr && dateStr.length >= 4 ? dateStr.slice(0, 4) : "";
}

// Autocomplete search — cheap, called per keystroke (debounced by the caller).
// Returns up to `limit` light results; never throws (network errors -> []).
export async function searchTitles(q, limit = 6) {
  if (!tmdbEnabled || !q || q.trim().length < 2) return [];
  try {
    const url = `${API}/search/movie?api_key=${TMDB_API_KEY}` +
      `&query=${encodeURIComponent(q.trim())}&include_adult=false&language=en-US&page=1`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).slice(0, limit).map((r) => ({
      tmdbId: r.id,
      title: r.title || r.original_title || "",
      year: yearOf(r.release_date),
      posterPath: r.poster_path || "",
      genres: (r.genre_ids || []).map((id) => GENRES[id]).filter(Boolean),
    }));
  } catch (_) {
    return [];
  }
}

// Fuller details for a chosen film (runtime + authoritative genres). Called once
// on selection, not per keystroke. Returns null on any error.
export async function getDetails(tmdbId) {
  if (!tmdbEnabled || !tmdbId) return null;
  try {
    const res = await fetch(`${API}/movie/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`);
    if (!res.ok) return null;
    const d = await res.json();
    return {
      tmdbId,
      title: d.title || d.original_title || "",
      year: yearOf(d.release_date),
      posterPath: d.poster_path || "",
      runtime: typeof d.runtime === "number" ? d.runtime : null,
      genres: (d.genres || []).map((g) => g.name).filter(Boolean),
    };
  } catch (_) {
    return null;
  }
}

// Common "where to watch" regions (TMDB keys provider results by ISO 3166-1
// country code). Enough to cover most clubs; the user can override the guess.
export const WATCH_REGIONS = [
  { code: "GB", name: "United Kingdom" }, { code: "US", name: "United States" },
  { code: "IE", name: "Ireland" },        { code: "CA", name: "Canada" },
  { code: "AU", name: "Australia" },      { code: "NZ", name: "New Zealand" },
  { code: "DE", name: "Germany" },        { code: "FR", name: "France" },
  { code: "ES", name: "Spain" },          { code: "IT", name: "Italy" },
  { code: "NL", name: "Netherlands" },    { code: "PT", name: "Portugal" },
  { code: "SE", name: "Sweden" },         { code: "NO", name: "Norway" },
  { code: "DK", name: "Denmark" },        { code: "FI", name: "Finland" },
  { code: "PL", name: "Poland" },         { code: "IN", name: "India" },
  { code: "BR", name: "Brazil" },         { code: "MX", name: "Mexico" },
  { code: "JP", name: "Japan" },          { code: "ZA", name: "South Africa" },
];

// Minimal IANA-timezone -> country map, used to infer the country when the
// browser locale carries no region (e.g. plain "en" reports US otherwise).
const TZ_REGION = {
  "Europe/London": "GB", "Europe/Dublin": "IE", "Europe/Lisbon": "PT",
  "Europe/Paris": "FR", "Europe/Berlin": "DE", "Europe/Madrid": "ES",
  "Europe/Rome": "IT", "Europe/Amsterdam": "NL", "Europe/Stockholm": "SE",
  "Europe/Oslo": "NO", "Europe/Copenhagen": "DK", "Europe/Helsinki": "FI",
  "Europe/Warsaw": "PL", "Atlantic/Canary": "ES",
  "America/New_York": "US", "America/Chicago": "US", "America/Denver": "US",
  "America/Los_Angeles": "US", "America/Phoenix": "US",
  "America/Toronto": "CA", "America/Vancouver": "CA",
  "America/Sao_Paulo": "BR", "America/Mexico_City": "MX",
  "Australia/Sydney": "AU", "Australia/Melbourne": "AU", "Australia/Perth": "AU",
  "Pacific/Auckland": "NZ", "Asia/Kolkata": "IN", "Asia/Tokyo": "JP",
  "Africa/Johannesburg": "ZA",
};

const REGION_KEY = "spinema_region";

// Best-guess streaming region: a manual override wins; otherwise the first
// browser language that carries a country (en-GB -> GB), then the timezone's
// country (so a plain "en" UK browser still resolves to GB), then US.
export function watchRegion() {
  try {
    const saved = localStorage.getItem(REGION_KEY);
    if (saved) return saved.toUpperCase();
  } catch (_) {}
  const langs = (navigator.languages && navigator.languages.length)
    ? navigator.languages : [navigator.language || ""];
  for (const l of langs) {
    const m = /[-_]([A-Za-z]{2})$/.exec(l || "");
    if (m) return m[1].toUpperCase();
  }
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    if (TZ_REGION[tz]) return TZ_REGION[tz];
  } catch (_) {}
  return "US";
}

// Persist a manual region override (or clear it with a falsy value).
export function setWatchRegion(code) {
  try {
    if (code) localStorage.setItem(REGION_KEY, String(code).toUpperCase());
    else localStorage.removeItem(REGION_KEY);
  } catch (_) {}
}

// "Where to watch" for a film in a region. TMDB sources this from JustWatch, so
// usage REQUIRES crediting JustWatch and linking to the provided page (we do
// both in the UI). Returns { providers:[{name,logo}], link } or null.
export async function getWatchProviders(tmdbId, region = "US") {
  if (!tmdbEnabled || !tmdbId) return null;
  try {
    const res = await fetch(`${API}/movie/${tmdbId}/watch/providers?api_key=${TMDB_API_KEY}`);
    if (!res.ok) return null;
    const r = ((await res.json()).results || {})[region];
    if (!r) return null;
    const seen = new Set();
    const providers = [...(r.flatrate || []), ...(r.free || []), ...(r.ads || [])]
      .filter((p) => p && p.provider_name && !seen.has(p.provider_name) && seen.add(p.provider_name))
      .map((p) => ({ name: p.provider_name, logo: p.logo_path || "" }));
    return { providers, link: r.link || "" };
  } catch (_) {
    return null;
  }
}

// ----------------------------------------------------------------------------
//  Streaming services a member can say they subscribe to. `match` are lowercase
//  substrings tested against TMDB watch-provider names, so small naming
//  differences ("Disney Plus" vs "Disney+", "Now TV" vs "NOW") still line up.
//  This is what powers "who can actually watch the film of the week".
// ----------------------------------------------------------------------------
export const STREAMING_SERVICES = [
  { id: "netflix",   name: "Netflix",      match: ["netflix"] },
  { id: "disney",    name: "Disney+",      match: ["disney"] },
  { id: "prime",     name: "Amazon Prime", match: ["amazon prime", "prime video"] },
  { id: "appletv",   name: "Apple TV+",    match: ["apple tv"] },
  { id: "max",       name: "Max / HBO",    match: ["max", "hbo"] },
  { id: "paramount", name: "Paramount+",   match: ["paramount"] },
  { id: "hulu",      name: "Hulu",         match: ["hulu"] },
  { id: "peacock",   name: "Peacock",      match: ["peacock"] },
  { id: "now",       name: "NOW / Sky",    match: ["now tv", "sky"] },
  { id: "iplayer",   name: "BBC iPlayer",  match: ["iplayer", "bbc"] },
  { id: "itvx",      name: "ITVX",         match: ["itvx", "itv"] },
  { id: "channel4",  name: "Channel 4",    match: ["channel 4", "all 4"] },
  { id: "mubi",      name: "MUBI",         match: ["mubi"] },
];

const SERVICE_BY_ID = Object.fromEntries(STREAMING_SERVICES.map((s) => [s.id, s]));

// Does owning `serviceId` get you this TMDB provider?
function providerIsService(providerName, serviceId) {
  const svc = SERVICE_BY_ID[serviceId];
  if (!svc) return false;
  const p = String(providerName || "").toLowerCase();
  return svc.match.some((tok) => p.includes(tok));
}

// Can a member who subscribes to `serviceIds` stream a film offered on these
// TMDB provider names? True if any of their services carries any provider.
export function canStream(serviceIds, providerNames) {
  return (serviceIds || []).some((id) =>
    (providerNames || []).some((p) => providerIsService(p, id)));
}
