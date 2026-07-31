// Home/Work used to save one fixed bus stop ({code, name}); they now save a
// geocoded address ({address, postal, latitude, longitude}) so the chip can
// show stops nearest to that address instead of a single pinned stop. Old
// entries don't carry coordinates and can't feed that view, so they're
// dropped — the user re-sets Home/Work via address search.
function sanitizePlaces(places) {
  const clean = {};
  for (const key of Object.keys(places || {})) {
    const p = places[key];
    if (p && typeof p.latitude === "number" && typeof p.longitude === "number") {
      clean[key] = p;
    }
  }
  return clean;
}

// Reminders and modes are rows in Postgres now, with uuid primary keys, so
// ids have to be minted as uuids rather than the old `Date.now()` strings.
function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // Safari < 15.4 has crypto.getRandomValues but not randomUUID.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}

const FAV_KEY = "bb_favourites";

// ── State ──
let state = {
  refreshSec: parseInt(localStorage.getItem("bb_refreshSec") || "30"),
  reminderLeadMin: parseInt(localStorage.getItem("bb_reminderLead") || "5"),
  favourites: JSON.parse(localStorage.getItem(FAV_KEY) || "[]"),
  departureReminders: JSON.parse(localStorage.getItem("bb_deptReminders") || "[]"),
  dropoffAlerts: JSON.parse(localStorage.getItem("bb_dropoffAlerts") || "[]"),
  modes: JSON.parse(localStorage.getItem("bb_modes") || "[]"),
  places: sanitizePlaces(JSON.parse(localStorage.getItem("bb_places") || "{}")),
  busStops: null,
  currentStop: null,
};
localStorage.setItem("bb_places", JSON.stringify(state.places));

let refreshTimer = null;
let deptCheckTimer = null;
let dropoffWatchId = null;
let activeDropoff = null;
let audioCtx = null;
let wakeLock = null;

// Dashboard state
let dashFetchQueue = [];
let dashFetchTimer = null;
let dashRefreshTimer = null;
let dashArrivalCache = {};
const DASH_CACHE_TTL = 20000;
const DASH_MAX_SERVICES = 3;
const DASH_FETCH_DELAY_MS = 800;

// Map state
let map = null;
let mapMarkers = null;
let mapUserMarker = null;
// Combined route view (tappable bus number → map + stop list) state
let routeMap = null;
let routeRouteLayer = null;
let routeSelMarker = null;
let routeStopsService = null;
let routeStopsDirection = null;
let routeStopsAnchor = null;

// ── Theme ──
const THEME_KEY = "bb_theme";

function applyTheme(theme) {
  if (theme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
    document.querySelector('meta[name="theme-color"]').setAttribute("content", "#1c1917");
    const btn = document.getElementById("themeToggle");
    if (btn) btn.textContent = "☀️";
  } else if (theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
    document.querySelector('meta[name="theme-color"]').setAttribute("content", "#0d9488");
    const btn = document.getElementById("themeToggle");
    if (btn) btn.textContent = "🌙";
  } else {
    document.documentElement.removeAttribute("data-theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.querySelector('meta[name="theme-color"]').setAttribute("content", prefersDark ? "#1c1917" : "#0d9488");
    const btn = document.getElementById("themeToggle");
    if (btn) btn.textContent = prefersDark ? "☀️" : "🌙";
  }
}

function toggleTheme() {
  const current = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isCurrentlyDark =
    current === "dark" || (current === null && prefersDark);
  const next = isCurrentlyDark ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  applyTheme(saved || null);
  // Follow OS preference changes when no manual override is set.
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (!localStorage.getItem(THEME_KEY)) applyTheme(null);
    });
}

// ── PWA Install Prompt ──
let deferredInstallPrompt = null;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (!localStorage.getItem("bb_installDismissed")) {
    document.getElementById("installBanner").classList.remove("hidden");
  }
});

async function triggerInstall() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  document.getElementById("installBanner").classList.add("hidden");
  if (outcome === "accepted") showToast("Bus Buddy installed!");
}

function dismissInstall() {
  document.getElementById("installBanner").classList.add("hidden");
  localStorage.setItem("bb_installDismissed", "1");
}

// ── Init ──
// Not a DOMContentLoaded handler any more: auth.js owns startup and calls this
// only once there's a signed-in user, so no render path ever runs without a
// user_id to scope its data to.
async function bootstrapApp() {
  document.getElementById("refreshInterval").value = state.refreshSec;
  document.getElementById("reminderLead").value = state.reminderLeadMin;
  document
    .querySelectorAll("[data-stop-autocomplete]")
    .forEach(attachStopAutocomplete);
  document
    .querySelectorAll("[data-address-autocomplete]")
    .forEach(attachAddressAutocomplete);
  renderFavourites();
  renderDepartureReminders();
  renderDropoffAlerts();
  renderPlaces();
  refreshDashboard();
  startDashAutoRefresh();
  requestNotificationPermission();
  initPush();
  // Server state first: this account may have favourites and reminders set on
  // another device that this one has never seen.
  await restorePrefs();
  loadModes();
  startDepartureChecker();
  startArrivalTicker();
  maybeShowOnboarding();
  document.addEventListener('click', unlockAudio, { once: true });
  document.addEventListener('touchstart', unlockAudio, { once: true });
  if (window.__hideSplash) window.__hideSplash();
}

