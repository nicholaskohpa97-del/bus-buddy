const webpush = require("web-push");

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_ANON_KEY;
const LTA_KEY = process.env.LTA_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const COOLDOWN_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

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
  const res = await fetchWithTimeout(`${SB_URL}/rest/v1/push_subs?select=device_id,data`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

async function saveRow(deviceId, data) {
  const res = await fetchWithTimeout(`${SB_URL}/rest/v1/push_subs`, {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ device_id: deviceId, data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase save ${res.status}: ${await res.text()}`);
}

async function fetchArrivalMin(stop, service) {
  const url = new URL("https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival");
  url.searchParams.set("BusStopCode", stop);
  if (service) url.searchParams.set("ServiceNo", service);
  const resp = await fetchWithTimeout(url.toString(), {
    headers: { AccountKey: LTA_KEY, accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`LTA ${resp.status}`);
  const data = await resp.json();
  const svc = data.Services && data.Services[0];
  if (!svc || !svc.NextBus || !svc.NextBus.EstimatedArrival) return null;
  return Math.max(0, Math.round((new Date(svc.NextBus.EstimatedArrival) - new Date()) / 60000));
}

module.exports = async (req, res) => {
  const auth = req.headers.authorization || "";
  const okAuth =
    (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) ||
    !!req.headers["x-vercel-cron"];
  if (!okAuth) return res.status(401).json({ error: "Unauthorized" });

  // Diagnostic mode: check env vars + DB connectivity without firing notifications.
  // Hit /api/check-reminders?probe=1 (with auth header) to debug config issues.
  if (req.query.probe === "1") {
    const checks = {
      LTA_API_KEY: !!LTA_KEY,
      VAPID_PUBLIC_KEY: !!process.env.VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: !!process.env.VAPID_PRIVATE_KEY,
      VAPID_SUBJECT: !!process.env.VAPID_SUBJECT,
      SUPABASE_URL: !!SB_URL,
      SUPABASE_ANON_KEY: !!SB_KEY,
      CRON_SECRET: !!CRON_SECRET,
    };
    let dbRows = null;
    let dbError = null;
    try {
      const rows = await getRows();
      dbRows = Array.isArray(rows) ? rows.length : rows;
    } catch (e) {
      dbError = e.message;
    }
    const allOk = !dbError && Object.values(checks).every(Boolean);
    return res.json({ ok: allOk, checks, dbRows, dbError });
  }

  if (!LTA_KEY) return res.status(400).json({ error: "LTA_API_KEY not set" });
  if (!vapidReady()) return res.status(400).json({ error: "VAPID keys not set" });

  const sgt = new Date(Date.now() + 8 * 3600 * 1000);
  const nowMins = sgt.getUTCHours() * 60 + sgt.getUTCMinutes();
  const todayDow = sgt.getUTCDay();
  const now = Date.now();

  let rows;
  try {
    rows = await getRows();
  } catch (e) {
    return res.status(500).json({ error: "DB read failed", details: e.message });
  }

  let sent = 0;
  let checked = 0;
  const errors = [];

  // Process all devices in parallel — each device row is independent.
  await Promise.all((rows || []).map(async (row) => {
    const data = row.data || {};
    const sub = data.subscription;
    const reminders = data.reminders || [];
    const notifyState = data.notifyState || {};
    if (!sub || reminders.length === 0) return;

    let rowChanged = false;
    let subDead = false;

    for (const r of reminders) {
      if (!r.enabled || !r.time) continue;
      if (Array.isArray(r.days) && r.days.length && !r.days.includes(todayDow)) continue;
      const [h, m] = r.time.split(":").map(Number);
      const targetMins = h * 60 + m;
      if (nowMins < targetMins - 30 || nowMins > targetMins + 10) continue;

      const last = notifyState[r.id]?.lastFired || 0;
      if (now - last < COOLDOWN_MS) continue;

      checked++;
      let min;
      try {
        min = await fetchArrivalMin(r.stop, r.service);
      } catch (e) {
        errors.push(`LTA ${r.stop}/${r.service}: ${e.message}`);
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
        errors.push(`Push ${row.device_id}: ${err.message}`);
      }
    }

    try {
      if (subDead) {
        data.subscription = null;
        await saveRow(row.device_id, data);
      } else if (rowChanged) {
        data.notifyState = notifyState;
        await saveRow(row.device_id, data);
      }
    } catch (e) {
      errors.push(`DB save ${row.device_id}: ${e.message}`);
    }
  }));

  res.json({ ok: true, devices: (rows || []).length, checked, sent, errors });
};
