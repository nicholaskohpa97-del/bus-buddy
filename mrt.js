// ── Rail network ───────────────────────────────────────────────────────────
//
// Draws Singapore's MRT and LRT network on the existing Leaflet map, and
// answers "what does Sengkang → Jurong East cost, and how do I get there".
//
// Drawn geographically rather than as a schematic SVG diagram. A schematic
// looks more like the official network map, but it would be a whole second
// rendering engine — and this way it reuses initMap(), overlays cleanly on the
// bus stops already there, and puts stations in the place you'd actually walk
// to. That's the version worth having.

let mrtData = null;
let mrtLayer = null;
let mrtVisible = false;
let mrtLoadPromise = null;

function loadMrtData() {
  if (mrtData) return Promise.resolve(mrtData);
  if (mrtLoadPromise) return mrtLoadPromise;
  mrtLoadPromise = fetch("/data/mrt.json")
    .then((r) => {
      if (!r.ok) throw new Error(`mrt.json ${r.status}`);
      return r.json();
    })
    .then((d) => {
      mrtData = d;
      return d;
    })
    .catch((e) => {
      mrtLoadPromise = null;
      throw e;
    });
  return mrtLoadPromise;
}

// ── Map overlay ──

async function toggleMrtLayer() {
  const btn = document.getElementById("mrtToggle");
  if (!map) return;
  if (mrtVisible) {
    if (mrtLayer) map.removeLayer(mrtLayer);
    mrtVisible = false;
    if (btn) {
      btn.classList.remove("active");
      btn.setAttribute("aria-pressed", "false");
    }
    return;
  }
  try {
    await drawMrtNetwork();
  } catch {
    showToast("Couldn't load the rail network.");
    return;
  }
  mrtVisible = true;
  if (btn) {
    btn.classList.add("active");
    btn.setAttribute("aria-pressed", "true");
  }
}

async function drawMrtNetwork() {
  const data = await loadMrtData();
  if (mrtLayer) map.removeLayer(mrtLayer);
  mrtLayer = L.layerGroup().addTo(map);

  // Lines first, so station markers sit on top of them.
  for (const line of data.lines) {
    for (const segment of line.segments) {
      const latlngs = segment
        .map((code) => data.stations[code])
        .filter(Boolean)
        .map((s) => [s.lat, s.lng]);
      if (latlngs.length < 2) continue;
      L.polyline(latlngs, {
        color: line.colour,
        weight: line.lrt ? 3 : 5,
        opacity: 0.85,
        // The LRT lines are drawn thinner and dashed so three grey loops don't
        // read as one more heavy-rail line.
        dashArray: line.lrt ? "6 5" : null,
      }).addTo(mrtLayer);
    }
  }

  // One marker per physical station, not per code — an interchange is one
  // place, and three stacked markers at Dhoby Ghaut would be three tap targets
  // for the same platform hall.
  const drawn = new Set();
  for (const code of Object.keys(data.stations)) {
    if (drawn.has(code)) continue;
    const st = data.stations[code];
    const codes = [code, ...st.interchange];
    codes.forEach((c) => drawn.add(c));

    const isInterchange = st.interchange.length > 0;
    const colours = codes
      .map((c) => data.lines.find((l) => l.id === data.stations[c]?.line)?.colour)
      .filter(Boolean);

    L.circleMarker([st.lat, st.lng], {
      radius: isInterchange ? 7 : 5,
      fillColor: isInterchange ? "#ffffff" : colours[0] || "#666",
      color: colours[0] || "#666",
      weight: isInterchange ? 3 : 2,
      opacity: 1,
      fillOpacity: 1,
    })
      .bindPopup(
        `<div class="popup-name">${escapeHtml(st.name)}</div>
         <div class="popup-detail">${codes.map(escapeHtml).join(" &middot; ")}</div>
         <div class="popup-actions">
           <button class="btn btn-sm" onclick="planFromStation('${jsArg(code)}')">Plan from here</button>
           <button class="btn btn-ghost btn-sm" onclick="planToStation('${jsArg(code)}')">Plan to here</button>
         </div>`
      )
      .addTo(mrtLayer);
  }
}

// ── Station-to-station planning ──

function openMrtPlanner() {
  document.getElementById("mrtModal").classList.remove("hidden");
  loadMrtData()
    .then(fillStationDatalist)
    .catch(() => showToast("Couldn't load the rail network."));
  focusFirstInput("mrtModal");
}

function closeMrtPlanner() {
  document.getElementById("mrtModal").classList.add("hidden");
}

