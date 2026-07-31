const { fetchWithTimeout, requireUser, cors } = require("./_auth");
const { getOneMapToken } = require("./onemap-token");

// Public-transport journey planning, proxied from OneMap.
//
// OneMap over Google Directions, for two reasons that aren't preference:
// Google returns no Singapore fare data at all, so it simply cannot answer
// "what will this cost"; and its terms require results to be drawn on a Google
// map with attribution and forbid caching them, which this app — Leaflet over
// OpenStreetMap — can't satisfy. OneMap is the government's own API, it's
// free, and it returns bus and MRT itineraries with fares. The app already
// proxies OneMap for geocoding.
const ROUTE_URL = "https://www.onemap.gov.sg/api/public/routingsvc/route";

function toMin(seconds) {
  return Math.max(0, Math.round((Number(seconds) || 0) / 60));
}

// OneMap returns a full OTP-shaped plan. The client only needs enough to rank
// itineraries, show a fare, and map each transit leg onto a real bus stop.
function simplify(plan) {
  const itineraries = (plan?.itineraries || []).map((it) => {
    const legs = (it.legs || []).map((leg) => ({
      mode: leg.mode, // WALK | BUS | SUBWAY | TRAM | RAIL
      service: leg.routeShortName || leg.route || null,
      agency: leg.agencyName || null,
      durationMin: toMin(leg.duration),
      distanceM: Math.round(Number(leg.distance) || 0),
      fromName: leg.from?.name || null,
      fromLat: leg.from?.lat ?? null,
      fromLng: leg.from?.lon ?? null,
      toName: leg.to?.name || null,
      toLat: leg.to?.lat ?? null,
      toLng: leg.to?.lon ?? null,
      numStops: leg.numIntermediateStops ?? null,
    }));
    return {
      // Fare is an adult card fare. Concession and cash fares differ, and
      // OneMap returns exactly one figure — the UI labels it rather than
      // implying it applies to everyone.
      fare: it.fare != null ? Number(it.fare) : null,
      durationMin: toMin(it.duration),
      walkMin: toMin(it.walkTime),
      waitMin: toMin(it.waitingTime),
      transfers: it.transfers ?? Math.max(0, legs.filter((l) => l.mode !== "WALK").length - 1),
      startTime: it.startTime || null,
      endTime: it.endTime || null,
      legs,
    };
  });
  itineraries.sort((a, b) => a.durationMin - b.durationMin);
  return itineraries;
}

const COORD_RE = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/;

module.exports = async (req, res) => {
  if (cors(req, res, "GET, OPTIONS")) return;

  // Signed-in only: this burns a rate-limited government API credential, so
  // it isn't an open proxy.
  const user = await requireUser(req, res);
  if (!user) return;

  const start = (req.query.start || "").toString().trim();
  const end = (req.query.end || "").toString().trim();
  if (!COORD_RE.test(start) || !COORD_RE.test(end)) {
    return res.status(400).json({ error: "start and end must be 'lat,lng'" });
  }

  // OneMap wants the departure moment split into its own date and time
  // fields, in Singapore local time.
  const when = req.query.at ? new Date(req.query.at) : new Date();
  if (Number.isNaN(when.getTime())) {
    return res.status(400).json({ error: "at must be an ISO timestamp" });
  }
  const sgt = new Date(when.getTime() + 8 * 3600 * 1000);
  const date = sgt.toISOString().slice(0, 10);
  const time = sgt.toISOString().slice(11, 19);

  try {
    const token = await getOneMapToken();
    const url = new URL(ROUTE_URL);
    url.searchParams.set("start", start);
    url.searchParams.set("end", end);
    url.searchParams.set("routeType", "pt");
    url.searchParams.set("date", date);
    url.searchParams.set("time", time);
    url.searchParams.set("mode", req.query.mode === "BUS" ? "BUS" : "TRANSIT");
    url.searchParams.set("maxWalkDistance", "1000");
    url.searchParams.set("numItineraries", "3");

    const resp = await fetchWithTimeout(url.toString(), {
      headers: { Authorization: token, accept: "application/json" },
    });
    if (!resp.ok) throw new Error(`OneMap route ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();

    if (data.error || (!data.plan && !data.itineraries)) {
      return res.status(502).json({ error: data.error?.msg || data.message || "No route found" });
    }
    return res.json({ itineraries: simplify(data.plan || data) });
  } catch (err) {
    return res.status(502).json({ error: "Failed to plan route", details: err.message });
  }
};
