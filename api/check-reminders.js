const webpush = require("web-push");

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_ANON_KEY;
const LTA_KEY = process.env.LTA_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const COOLDOWN_MS = 60 * 60 * 1000; // one alert per reminder per daily window

function vapidReady() {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:alerts@bus-buddy.app",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  return true;
}

async function getRows() {
  const res = await fetch(`${SB_URL}/rest/v1/push_subs?select=device_id,data`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  return res.json();
}

async function saveRow(deviceId, data) {
  await fetch(`${SB_URL}/rest/v1/push_subs`, {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      device_id: deviceId,
      data,
      updated_at: new Date().toISOString(),
    }),
  });
}

async function fetchArrivalMin(stop, service) {
  const url = new URL(
    "https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival"
  );
  url.searchParams.set("BusStopCode", stop);
  if (service) url.searchParams.set("ServiceNo", service);
  const resp = await fetch(url.toString(), {
    headers: { AccountKey: LTA_KEY, accept: "application/json" },
  });
  const data = await resp.json();
  const svc = data.Services && data.Services[0];
  if (!svc || !svc.NextBus || !svc.NextBus.EstimatedArrival) return null;
  return Math.max(
    0,
    Math.round((new Date(svc.NextBus.EstimatedArrival) - new Date()) / 60000)
  );
}

module.exports = async (req, res) => {
  // Auth: external pinger sends Bearer CRON_SECRET; Vercel Cron sends its own header.
  const auth = req.headers.authorization || "";
  const okAuth =
    (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) ||
    !!req.headers["x-vercel-cron"];
  if (!okAuth) return res.status(401).json({ error: "Unauthorized" });

  if (!LTA_KEY) return res.status(400).json({ error: "LTA_API_KEY not set" });
  if (!vapidReady()) return res.status(400).json({ error: "VAPID keys not set" });

  // Singapore is fixed UTC+8 (no DST).
  const sgt = new Date(Date.now() + 8 * 3600 * 1000);
  const nowMins = sgt.getUTCHours() * 60 + sgt.getUTCMinutes();
  const now = Date.now();

  let rows;
  try {
    rows = await getRows();
  } catch (e) {
    return res.status(500).json({ error: "DB read failed", details: e.message });
  }

  let sent = 0;
  let checked = 0;

  for (const row of rows || []) {
    const data = row.data || {};
    const sub = data.subscription;
    const reminders = data.reminders || [];
    const notifyState = data.notifyState || {};
    if (!sub || reminders.length === 0) continue;

    let rowChanged = false;
    let subDead = false;

    for (const r of reminders) {
      if (!r.enabled) continue;
      if (!r.time) continue;
      const [h, m] = r.time.split(":").map(Number);
      const targetMins = h * 60 + m;
      if (nowMins < targetMins - 30 || nowMins > targetMins + 10) continue;

      const last = notifyState[r.id]?.lastFired || 0;
      if (now - last < COOLDOWN_MS) continue;

      checked++;
      let min;
      try {
        min = await fetchArrivalMin(r.stop, r.service);
      } catch {
        continue;
      }
      if (min === null || min > (r.leadMin || 5)) continue;

      const payload = JSON.stringify({
        title: `Bus ${r.service} arriving in ${min} min!`,
        body: `${r.nickname || "Departure reminder"} — head to stop ${r.stop}`,
        tag: `bb-dep-${r.id}`,
        url: "/",
      });

      try {
        await webpush.sendNotification(sub, payload);
        notifyState[r.id] = { lastFired: now };
        rowChanged = true;
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          subDead = true;
          break;
        }
      }
    }

    if (subDead) {
      data.subscription = null;
      await saveRow(row.device_id, data);
    } else if (rowChanged) {
      data.notifyState = notifyState;
      await saveRow(row.device_id, data);
    }
  }

  res.json({ ok: true, devices: (rows || []).length, checked, sent });
};