// ── API ──
async function fetchArrivals(stopCode, serviceNo) {
  let url = `/api/bus-arrival?BusStopCode=${stopCode}`;
  if (serviceNo) url += `&ServiceNo=${serviceNo}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("API error");
  return res.json();
}

// ── Bus Stops Cache (IndexedDB) ──
const BUS_STOPS_DB = "bb_bus_stops_db";
const BUS_STOPS_STORE = "stops";
const BUS_STOPS_CACHE_KEY = "all_stops";
const BUS_STOPS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function openBusStopsDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BUS_STOPS_DB, 1);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(BUS_STOPS_STORE, { keyPath: "key" });
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

async function getCachedBusStops() {
  try {
    const db = await openBusStopsDB();
    return new Promise((resolve) => {
      const tx = db.transaction(BUS_STOPS_STORE, "readonly");
      const req = tx.objectStore(BUS_STOPS_STORE).get(BUS_STOPS_CACHE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function setCachedBusStops(stops) {
  try {
    const db = await openBusStopsDB();
    return new Promise((resolve) => {
      const tx = db.transaction(BUS_STOPS_STORE, "readwrite");
      tx.objectStore(BUS_STOPS_STORE).put({ key: BUS_STOPS_CACHE_KEY, stops, cachedAt: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  } catch {
    // non-fatal
  }
}

async function loadBusStops(forceRefresh = false) {
  if (state.busStops && !forceRefresh) return state.busStops;

  if (!forceRefresh) {
    const cached = await getCachedBusStops();
    if (cached && Date.now() - cached.cachedAt < BUS_STOPS_TTL_MS) {
      state.busStops = cached.stops;
      return state.busStops;
    }
  }

  showToast("Updating bus stop database...");
  try {
    const res = await fetch("/api/bus-stops");
    if (!res.ok) throw new Error(`API error ${res.status}`);
    const data = await res.json();
    state.busStops = data.value || [];
    showToast(`Loaded ${state.busStops.length} bus stops`);
    await setCachedBusStops(state.busStops);
  } catch (err) {
    const cached = await getCachedBusStops();
    if (cached) {
      state.busStops = cached.stops;
      showToast("Using offline bus stop data");
    } else {
      throw err;
    }
  }

  return state.busStops;
}

// Index bus stops by code (built lazily, reused by route drawing & lookups).
let busStopIndex = null;
async function getBusStopIndex() {
  const stops = await loadBusStops();
  if (!busStopIndex || busStopIndex.size !== stops.length) {
    busStopIndex = new Map(stops.map((s) => [s.BusStopCode, s]));
  }
  return busStopIndex;
}

// ── Bus Routes Cache (IndexedDB) ──
const BUS_ROUTES_DB = "bb_bus_routes_db";
const BUS_ROUTES_STORE = "routes";
const BUS_ROUTES_CACHE_KEY = "all_routes";
const BUS_ROUTES_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
let busRoutes = null;

function openBusRoutesDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BUS_ROUTES_DB, 1);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(BUS_ROUTES_STORE, { keyPath: "key" });
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

async function getCachedBusRoutes() {
  try {
    const db = await openBusRoutesDB();
    return new Promise((resolve) => {
      const tx = db.transaction(BUS_ROUTES_STORE, "readonly");
      const req = tx.objectStore(BUS_ROUTES_STORE).get(BUS_ROUTES_CACHE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function setCachedBusRoutes(routes) {
  try {
    const db = await openBusRoutesDB();
    return new Promise((resolve) => {
      const tx = db.transaction(BUS_ROUTES_STORE, "readwrite");
      tx.objectStore(BUS_ROUTES_STORE).put({ key: BUS_ROUTES_CACHE_KEY, routes, cachedAt: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  } catch {
    // non-fatal
  }
}

async function loadBusRoutes(forceRefresh = false) {
  if (busRoutes && !forceRefresh) return busRoutes;

  if (!forceRefresh) {
    const cached = await getCachedBusRoutes();
    if (cached && Date.now() - cached.cachedAt < BUS_ROUTES_TTL_MS) {
      busRoutes = cached.routes;
      return busRoutes;
    }
  }

  showToast("Loading bus route map (one-time)...");
  try {
    const res = await fetch("/api/bus-routes");
    if (!res.ok) throw new Error(`API error ${res.status}`);
    const data = await res.json();
    busRoutes = data.value || [];
    await setCachedBusRoutes(busRoutes);
  } catch (err) {
    const cached = await getCachedBusRoutes();
    if (cached) {
      busRoutes = cached.routes;
      showToast("Using offline route data");
    } else {
      throw err;
    }
  }
  return busRoutes;
}

// Returns ordered stops for a service+direction: [{code, seq, stop}]
async function getRouteStops(serviceNo, direction) {
  const routes = await loadBusRoutes();
  const index = await getBusStopIndex();
  return routes
    .filter((r) => r.ServiceNo === serviceNo && r.Direction === direction)
    .sort((a, b) => a.StopSequence - b.StopSequence)
    .map((r) => ({ code: r.BusStopCode, seq: r.StopSequence, stop: index.get(r.BusStopCode) }))
    .filter((r) => r.stop && r.stop.Latitude && r.stop.Longitude);
}

// Route-map row (incl. WD_/SAT_/SUN_ First/LastBus) per service at a stop —
// used both to show services with no live arrival as "not currently
// running" instead of being omitted, and to display/highlight scheduled
// first & last bus times. BusRoutes is LTA's only source for these; there
// is no separate "first/last bus" endpoint.
async function getStopRouteInfo(stopCode) {
  const routes = await loadBusRoutes();
  const map = new Map();
  for (const r of routes) {
    if (r.BusStopCode === stopCode && !map.has(r.ServiceNo)) {
      map.set(r.ServiceNo, r);
    }
  }
  return map;
}

async function getServicesForStop(stopCode) {
  const map = await getStopRouteInfo(stopCode);
  return [...map.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// ── Scheduled first/last bus (from BusRoutes WD_/SAT_/SUN_ First/LastBus) ──
// LTA publishes weekday / Saturday / Sunday bands only — public holidays
// aren't separately flagged in this dataset, so they fall back to whichever
// day-of-week they land on.
function hhmmToMinutes(hhmm) {
  if (hhmm === undefined || hhmm === null || hhmm === "") return null;
  const s = String(hhmm).padStart(4, "0");
  const h = parseInt(s.slice(0, 2), 10);
  const m = parseInt(s.slice(2), 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function hhmmToDisplay(hhmm) {
  const mins = hhmmToMinutes(hhmm);
  if (mins === null) return null;
  const h = String(Math.floor(mins / 60) % 24).padStart(2, "0");
  const m = String(mins % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function todayScheduleKey() {
  const day = new Date().getDay(); // 0 = Sun, 6 = Sat
  if (day === 0) return "SUN";
  if (day === 6) return "SAT";
  return "WD";
}

// { firstMin, lastMin, firstDisp, lastDisp } for today's day-type, or all
// null if this service/stop combo has no schedule data.
function todaySchedule(routeRow) {
  if (!routeRow) return { firstMin: null, lastMin: null, firstDisp: null, lastDisp: null };
  const key = todayScheduleKey();
  const firstRaw = routeRow[`${key}_FirstBus`];
  const lastRaw = routeRow[`${key}_LastBus`];
  return {
    firstMin: hhmmToMinutes(firstRaw),
    lastMin: hhmmToMinutes(lastRaw),
    firstDisp: hhmmToDisplay(firstRaw),
    lastDisp: hhmmToDisplay(lastRaw),
  };
}

// Real-time predictions drift a few minutes from the static schedule, so a
// live arrival within this window of the scheduled last-bus time counts as
// "the last bus" rather than requiring an exact match.
const LAST_BUS_TOLERANCE_MIN = 10;

function isLastBusArrival(estimatedArrivalIso, lastBusMinutes) {
  if (!estimatedArrivalIso || lastBusMinutes === null) return false;
  const d = new Date(estimatedArrivalIso);
  const arrivalMinutes = d.getHours() * 60 + d.getMinutes();
  return Math.abs(arrivalMinutes - lastBusMinutes) <= LAST_BUS_TOLERANCE_MIN;
}

// ── Stop classification: bus interchanges & MRT/LRT-connected stops ──
// SG bus-stop Descriptions name station stops "…Stn" and interchanges "…Int".
// We derive station locations from those, then also flag nearby stops by
// proximity — so detection uses both naming convention and location.
let stationAnchors = null;
const stopClassCache = new Map();

async function getStationAnchors() {
  if (stationAnchors) return stationAnchors;
  const stops = await loadBusStops();
  stationAnchors = stops
    .filter((s) => /\bstn\b/i.test(s.Description || ""))
    .map((s) => [s.Latitude, s.Longitude]);
  return stationAnchors;
}

// Returns { interchange, mrt } for a stop, memoized by BusStopCode.
async function classifyStop(stop) {
  if (!stop) return { interchange: false, mrt: false };
  const cached = stopClassCache.get(stop.BusStopCode);
  if (cached) return cached;
  const desc = stop.Description || "";
  const interchange = /\bint\b/i.test(desc);
  let mrt = /\bstn\b/i.test(desc);
  if (!mrt) {
    const anchors = await getStationAnchors();
    mrt = anchors.some(
      ([lat, lng]) => haversine(stop.Latitude, stop.Longitude, lat, lng) <= 150
    );
  }
  const result = { interchange, mrt };
  stopClassCache.set(stop.BusStopCode, result);
  return result;
}

// Badge markup for a classified stop (reused by list + detail).
function stopTagsHtml(cls) {
  let html = "";
  if (cls.mrt) html += '<span class="route-tag route-tag-mrt">🚆 MRT</span>';
  if (cls.interchange) html += '<span class="route-tag route-tag-int">🔁 Int</span>';
  return html;
}

// How many directions a service runs (1 or 2).
async function getRouteDirections(serviceNo) {
  const routes = await loadBusRoutes();
  const dirs = new Set(
    routes.filter((r) => r.ServiceNo === serviceNo).map((r) => r.Direction)
  );
  return [...dirs].sort();
}

// ── Tabs ──
function switchTab(tab) {
  document.querySelectorAll(".tab").forEach((t) => {
    const isActive = t.dataset.tab === tab;
    t.classList.toggle("active", isActive);
    t.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  ["dashboard", "arrivals", "map", "favourites", "reminders"].forEach((t) => {
    document.getElementById(`tab-${t}`).classList.toggle("hidden", t !== tab);
  });
  if (tab === "dashboard") {
    refreshDashboard();
    startDashAutoRefresh();
  } else {
    stopDashAutoRefresh();
  }
  if (tab === "map") {
    if (!map) initMap();
    else setTimeout(() => map.invalidateSize(), 100);
  }
}

// ── Search ──
// Shared matcher: filter bus stops by name / road / address / code.
// Addresses ("21 Jurong East St 13") are matched as a set of tokens against
// the combined name+road+code text, so word order doesn't matter — this is
// what lets a street/address query find the right stop, not just an exact
// stop name or code.
async function searchStops(query, limit = 20) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/\s+/).filter(Boolean);
  const stops = await loadBusStops();
  const scored = [];
  for (const s of stops) {
    const desc = (s.Description || "").toLowerCase();
    const road = (s.RoadName || "").toLowerCase();
    const code = (s.BusStopCode || "").toLowerCase();
    const hay = `${desc} ${road} ${code}`;
    if (!tokens.every((t) => hay.includes(t))) continue;
    let score;
    if (code === q) score = 0;
    else if (desc.startsWith(q)) score = 1;
    else if (road.startsWith(q)) score = 2;
    else if (desc.includes(q) || road.includes(q)) score = 3;
    else score = 4; // matched only as separate address tokens
    scored.push({ stop: s, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((x) => x.stop);
}

// Matches bus service numbers (e.g. "965", "NR8", "913A") for the "search by
// bus number" flow — lets a query like "965" surface the route directly,
// independent of any bus stop.
async function searchBusServices(query, limit = 8) {
  const q = (query || "").trim().toUpperCase();
  if (!q) return [];
  const routes = await loadBusRoutes();
  const seen = new Set();
  for (const r of routes) {
    if (r.ServiceNo) seen.add(r.ServiceNo);
  }
  const matches = [...seen].filter((no) => no.toUpperCase().includes(q));
  matches.sort((a, b) => {
    const au = a.toUpperCase(), bu = b.toUpperCase();
    const aExact = au === q, bExact = bu === q;
    if (aExact !== bExact) return aExact ? -1 : 1;
    const aStarts = au.startsWith(q), bStarts = bu.startsWith(q);
    if (aStarts !== bStarts) return aStarts ? -1 : 1;
    return a.localeCompare(b, undefined, { numeric: true });
  });
  return matches.slice(0, limit);
}

// Singapore postal codes are exactly 6 digits — distinct from 5-digit bus
// stop codes and never used for service numbers, so this is unambiguous.
function isPostalCode(q) {
  return /^\d{6}$/.test((q || "").trim());
}

// Resolves a road name / address / postal code to a location via OneMap's
// public geocoder, so free-text place queries ("Beach Road", "541298") can
// be ranked by actual distance rather than just text matching. Small
// same-session cache avoids re-hitting the network for repeated queries.
const geocodeCache = new Map();
async function geocodeSearch(query, limit = 5) {
  const q = (query || "").trim();
  if (!q) return [];
  if (geocodeCache.has(q)) return geocodeCache.get(q);
  try {
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error(`geocode ${res.status}`);
    const data = await res.json();
    const results = (data.results || []).slice(0, limit);
    geocodeCache.set(q, results);
    return results;
  } catch {
    return []; // not cached — a transient failure shouldn't stick
  }
}

async function geocodeAddress(query) {
  const results = await geocodeSearch(query, 1);
  return results[0] || null;
}

// Bus stops within `limit` of a lat/lng, nearest first.
async function stopsNear(latitude, longitude, limit = 8) {
  const stops = await loadBusStops();
  return stops
    .map((s) => ({ ...s, dist: haversine(latitude, longitude, s.Latitude, s.Longitude) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit);
}

// Search UI is duplicated in two places — the dedicated Search tab and the
// home-page quick-search bar — sharing this logic via a scope name so
// there's one implementation instead of two copies.
const SEARCH_SCOPES = {
  arrivals: { input: "stopSearch", results: "searchResults", nearby: "nearbyResults" },
  home: { input: "homeStopSearch", results: "homeSearchResults", nearby: "homeNearbyResults" },
};

let searchDebounce = null;
let searchGeneration = 0;
async function handleSearch(val, scope = "arrivals") {
  clearTimeout(searchDebounce);
  const cfg = SEARCH_SCOPES[scope];
  const container = document.getElementById(cfg.results);
  const trimmed = (val || "").trim();
  if (!trimmed) {
    // Query cleared back to empty while still focused — re-offer nearby
    // suggestions since no fresh "focus" event fires in that case.
    container.classList.add("hidden");
    maybeSuggestNearby(scope);
    return;
  }
  document.getElementById(cfg.nearby).classList.add("hidden");
  if (trimmed.length < 2) {
    container.classList.add("hidden");
    return;
  }
  if (/^\d{5}$/.test(trimmed)) {
    container.classList.add("hidden");
    return;
  }

  const postal = isPostalCode(trimmed);
  const pureNumeric = /^\d+$/.test(trimmed);
  const shouldGeocode = postal || (!pureNumeric && trimmed.length >= 4);

  const myGen = ++searchGeneration;
  searchDebounce = setTimeout(async () => {
    try {
      const [services, stops, geo] = await Promise.all([
        postal ? [] : searchBusServices(val, 6),
        postal ? [] : searchStops(val, 20),
        shouldGeocode ? geocodeAddress(trimmed) : null,
      ]);
      if (myGen !== searchGeneration) return; // superseded by a newer search

      let near = [];
      if (geo) {
        near = await stopsNear(geo.latitude, geo.longitude, 8);
        if (myGen !== searchGeneration) return;
      }
      const nearCodes = new Set(near.map((s) => s.BusStopCode));
      const otherStops = stops.filter((s) => !nearCodes.has(s.BusStopCode));

      if (services.length === 0 && near.length === 0 && otherStops.length === 0) {
        container.innerHTML = postal
          ? `<div class="search-result-item"><span class="search-result-detail">No location found for postal code ${escapeHtml(trimmed)}</span></div>`
          : '<div class="search-result-item"><span class="search-result-detail">No stops or bus services found</span></div>';
      } else {
        let html = "";
        if (services.length > 0) {
          html += `<div class="search-section-label">Bus services</div>`;
          html += services
            .map(
              (no) => `
            <div class="search-result-item search-result-item-service" onclick="selectService('${jsArg(no)}','${scope}')">
              <div class="search-result-name">&#128652; Bus ${escapeHtml(no)}</div>
              <div class="search-result-detail">Tap to view route &amp; stops</div>
            </div>`
            )
            .join("");
        }
        if (near.length > 0) {
          const label = geo.address ? escapeHtml(geo.address) : escapeHtml(trimmed);
          html += `<div class="search-section-label">Near ${label}</div>`;
          html += near
            .map(
              (s) => `
            <div class="search-result-item search-result-item--dist" onclick="selectStop('${s.BusStopCode}','${scope}')">
              <div>
                <div class="search-result-name">${escapeHtml(s.Description)}</div>
                <div class="search-result-detail">${s.BusStopCode} &middot; ${escapeHtml(s.RoadName)}</div>
              </div>
              <span class="search-result-dist">${formatDist(s.dist)}</span>
            </div>`
            )
            .join("");
        }
        if (otherStops.length > 0) {
          if (services.length > 0 || near.length > 0) html += `<div class="search-section-label">Matching stops</div>`;
          html += otherStops
            .map(
              (s) => `
            <div class="search-result-item" onclick="selectStop('${s.BusStopCode}','${scope}')">
              <div class="search-result-name">${escapeHtml(s.Description)}</div>
              <div class="search-result-detail">${s.BusStopCode} &middot; ${escapeHtml(s.RoadName)}</div>
            </div>`
            )
            .join("");
        }
        container.innerHTML = html;
      }
      container.classList.remove("hidden");
    } catch {
      if (myGen === searchGeneration) container.classList.add("hidden");
    }
  }, 300);
}

function selectService(serviceNo, scope = "arrivals") {
  const cfg = SEARCH_SCOPES[scope];
  document.getElementById(cfg.results).classList.add("hidden");
  document.getElementById(cfg.nearby).classList.add("hidden");
  openRouteStops(serviceNo);
}

function selectStop(code, scope = "arrivals") {
  const cfg = SEARCH_SCOPES[scope];
  document.getElementById(cfg.input).value = code;
  document.getElementById(cfg.results).classList.add("hidden");
  document.getElementById(cfg.nearby).classList.add("hidden");
  switchTab("arrivals");
  document.getElementById("stopSearch").value = code;
  searchStop();
}

// ── Reusable stop autocomplete (attached to any bus-stop input) ──
let stopAcId = 0;
function attachStopAutocomplete(input) {
  if (!input || input.dataset.acReady) return;
  input.dataset.acReady = "1";

  // Wrap the input so the dropdown can be absolutely positioned under it.
  const wrap = document.createElement("div");
  wrap.className = "stop-ac-wrap";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  const list = document.createElement("div");
  list.className = "stop-suggest hidden";
  list.id = `stopAc${++stopAcId}`;
  list.setAttribute("role", "listbox");
  wrap.appendChild(list);

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("autocomplete", "off");

  let matches = [];
  let emptyMessage = "No stops found";
  let active = -1;
  let debounce = null;

  const close = () => {
    list.classList.add("hidden");
    list.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  };

  const choose = (i) => {
    const s = matches[i];
    if (!s) return;
    input.value = s.BusStopCode;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    close();
    input.focus();
  };

  const highlight = (i) => {
    active = i;
    [...list.children].forEach((el, idx) => {
      const on = idx === active;
      el.classList.toggle("active", on);
      if (on) {
        input.setAttribute("aria-activedescendant", el.id);
        el.scrollIntoView({ block: "nearest" });
      }
    });
  };

  const render = () => {
    if (matches.length === 0) {
      list.innerHTML = `<div class="search-result-item"><span class="search-result-detail">${escapeHtml(emptyMessage)}</span></div>`;
    } else {
      list.innerHTML = matches
        .map(
          (s, i) => `
        ${s.sectionLabel ? `<div class="search-section-label">${escapeHtml(s.sectionLabel)}</div>` : ""}
        <div class="search-result-item${s.dist != null ? " search-result-item--dist" : ""}" role="option" id="${list.id}-o${i}" data-i="${i}">
          ${s.dist != null ? `
            <div>
              <div class="search-result-name">${escapeHtml(s.Description)}</div>
              <div class="search-result-detail">${s.BusStopCode} &middot; ${escapeHtml(s.RoadName)}</div>
            </div>
            <span class="search-result-dist">${formatDist(s.dist)}</span>
          ` : `
            <div class="search-result-name">${escapeHtml(s.Description)}</div>
            <div class="search-result-detail">${s.BusStopCode} &middot; ${escapeHtml(s.RoadName)}</div>
          `}
        </div>`
        )
        .join("");
      [...list.querySelectorAll("[data-i]")].forEach((el) => {
        el.addEventListener("mousedown", (e) => {
          e.preventDefault(); // keep focus, beat blur
          choose(parseInt(el.dataset.i));
        });
      });
    }
    list.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
    active = -1;
  };

  // Same code / name / postal-code / address capability as the main search
  // bars, so every bus-stop picker in the app behaves identically.
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    const val = input.value.trim();
    if (val.length < 2 || /^\d{5}$/.test(val)) {
      close();
      return;
    }
    debounce = setTimeout(async () => {
      try {
        const postal = isPostalCode(val);
        const pureNumeric = /^\d+$/.test(val);
        const shouldGeocode = postal || (!pureNumeric && val.length >= 4);
        const [stops, geo] = await Promise.all([
          postal ? [] : searchStops(val, 8),
          shouldGeocode ? geocodeAddress(val) : null,
        ]);

        let near = [];
        if (geo) near = await stopsNear(geo.latitude, geo.longitude, 6);
        const nearCodes = new Set(near.map((s) => s.BusStopCode));
        const otherStops = stops.filter((s) => !nearCodes.has(s.BusStopCode));

        matches = [];
        if (near.length > 0) {
          const label = `Near ${geo.address || val}`;
          near.forEach((s, i) => matches.push({ ...s, sectionLabel: i === 0 ? label : undefined }));
        }
        otherStops.forEach((s, i) =>
          matches.push({ ...s, sectionLabel: i === 0 && near.length > 0 ? "Matching stops" : undefined })
        );
        emptyMessage = postal ? `No location found for postal code ${val}` : "No stops found";
        render();
      } catch {
        close();
      }
    }, 250);
  });

  input.addEventListener("keydown", (e) => {
    if (list.classList.contains("hidden") || matches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlight((active + 1) % matches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlight((active - 1 + matches.length) % matches.length);
    } else if (e.key === "Enter") {
      if (active >= 0) {
        e.preventDefault();
        choose(active);
      }
    } else if (e.key === "Escape") {
      close();
    }
  });

  input.addEventListener("blur", () => setTimeout(close, 150));
}

// ── Address autocomplete (Home/Work — resolves to a geocoded address+coords,
// not a specific bus stop, since Home/Work now show nearby stops instead of
// pinning one fixed stop) ──
let addressAcId = 0;
function attachAddressAutocomplete(input) {
  if (!input || input.dataset.acReady) return;
  input.dataset.acReady = "1";

  const wrap = document.createElement("div");
  wrap.className = "stop-ac-wrap";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  const list = document.createElement("div");
  list.className = "stop-suggest hidden";
  list.id = `addrAc${++addressAcId}`;
  list.setAttribute("role", "listbox");
  wrap.appendChild(list);

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("autocomplete", "off");

  let matches = [];
  let active = -1;
  let debounce = null;

  const close = () => {
    list.classList.add("hidden");
    list.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  };

  const choose = (i) => {
    const m = matches[i];
    if (!m) return;
    input.value = m.address || input.value;
    input.dataset.lat = m.latitude;
    input.dataset.lng = m.longitude;
    input.dataset.postal = m.postal || "";
    input.dataset.resolvedFor = input.value;
    close();
    input.focus();
  };

  const highlight = (i) => {
    active = i;
    [...list.children].forEach((el, idx) => {
      const on = idx === active;
      el.classList.toggle("active", on);
      if (on) {
        input.setAttribute("aria-activedescendant", el.id);
        el.scrollIntoView({ block: "nearest" });
      }
    });
  };

  const render = () => {
    if (matches.length === 0) {
      list.innerHTML = '<div class="search-result-item"><span class="search-result-detail">No matching address</span></div>';
    } else {
      list.innerHTML = matches
        .map(
          (m, i) => `
        <div class="search-result-item" role="option" id="${list.id}-o${i}" data-i="${i}">
          <div class="search-result-name">${escapeHtml(m.address || "")}</div>
          ${m.postal ? `<div class="search-result-detail">Postal ${escapeHtml(m.postal)}</div>` : ""}
        </div>`
        )
        .join("");
      [...list.querySelectorAll("[data-i]")].forEach((el) => {
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          choose(parseInt(el.dataset.i));
        });
      });
    }
    list.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
    active = -1;
  };

  input.addEventListener("input", () => {
    delete input.dataset.lat;
    delete input.dataset.lng;
    delete input.dataset.postal;
    delete input.dataset.resolvedFor;
    clearTimeout(debounce);
    const val = input.value.trim();
    if (val.length < 3) {
      close();
      return;
    }
    debounce = setTimeout(async () => {
      try {
        matches = await geocodeSearch(val, 6);
        render();
      } catch {
        close();
      }
    }, 300);
  });

  input.addEventListener("keydown", (e) => {
    if (list.classList.contains("hidden") || matches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlight((active + 1) % matches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlight((active - 1 + matches.length) % matches.length);
    } else if (e.key === "Enter") {
      if (active >= 0) {
        e.preventDefault();
        choose(active);
      }
    } else if (e.key === "Escape") {
      close();
    }
  });

  input.addEventListener("blur", () => setTimeout(close, 150));
}

async function searchStop() {
  const input = document.getElementById("stopSearch").value.trim();
  if (!input) return;

  let stopCode = input;
  if (!/^\d{5}$/.test(input)) {
    const stops = await loadBusStops();
    const match = stops.find(
      (s) => s.Description.toLowerCase() === input.toLowerCase()
    );
    if (match) stopCode = match.BusStopCode;
    else stopCode = input;
  }

  await loadArrivals(stopCode);
  startAutoRefresh(stopCode);
}

function arrivalSkeleton() {
  return `
    <div class="card">
      <div class="bus-stop-header">
        <div style="flex:1;">
          <div class="skeleton skeleton-text-md" style="width:55%;margin-bottom:6px;"></div>
          <div class="skeleton skeleton-text-sm" style="width:30%;"></div>
        </div>
      </div>
      ${[0,1,2].map(() => `
        <div class="skeleton-row">
          <div class="skeleton skeleton-svc"></div>
          <div class="skeleton-badges">
            <div class="skeleton skeleton-badge"></div>
            <div class="skeleton skeleton-badge"></div>
            <div class="skeleton skeleton-badge"></div>
          </div>
        </div>`).join("")}
    </div>`;
}

async function loadArrivals(stopCode) {
  const container = document.getElementById("arrivalResults");
  container.innerHTML = arrivalSkeleton();
  try {
    const [data, routeInfo] = await Promise.all([
      fetchArrivals(stopCode),
      getStopRouteInfo(stopCode).catch(() => new Map()),
    ]);
    state.currentStop = stopCode;

    const stopName = await getStopName(stopCode);
    const isFav = state.favourites.some((f) => f.code === stopCode);

    const liveByNo = new Map();
    (data.Services || []).forEach((svc) => {
      const times = [svc.NextBus, svc.NextBus2, svc.NextBus3].map((b) => parseBusArrival(b));
      liveByNo.set(svc.ServiceNo, { no: svc.ServiceNo, times });
    });

    const activeServices = [...liveByNo.values()].sort((a, b) => {
      const aMin = Math.min(...a.times.map((t) => t.min ?? 999));
      const bMin = Math.min(...b.times.map((t) => t.min ?? 999));
      return aMin - bMin;
    });
    const inactiveServices = [...routeInfo.keys()]
      .filter((no) => !liveByNo.has(no))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    if (activeServices.length === 0 && inactiveServices.length === 0) {
      container.innerHTML = `
        <div class="card">
          <div class="bus-stop-header">
            <div>
              <h3>${escapeHtml(stopName)}</h3>
              <span class="bus-stop-code">${stopCode}</span>
            </div>
            <button class="icon-btn ${isFav ? "active" : ""}" onclick="toggleFav('${stopCode}','${jsArg(stopName)}')" title="Favourite">&#9733;</button>
          </div>
          <div class="empty-state"><p>No bus services at this time.</p></div>
        </div>`;
      return;
    }

    container.innerHTML = `
      <div class="card">
        <div class="bus-stop-header">
          <div>
            <h3>${escapeHtml(stopName)}</h3>
            <span class="bus-stop-code">${stopCode}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <div class="auto-refresh"><div class="dot"></div> Live</div>
            <button class="icon-btn ${isFav ? "active" : ""}" onclick="toggleFav('${stopCode}','${jsArg(stopName)}')" title="Favourite">&#9733;</button>
          </div>
        </div>
        ${activeServices.length === 0 ? '<div class="empty-state" style="padding:16px 0;"><p>No bus services at this time.</p></div>' : ""}
        ${activeServices.map((svc) => renderServiceRow(svc, stopCode, routeInfo.get(svc.no))).join("")}
        ${inactiveServices.length > 0 ? `
          <div class="service-inactive-label">Not currently running</div>
          ${inactiveServices.map((no) => renderInactiveServiceRow(no, stopCode, routeInfo.get(no))).join("")}
        ` : ""}
      </div>`;
  } catch (err) {
    container.innerHTML = `
      <div class="error-card">
        <div class="error-icon">⚠️</div>
        <p>${err.message.includes("API") ? "Couldn't load arrivals. Check your API key in Settings." : "Couldn't load arrivals. Check your connection."}</p>
        <button class="btn btn-sm" onclick="loadArrivals('${stopCode}')">Try again</button>
      </div>`;
  }
}

function parseBusArrival(bus) {
  if (!bus || !bus.EstimatedArrival)
    return { min: null, load: null, loadCode: null, type: null, feature: null, arrival: null };
  const diff = Math.round(
    (new Date(bus.EstimatedArrival) - new Date()) / 60000
  );
  const loadMap = { SEA: "Seats", SDA: "Standing", LSD: "Full" };
  const typeMap = { SD: "Single", DD: "Double", BD: "Bendy" };
  return {
    min: Math.max(0, diff),
    load: loadMap[bus.Load] || bus.Load,
    loadCode: bus.Load || null,
    type: typeMap[bus.Type] || bus.Type,
    feature: bus.Feature || null,
    arrival: bus.EstimatedArrival,
  };
}

// ── Arrival badge helpers (shared by arrivals tab, dashboard & live ticker) ──
function badgeClass(min) {
  if (min === null) return "na";
  if (min <= 1) return "arriving";
  if (min <= 5) return "soon";
  return "later";
}

function badgeLabel(min) {
  if (min === null) return "-";
  if (min <= 1) return "Arr";
  return `${min} min`;
}

function loadClass(code) {
  if (code === "SEA") return "load-ok";
  if (code === "SDA") return "load-busy";
  if (code === "LSD") return "load-full";
  return "";
}

// routeRow (optional) supplies today's scheduled first/last bus for this
// service at this stop, from BusRoutes — used to show that schedule under
// the service number and to flag whichever live arrival is the last bus.
function renderServiceRow(svc, stopCode, routeRow) {
  const sched = todaySchedule(routeRow);
  const badges = svc.times
    .map((t) => {
      const cls = badgeClass(t.min);
      if (t.min === null) {
        return '<span class="arrival-badge na"><span class="time-text">-</span></span>';
      }
      const isLast = isLastBusArrival(t.arrival, sched.lastMin);
      const metaParts = [];
      if (t.feature === "WAB")
        metaParts.push('<span class="wab" title="Wheelchair accessible">&#9855;</span>');
      if (t.load) metaParts.push(t.load);
      if (isLast) metaParts.push('<span class="last-bus-tag">Last bus</span>');
      const meta = metaParts.length
        ? `<span class="badge-meta ${loadClass(t.loadCode)}">${metaParts.join(" ")}</span>`
        : "";
      const dataAttr = t.arrival ? ` data-arrival="${t.arrival}"` : "";
      const cssCls = isLast ? `${cls} last-bus` : cls;
      return `<span class="arrival-badge ${cssCls}"${dataAttr}><span class="time-text">${badgeLabel(t.min)}</span>${meta}</span>`;
    })
    .join("");

  return `
    <div class="service-row">
      <div class="service-number-wrap">
        <button class="service-number" onclick="event.stopPropagation();openRouteStops('${svc.no}','${stopCode}')" aria-label="View stops for bus ${escapeHtml(svc.no)}">${escapeHtml(svc.no)}</button>
        ${scheduleLineHtml(sched)}
      </div>
      <div class="arrival-times">${badges}</div>
      <div class="service-actions">
        <button class="icon-btn" onclick="quickDeptReminder('${stopCode}','${svc.no}')" title="Remind me" aria-label="Set reminder for bus ${svc.no}">&#128276;</button>
      </div>
    </div>`;
}

// "First HH:MM · Last HH:MM" line shown under a service number, when known.
function scheduleLineHtml(sched) {
  if (sched.firstDisp === null && sched.lastDisp === null) return "";
  const parts = [];
  if (sched.firstDisp !== null) parts.push(`First ${sched.firstDisp}`);
  if (sched.lastDisp !== null) parts.push(`Last ${sched.lastDisp}`);
  return `<div class="service-schedule">${parts.join(" &middot; ")}</div>`;
}

// A service known to serve this stop (from the static route map) but with
// no live arrival right now — shown greyed out rather than hidden, so the
// full roster of routes is always visible. routeRow lets us explain *why*
// it's inactive: already past today's last bus, or not started yet.
function renderInactiveServiceRow(serviceNo, stopCode, routeRow) {
  const sched = todaySchedule(routeRow);
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  let status = "Not running";
  let ended = false;
  if (sched.lastMin !== null && nowMin > sched.lastMin) {
    status = `Last bus was ${sched.lastDisp}`;
    ended = true;
  } else if (sched.firstMin !== null && nowMin < sched.firstMin) {
    status = `First bus at ${sched.firstDisp}`;
  }
  return `
    <div class="service-row service-row--inactive">
      <div class="service-number-wrap">
        <button class="service-number" onclick="event.stopPropagation();openRouteStops('${serviceNo}','${stopCode}')" aria-label="View stops for bus ${escapeHtml(serviceNo)}">${escapeHtml(serviceNo)}</button>
        ${scheduleLineHtml(sched)}
      </div>
      <div class="arrival-times"><span class="arrival-badge na${ended ? " last-bus" : ""}"><span class="time-text">${escapeHtml(status)}</span></span></div>
      <div class="service-actions"></div>
    </div>`;
}

// ── Live countdown ticker ──
let arrivalTicker = null;

function startArrivalTicker() {
  clearInterval(arrivalTicker);
  arrivalTicker = setInterval(updateArrivalBadges, 1000);
}

function updateArrivalBadges() {
  const badges = document.querySelectorAll(".arrival-badge[data-arrival]");
  badges.forEach((b) => {
    const diff = Math.round((new Date(b.dataset.arrival) - new Date()) / 60000);
    const min = Math.max(0, diff);
    b.classList.remove("arriving", "soon", "later");
    b.classList.add(badgeClass(min));
    const tt = b.querySelector(".time-text");
    if (tt) tt.textContent = badgeLabel(min);
  });
}

function startAutoRefresh(stopCode) {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(
    () => loadArrivals(stopCode),
    state.refreshSec * 1000
  );
}

// ── Favourites ──
function toggleFav(code, name) {
  const idx = state.favourites.findIndex((f) => f.code === code);
  if (idx >= 0) {
    state.favourites.splice(idx, 1);
    showToast("Removed from favourites");
  } else {
    state.favourites.push({ code, name });
    showToast("Added to favourites");
  }
  localStorage.setItem(FAV_KEY, JSON.stringify(state.favourites));
  renderFavourites();
  refreshDashboard();
  syncPrefs();
  if (state.currentStop === code) loadArrivals(code);
}

function renderFavourites() {
  const list = document.getElementById("favList");
  const empty = document.getElementById("favEmpty");
  if (state.favourites.length === 0) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  list.innerHTML = state.favourites
    .map(
      (f) => `
    <div class="fav-item" onclick="goToStop('${f.code}')">
      <div>
        <div class="fav-name">${escapeHtml(f.name)}</div>
        <div class="fav-detail">${f.code}</div>
      </div>
      <button class="icon-btn" onclick="event.stopPropagation();toggleFav('${f.code}','${jsArg(f.name)}')" title="Remove">&#10005;</button>
    </div>`
    )
    .join("");
}

function goToStop(code) {
  switchTab("arrivals");
  document.getElementById("stopSearch").value = code;
  searchStop();
}

// ── Places (Home / Work shortcuts) ──
const PLACE_META = {
  home: { icon: "🏠", label: "Home" },
  work: { icon: "💼", label: "Work" },
};

function renderPlaces() {
  const container = document.getElementById("dashPlaces");
  if (!container) return;
  container.innerHTML = ["home", "work"]
    .map((key) => {
      const meta = PLACE_META[key];
      const place = state.places[key];
      if (place && place.address) {
        return `
          <button class="place-chip place-chip--set" onclick="openPlaceNearby('${key}')"
                  aria-label="${meta.label}: ${escapeHtml(place.address)}, view nearby stops">
            <span class="place-chip-icon" aria-hidden="true">${meta.icon}</span>
            <span class="place-chip-body">
              <span class="place-chip-label">${meta.label}</span>
              <span class="place-chip-name">${escapeHtml(place.address)}</span>
            </span>
            <span class="place-chip-edit" onclick="event.stopPropagation();openPlaceModal('${key}')"
                  role="button" aria-label="Edit ${meta.label}" title="Edit">✎</span>
          </button>`;
      }
      return `
        <button class="place-chip place-chip--empty" onclick="openPlaceModal('${key}')"
                aria-label="Set ${meta.label} address">
          <span class="place-chip-icon" aria-hidden="true">${meta.icon}</span>
          <span class="place-chip-body">
            <span class="place-chip-label">${meta.label}</span>
            <span class="place-chip-name place-chip-set">Set ${meta.label}</span>
          </span>
          <span class="place-chip-add" aria-hidden="true">+</span>
        </button>`;
    })
    .join("");
}

let editingPlaceKey = null;

async function openPlaceModal(key) {
  editingPlaceKey = key;
  const meta = PLACE_META[key];
  document.getElementById("placeModalTitle").textContent = `Set ${meta.label}`;
  const existing = state.places[key];
  const input = document.getElementById("placeStopInput");
  input.value = existing?.address || "";
  delete input.dataset.lat;
  delete input.dataset.lng;
  delete input.dataset.postal;
  delete input.dataset.resolvedFor;
  if (existing) {
    input.dataset.lat = existing.latitude;
    input.dataset.lng = existing.longitude;
    input.dataset.postal = existing.postal || "";
    input.dataset.resolvedFor = existing.address;
  }
  document.getElementById("placeModal").classList.remove("hidden");
  const removeBtn = document.getElementById("placeRemoveBtn");
  removeBtn.style.display = existing ? "" : "none";
  focusFirstInput("placeModal");
}

async function savePlace() {
  if (!editingPlaceKey) return;
  const input = document.getElementById("placeStopInput");
  const query = input.value.trim();
  if (!query) {
    showToast("Enter an address or postal code");
    return;
  }

  let geo;
  if (input.dataset.lat && input.dataset.resolvedFor === query) {
    geo = { address: query, postal: input.dataset.postal, latitude: parseFloat(input.dataset.lat), longitude: parseFloat(input.dataset.lng) };
  } else {
    geo = await geocodeAddress(query);
  }
  if (!geo) {
    showToast("Couldn't find that address — try a postal code or a more specific road name");
    return;
  }

  state.places[editingPlaceKey] = {
    address: geo.address || query,
    postal: geo.postal || "",
    latitude: geo.latitude,
    longitude: geo.longitude,
  };
  localStorage.setItem("bb_places", JSON.stringify(state.places));
  document.getElementById("placeModal").classList.add("hidden");
  renderPlaces();
  syncPrefs();
  showToast(`${PLACE_META[editingPlaceKey].label} set to ${state.places[editingPlaceKey].address}`);
}

function removePlace() {
  if (!editingPlaceKey) return;
  delete state.places[editingPlaceKey];
  localStorage.setItem("bb_places", JSON.stringify(state.places));
  document.getElementById("placeModal").classList.add("hidden");
  renderPlaces();
  syncPrefs();
}

// ── Home/Work "nearby stops" full-screen view ──
// Tapping a Home/Work chip doesn't jump to one fixed stop anymore — it opens
// the bus stops closest to that saved address, ranked by distance, so it
// stays useful even if the nearest stop to your door changes.
async function openPlaceNearby(key) {
  const place = state.places[key];
  if (!place) return;
  const meta = PLACE_META[key];
  document.getElementById("placeNearbyTitle").textContent = `${meta.icon} ${meta.label}`;
  document.getElementById("placeNearbySub").textContent = place.address;
  document.getElementById("placeNearbyList").innerHTML = '<div class="nearby-locating">Finding nearby stops...</div>';
  document.getElementById("placeNearbyModal").classList.remove("hidden");

  try {
    const nearest = await stopsNear(place.latitude, place.longitude, 10);
    document.getElementById("placeNearbyList").innerHTML = nearest
      .map(
        (s) => `
      <div class="nearby-card" onclick="closePlaceNearby();selectStop('${s.BusStopCode}')">
        <div class="nearby-info">
          <div class="nearby-name">${escapeHtml(s.Description)}</div>
          <div class="nearby-detail">${s.BusStopCode} &middot; ${escapeHtml(s.RoadName)}</div>
        </div>
        <div class="nearby-dist">${formatDist(s.dist)}</div>
      </div>`
      )
      .join("");
  } catch {
    document.getElementById("placeNearbyList").innerHTML = '<div class="nearby-locating">Couldn\'t load nearby stops.</div>';
  }
}

function closePlaceNearby() {
  document.getElementById("placeNearbyModal").classList.add("hidden");
}

// ── Departure Reminders ──
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_SHORT = ["S", "M", "T", "W", "T", "F", "S"];

// Render the 7 day-toggle buttons into a container. selected = array of 0–6.
function renderDayPicker(containerId, selected) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const sel = new Set(selected || []);
  el.innerHTML = DAY_SHORT.map(
    (d, i) =>
      `<button type="button" class="day-toggle${sel.has(i) ? " active" : ""}" data-day="${i}"
        aria-label="${DAY_LABELS[i]}" aria-pressed="${sel.has(i)}"
        onclick="toggleDay(this)">${d}</button>`
  ).join("");
}

function toggleDay(btn) {
  const on = btn.classList.toggle("active");
  btn.setAttribute("aria-pressed", on ? "true" : "false");
}

// Returns selected days as [0–6]; empty array means "every day".
function readDayPicker(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return [];
  return [...el.querySelectorAll(".day-toggle.active")].map((b) =>
    parseInt(b.dataset.day)
  );
}

// Human-readable summary of a reminder's day set.
function daysSummary(days) {
  if (!days || days.length === 0 || days.length === 7) return "Every day";
  const set = new Set(days);
  const weekdays = [1, 2, 3, 4, 5];
  const weekend = [0, 6];
  if (weekdays.every((d) => set.has(d)) && set.size === 5) return "Weekdays";
  if (weekend.every((d) => set.has(d)) && set.size === 2) return "Weekends";
  return [...days]
    .sort((a, b) => a - b)
    .map((d) => DAY_LABELS[d])
    .join(", ");
}

function openDepartureReminderModal() {
  renderDayPicker("deptDays", [1, 2, 3, 4, 5]); // default weekdays
  document.getElementById("deptReminderModal").classList.remove("hidden");
  focusFirstInput("deptReminderModal");
}

function saveDepartureReminder() {
  const reminder = {
    id: newId(),
    type: "scheduled",
    stop: document.getElementById("deptStop").value.trim(),
    service: document.getElementById("deptService").value.trim(),
    time: document.getElementById("deptTime").value,
    leadMin: parseInt(document.getElementById("deptLeadMin").value) || 5,
    nickname:
      document.getElementById("deptNickname").value.trim() ||
      `Bus ${document.getElementById("deptService").value.trim()} @ ${document.getElementById("deptStop").value.trim()}`,
    days: readDayPicker("deptDays"),
    enabled: true,
  };
  if (!reminder.stop || !reminder.service) {
    showToast("Please fill in stop code and service number");
    return;
  }
  state.departureReminders.push(reminder);
  localStorage.setItem(
    "bb_deptReminders",
    JSON.stringify(state.departureReminders)
  );
  document.getElementById("deptReminderModal").classList.add("hidden");
  renderDepartureReminders();
  refreshDashboard();
  syncPushReminders();
  showToast("Departure reminder saved");
}

function deleteDeptReminder(id) {
  state.departureReminders = state.departureReminders.filter(
    (r) => r.id !== id
  );
  localStorage.setItem(
    "bb_deptReminders",
    JSON.stringify(state.departureReminders)
  );
  renderDepartureReminders();
  refreshDashboard();
  syncPushReminders();
}

function toggleDeptReminder(id) {
  const r = state.departureReminders.find((r) => r.id === id);
  if (r) r.enabled = !r.enabled;
  localStorage.setItem(
    "bb_deptReminders",
    JSON.stringify(state.departureReminders)
  );
  renderDepartureReminders();
  refreshDashboard();
  syncPushReminders();
}

function renderDepartureReminders() {
  const container = document.getElementById("departureReminders");
  const visible = state.departureReminders.filter(r => !r.fromMode);
  if (visible.length === 0) {
    container.innerHTML =
      '<p style="color:var(--text2);font-size:13px;">No reminders set.</p>';
    return;
  }
  container.innerHTML = visible
    .map(
      (r) => `
    <div class="reminder-card">
      <div class="reminder-info">
        <span class="reminder-value">${escapeHtml(r.nickname)}</span>
        <span class="reminder-label">Bus ${escapeHtml(r.service)} @ stop ${escapeHtml(r.stop)} &middot; Leave by ${escapeHtml(r.time)} &middot; Alert ${escapeHtml(r.leadMin)}min before</span>
        <span class="reminder-label reminder-days">&#128197; ${daysSummary(r.days)}</span>
      </div>
      <div style="display:flex;gap:4px;">
        <button class="icon-btn ${r.enabled ? "active" : ""}" onclick="toggleDeptReminder('${r.id}')" title="Toggle" aria-label="${r.enabled ? "Disable" : "Enable"} reminder">${r.enabled ? "&#9654;" : "&#9724;"}</button>
        <button class="icon-btn" onclick="deleteDeptReminder('${r.id}')" title="Delete" aria-label="Delete reminder">&#10005;</button>
      </div>
    </div>`
    )
    .join("");
}

function quickDeptReminder(stopCode, serviceNo) {
  document.getElementById("deptStop").value = stopCode;
  document.getElementById("deptService").value = serviceNo;
  document.getElementById("deptNickname").value = `Bus ${serviceNo}`;
  openDepartureReminderModal();
}

function startDepartureChecker() {
  clearInterval(deptCheckTimer);
  checkDepartureReminders();
  deptCheckTimer = setInterval(checkDepartureReminders, 30000);
}

// This checker was dead code in production: it early-returned on an empty
// state.apiKey, which was always empty once the key moved to a server env var.
// Reviving it needs a cooldown, or a reminder in its window would re-fire
// every 30 seconds. One hour matches the server cron so the two agree about
// what "already alerted you about this" means.
const FOREGROUND_COOLDOWN_MS = 60 * 60 * 1000;
const foregroundLastFired = new Map();

async function checkDepartureReminders() {
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();

  const todayDow = now.getDay();
  for (const r of state.departureReminders) {
    if (!r.enabled) continue;
    if (Array.isArray(r.days) && r.days.length && !r.days.includes(todayDow))
      continue;
    const [h, m] = r.time.split(":").map(Number);
    const targetMins = h * 60 + m;
    const windowStart = targetMins - 30;
    const windowEnd = targetMins + 10;

    if (nowMins < windowStart || nowMins > windowEnd) continue;
    if (Date.now() - (foregroundLastFired.get(r.id) || 0) < FOREGROUND_COOLDOWN_MS)
      continue;

    try {
      const data = await fetchArrivals(r.stop, r.service);
      if (!data.Services || data.Services.length === 0) continue;
      const svc = data.Services[0];
      const next = parseBusArrival(svc.NextBus);
      if (next.min !== null && next.min <= r.leadMin) {
        foregroundLastFired.set(r.id, Date.now());
        sendNotification(
          `Bus ${r.service} arriving in ${next.min} min!`,
          `${r.nickname} - Time to head to stop ${r.stop}`
        );
      }
    } catch (e) { console.error('Reminder check failed:', e); }
  }
}

// ── Drop-off Alerts ──
function openDropoffModal() {
  document.getElementById("dropoffModal").classList.remove("hidden");
  focusFirstInput("dropoffModal");
}

function saveDropoffAlert() {
  const alert = {
    id: newId(),
    stopCode: document.getElementById("dropoffStopCode").value.trim(),
    radius: parseInt(document.getElementById("dropoffRadius").value) || 300,
    nickname:
      document.getElementById("dropoffNickname").value.trim() || "Drop-off",
    lat: null,
    lng: null,
  };
  if (!alert.stopCode) {
    showToast("Please enter a destination stop code");
    return;
  }
  state.dropoffAlerts.push(alert);
  localStorage.setItem(
    "bb_dropoffAlerts",
    JSON.stringify(state.dropoffAlerts)
  );
  document.getElementById("dropoffModal").classList.add("hidden");
  renderDropoffAlerts();
  refreshDashboard();
  resolveDropoffCoords(alert);
  syncPrefs();
  showToast("Drop-off alert saved");
}

async function resolveDropoffCoords(alert) {
  try {
    const stops = await loadBusStops();
    const stop = stops.find((s) => s.BusStopCode === alert.stopCode);
    if (stop) {
      alert.lat = stop.Latitude;
      alert.lng = stop.Longitude;
      localStorage.setItem(
        "bb_dropoffAlerts",
        JSON.stringify(state.dropoffAlerts)
      );
      syncPrefs();
    }
  } catch {}
}

function deleteDropoffAlert(id) {
  state.dropoffAlerts = state.dropoffAlerts.filter((a) => a.id !== id);
  localStorage.setItem(
    "bb_dropoffAlerts",
    JSON.stringify(state.dropoffAlerts)
  );
  renderDropoffAlerts();
  refreshDashboard();
  syncPrefs();
  if (activeDropoff && activeDropoff.id === id) stopDropoff();
}

function renderDropoffAlerts() {
  const container = document.getElementById("dropoffReminders");
  const visible = state.dropoffAlerts.filter(a => !a.fromMode);
  if (visible.length === 0) {
    container.innerHTML =
      '<p style="color:var(--text2);font-size:13px;">No drop-off alerts set.</p>';
    return;
  }
  container.innerHTML = visible
    .map(
      (a) => `
    <div class="reminder-card">
      <div class="reminder-info">
        <span class="reminder-value">${escapeHtml(a.nickname)}</span>
        <span class="reminder-label">Stop ${escapeHtml(a.stopCode)} &middot; ${escapeHtml(a.radius)}m radius ${a.lat ? "&#9989;" : "&#9888; resolving coords..."}</span>
      </div>
      <div style="display:flex;gap:4px;">
        <button class="btn btn-sm ${activeDropoff && activeDropoff.id === a.id ? "btn-danger" : ""}" onclick="${activeDropoff && activeDropoff.id === a.id ? "stopDropoff()" : `startDropoff('${a.id}')`}">
          ${activeDropoff && activeDropoff.id === a.id ? "Stop" : "Start"}
        </button>
        <button class="icon-btn" onclick="deleteDropoffAlert('${a.id}')" title="Delete">&#10005;</button>
      </div>
    </div>`
    )
    .join("");
}

function startDropoff(alertId) {
  const alert = state.dropoffAlerts.find((a) => a.id === alertId);
  if (!alert) return;
  if (!alert.lat || !alert.lng) {
    showToast("Coordinates not resolved yet. Try again in a moment.");
    return;
  }
  if (!navigator.geolocation) {
    showToast("Geolocation not supported in this browser");
    return;
  }

  activeDropoff = alert;
  requestWakeLock();
  document.getElementById("dropoffBanner").classList.remove("hidden");
  document.getElementById("dropoffDetail").textContent =
    `${alert.nickname} - Stop ${alert.stopCode} (${alert.radius}m radius)`;

  dropoffWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      const dist = haversine(
        pos.coords.latitude,
        pos.coords.longitude,
        alert.lat,
        alert.lng
      );
      document.getElementById("dropoffDetail").textContent =
        `${alert.nickname} - ${Math.round(dist)}m away`;
      if (dist <= alert.radius) {
        sendNotification(
          `Approaching ${alert.nickname}!`,
          `You're ${Math.round(dist)}m from stop ${alert.stopCode}. Prepare to alight!`
        );
        stopDropoff();
      }
    },
    (err) => {
      showToast("Location error: " + err.message);
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
  );

  renderDropoffAlerts();
  refreshDashboard();
}

