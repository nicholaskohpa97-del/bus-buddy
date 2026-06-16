// ── State ──
let state = {
  apiKey: localStorage.getItem("bb_apiKey") || "",
  refreshSec: parseInt(localStorage.getItem("bb_refreshSec") || "30"),
  reminderLeadMin: parseInt(localStorage.getItem("bb_reminderLead") || "5"),
  favourites: JSON.parse(localStorage.getItem("bb_favourites") || "[]"),
  departureReminders: JSON.parse(localStorage.getItem("bb_deptReminders") || "[]"),
  dropoffAlerts: JSON.parse(localStorage.getItem("bb_dropoffAlerts") || "[]"),
  busStops: null,
  currentStop: null,
};

let refreshTimer = null;
let deptCheckTimer = null;
let dropoffWatchId = null;
let activeDropoff = null;

// ── Init ──
document.addEventListener("DOMContentLoaded", async () => {
  const keyCheck = await fetch("/api/check-key").then(r => r.json()).catch(() => ({ hasKey: false }));
  if (keyCheck.hasKey) {
    document.getElementById("apiKeyBar").classList.add("hidden");
  } else if (state.apiKey) {
    await setApiKey(state.apiKey);
    document.getElementById("apiKeyBar").classList.add("hidden");
  }
  document.getElementById("apiKeyInput").value = state.apiKey;
  document.getElementById("refreshInterval").value = state.refreshSec;
  document.getElementById("reminderLead").value = state.reminderLeadMin;
  renderFavourites();
  renderDepartureReminders();
  renderDropoffAlerts();
  requestNotificationPermission();
  startDepartureChecker();
});

// ── API ──
async function setApiKey(key) {
  await fetch("/api/set-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
}

async function fetchArrivals(stopCode, serviceNo) {
  let url = `/api/bus-arrival?BusStopCode=${stopCode}`;
  if (serviceNo) url += `&ServiceNo=${serviceNo}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("API error");
  return res.json();
}

async function loadBusStops() {
  if (state.busStops) return state.busStops;
  showToast("Loading bus stop database...");
  const res = await fetch("/api/bus-stops");
  const data = await res.json();
  state.busStops = data.value || [];
  showToast(`Loaded ${state.busStops.length} bus stops`);
  return state.busStops;
}

// ── Tabs ──
function switchTab(tab) {
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === tab);
  });
  ["arrivals", "favourites", "reminders"].forEach((t) => {
    document.getElementById(`tab-${t}`).classList.toggle("hidden", t !== tab);
  });
}

// ── Search ──
let searchDebounce = null;
async function handleSearch(val) {
  clearTimeout(searchDebounce);
  const container = document.getElementById("searchResults");
  if (!val || val.length < 2) {
    container.classList.add("hidden");
    return;
  }
  if (/^\d{5}$/.test(val.trim())) {
    container.classList.add("hidden");
    return;
  }
  searchDebounce = setTimeout(async () => {
    try {
      const stops = await loadBusStops();
      const q = val.toLowerCase();
      const matches = stops
        .filter(
          (s) =>
            s.Description.toLowerCase().includes(q) ||
            s.RoadName.toLowerCase().includes(q) ||
            s.BusStopCode.includes(q)
        )
        .slice(0, 20);
      if (matches.length === 0) {
        container.innerHTML =
          '<div class="search-result-item"><span class="search-result-detail">No stops found</span></div>';
      } else {
        container.innerHTML = matches
          .map(
            (s) => `
          <div class="search-result-item" onclick="selectStop('${s.BusStopCode}')">
            <div class="search-result-name">${s.Description}</div>
            <div class="search-result-detail">${s.BusStopCode} &middot; ${s.RoadName}</div>
          </div>`
          )
          .join("");
      }
      container.classList.remove("hidden");
    } catch {
      container.classList.add("hidden");
    }
  }, 300);
}

function selectStop(code) {
  document.getElementById("stopSearch").value = code;
  document.getElementById("searchResults").classList.add("hidden");
  document.getElementById("nearbyResults").classList.add("hidden");
  searchStop();
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

async function loadArrivals(stopCode) {
  const container = document.getElementById("arrivalResults");
  try {
    const data = await fetchArrivals(stopCode);
    state.currentStop = stopCode;

    const stopName = await getStopName(stopCode);
    const isFav = state.favourites.some((f) => f.code === stopCode);

    if (!data.Services || data.Services.length === 0) {
      container.innerHTML = `
        <div class="card">
          <div class="bus-stop-header">
            <div>
              <h3>${stopName}</h3>
              <span class="bus-stop-code">${stopCode}</span>
            </div>
            <button class="icon-btn ${isFav ? "active" : ""}" onclick="toggleFav('${stopCode}','${escapeHtml(stopName)}')" title="Favourite">&#9733;</button>
          </div>
          <div class="empty-state"><p>No bus services at this time.</p></div>
        </div>`;
      return;
    }

    const services = data.Services.map((svc) => {
      const times = [svc.NextBus, svc.NextBus2, svc.NextBus3].map((b) =>
        parseBusArrival(b)
      );
      return { no: svc.ServiceNo, times };
    });

    services.sort((a, b) => {
      const aMin = Math.min(...a.times.map((t) => t.min ?? 999));
      const bMin = Math.min(...b.times.map((t) => t.min ?? 999));
      return aMin - bMin;
    });

    container.innerHTML = `
      <div class="card">
        <div class="bus-stop-header">
          <div>
            <h3>${stopName}</h3>
            <span class="bus-stop-code">${stopCode}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <div class="auto-refresh"><div class="dot"></div> Live</div>
            <button class="icon-btn ${isFav ? "active" : ""}" onclick="toggleFav('${stopCode}','${escapeHtml(stopName)}')" title="Favourite">&#9733;</button>
          </div>
        </div>
        ${services.map((svc) => renderServiceRow(svc, stopCode)).join("")}
      </div>`;
  } catch (err) {
    container.innerHTML = `<div class="card"><p style="color:var(--red);">Error: ${err.message}. Check your API key.</p></div>`;
  }
}

function parseBusArrival(bus) {
  if (!bus || !bus.EstimatedArrival)
    return { min: null, load: null, type: null };
  const diff = Math.round(
    (new Date(bus.EstimatedArrival) - new Date()) / 60000
  );
  const loadMap = { SEA: "Seats", SDA: "Standing", LSD: "Full" };
  const typeMap = { SD: "Single", DD: "Double", BD: "Bendy" };
  return {
    min: Math.max(0, diff),
    load: loadMap[bus.Load] || bus.Load,
    type: typeMap[bus.Type] || bus.Type,
  };
}

function renderServiceRow(svc, stopCode) {
  const badges = svc.times
    .map((t) => {
      if (t.min === null) return '<span class="arrival-badge na">-</span>';
      let cls = "later";
      let label = `${t.min} min`;
      if (t.min <= 1) {
        cls = "arriving";
        label = "Arr";
      } else if (t.min <= 5) {
        cls = "soon";
      }
      const loadInfo = t.load
        ? `<span class="load-indicator">${t.load}</span>`
        : "";
      return `<span class="arrival-badge ${cls}">${label}${loadInfo}</span>`;
    })
    .join("");

  return `
    <div class="service-row">
      <span class="service-number">${svc.no}</span>
      <div class="arrival-times">${badges}</div>
      <div class="service-actions">
        <button class="icon-btn" onclick="quickDeptReminder('${stopCode}','${svc.no}')" title="Remind me">&#128276;</button>
      </div>
    </div>`;
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
  localStorage.setItem("bb_favourites", JSON.stringify(state.favourites));
  renderFavourites();
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
        <div class="fav-name">${f.name}</div>
        <div class="fav-detail">${f.code}</div>
      </div>
      <button class="icon-btn" onclick="event.stopPropagation();toggleFav('${f.code}','${escapeHtml(f.name)}')" title="Remove">&#10005;</button>
    </div>`
    )
    .join("");
}