// A <datalist> rather than a bespoke autocomplete: 184 stations is small
// enough that the browser's own picker is faster and more accessible than
// anything hand-rolled here.
function fillStationDatalist() {
  const list = document.getElementById("mrtStationList");
  if (!list || list.dataset.filled) return;
  const seen = new Set();
  const options = [];
  for (const st of Object.values(mrtData.stations)) {
    if (seen.has(st.name)) continue;
    seen.add(st.name);
    const codes = [st.code, ...st.interchange].join(" ");
    options.push(`<option value="${escapeHtml(st.name)}">${escapeHtml(codes)}</option>`);
  }
  options.sort();
  list.innerHTML = options.join("");
  list.dataset.filled = "1";
}

function findStationByName(name) {
  if (!mrtData) return null;
  const target = (name || "").trim().toLowerCase();
  if (!target) return null;
  return (
    Object.values(mrtData.stations).find((s) => s.name.toLowerCase() === target) ||
    Object.values(mrtData.stations).find((s) => s.code.toLowerCase() === target) ||
    Object.values(mrtData.stations).find((s) => s.name.toLowerCase().startsWith(target)) ||
    null
  );
}

function planFromStation(code) {
  openMrtPlanner();
  loadMrtData().then(() => {
    document.getElementById("mrtFrom").value = mrtData.stations[code]?.name || "";
  });
}

function planToStation(code) {
  openMrtPlanner();
  loadMrtData().then(() => {
    document.getElementById("mrtTo").value = mrtData.stations[code]?.name || "";
  });
}

// Same OneMap proxy the address planner uses — it already returns fares and
// picks the sensible interchange, so there's no separate rail fare table to
// maintain and get wrong.
async function planMrtJourney() {
  const results = document.getElementById("mrtResults");
  await loadMrtData().catch(() => {});
  const from = findStationByName(document.getElementById("mrtFrom").value);
  const to = findStationByName(document.getElementById("mrtTo").value);
  if (!from || !to) {
    results.innerHTML =
      '<div class="empty-state"><p>Pick a start and destination station.</p></div>';
    return;
  }
  if (from.code === to.code) {
    results.innerHTML =
      '<div class="empty-state"><p>Those are the same station.</p></div>';
    return;
  }

  results.innerHTML = '<div class="nearby-locating">Finding routes…</div>';
  try {
    const res = await authFetch(
      `/api/route-plan?start=${from.lat},${from.lng}&end=${to.lat},${to.lng}`
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `route-plan ${res.status}`);
    }
    const { itineraries } = await res.json();
    if (!itineraries || itineraries.length === 0) {
      results.innerHTML =
        '<div class="empty-state"><p>No route found between those stations.</p></div>';
      return;
    }
    results.innerHTML =
      `<div class="planner-summary">${escapeHtml(from.name)} &rarr; ${escapeHtml(to.name)}</div>` +
      itineraries
        .map(
          (it) => `
      <div class="itinerary-card" style="cursor:default;">
        <div class="itinerary-top">
          <span class="itinerary-duration">${it.durationMin} min</span>
          <span class="itinerary-fare">${escapeHtml(fareLabel(it.fare))}</span>
        </div>
        <div class="itinerary-legs">${it.legs.map(legChip).join('<span class="leg-arrow">›</span>')}</div>
        <div class="itinerary-meta">${it.transfers} transfer${it.transfers === 1 ? "" : "s"} &middot; ${it.walkMin} min walking</div>
      </div>`
        )
        .join("");
  } catch (e) {
    results.innerHTML = `<div class="empty-state"><p>Couldn't plan that trip.</p><p style="font-size:12px;">${escapeHtml(e.message)}</p></div>`;
  }
}

// ── Stop classification ──
//
// classifyStop() used to infer "near MRT" from a /\bstn\b/i regex on bus stop
// descriptions, then from proximity to other stops whose names matched the
// same regex. That misses every station whose nearby stops aren't named after
// it and invents stations from any description containing "stn". With the real
// station list loaded, proximity to an actual station is the answer.
const MRT_NEAR_M = 200;
let mrtStationPoints = null;

async function mrtStationsNear(lat, lng, radius = MRT_NEAR_M) {
  const data = await loadMrtData();
  if (!mrtStationPoints) {
    const seen = new Set();
    mrtStationPoints = [];
    for (const st of Object.values(data.stations)) {
      if (seen.has(st.name)) continue;
      seen.add(st.name);
      mrtStationPoints.push(st);
    }
  }
  return mrtStationPoints
    .map((s) => ({ station: s, dist: haversine(lat, lng, s.lat, s.lng) }))
    .filter((s) => s.dist <= radius)
    .sort((a, b) => a.dist - b.dist);
}
