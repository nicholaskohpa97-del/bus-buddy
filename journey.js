// ── Journey planning ───────────────────────────────────────────────────────
//
// Plan a trip from an address to an address, see the real fare and duration,
// confirm which bus stops the plan actually means, then start it — which arms
// the drop-off alert for you rather than making you set one up by hand.
//
// Split out of app.js, which was already 3,000+ lines in one global scope.
// Still a plain <script> with global functions: the onclick="..." handlers
// everywhere in this app depend on that, and a bundler would be a big change
// to pay for one file split.

let plannerItineraries = [];
let plannerSelected = null;
// Per-leg stop resolution the user can correct: OneMap names a stop, we map it
// onto a real BusStopCode, and they get the final say.
let plannerLegStops = {};

function openPlanner() {
  document.getElementById("plannerModal").classList.remove("hidden");
  document
    .querySelectorAll("#plannerModal [data-address-autocomplete]")
    .forEach(attachAddressAutocomplete);
  focusFirstInput("plannerModal");
}

function closePlanner() {
  document.getElementById("plannerModal").classList.add("hidden");
}

// Reuses whatever attachAddressAutocomplete already resolved for this exact
// text, and falls back to a fresh geocode when the user typed and didn't pick.
async function readPlannerPoint(inputId) {
  const input = document.getElementById(inputId);
  const query = input.value.trim();
  if (!query) return null;
  if (input.dataset.lat && input.dataset.resolvedFor === query) {
    return {
      label: query,
      latitude: parseFloat(input.dataset.lat),
      longitude: parseFloat(input.dataset.lng),
    };
  }
  const geo = await geocodeAddress(query);
  if (!geo) return null;
  return { label: geo.address || query, latitude: geo.latitude, longitude: geo.longitude };
}

async function planJourney() {
  const results = document.getElementById("plannerResults");
  results.innerHTML = '<div class="nearby-locating">Planning…</div>';

  const [from, to] = await Promise.all([
    readPlannerPoint("plannerFrom"),
    readPlannerPoint("plannerTo"),
  ]);
  if (!from || !to) {
    results.innerHTML =
      '<div class="empty-state"><p>Enter a start and destination — an address or a postal code.</p></div>';
    return;
  }

  try {
    const res = await authFetch(
      `/api/route-plan?start=${from.latitude},${from.longitude}&end=${to.latitude},${to.longitude}`
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `route-plan ${res.status}`);
    }
    const { itineraries } = await res.json();
    plannerItineraries = itineraries || [];
    if (plannerItineraries.length === 0) {
      results.innerHTML =
        '<div class="empty-state"><p>No public transport route found between those points.</p></div>';
      return;
    }
    renderItineraries(from, to);
  } catch (e) {
    results.innerHTML = `<div class="empty-state"><p>Couldn't plan that journey.</p><p style="font-size:12px;">${escapeHtml(e.message)}</p></div>`;
  }
}

const LEG_ICONS = { WALK: "🚶", BUS: "🚌", SUBWAY: "🚆", RAIL: "🚆", TRAM: "🚋" };

function legChip(leg) {
  const icon = LEG_ICONS[leg.mode] || "•";
  const label = leg.mode === "WALK" ? `${leg.durationMin} min` : leg.service || leg.mode;
  return `<span class="leg-chip leg-${leg.mode.toLowerCase()}">${icon} ${escapeHtml(label)}</span>`;
}

function fareLabel(fare) {
  if (fare === null || fare === undefined) return "Fare unavailable";
  // OneMap returns a single figure. Saying "fare" flat would be wrong for the
  // large number of riders on concession or paying cash.
  return `$${fare.toFixed(2)} adult card fare`;
}

function renderItineraries(from, to) {
  const results = document.getElementById("plannerResults");
  results.innerHTML = plannerItineraries
    .map(
      (it, i) => `
    <button class="itinerary-card" onclick="selectItinerary(${i})">
      <div class="itinerary-top">
        <span class="itinerary-duration">${it.durationMin} min</span>
        <span class="itinerary-fare">${escapeHtml(fareLabel(it.fare))}</span>
      </div>
      <div class="itinerary-legs">${it.legs.map(legChip).join('<span class="leg-arrow">›</span>')}</div>
      <div class="itinerary-meta">${it.transfers} transfer${it.transfers === 1 ? "" : "s"} &middot; ${it.walkMin} min walking</div>
    </button>`
    )
    .join("");
  document.getElementById("plannerFromLabel").textContent = from.label;
  document.getElementById("plannerToLabel").textContent = to.label;
  document.getElementById("plannerSummary").classList.remove("hidden");
}

// OneMap names a stop ("Opp Blk 123"); the app needs a BusStopCode to ask LTA
// anything about it. Match on position and on the stop actually being served
// by that route — name matching alone is unreliable, since OneMap and LTA
// don't use identical wording.
async function resolveLegStop(lat, lng, service) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const candidates = await stopsNear(lat, lng, 8);
  if (candidates.length === 0) return null;
  if (!service) return candidates[0];
  try {
    const routes = await loadBusRoutes();
    const served = new Set(
      routes.filter((r) => r.ServiceNo === service).map((r) => r.BusStopCode)
    );
    return candidates.find((s) => served.has(s.BusStopCode)) || candidates[0];
  } catch {
    return candidates[0];
  }
}

