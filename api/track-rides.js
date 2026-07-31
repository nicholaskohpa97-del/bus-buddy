const webpush = require("web-push");

const { SB_URL, fetchWithTimeout, serviceHeaders } = require("./_auth");

const LTA_KEY = process.env.LTA_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

// Alerting at the destination is too late — you want to be standing by the
// door before the bus pulls in. Both of these are "one stop out" heuristics:
// the vehicle is physically near the previous stop, or its estimate for your
// stop has dropped low enough that it must be on the last leg.
const PREV_STOP_RADIUS_M = 200;
const DEST_ETA_ALERT_MIN = 2;

// A ride nobody ended is abandoned rather than tracked forever — the user got
// off, closed the app and forgot. Singapore's longest bus routes run under
// two hours end to end.
const RIDE_MAX_AGE_MS = 3 * 60 * 60 * 1000;

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

async function getRides() {
  const res = await fetchWithTimeout(
    `${SB_URL}/rest/v1/rides?select=id,user_id,data,created_at`,
    { headers: serviceHeaders() }
  );
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getSubs() {
  const res = await fetchWithTimeout(
    `${SB_URL}/rest/v1/push_subs?select=id,user_id,device_id,subscription`,
    { headers: serviceHeaders() }
  );
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

async function endRide(rideId) {
  await fetchWithTimeout(`${SB_URL}/rest/v1/rides?id=eq.${rideId}`, {
    method: "DELETE",
    headers: serviceHeaders({ Prefer: "return=minimal" }),
  });
}

// parseBusArrival in the client throws NextBus.Latitude/Longitude away. They
// are the live position of the vehicle itself, which is what makes background
// tracking possible at all: navigator.geolocation doesn't exist in a service
// worker and Chrome cancelled the Geofencing API, so the phone cannot watch
// itself with the app closed — but the bus can be watched from the server.
async function fetchVehicle(destStop, service) {
  const url = new URL("https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival");
  url.searchParams.set("BusStopCode", destStop);
  url.searchParams.set("ServiceNo", service);
  const resp = await fetchWithTimeout(url.toString(), {
    headers: { AccountKey: LTA_KEY, accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`LTA ${resp.status}`);
  const data = await resp.json();
  const svc = data.Services && data.Services[0];
  const next = svc && svc.NextBus;
  if (!next) return null;
  const lat = parseFloat(next.Latitude);
  const lng = parseFloat(next.Longitude);
  return {
    // LTA sends "0" for both when it has no fix for the vehicle, which is a
    // point in the Gulf of Guinea, not a bus in Singapore.
    lat: Number.isFinite(lat) && lat !== 0 ? lat : null,
    lng: Number.isFinite(lng) && lng !== 0 ? lng : null,
    etaMin: next.EstimatedArrival
      ? Math.max(0, Math.round((new Date(next.EstimatedArrival) - Date.now()) / 60000))
      : null,
  };
}

async function pushToUser(subs, payload, errors, label) {
  let sent = 0;
  for (const sub of subs) {
    if (!sub.subscription || !sub.subscription.endpoint) continue;
    try {
      await webpush.sendNotification(sub.subscription, payload);
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await fetchWithTimeout(`${SB_URL}/rest/v1/push_subs?id=eq.${sub.id}`, {
          method: "DELETE",
          headers: serviceHeaders({ Prefer: "return=minimal" }),
        }).catch(() => {});
      } else {
        errors.push(`Push ${label}/${sub.device_id}: ${err.message}`);
      }
    }
  }
  return sent;
}

// Shared by this endpoint and by api/check-reminders.js, so a single
// once-a-minute pinger drives both without needing a second schedule.
async function trackRides() {
  const errors = [];
  let sent = 0;
  let ended = 0;

  const [rides, subs] = await Promise.all([getRides(), getSubs()]);

  const subsByUser = new Map();
  for (const s of subs || []) {
    if (!subsByUser.has(s.user_id)) subsByUser.set(s.user_id, []);
    subsByUser.get(s.user_id).push(s);
  }

  await Promise.all(
    (rides || []).map(async (row) => {
      const d = row.data || {};
      const startedAt = new Date(d.startedAt || row.created_at).getTime();
      if (Date.now() - startedAt > RIDE_MAX_AGE_MS) {
        try {
          await endRide(row.id);
          ended++;
        } catch (e) {
          errors.push(`End ride ${row.id}: ${e.message}`);
        }
        return;
      }

      const userSubs = subsByUser.get(row.user_id) || [];
      if (userSubs.length === 0) return;

      let vehicle;
      try {
        vehicle = await fetchVehicle(d.destStop, d.service);
      } catch (e) {
        errors.push(`LTA ${d.destStop}/${d.service}: ${e.message}`);
        return;
      }
      if (!vehicle) return;

      const nearPrev =
        vehicle.lat !== null &&
        vehicle.lng !== null &&
        haversine(vehicle.lat, vehicle.lng, d.prevLat, d.prevLng) <= PREV_STOP_RADIUS_M;
      const closeByEta = vehicle.etaMin !== null && vehicle.etaMin <= DEST_ETA_ALERT_MIN;
      if (!nearPrev && !closeByEta) return;

      const payload = JSON.stringify({
        title: `Your stop is next — ${d.destName || d.destStop}`,
        body: d.prevName
          ? `Bus ${d.service} is at ${d.prevName}. Get ready to alight.`
          : `Bus ${d.service} is one stop away. Get ready to alight.`,
        tag: `bb-ride-${row.id}`,
        url: "/",
      });

      sent += await pushToUser(userSubs, payload, errors, row.id);

      // One alert per ride, then it's done. A second "your stop is next" after
      // you've already stood up is just noise.
      try {
        await endRide(row.id);
        ended++;
      } catch (e) {
        errors.push(`End ride ${row.id}: ${e.message}`);
      }
    })
  );

  return { rides: (rides || []).length, sent, ended, errors };
}

module.exports = async (req, res) => {
  const auth = req.headers.authorization || "";
  const okAuth =
    (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) ||
    !!req.headers["x-vercel-cron"];
  if (!okAuth) return res.status(401).json({ error: "Unauthorized" });

  if (!LTA_KEY) return res.status(400).json({ error: "LTA_API_KEY not set" });
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY)
    return res.status(400).json({ error: "VAPID keys not set" });

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:alerts@bus-buddy.app",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  try {
    return res.json({ ok: true, ...(await trackRides()) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

module.exports.trackRides = trackRides;