function stopDropoff() {
  if (dropoffWatchId !== null) {
    navigator.geolocation.clearWatch(dropoffWatchId);
    dropoffWatchId = null;
  }
  activeDropoff = null;
  releaseWakeLock();
  document.getElementById("dropoffBanner").classList.add("hidden");
  renderDropoffAlerts();
  refreshDashboard();
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
    // Re-acquire if the page is hidden then shown again while tracking.
    document.addEventListener("visibilitychange", reacquireWakeLock);
  } catch (e) {
    console.error("Wake lock failed:", e);
  }
}

async function reacquireWakeLock() {
  if (activeDropoff && document.visibilityState === "visible" && !wakeLock) {
    requestWakeLock();
  }
}

function releaseWakeLock() {
  document.removeEventListener("visibilitychange", reacquireWakeLock);
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Journey Modes ──
async function postModes(modes) {
  localStorage.setItem("bb_modes", JSON.stringify(modes));
  try {
    await authFetch("/api/modes", {
      method: "POST",
      body: JSON.stringify(modes),
    });
  } catch {}
}

async function loadModes() {
  try {
    const remote = await authFetch("/api/modes").then(r => r.json());
    if (Array.isArray(remote)) {
      state.modes = remote;
      localStorage.setItem("bb_modes", JSON.stringify(remote));
    }
  } catch {}
  renderModes();
}

function openModeModal() {
  document.getElementById("modeModal").classList.remove("hidden");
  focusFirstInput("modeModal");
}

async function saveMode() {
  const name = document.getElementById("modeNameInput").value.trim();
  const departureStop = document.getElementById("modeDeptStop").value.trim();
  const service = document.getElementById("modeDeptService").value.trim();
  const leaveTime = document.getElementById("modeLeaveTime").value;
  const leadMin = parseInt(document.getElementById("modeLeadMin").value) || 5;
  const dropoffStop = document.getElementById("modeDropoffStop").value.trim();
  const dropoffRadius = parseInt(document.getElementById("modeDropoffRadius").value) || 300;

  if (!name || !departureStop || !service || !dropoffStop) {
    showToast("Please fill in all required fields");
    return;
  }

  const mode = {
    id: newId(),
    name,
    departureStop,
    service,
    leaveTime,
    leadMin,
    dropoffStop,
    dropoffRadius,
    dropoffLat: null,
    dropoffLng: null,
    active: false,
    createdVia: "app",
  };

  state.modes.push(mode);
  await postModes(state.modes);
  document.getElementById("modeModal").classList.add("hidden");
  renderModes();
  resolveModDropoffCoords(mode);
  showToast("Journey mode saved");
}

async function resolveModDropoffCoords(mode) {
  try {
    const stops = await loadBusStops();
    const stop = stops.find(s => s.BusStopCode === mode.dropoffStop);
    if (stop) {
      mode.dropoffLat = stop.Latitude;
      mode.dropoffLng = stop.Longitude;
      await postModes(state.modes);
      renderModes();
    }
  } catch {}
}

function renderModes() {
  const container = document.getElementById("modesContainer");
  if (!container) return;
  if (state.modes.length === 0) {
    container.innerHTML = '<p style="color:var(--text2);font-size:13px;">No modes saved yet. Add one to combine your bus reminder and drop-off alert in one tap.</p>';
    return;
  }
  container.innerHTML = state.modes.map(m => `
    <div class="reminder-card${m.active ? " reminder-card--active" : ""}">
      <div class="reminder-info">
        <span class="reminder-value">${escapeHtml(m.name)}</span>
        <span class="reminder-label">&#128652; Bus ${escapeHtml(m.service)} from stop ${escapeHtml(m.departureStop)} &middot; Leave by ${escapeHtml(m.leaveTime)} &middot; ${escapeHtml(m.leadMin)}min alert</span>
        <span class="reminder-label">&#128205; Drop-off stop ${escapeHtml(m.dropoffStop)} &middot; ${escapeHtml(m.dropoffRadius)}m ${m.dropoffLat ? "&#9989;" : "&#9888; resolving..."}</span>
      </div>
      <div style="display:flex;gap:4px;align-items:center;">
        <button class="btn btn-sm${m.active ? " btn-danger" : ""}" onclick="${m.active ? `deactivateMode('${m.id}')` : `activateMode('${m.id}')`}">
          ${m.active ? "Deactivate" : "Activate"}
        </button>
        <button class="icon-btn" onclick="deleteMode('${m.id}')" title="Delete">&#10005;</button>
      </div>
    </div>`).join("");
}

async function activateMode(id) {
  const prev = state.modes.find(m => m.active);
  if (prev && prev.id !== id) await deactivateMode(prev.id);

  const mode = state.modes.find(m => m.id === id);
  if (!mode) return;
  if (!mode.dropoffLat || !mode.dropoffLng) {
    showToast("Coordinates not resolved yet. Try again in a moment.");
    return;
  }

  // The derived reminder used to take the id `mode_<modeId>`, which is no
  // longer a legal primary key. Reuse the existing derived row's id when
  // re-activating so its firing history survives, and only mint a new one the
  // first time.
  const prevReminder = state.departureReminders.find((r) => r.fromMode === mode.id);
  const reminder = {
    id: prevReminder?.id || newId(),
    type: "scheduled",
    stop: mode.departureStop,
    service: mode.service,
    time: mode.leaveTime,
    leadMin: mode.leadMin,
    nickname: mode.name,
    enabled: true,
    fromMode: mode.id,
  };
  state.departureReminders = state.departureReminders.filter(r => r.fromMode !== mode.id);
  state.departureReminders.push(reminder);
  localStorage.setItem("bb_deptReminders", JSON.stringify(state.departureReminders));

  const prevDropoff = state.dropoffAlerts.find((a) => a.fromMode === mode.id);
  const dropoff = {
    id: prevDropoff?.id || newId(),
    stopCode: mode.dropoffStop,
    radius: mode.dropoffRadius,
    nickname: mode.name,
    lat: mode.dropoffLat,
    lng: mode.dropoffLng,
    fromMode: mode.id,
  };
  state.dropoffAlerts = state.dropoffAlerts.filter(a => a.fromMode !== mode.id);
  state.dropoffAlerts.push(dropoff);
  localStorage.setItem("bb_dropoffAlerts", JSON.stringify(state.dropoffAlerts));

  mode.active = true;
  await postModes(state.modes);
  syncPushReminders();
  syncPrefs();
  startDropoff(dropoff.id);
  renderModes();
  renderDepartureReminders();
}

async function deactivateMode(id) {
  const mode = state.modes.find(m => m.id === id);
  if (!mode) return;

  if (activeDropoff && activeDropoff.fromMode === mode.id) stopDropoff();
  state.departureReminders = state.departureReminders.filter(r => r.fromMode !== mode.id);
  localStorage.setItem("bb_deptReminders", JSON.stringify(state.departureReminders));
  state.dropoffAlerts = state.dropoffAlerts.filter(a => a.fromMode !== mode.id);
  localStorage.setItem("bb_dropoffAlerts", JSON.stringify(state.dropoffAlerts));

  mode.active = false;
  await postModes(state.modes);
  syncPushReminders();
  syncPrefs();
  renderModes();
  renderDepartureReminders();
  renderDropoffAlerts();
}

async function deleteMode(id) {
  const mode = state.modes.find(m => m.id === id);
  if (mode && mode.active) await deactivateMode(id);
  state.modes = state.modes.filter(m => m.id !== id);
  await postModes(state.modes);
  renderModes();
}

// ── Dashboard ──
function refreshDashboard() {
  renderPlaces();
  renderDashFavourites();
  renderDashReminders();
  renderDashDropoffs();
  refreshDashNearby();
}

// ── Dashboard "Nearby Stops" section ──
// Distinct from the search bar's suggestions: this is a persistent widget,
// so it's fine to actively request location on a real (button) gesture, but
// on plain dashboard visits it only auto-populates when permission is
// already granted — never surprises the user with a permission prompt.
let dashNearbyCache = null;
let dashNearbyCacheAt = 0;
const DASH_NEARBY_TTL_MS = 60 * 1000;

async function refreshDashNearby(forcePrompt = false) {
  const container = document.getElementById("dashNearby");
  if (!container) return;

  if (!navigator.geolocation) {
    container.innerHTML = `<div class="empty-state"><p>Geolocation isn't supported in this browser.</p></div>`;
    return;
  }

  if (!forcePrompt && dashNearbyCache && Date.now() - dashNearbyCacheAt < DASH_NEARBY_TTL_MS) {
    renderDashNearby(dashNearbyCache);
    return;
  }

  if (!forcePrompt && navigator.permissions && navigator.permissions.query) {
    try {
      const status = await navigator.permissions.query({ name: "geolocation" });
      if (status.state === "denied") {
        container.innerHTML = `<div class="empty-state"><p>Location access is blocked. Enable it in your browser settings to see nearby stops.</p></div>`;
        return;
      }
      if (status.state === "prompt") {
        container.innerHTML = `
          <div class="empty-state">
            <p>See the bus stops closest to you.</p>
            <button class="btn btn-sm" onclick="refreshDashNearby(true)">Enable location</button>
          </div>`;
        return;
      }
    } catch {
      container.innerHTML = `
        <div class="empty-state">
          <p>See the bus stops closest to you.</p>
          <button class="btn btn-sm" onclick="refreshDashNearby(true)">Enable location</button>
        </div>`;
      return;
    }
  }

  container.innerHTML = `<div class="nearby-locating">Locating you...</div>`;
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      try {
        const nearest = await stopsNear(latitude, longitude, 5);
        dashNearbyCache = nearest;
        dashNearbyCacheAt = Date.now();
        renderDashNearby(nearest);
      } catch {
        container.innerHTML = `<div class="empty-state"><p>Couldn't load bus stops.</p></div>`;
      }
    },
    () => {
      container.innerHTML = `
        <div class="empty-state">
          <p>Couldn't get your location.</p>
          <button class="btn btn-sm" onclick="refreshDashNearby(true)">Try again</button>
        </div>`;
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function renderDashNearby(nearest) {
  const container = document.getElementById("dashNearby");
  if (!container) return;
  container.innerHTML = nearest
    .map(
      (s) => `
    <div class="nearby-card" onclick="selectStop('${s.BusStopCode}','home')">
      <div class="nearby-info">
        <div class="nearby-name">${escapeHtml(s.Description)}</div>
        <div class="nearby-detail">${s.BusStopCode} &middot; ${escapeHtml(s.RoadName)}</div>
      </div>
      <div class="nearby-dist">${formatDist(s.dist)}</div>
    </div>`
    )
    .join("");
}

function renderDashFavourites() {
  const container = document.getElementById("dashFavStops");
  const empty = document.getElementById("dashFavEmpty");
  if (!container) return;

  if (state.favourites.length === 0) {
    container.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  container.innerHTML = state.favourites.map((fav, i) => `
    <div class="card dash-stop-card" id="dash-stop-${fav.code}" data-stop="${fav.code}">
      <div class="dash-stop-header">
        <div>
          <span class="dash-stop-name">${escapeHtml(fav.name)}</span>
          <span class="bus-stop-code">${fav.code}</span>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="dashLoadStop('${fav.code}')">Load</button>
      </div>
      <div class="dash-stop-arrivals" id="dash-arrivals-${fav.code}">
        ${i < 3 ? `<div style="padding:4px 0;">${[0,1].map(() => `
          <div class="skeleton-row">
            <div class="skeleton skeleton-svc" style="height:18px;"></div>
            <div class="skeleton-badges">
              <div class="skeleton skeleton-badge" style="height:28px;"></div>
              <div class="skeleton skeleton-badge" style="height:28px;"></div>
            </div>
          </div>`).join("")}</div>` : '<div class="dash-tap-load">Tap Load to see arrivals</div>'}
      </div>
    </div>
  `).join("");

  dashFetchQueue = state.favourites.slice(0, 3).map(f => f.code);
  processDashFetchQueue();
}

function processDashFetchQueue() {
  clearTimeout(dashFetchTimer);
  if (dashFetchQueue.length === 0) return;
  const code = dashFetchQueue.shift();
  dashLoadStop(code);
  if (dashFetchQueue.length > 0) {
    dashFetchTimer = setTimeout(processDashFetchQueue, DASH_FETCH_DELAY_MS);
  }
}

async function dashLoadStop(stopCode) {
  const container = document.getElementById(`dash-arrivals-${stopCode}`);
  if (!container) return;

  const cached = dashArrivalCache[stopCode];
  if (cached && (Date.now() - cached.timestamp) < DASH_CACHE_TTL) {
    renderDashArrivals(stopCode, cached.data);
    return;
  }

  container.innerHTML = `
    <div style="padding:4px 0;">
      ${[0,1].map(() => `
        <div class="skeleton-row">
          <div class="skeleton skeleton-svc" style="height:18px;"></div>
          <div class="skeleton-badges">
            <div class="skeleton skeleton-badge" style="height:28px;"></div>
            <div class="skeleton skeleton-badge" style="height:28px;"></div>
          </div>
        </div>`).join("")}
    </div>`;
  try {
    const data = await fetchArrivals(stopCode);
    dashArrivalCache[stopCode] = { data, timestamp: Date.now() };
    renderDashArrivals(stopCode, data);
  } catch {
    container.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 0;">
        <span style="color:var(--red);font-size:13px;">Failed to load</span>
        <button class="btn btn-ghost btn-sm" onclick="dashLoadStop('${stopCode}')">Retry</button>
      </div>`;
  }
}

async function renderDashArrivals(stopCode, data) {
  const container = document.getElementById(`dash-arrivals-${stopCode}`);
  if (!container) return;

  const card = document.getElementById(`dash-stop-${stopCode}`);
  const headerBtn = card.querySelector(".dash-stop-header .btn, .dash-stop-header .auto-refresh");
  if (headerBtn && headerBtn.classList.contains("btn")) {
    headerBtn.outerHTML = `
      <div style="display:flex;align-items:center;gap:8px;">
        <div class="auto-refresh"><div class="dot"></div> Live</div>
        <button class="icon-btn" onclick="event.stopPropagation();goToStop('${stopCode}')" title="Full view">&#8594;</button>
      </div>`;
  }

  if (!data.Services || data.Services.length === 0) {
    container.innerHTML = '<div class="dash-no-service">No services at this time</div>';
    return;
  }

  const services = data.Services.map(svc => {
    const times = [svc.NextBus, svc.NextBus2, svc.NextBus3].map(parseBusArrival);
    return { no: svc.ServiceNo, times };
  });
  services.sort((a, b) => {
    const aMin = Math.min(...a.times.map(t => t.min ?? 999));
    const bMin = Math.min(...b.times.map(t => t.min ?? 999));
    return aMin - bMin;
  });

  const shown = services.slice(0, DASH_MAX_SERVICES);
  const remaining = services.length - DASH_MAX_SERVICES;
  const routeInfo = await getStopRouteInfo(stopCode).catch(() => new Map());
  if (!document.getElementById(`dash-arrivals-${stopCode}`)) return; // navigated away meanwhile

  container.innerHTML = shown.map(svc => renderServiceRow(svc, stopCode, routeInfo.get(svc.no))).join("")
    + (remaining > 0
      ? `<div class="dash-more-link" onclick="goToStop('${stopCode}')">+${remaining} more service${remaining > 1 ? 's' : ''} &rsaquo;</div>`
      : "");
}

function startDashAutoRefresh() {
  clearInterval(dashRefreshTimer);
  dashRefreshTimer = setInterval(() => {
    const loadedStops = Object.keys(dashArrivalCache);
    if (loadedStops.length === 0) return;
    dashFetchQueue = loadedStops.slice();
    dashArrivalCache = {};
    processDashFetchQueue();
  }, state.refreshSec * 1000);
}

function stopDashAutoRefresh() {
  clearInterval(dashRefreshTimer);
}

function dashRefreshAll() {
  dashArrivalCache = {};
  dashFetchQueue = state.favourites.map(f => f.code);
  processDashFetchQueue();
  showToast("Refreshing all stops...");
}

function renderDashReminders() {
  const container = document.getElementById("dashDeptReminders");
  const empty = document.getElementById("dashDeptEmpty");
  if (!container) return;

  if (state.departureReminders.length === 0) {
    container.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  container.innerHTML = state.departureReminders.map(r => {
    const statusCls = r.enabled ? "active" : "idle";
    const statusText = r.enabled ? "Active" : "Off";
    const nextTrigger = r.enabled ? computeNextTrigger(r) : "";
    return `
      <div class="card dash-reminder-card ${r.enabled ? '' : 'dash-disabled'}">
        <div class="dash-reminder-top">
          <span class="reminder-value">${escapeHtml(r.nickname)}</span>
          <span class="reminder-status ${statusCls}">${statusText}</span>
        </div>
        <div class="reminder-label">Bus ${escapeHtml(r.service)} @ stop ${escapeHtml(r.stop)} &middot; Leave by ${escapeHtml(r.time)} &middot; Alert ${escapeHtml(r.leadMin)}min before</div>
        ${nextTrigger ? `<div class="dash-next-trigger">${nextTrigger}</div>` : ""}
      </div>`;
  }).join("");
}

function computeNextTrigger(reminder) {
  const now = new Date();
  const [h, m] = reminder.time.split(":").map(Number);
  const target = new Date();
  target.setHours(h, m, 0, 0);
  if (target <= now) return `Next: Tomorrow ${reminder.time}`;
  const diffMin = Math.round((target - now) / 60000);
  if (diffMin <= 60) return `Next: in ${diffMin} min`;
  return `Next: Today ${reminder.time}`;
}

function renderDashDropoffs() {
  const container = document.getElementById("dashDropoffs");
  const empty = document.getElementById("dashDropoffEmpty");
  if (!container) return;

  if (state.dropoffAlerts.length === 0) {
    container.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  container.innerHTML = state.dropoffAlerts.map(a => {
    const isActive = activeDropoff && activeDropoff.id === a.id;
    return `
      <div class="card dash-dropoff-card ${isActive ? 'dash-dropoff-active' : ''}">
        <div style="display:flex;align-items:center;gap:8px;">
          ${isActive ? '<div class="pulse"></div>' : ''}
          <div>
            <div class="reminder-value">${escapeHtml(a.nickname)}</div>
            <div class="reminder-label">Stop ${escapeHtml(a.stopCode)} &middot; ${escapeHtml(a.radius)}m radius${isActive ? ' &middot; Tracking' : ''}${a.lat ? '' : ' &middot; &#9888; resolving...'}</div>
          </div>
        </div>
        <button class="btn btn-sm ${isActive ? 'btn-danger' : 'btn-ghost'}"
                onclick="${isActive ? 'stopDropoff()' : `startDropoff('${a.id}')`}">
          ${isActive ? 'Stop' : 'Start'}
        </button>
      </div>`;
  }).join("");
}

// ── Map ──
function initMap() {
  map = L.map("busMap", { zoomControl: true }).setView([1.3521, 103.8198], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);
  mapMarkers = L.markerClusterGroup({ maxClusterRadius: 50 });
  map.addLayer(mapMarkers);
  loadMapStops();
  locateOnMap();
}

function makeBusStopIcon(isFav) {
  return L.divIcon({
    html: `<div class="map-pin-wrap"><div class="map-pin-head${isFav ? ' map-pin-head--fav' : ''}"><span class="map-pin-icon">🚌</span></div></div>`,
    className: '',
    iconSize: [22, 30],
    iconAnchor: [11, 28],
    popupAnchor: [0, -28],
  });
}

async function loadMapStops() {
  try {
    const stops = await loadBusStops();
    stops.forEach(s => {
      if (!s.Latitude || !s.Longitude) return;
      const isFav = state.favourites.some(f => f.code === s.BusStopCode);
      const marker = L.marker([s.Latitude, s.Longitude], { icon: makeBusStopIcon(isFav) });
      marker.bindPopup(`
        <div class="popup-name">${escapeHtml(s.Description)}</div>
        <div class="popup-detail">${s.BusStopCode} &middot; ${escapeHtml(s.RoadName)}</div>
        <div class="popup-arrivals" id="popup-arr-${s.BusStopCode}"><div class="popup-arr-loading">Loading arrivals…</div></div>
        <div class="popup-actions">
          <button class="btn btn-sm" onclick="goToStop('${s.BusStopCode}')">View Arrivals</button>
          <button class="icon-btn ${isFav ? 'active' : ''}" onclick="toggleFav('${s.BusStopCode}','${jsArg(s.Description)}')" title="Favourite">&#9733;</button>
        </div>
      `);
      marker.on("popupopen", () => loadPopupArrivals(s.BusStopCode));
      mapMarkers.addLayer(marker);
    });
  } catch {
    showToast("Failed to load bus stops on map");
  }
}

// Inject a compact live-arrival preview into an open map popup.
async function loadPopupArrivals(stopCode) {
  const el = document.getElementById(`popup-arr-${stopCode}`);
  if (!el) return;
  try {
    const data = await fetchArrivals(stopCode);
    if (!data.Services || data.Services.length === 0) {
      el.innerHTML = '<div class="popup-arr-empty">No services now</div>';
      return;
    }
    const services = data.Services.map((svc) => ({
      no: svc.ServiceNo,
      next: parseBusArrival(svc.NextBus),
    }))
      .sort((a, b) => (a.next.min ?? 999) - (b.next.min ?? 999))
      .slice(0, 4);
    el.innerHTML = services
      .map((s) => {
        const cls = badgeClass(s.next.min);
        const arr = s.next.arrival ? ` data-arrival="${s.next.arrival}"` : "";
        return `<div class="popup-arr-row">
          <span class="popup-arr-svc">${escapeHtml(s.no)}</span>
          <span class="arrival-badge ${cls}"${arr}><span class="time-text">${badgeLabel(s.next.min)}</span></span>
        </div>`;
      })
      .join("");
  } catch {
    el.innerHTML = '<div class="popup-arr-empty">Couldn\'t load arrivals</div>';
  }
}

// ── Combined route view: in-view map ──
function initRouteMap() {
  if (routeMap) return;
  routeMap = L.map("routeMap", { zoomControl: true }).setView([1.3521, 103.8198], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(routeMap);
}

// Draw the current service's polyline + stop markers on the in-view map.
async function drawRouteOnMap() {
  if (!routeMap) return;
  const stops = await getRouteStops(routeStopsService, routeStopsDirection);
  if (stops.length === 0) return;

  if (routeRouteLayer) routeMap.removeLayer(routeRouteLayer);
  routeRouteLayer = L.layerGroup().addTo(routeMap);

  const latlngs = stops.map((s) => [s.stop.Latitude, s.stop.Longitude]);
  L.polyline(latlngs, { color: "#0d9488", weight: 5, opacity: 0.8 }).addTo(routeRouteLayer);

  const classes = await Promise.all(stops.map((s) => classifyStop(s.stop)));
  stops.forEach((s, i) => {
    const ll = [s.stop.Latitude, s.stop.Longitude];
    const isEnd = i === 0 || i === stops.length - 1;
    const isAnchor = s.code === routeStopsAnchor;
    const cls = classes[i];
    let marker;
    if (cls.mrt || cls.interchange) {
      const emoji = cls.mrt ? "🚆" : "🔁";
      marker = L.marker(ll, {
        icon: L.divIcon({
          className: "route-marker",
          html: `<span class="route-marker-badge${cls.mrt ? " is-mrt" : " is-int"}">${emoji}</span>`,
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        }),
      });
    } else {
      marker = L.circleMarker(ll, {
        radius: isAnchor ? 9 : isEnd ? 7 : 4,
        fillColor: isEnd && !isAnchor ? "#f97316" : "#0d9488",
        color: "#fff",
        weight: isAnchor ? 4 : 2,
        opacity: 1,
        fillOpacity: 1,
      });
    }
    marker.addTo(routeRouteLayer).on("click", () => openRouteStopDetail(s.code));
  });

  const sheetH = Math.round(window.innerHeight * 0.72);
  routeMap.fitBounds(L.latLngBounds(latlngs), {
    paddingTopLeft: [30, 80],
    paddingBottomRight: [30, sheetH],
  });
}

// ── Combined route view: draggable bottom sheet ──
function setRouteSheet(stateName) {
  const sheet = document.getElementById("routeSheet");
  if (!sheet) return;
  sheet.style.height = "";
  sheet.classList.remove("route-sheet--full", "route-sheet--mid", "route-sheet--peek");
  sheet.classList.add(`route-sheet--${stateName}`);
}

let routeSheetDragReady = false;
function initRouteSheetDrag() {
  if (routeSheetDragReady) return;
  const handle = document.getElementById("routeSheetHandle");
  const sheet = document.getElementById("routeSheet");
  if (!handle || !sheet) return;
  routeSheetDragReady = true;

  let startY = 0, startH = 0, dragging = false;
  const snaps = () => ({
    peek: Math.round(window.innerHeight * 0.24),
    mid: Math.round(window.innerHeight * 0.45),
    full: Math.round(window.innerHeight * 0.72),
  });

  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    startY = e.clientY;
    startH = sheet.getBoundingClientRect().height;
    sheet.classList.add("route-sheet--dragging");
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const h = startH - (e.clientY - startY);
    const min = Math.round(window.innerHeight * 0.15);
    const max = Math.round(window.innerHeight * 0.85);
    sheet.style.height = Math.max(min, Math.min(max, h)) + "px";
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    sheet.classList.remove("route-sheet--dragging");
    const h = sheet.getBoundingClientRect().height;
    const s = snaps();
    const nearest = Object.keys(s).reduce((a, b) =>
      Math.abs(s[b] - h) < Math.abs(s[a] - h) ? b : a
    );
    setRouteSheet(nearest);
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

function closeRouteStops() {
  document.getElementById("routeStopsModal").classList.add("hidden");
  if (routeMap && routeSelMarker) {
    routeMap.removeLayer(routeSelMarker);
    routeSelMarker = null;
  }
}

// ── Line view (tap a bus number → scrollable stop sequence) ──
async function openRouteStops(serviceNo, anchorCode) {
  showToast(`Loading route for bus ${serviceNo}…`);
  try {
    const dirs = await getRouteDirections(serviceNo);
    if (dirs.length === 0) {
      showToast(`No route data for bus ${serviceNo}`);
      return;
    }
    // Pick the direction that actually contains the stop we tapped from.
    let direction = dirs[0];
    for (const d of dirs) {
      const stops = await getRouteStops(serviceNo, d);
      if (stops.some((s) => s.code === anchorCode)) {
        direction = d;
        break;
      }
    }
    routeStopsService = serviceNo;
    routeStopsDirection = direction;
    routeStopsAnchor = anchorCode;

    document.getElementById("routeStopDetail").classList.add("hidden");
    document.getElementById("routeStopsListView").classList.remove("hidden");
    setRouteSheet("full");
    document.getElementById("routeStopsModal").classList.remove("hidden");

    await renderRouteStopsList();
    initRouteMap();
    initRouteSheetDrag();
    setTimeout(() => {
      if (routeMap) routeMap.invalidateSize();
      drawRouteOnMap();
    }, 60);
  } catch {
    showToast("Couldn't load route");
  }
}

async function renderRouteStopsList() {
  const dirs = await getRouteDirections(routeStopsService);
  const stops = await getRouteStops(routeStopsService, routeStopsDirection);
  if (stops.length === 0) {
    showToast(`No route data for bus ${routeStopsService}`);
    return;
  }
  const anchorIndex = stops.findIndex((s) => s.code === routeStopsAnchor);

  document.getElementById("routeStopsTitle").textContent = `Bus ${routeStopsService}`;
  const origin = stops[0].stop.Description;
  const dest = stops[stops.length - 1].stop.Description;
  document.getElementById("routeStopsSub").textContent =
    `${origin} → ${dest} · ${stops.length} stops`;

  const reverseBtn = document.getElementById("routeStopsReverse");
  reverseBtn.classList.toggle("hidden", dirs.length < 2);

  const tags = await Promise.all(stops.map((s) => classifyStop(s.stop)));
  const list = document.getElementById("routeStopsList");
  list.innerHTML = stops
    .map((s, i) => {
      let cls = "upcoming";
      if (anchorIndex !== -1 && i < anchorIndex) cls = "passed";
      else if (i === anchorIndex) cls = "current";
      const here = i === anchorIndex ? '<span class="route-here-badge">Here</span>' : "";
      return `
        <button class="route-stop-item ${cls}" onclick="openRouteStopDetail('${s.code}')" aria-label="${escapeHtml(s.stop.Description)}, view stop details">
          <span class="route-stop-rail"><span class="route-stop-dot"></span></span>
          <span class="route-stop-body">
            <span class="route-stop-name">${escapeHtml(s.stop.Description)}${here}${stopTagsHtml(tags[i])}</span>
            <span class="route-stop-meta">Stop ${s.seq} · ${s.code}${s.stop.RoadName ? " · " + escapeHtml(s.stop.RoadName) : ""}</span>
          </span>
          <span class="route-stop-chevron" aria-hidden="true">›</span>
        </button>`;
    })
    .join("");

  // Bring the current stop into view.
  requestAnimationFrame(() => {
    const cur = list.querySelector(".route-stop-item.current");
    if (cur) cur.scrollIntoView({ block: "center" });
    else list.scrollTop = 0;
  });
}

async function toggleRouteStopsDirection() {
  const dirs = await getRouteDirections(routeStopsService);
  routeStopsDirection =
    dirs.find((d) => d !== routeStopsDirection) ?? routeStopsDirection;
  await renderRouteStopsList();
  await drawRouteOnMap();
}

function backToRouteStops() {
  document.getElementById("routeStopDetail").classList.add("hidden");
  document.getElementById("routeStopsListView").classList.remove("hidden");
  setRouteSheet("full");
  if (routeMap && routeSelMarker) {
    routeMap.removeLayer(routeSelMarker);
    routeSelMarker = null;
  }
  // Re-fit the whole route now that the sheet is back to full height.
  drawRouteOnMap();
}

async function openRouteStopDetail(code) {
  document.getElementById("routeStopsListView").classList.add("hidden");
  document.getElementById("routeStopDetail").classList.remove("hidden");
  setRouteSheet("mid");
  const body = document.getElementById("routeStopDetailBody");
  const st = (await getBusStopIndex()).get(code);
  const stopName = st ? st.Description : await getStopName(code);
  const cls = await classifyStop(st);

  // Zoom the in-view map to the tapped stop and highlight it.
  if (routeMap && st) {
    if (routeSelMarker) routeMap.removeLayer(routeSelMarker);
    routeSelMarker = L.circleMarker([st.Latitude, st.Longitude], {
      radius: 11, fillColor: "#0d9488", color: "#fff",
      weight: 4, opacity: 1, fillOpacity: 0.9,
    }).addTo(routeMap);
    setTimeout(() => {
      routeMap.invalidateSize();
      routeMap.setView([st.Latitude, st.Longitude], 17);
      // Lift the stop into the strip visible above the bottom sheet.
      routeMap.panBy([0, Math.round(window.innerHeight * 0.22)], { animate: false });
    }, 280);
  }

  body.innerHTML = `
    <div class="route-detail-name">${escapeHtml(stopName)}${stopTagsHtml(cls)}</div>
    <div class="route-detail-code">${code}</div>
    <div class="route-detail-section-label">Live arrivals</div>
    <div id="routeStopDetailArrivals">${arrivalSkeleton()}</div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeRouteStops();goToStop('${code}')">Full arrivals ↗</button>
    </div>`;

  // Load live arrivals into the detail view, reusing the arrivals renderer.
  try {
    const [data, routeInfo] = await Promise.all([
      fetchArrivals(code),
      getStopRouteInfo(code).catch(() => new Map()),
    ]);
    const target = document.getElementById("routeStopDetailArrivals");
    if (!target) return; // user navigated away
    if (!data.Services || data.Services.length === 0) {
      target.innerHTML = `<div class="empty-state"><p>No buses running right now.</p></div>`;
      return;
    }
    const services = data.Services.map((svc) => ({
      no: svc.ServiceNo,
      times: [svc.NextBus, svc.NextBus2, svc.NextBus3].map((b) => parseBusArrival(b)),
    }));
    services.sort((a, b) => {
      const aMin = Math.min(...a.times.map((t) => t.min ?? 999));
      const bMin = Math.min(...b.times.map((t) => t.min ?? 999));
      return aMin - bMin;
    });
    target.innerHTML = services.map((svc) => renderServiceRow(svc, code, routeInfo.get(svc.no))).join("");
  } catch {
    const target = document.getElementById("routeStopDetailArrivals");
    if (target) target.innerHTML = `<div class="empty-state"><p>Couldn't load arrivals.</p></div>`;
  }
}

function locateOnMap() {
  if (!map || !navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      map.setView([latitude, longitude], 16);
      if (mapUserMarker) map.removeLayer(mapUserMarker);
      mapUserMarker = L.circleMarker([latitude, longitude], {
        radius: 10, fillColor: "#10b981", color: "#fff",
        weight: 3, opacity: 1, fillOpacity: 0.9,
      }).addTo(map).bindPopup("You are here");
    },
    () => {},
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// ── Nearby Stops ──
// Radius bands (metres) tried in order — stop widening as soon as enough
// stops are found nearby, so "top suggestions" stay genuinely close by.
const NEARBY_RADII_M = [300, 500, 1000];

async function findNearbyStops(scope = "arrivals") {
  const cfg = SEARCH_SCOPES[scope];
  const container = document.getElementById(cfg.nearby);
  container.classList.remove("hidden");
  container.innerHTML = '<div class="nearby-locating">Locating you...</div>';

  if (!navigator.geolocation) {
    container.innerHTML = '<div class="nearby-locating">Geolocation not supported in this browser.</div>';
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      try {
        const stops = await loadBusStops();
        const withDist = stops.map((s) => ({
          ...s,
          dist: haversine(latitude, longitude, s.Latitude, s.Longitude),
        }));
        withDist.sort((a, b) => a.dist - b.dist);

        let radius = null;
        let nearest = [];
        for (const r of NEARBY_RADII_M) {
          nearest = withDist.filter((s) => s.dist <= r);
          if (nearest.length >= 3) {
            radius = r;
            break;
          }
        }
        if (nearest.length === 0) nearest = withDist.slice(0, 5);
        nearest = nearest.slice(0, 10);

        container.innerHTML = `
          <div class="nearby-header">
            <h3>Nearest Bus Stops${radius ? ` <span style="font-weight:400;font-size:12px;color:var(--text2);">within ${radius}m</span>` : ""}</h3>
            <button class="btn btn-ghost btn-sm" onclick="document.getElementById('${cfg.nearby}').classList.add('hidden')">Close</button>
          </div>
          ${nearest
            .map(
              (s) => `
            <div class="nearby-card" onclick="selectStop('${s.BusStopCode}','${scope}')">
              <div class="nearby-info">
                <div class="nearby-name">${escapeHtml(s.Description)}</div>
                <div class="nearby-detail">${s.BusStopCode} &middot; ${escapeHtml(s.RoadName)}</div>
              </div>
              <div class="nearby-dist">${formatDist(s.dist)}</div>
            </div>`
            )
            .join("")}`;
      } catch {
        container.innerHTML = '<div class="nearby-locating">Failed to load bus stops.</div>';
      }
    },
    (err) => {
      container.innerHTML = `<div class="nearby-locating">Location error: ${err.message}</div>`;
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// If the search box is (or becomes) empty and we already have location
// permission, surface nearby stops as top suggestions without prompting.
function handleSearchFocus(scope = "arrivals") {
  const cfg = SEARCH_SCOPES[scope];
  if (!document.getElementById(cfg.input).value.trim()) maybeSuggestNearby(scope);
}

async function maybeSuggestNearby(scope = "arrivals") {
  if (!navigator.geolocation || !navigator.permissions || !navigator.permissions.query) return;
  try {
    const status = await navigator.permissions.query({ name: "geolocation" });
    if (status.state === "granted") findNearbyStops(scope);
  } catch {
    // permissions API unsupported for this query — skip silent auto-suggest
  }
}

function formatDist(m) {
  if (m < 1000) return `${Math.round(m)}m`;
  return `${(m / 1000).toFixed(1)}km`;
}

// ── Settings ──
async function openSettings() {
  const langSel = document.getElementById("langSelect");
  if (langSel && typeof currentLang !== "undefined") langSel.value = currentLang;
  document.getElementById("refreshInterval").value = state.refreshSec;
  document.getElementById("reminderLead").value = state.reminderLeadMin;
  const soundName = localStorage.getItem('bb_alert_sound_name');
  document.getElementById("alertSoundName").textContent = soundName || "Default chime";
  document.getElementById("clearSoundBtn").style.display = soundName ? "" : "none";
  document.getElementById("settingsModal").classList.remove("hidden");
  if (!("Notification" in window) || !("PushManager" in window)) setPushStatus("unsupported");
  else if (Notification.permission !== "granted") setPushStatus("permission");
  else if (pushSubscription) setPushStatus("enabled");
  else initPush();
  const cached = await getCachedBusStops();
  const infoEl = document.getElementById("busStopCacheInfo");
  if (cached) {
    const age = Date.now() - cached.cachedAt;
    const days = Math.floor(age / 86400000);
    const hours = Math.floor((age % 86400000) / 3600000);
    const ageStr = days > 0 ? `${days}d ${hours}h ago` : `${hours}h ago`;
    infoEl.textContent = `${cached.stops.length} stops cached · last updated ${ageStr}`;
  } else {
    infoEl.textContent = "Not cached yet";
  }
  refreshServerKeyStatus();
  refreshTelegramStatus();
}

// The LTA key is a server env var, so there is nothing to type here any more —
// but "is it actually configured?" is still worth answering, because every
// arrival in the app fails silently without it.
async function refreshServerKeyStatus() {
  const el = document.getElementById("ltaKeyStatus");
  if (!el) return;
  try {
    const { hasKey } = await fetch("/api/check-key").then((r) => r.json());
    el.textContent = hasKey
      ? "✅ LTA DataMall key configured on the server."
      : "❌ LTA_API_KEY isn't set on the server — arrivals won't load. See SETUP.md.";
  } catch {
    el.textContent = "⚠️ Couldn't check the server's LTA key.";
  }
}

// ── Telegram account linking ──
// The bot has no Supabase session — a webhook only carries a chat id — so the
// two are paired with a short-lived code the user types into the chat once.
async function refreshTelegramStatus() {
  const el = document.getElementById("tgStatus");
  if (!el) return;
  try {
    const res = await authFetch("/api/telegram-link");
    if (!res.ok) throw new Error();
    const { linked, chats } = await res.json();
    el.textContent = linked
      ? `✅ Linked to ${chats} Telegram chat${chats === 1 ? "" : "s"}.`
      : "Not linked. Get a code, then send it to the bot as /link CODE.";
    document.getElementById("tgUnlinkBtn").style.display = linked ? "" : "none";
  } catch {
    el.textContent = "Couldn't check Telegram link status.";
  }
}

async function requestTelegramCode() {
  const el = document.getElementById("tgStatus");
  try {
    const res = await authFetch("/api/telegram-link", { method: "POST", body: "{}" });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
    const { code, expiresInMin } = await res.json();
    el.innerHTML = `Send <code>/link ${escapeHtml(code)}</code> to the Bus Buddy bot within ${expiresInMin} minutes.`;
  } catch (e) {
    el.textContent = "Couldn't get a link code: " + e.message;
  }
}

async function unlinkTelegram() {
  try {
    await authFetch("/api/telegram-link", { method: "DELETE" });
    showToast("Telegram unlinked");
  } catch {
    showToast("Couldn't unlink Telegram");
  }
  refreshTelegramStatus();
}

async function refreshBusStopsCache() {
  state.busStops = null;
  document.getElementById("busStopCacheInfo").textContent = "Refreshing...";
  await loadBusStops(true);
  openSettings();
}

function saveAlertSound(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) {
    showToast("File too large — choose a sound under 3 MB.");
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      localStorage.setItem('bb_alert_sound', e.target.result);
      localStorage.setItem('bb_alert_sound_name', file.name);
      document.getElementById("alertSoundName").textContent = file.name;
      document.getElementById("clearSoundBtn").style.display = "";
      new Audio(e.target.result).play().catch(() => {});
    } catch {
      showToast("Could not save audio — try a smaller file.");
    }
  };
  reader.readAsDataURL(file);
}

function clearAlertSound() {
  localStorage.removeItem('bb_alert_sound');
  localStorage.removeItem('bb_alert_sound_name');
  document.getElementById("alertSoundName").textContent = "Default chime";
  document.getElementById("clearSoundBtn").style.display = "none";
  document.getElementById("alertSoundInput").value = "";
}

async function saveSettings() {
  state.refreshSec =
    parseInt(document.getElementById("refreshInterval").value) || 30;
  state.reminderLeadMin =
    parseInt(document.getElementById("reminderLead").value) || 5;

  localStorage.setItem("bb_refreshSec", state.refreshSec.toString());
  localStorage.setItem("bb_reminderLead", state.reminderLeadMin.toString());

  syncPrefs();
  startDashAutoRefresh();
  document.getElementById("settingsModal").classList.add("hidden");
  showToast("Settings saved");
}

// ── Audio ──
async function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }
  return audioCtx;
}

function unlockAudio() {
  ensureAudioContext();
}

async function playAlertSound() {
  const customSound = localStorage.getItem('bb_alert_sound');
  if (customSound) {
    try {
      const audio = new Audio(customSound);
      audio.volume = 1;
      await audio.play();
    } catch (e) {
      console.error('Audio alert failed:', e);
    }
    return;
  }
  // Fallback: synthesized chime
  try {
    const ctx = await ensureAudioContext();
    const notes = [
      [880,  0.0,  0.15, 0.4],
      [1046, 0.18, 0.15, 0.4],
      [880,  0.36, 0.25, 0.3],
    ];
    const now = ctx.currentTime;
    notes.forEach(([freq, start, dur, gain]) => {
      const osc = ctx.createOscillator();
      const amp = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + start);
      amp.gain.setValueAtTime(0, now + start);
      amp.gain.linearRampToValueAtTime(gain, now + start + 0.02);
      amp.gain.exponentialRampToValueAtTime(0.001, now + start + dur);
      osc.connect(amp);
      amp.connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur + 0.05);
    });
  } catch (e) {
    console.error('Audio alert failed:', e);
  }
}