async function selectItinerary(index) {
  const it = plannerItineraries[index];
  if (!it) return;
  plannerSelected = { index, itinerary: it };
  plannerLegStops = {};

  const body = document.getElementById("plannerConfirmBody");
  document.getElementById("plannerResultsView").classList.add("hidden");
  document.getElementById("plannerConfirmView").classList.remove("hidden");
  body.innerHTML = '<div class="nearby-locating">Matching stops…</div>';

  const transitLegs = it.legs
    .map((leg, i) => ({ leg, i }))
    .filter(({ leg }) => leg.mode !== "WALK");

  const resolved = await Promise.all(
    transitLegs.map(async ({ leg, i }) => {
      if (leg.mode !== "BUS") return { i, leg, board: null, alight: null };
      const [board, alight] = await Promise.all([
        resolveLegStop(leg.fromLat, leg.fromLng, leg.service),
        resolveLegStop(leg.toLat, leg.toLng, leg.service),
      ]);
      plannerLegStops[i] = {
        board: board?.BusStopCode || null,
        alight: alight?.BusStopCode || null,
      };
      return { i, leg, board, alight };
    })
  );

  body.innerHTML = `
    <div class="itinerary-top" style="margin-bottom:10px;">
      <span class="itinerary-duration">${it.durationMin} min</span>
      <span class="itinerary-fare">${escapeHtml(fareLabel(it.fare))}</span>
    </div>
    ${resolved
      .map(({ i, leg, board, alight }) => {
        if (leg.mode !== "BUS") {
          return `
          <div class="leg-row">
            <div class="leg-row-head">${legChip(leg)} <span class="leg-name">${escapeHtml(leg.fromName || "")} → ${escapeHtml(leg.toName || "")}</span></div>
            <div class="leg-row-note">Rail legs aren't tracked — only the bus legs arm a drop-off alert.</div>
          </div>`;
        }
        return `
        <div class="leg-row">
          <div class="leg-row-head">${legChip(leg)} <span class="leg-name">${escapeHtml(leg.fromName || "")} → ${escapeHtml(leg.toName || "")}</span></div>
          <label for="legBoard${i}">Board at</label>
          <input type="text" id="legBoard${i}" value="${board ? board.BusStopCode : ""}"
                 placeholder="Stop code" data-stop-autocomplete autocomplete="off"
                 onchange="updateLegStop(${i},'board',this.value)">
          <div class="leg-row-note">${board ? escapeHtml(board.Description) : "No matching stop found — enter one."}</div>
          <label for="legAlight${i}">Alight at</label>
          <input type="text" id="legAlight${i}" value="${alight ? alight.BusStopCode : ""}"
                 placeholder="Stop code" data-stop-autocomplete autocomplete="off"
                 onchange="updateLegStop(${i},'alight',this.value)">
          <div class="leg-row-note">${alight ? escapeHtml(alight.Description) : "No matching stop found — enter one."}</div>
        </div>`;
      })
      .join("")}
    <div id="plannerEta" class="planner-eta"></div>`;

  document
    .querySelectorAll("#plannerConfirmBody [data-stop-autocomplete]")
    .forEach(attachStopAutocomplete);

  refineFirstLegEta();
}

function updateLegStop(legIndex, which, value) {
  if (!plannerLegStops[legIndex]) plannerLegStops[legIndex] = { board: null, alight: null };
  plannerLegStops[legIndex][which] = value.trim() || null;
  refineFirstLegEta();
}

function backToItineraries() {
  document.getElementById("plannerConfirmView").classList.add("hidden");
  document.getElementById("plannerResultsView").classList.remove("hidden");
}

// The itinerary's own start time assumes the timetable. The first leg is the
// one the user is about to stand at a stop waiting for, so it's worth
// replacing that assumption with the live arrival.
async function refineFirstLegEta() {
  const el = document.getElementById("plannerEta");
  if (!el || !plannerSelected) return;
  const it = plannerSelected.itinerary;
  const firstBusIndex = it.legs.findIndex((l) => l.mode === "BUS");
  if (firstBusIndex === -1) {
    el.textContent = `Planned journey time ${it.durationMin} min.`;
    return;
  }
  const leg = it.legs[firstBusIndex];
  const board = plannerLegStops[firstBusIndex]?.board;
  if (!board) {
    el.textContent = `Planned journey time ${it.durationMin} min.`;
    return;
  }
  el.textContent = "Checking live arrivals…";
  try {
    const data = await fetchArrivals(board, leg.service);
    const next = parseBusArrival(data.Services?.[0]?.NextBus);
    if (next.min === null) {
      el.textContent = `Planned journey time ${it.durationMin} min — bus ${leg.service} isn't running right now.`;
      return;
    }
    el.textContent =
      `Bus ${leg.service} in ${next.min} min · arrive in about ${it.durationMin + next.min} min.`;
  } catch {
    el.textContent = `Planned journey time ${it.durationMin} min.`;
  }
}

// Starting a journey arms the drop-off alert for its first bus leg, which is
// the whole point of planning inside the app rather than in a maps tab.
async function startPlannedJourney() {
  if (!plannerSelected) return;
  const it = plannerSelected.itinerary;
  const firstBusIndex = it.legs.findIndex((l) => l.mode === "BUS");
  if (firstBusIndex === -1) {
    showToast("This journey has no bus leg to track.");
    return;
  }
  const leg = it.legs[firstBusIndex];
  const stops = plannerLegStops[firstBusIndex] || {};
  if (!stops.alight) {
    showToast("Set the stop you're alighting at first.");
    return;
  }

  const started = await startServerTrackedRide(leg.service, stops.alight);
  if (!started) return;
  closePlanner();
  switchTab("dashboard");
  showToast(`Journey started — you'll be alerted one stop before ${started.destName}.`);
}