function goToStop(code) {
  switchTab("arrivals");
  document.getElementById("stopSearch").value = code;
  searchStop();
}

// ── Departure Reminders ──
function openDepartureReminderModal() {
  document.getElementById("deptReminderModal").classList.remove("hidden");
}

function saveDepartureReminder() {
  const reminder = {
    id: Date.now().toString(36),
    stop: document.getElementById("deptStop").value.trim(),
    service: document.getElementById("deptService").value.trim(),
    time: document.getElementById("deptTime").value,
    leadMin: parseInt(document.getElementById("deptLeadMin").value) || 5,
    nickname:
      document.getElementById("deptNickname").value.trim() ||
      `Bus ${document.getElementById("deptService").value.trim()} @ ${document.getElementById("deptStop").value.trim()}`,
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
}

function toggleDeptReminder(id) {
  const r = state.departureReminders.find((r) => r.id === id);
  if (r) r.enabled = !r.enabled;
  localStorage.setItem(
    "bb_deptReminders",
    JSON.stringify(state.departureReminders)
  );
  renderDepartureReminders();
}

function renderDepartureReminders() {
  const container = document.getElementById("departureReminders");
  if (state.departureReminders.length === 0) {
    container.innerHTML =
      '<p style="color:var(--text2);font-size:13px;">No reminders set.</p>';
    return;
  }
  container.innerHTML = state.departureReminders
    .map(
      (r) => `
    <div class="reminder-card">
      <div class="reminder-info">
        <span class="reminder-value">${r.nickname}</span>
        <span class="reminder-label">Bus ${r.service} @ stop ${r.stop} &middot; Leave by ${r.time} &middot; Alert ${r.leadMin}min before</span>
      </div>
      <div style="display:flex;gap:4px;">
        <button class="icon-btn ${r.enabled ? "active" : ""}" onclick="toggleDeptReminder('${r.id}')" title="Toggle">${r.enabled ? "&#9654;" : "&#9724;"}</button>
        <button class="icon-btn" onclick="deleteDeptReminder('${r.id}')" title="Delete">&#10005;</button>
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
  deptCheckTimer = setInterval(checkDepartureReminders, 30000);
}

async function checkDepartureReminders() {
  if (!state.apiKey) return;
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();

  for (const r of state.departureReminders) {
    if (!r.enabled) continue;
    const [h, m] = r.time.split(":").map(Number);
    const targetMins = h * 60 + m;
    const windowStart = targetMins - 30;
    const windowEnd = targetMins + 10;

    if (nowMins < windowStart || nowMins > windowEnd) continue;

    try {
      const data = await fetchArrivals(r.stop, r.service);
      if (!data.Services || data.Services.length === 0) continue;
      const svc = data.Services[0];
      const next = parseBusArrival(svc.NextBus);
      if (next.min !== null && next.min <= r.leadMin) {
        sendNotification(
          `Bus ${r.service} arriving in ${next.min} min!`,
          `${r.nickname} - Time to head to stop ${r.stop}`
        );
      }
    } catch {}
  }
}

// ── Drop-off Alerts ──
function openDropoffModal() {
  document.getElementById("dropoffModal").classList.remove("hidden");
}

function saveDropoffAlert() {
  const alert = {
    id: Date.now().toString(36),
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
  resolveDropoffCoords(alert);
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
  if (activeDropoff && activeDropoff.id === id) stopDropoff();
}

function renderDropoffAlerts() {
  const container = document.getElementById("dropoffReminders");
  if (state.dropoffAlerts.length === 0) {
    container.innerHTML =
      '<p style="color:var(--text2);font-size:13px;">No drop-off alerts set.</p>';
    return;
  }
  container.innerHTML = state.dropoffAlerts
    .map(
      (a) => `
    <div class="reminder-card">
      <div class="reminder-info">
        <span class="reminder-value">${a.nickname}</span>
        <span class="reminder-label">Stop ${a.stopCode} &middot; ${a.radius}m radius ${a.lat ? "&#9989;" : "&#9888; resolving coords..."}</span>
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
}

function stopDropoff() {
  if (dropoffWatchId !== null) {
    navigator.geolocation.clearWatch(dropoffWatchId);
    dropoffWatchId = null;
  }
  activeDropoff = null;
  document.getElementById("dropoffBanner").classList.add("hidden");
  renderDropoffAlerts();
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

// ── Nearby Stops ──
async function findNearbyStops() {
  const container = document.getElementById("nearbyResults");
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
        const nearest = withDist.slice(0, 10);

        container.innerHTML = `
          <div class="nearby-header">
            <h3>Nearest Bus Stops</h3>
            <button class="btn btn-ghost btn-sm" onclick="document.getElementById('nearbyResults').classList.add('hidden')">Close</button>
          </div>
          ${nearest
            .map(
              (s) => `
            <div class="nearby-card" onclick="selectStop('${s.BusStopCode}')">
              <div class="nearby-info">
                <div class="nearby-name">${s.Description}</div>
                <div class="nearby-detail">${s.BusStopCode} &middot; ${s.RoadName}</div>
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

function formatDist(m) {
  if (m < 1000) return `${Math.round(m)}m`;
  return `${(m / 1000).toFixed(1)}km`;
}

// ── Settings ──
function openSettings() {
  document.getElementById("apiKeyInput").value = state.apiKey;
  document.getElementById("refreshInterval").value = state.refreshSec;
  document.getElementById("reminderLead").value = state.reminderLeadMin;
  document.getElementById("settingsModal").classList.remove("hidden");
}

async function saveSettings() {
  state.apiKey = document.getElementById("apiKeyInput").value.trim();
  state.refreshSec =
    parseInt(document.getElementById("refreshInterval").value) || 30;
  state.reminderLeadMin =
    parseInt(document.getElementById("reminderLead").value) || 5;

  localStorage.setItem("bb_apiKey", state.apiKey);
  localStorage.setItem("bb_refreshSec", state.refreshSec.toString());
  localStorage.setItem("bb_reminderLead", state.reminderLeadMin.toString());

  if (state.apiKey) {
    await setApiKey(state.apiKey);
    document.getElementById("apiKeyBar").classList.add("hidden");
    showToast("Settings saved");
  }
  document.getElementById("settingsModal").classList.add("hidden");
}

// ── Notifications ──
function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

function sendNotification(title, body) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body, icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='80' font-size='80'>🚌</text></svg>" });
  }
  showToast(`${title} - ${body}`);
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

function escapeHtml(str) {
  return str.replace(/'/g, "\\'").replace(/"/g, "&quot;");
}

function closeModal(event, id) {
  if (event.target === event.currentTarget) {
    document.getElementById(id).classList.add("hidden");
  }
}

function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add("hidden"), 3000);
}