function triggerVibration() {
  if ('vibrate' in navigator) {
    navigator.vibrate([200, 100, 200, 100, 400]);
  }
}

// ── Notifications ──
function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    ensureAudioContext();
    return;
  }
  if (Notification.permission === 'default') {
    Notification.requestPermission().then(permission => {
      if (permission === 'granted') {
        ensureAudioContext();
        initPush();
      }
    });
  }
}

async function sendNotification(title, body) {
  await playAlertSound();
  triggerVibration();
  if ('Notification' in window && Notification.permission === 'granted') {
    const opts = {
      body,
      icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='80' font-size='80'>🚌</text></svg>",
      requireInteraction: true,
      tag: 'bus-buddy-alert',
      renotify: true,
    };
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.ready;
      reg.showNotification(title, opts);
    } else {
      new Notification(title, opts);
    }
  }
  showToast(`${title} - ${body}`);
}

// ── Web Push (background alerts) ──
// The device id is no longer an identity — it just distinguishes this browser
// from the other devices on the same account, so one account can hold several
// push subscriptions.
function getDeviceId() {
  let id = localStorage.getItem("bb_deviceId");
  if (!id) {
    id = "d_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem("bb_deviceId", id);
  }
  return id;
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

let pushSubscription = null;

async function initPush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    setPushStatus("unsupported");
    return;
  }
  if (Notification.permission !== "granted") {
    setPushStatus("permission");
    return;
  }
  try {
    const { key } = await fetch("/api/vapid-public-key").then((r) => r.json());
    if (!key) {
      setPushStatus("unsupported");
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
    }
    pushSubscription = sub;
    await registerPushDevice();
    setPushStatus("enabled");
  } catch (e) {
    console.error("Push init failed:", e);
    setPushStatus("error");
  }
}

