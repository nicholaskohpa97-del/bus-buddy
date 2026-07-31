const webpush = require("web-push");
const { sbUrl, serviceKey, serviceHeaders, fetchWithTimeout } = require("./_auth");

const COOLDOWN_MS = 60 * 60 * 1000;

function vapidReady() {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:alerts@bus-buddy.app",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  return true;
}

// This job runs with the service-role key because it must read across every
// user's rows. RLS would (correctly) hide them from the anon key.
async function getPrefRows() {
  const res = await fetchWithTimeout(
    `${sbUrl()}/rest/v1/user_prefs?select=user_id,data`,
    { headers: serviceHeaders() }
  );
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getSubRows() {
  const res = await fetchWithTimeout(
    `${sbUrl()}/rest/v1/push_subs?select=user_id,device_id,subscription`,
    { headers: serviceHeaders() }
  );
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

async function savePrefs(userId, data) {
  const res = await fetchWithTimeout(`${sbUrl()}/rest/v1/user_prefs`, {
    method: "POST",
    headers: serviceHeaders({
      Prefer: "resolution=merge-duplicates,return=minimal",
    }),
    body: JSON.stringify({
      user_id: userId,
      data,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`Supabase save ${res.status}: ${await res.text()}`);
}

// A 404/410 from the push service means the browser threw the subscription
// away; drop that device rather than retrying it every minute forever.
async function deleteSub(userId, deviceId) {
  await fetchWithTimeout(
    `${sbUrl()}/rest/v1/push_subs?user_id=eq.${userId}&device_id=eq.${encodeURIComponent(
      deviceId
    )}`,
    { method: "DELETE", headers: serviceHeaders() }
  );
}

async function fetchArrivalMin(stop, service) {
  const url = new URL("https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival");
  url.searchParams.set("BusStopCode", stop);
  if (service) url.searchParams.set("ServiceNo", service);
  const resp = await fetchWithTimeout(url.toString(), {
    headers: { AccountKey: process.env.LTA_API_KEY, accept: "application/json" },
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
    (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) ||
    !!req.headers["x-vercel-cron"];
  if (!okAuth) return res.status(401).json({ error: "Unauthorized" });

  // Diagnostic mode: check env vars + DB connectivity without firing notifications.
  // Hit /api/check-reminders?probe=1 (with auth header) to debug config issues.
  if (req.query.probe === "1") {
    const checks = {
      LTA_API_KEY: !!process.env.LTA_API_KEY,
      VAPID_PUBLIC_KEY: !!process.env.VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: !!process.env.VAPID_PRIVATE_KEY,
      VAPID_SUBJECT: !!process.env.VAPID_SUBJECT,
      SUPABASE_URL: !!sbUrl(),
      SUPABASE_ANON_KEY: !!process.env.SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: !!serviceKey(),
      CRON_SECRET: !!process.env.CRON_SECRET,
    };
    let dbRows = null;
    let dbError = null;
    try {
      const rows = await getPrefRows();
      dbRows = Array.isArray(rows) ? rows.length : rows;
    } catch (e) {
      dbError = e.message;
    }
    const allOk = !dbError && Object.values(checks).every(Boolean);
    return res.json({ ok: allOk, checks, dbRows, dbError });
  }

  if (!process.env.LTA_API_KEY) return res.status(400).json({ error: "LTA_API_KEY not set" });
  if (!serviceKey())
    return res.status(400).json({ error: "SUPABASE_SERVICE_ROLE_KEY not set" });
  if (!vapidReady()) return res.status(400).json({ error: "VAPID keys not set" });

  const sgt = new Date(Date.now() + 8 * 3600 * 1000);
  const nowMins = sgt.getUTCHours() * 60 + sgt.getUTCMinutes();
  const todayDow = sgt.getUTCDay();
  const now = Date.now();

  let prefRows;
  let subRows;
  try {
    [prefRows, subRows] = await Promise.all([getPrefRows(), getSubRows()]);
  } catch (e) {
    return res.status(500).json({ error: "DB read failed", details: e.message });
  }

  // Preferences are per account; push subscriptions are per device. One
  // reminder therefore fans out to every device the user is signed in on.
  const subsByUser = new Map();
  for (const row of subRows || []) {
    if (!row.subscription) continue;
    if (!subsByUser.has(row.user_id)) subsByUser.set(row.user_id, []);
    subsByUser.get(row.user_id).push(row);
  }

  let sent = 0;
  let checked = 0;
  const errors = [];

  await Promise.all((prefRows || []).map(async (row) => {
    const data = row.data || {};
    const reminders = data.reminders || [];
    const notifyState = data.notifyState || {};
    const subs = subsByUser.get(row.user_id) || [];
    if (subs.length === 0 || reminders.length === 0) return;

    let rowChanged = false;

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

      let deliveredToAny = false;
      for (const sub of subs) {
        try {
          await webpush.sendNotification(sub.subscription, payload);
          deliveredToAny = true;
          sent++;
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            try {
              await deleteSub(row.user_id, sub.device_id);
            } catch (e) {
              errors.push(`Sub prune ${sub.device_id}: ${e.message}`);
            }
          } else {
            errors.push(`Push ${sub.device_id}: ${err.message}`);
          }
        }
      }

      // Only start the cooldown once the alert actually reached a device,
      // otherwise a transient failure would silently swallow the reminder.
      if (deliveredToAny) {
        notifyState[r.id] = { lastFired: now };
        rowChanged = true;
      }
    }

    if (rowChanged) {
      try {
        data.notifyState = notifyState;
        await savePrefs(row.user_id, data);
      } catch (e) {
        errors.push(`DB save ${row.user_id}: ${e.message}`);
      }
    }
  }));

  res.json({ ok: true, users: (prefRows || []).length, checked, sent, errors });
};