// Registers this browser as one of the account's push targets. Several devices
// can be registered at once; the cron fans every alert out to all of them.
async function registerPushDevice() {
  if (!pushSubscription) return;
  try {
    await authFetch("/api/push", {
      method: "POST",
      body: JSON.stringify({
        deviceId: getDeviceId(),
        subscription: pushSubscription,
      }),
    });
  } catch (e) {
    console.error("Push registration failed:", e);
  }
}

// Called on sign-out: this browser must stop receiving the outgoing account's
// alerts, even though the push subscription itself survives in the browser.
async function unregisterPushForDevice() {
  await authFetch(
    `/api/push?deviceId=${encodeURIComponent(getDeviceId())}`,
    { method: "DELETE" }
  );
}

// ── Server sync ──
// Two stores, because they have different owners. The preference blob
// (favourites, places, settings) is written only by the client, so a single
// merged document is fine. Reminders live in their own table because the cron
// writes to them too — keeping them out of the blob is what stops a "last
// write wins" save from resurrecting a fired reminder's cooldown.
function remindersToRows() {
  return state.departureReminders.map((r) => {
    const { id, ...payload } = r;
    return { id, type: r.type || "scheduled", payload };
  });
}

function rowsToReminders(rows) {
  return (rows || []).map((row) => ({ ...row.payload, id: row.id, type: row.type }));
}

let prefsSyncTimer = null;

// Coalesces the bursts of writes that a single user action can produce —
// toggling a favourite calls this from three different render paths.
function syncPrefs() {
  clearTimeout(prefsSyncTimer);
  prefsSyncTimer = setTimeout(pushPrefsNow, 400);
}

async function pushPrefsNow() {
  try {
    await authFetch("/api/prefs", {
      method: "POST",
      body: JSON.stringify({
        data: {
          favourites: state.favourites,
          places: state.places,
          dropoffAlerts: state.dropoffAlerts,
          settings: {
            refreshSec: state.refreshSec,
            reminderLeadMin: state.reminderLeadMin,
          },
        },
      }),
    });
  } catch (e) {
    console.error("Prefs sync failed:", e);
  }
}

async function syncPushReminders() {
  try {
    await authFetch("/api/reminders", {
      method: "POST",
      body: JSON.stringify({ reminders: remindersToRows() }),
    });
  } catch (e) {
    console.error("Reminder sync failed:", e);
  }
}

// On startup, pull this *account's* stored state. Unlike the old
// device-keyed version, this genuinely restores across devices: sign in on a
// new phone and your favourites, places and reminders are already there.
//
// The server is authoritative on load. Local storage is a cache for offline
// starts, not a second source of truth — treating it as one is what produced
// the old "whichever device edited last silently wins" behaviour.
async function restorePrefs() {
  try {
    const [prefsRes, remRes] = await Promise.all([
      authFetch("/api/prefs"),
      authFetch("/api/reminders"),
    ]);
    if (!prefsRes.ok || !remRes.ok) return;

    const { data } = await prefsRes.json();
    const { reminders } = await remRes.json();

    if (data && typeof data === "object") {
      if (Array.isArray(data.favourites)) {
        state.favourites = data.favourites;
        localStorage.setItem(FAV_KEY, JSON.stringify(state.favourites));
      }
      if (data.places && typeof data.places === "object") {
        state.places = sanitizePlaces(data.places);
        localStorage.setItem("bb_places", JSON.stringify(state.places));
      }
      if (Array.isArray(data.dropoffAlerts)) {
        state.dropoffAlerts = data.dropoffAlerts;
        localStorage.setItem("bb_dropoffAlerts", JSON.stringify(state.dropoffAlerts));
      }
      if (data.settings) {
        if (data.settings.refreshSec) state.refreshSec = data.settings.refreshSec;
        if (data.settings.reminderLeadMin)
          state.reminderLeadMin = data.settings.reminderLeadMin;
        localStorage.setItem("bb_refreshSec", String(state.refreshSec));
        localStorage.setItem("bb_reminderLead", String(state.reminderLeadMin));
      }
    }

    if (Array.isArray(reminders)) {
      state.departureReminders = rowsToReminders(reminders);
      localStorage.setItem(
        "bb_deptReminders",
        JSON.stringify(state.departureReminders)
      );
    }

    renderFavourites();
    renderDepartureReminders();
    renderDropoffAlerts();
    renderPlaces();
    refreshDashboard();
  } catch (e) {
    console.error("Prefs restore failed:", e);
  }
}

function setPushStatus(status) {
  const el = document.getElementById("pushStatus");
  if (!el) return;
  const map = {
    enabled: "✅ Background alerts enabled — alerts will reach you with the app closed.",
    permission: "⚠️ Allow notifications to enable background alerts.",
    unsupported: "❌ Background alerts not supported on this browser.",
    error: "⚠️ Couldn't enable background alerts. Try reloading.",
  };
  el.textContent = map[status] || "";
}

async function testBackgroundAlert() {
  if (Notification.permission !== "granted") {
    showToast("Allow notifications first, then try again.");
    requestNotificationPermission();
    return;
  }
  if (!pushSubscription) await initPush();
  showToast("Sending background alert… lock your phone to see it arrive.");
  try {
    const res = await authFetch("/api/test-push", { method: "POST", body: "{}" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast("Background test failed: " + (err.error || res.status));
    } else {
      const out = await res.json().catch(() => ({}));
      if (out.devices > 1) showToast(`Sent to ${out.sent} of ${out.devices} devices on this account.`);
    }
  } catch (e) {
    showToast("Background test failed: " + e.message);
  }
}

// ── Onboarding (first-run) ──
let onboardingStep = 0;

function maybeShowOnboarding() {
  if (localStorage.getItem("bb_onboarded")) return;
  onboardingStep = 0;
  showOnboardingStep(0);
  document.getElementById("onboardingModal").classList.remove("hidden");
}

function showOnboardingStep(step) {
  onboardingStep = step;
  document.querySelectorAll("#onboardingModal .onb-step").forEach((el) => {
    el.classList.toggle("hidden", parseInt(el.dataset.step) !== step);
  });
  document.querySelectorAll("#onboardingModal .onb-dot").forEach((el) => {
    el.classList.toggle("active", parseInt(el.dataset.step) <= step);
  });
}

function onboardingNext() {
  if (onboardingStep < 2) showOnboardingStep(onboardingStep + 1);
  else finishOnboarding();
}

async function onboardingEnableAlerts() {
  if ("Notification" in window && Notification.permission === "default") {
    const perm = await Notification.requestPermission();
    if (perm === "granted") {
      ensureAudioContext();
      initPush();
      showToast("Alerts enabled");
    }
  } else if (Notification.permission === "granted") {
    initPush();
  }
  onboardingNext();
}

async function onboardingSavePlaces() {
  await setPlaceFromInput("home", document.getElementById("onbHomeInput"));
  await setPlaceFromInput("work", document.getElementById("onbWorkInput"));
  finishOnboarding();
}

// Resolve an address input into a stored place (shared by onboarding).
// Reuses whatever attachAddressAutocomplete already resolved for this exact
// text, falling back to a fresh geocode otherwise.
async function setPlaceFromInput(key, input) {
  const query = input.value.trim();
  if (!query) return;
  let geo;
  if (input.dataset.lat && input.dataset.resolvedFor === query) {
    geo = { address: query, postal: input.dataset.postal, latitude: parseFloat(input.dataset.lat), longitude: parseFloat(input.dataset.lng) };
  } else {
    geo = await geocodeAddress(query);
  }
  if (!geo) return;
  state.places[key] = {
    address: geo.address || query,
    postal: geo.postal || "",
    latitude: geo.latitude,
    longitude: geo.longitude,
  };
  localStorage.setItem("bb_places", JSON.stringify(state.places));
}

function skipOnboarding() {
  finishOnboarding();
}

function finishOnboarding() {
  localStorage.setItem("bb_onboarded", "1");
  document.getElementById("onboardingModal").classList.add("hidden");
  renderPlaces();
  refreshDashboard();
  syncPrefs();
}

// ── Helpers ──
async function getStopName(code) {
  try {
    const stops = await loadBusStops();
    const stop = stops.find((s) => s.BusStopCode === code);
    return stop ? stop.Description : `Stop ${code}`;
  } catch {
    return `Stop ${code}`;
  }
}

// This escaped only ' and " — not <, > or & — so it was never HTML-safe; it
// was really a "make this survive being pasted into an onclick attribute"
// helper wearing the wrong name. Both jobs are needed, so they're now two
// functions that each do one of them properly.
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// For text going into a JS string literal that itself sits inside an HTML
// attribute — onclick="fn('…')". Two layers of parsing, so two layers of
// escaping: JS first (a bare quote would end the literal), then HTML. Escaping
// only one of them is exactly how a stop name with an apostrophe breaks out.
function jsArg(str) {
  return escapeHtml(
    String(str ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'")
  );
}

function closeModal(event, id) {
  if (event.target === event.currentTarget) {
    document.getElementById(id).classList.add("hidden");
  }
}

// Move keyboard focus to the first field of a freshly-opened modal.
function focusFirstInput(modalId) {
  setTimeout(() => {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    const field = modal.querySelector("input, select, textarea, button");
    if (field) field.focus();
  }, 50);
}

// Close any open modal (or the combined route view) with the Escape key.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  document.querySelectorAll(".modal-overlay:not(.hidden)").forEach((m) => {
    m.classList.add("hidden");
  });
  const routeView = document.getElementById("routeStopsModal");
  if (routeView && !routeView.classList.contains("hidden")) {
    routeView.classList.add("hidden");
  }
});

function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add("hidden"), 3000);
}
