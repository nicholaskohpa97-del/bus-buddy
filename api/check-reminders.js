const webpush = require("web-push");

const { SB_URL, fetchWithTimeout, serviceHeaders } = require("./_auth");

const LTA_KEY = process.env.LTA_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

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

// The cron has no user context, so it reads across every account with the
// service-role key. This is the one place that legitimately bypasses RLS; all
// the user-facing routes go through the caller's own JWT instead.
async function getReminders() {
  const res = await fetchWithTimeout(
    `${SB_URL}/rest/v1/reminders?select=id,user_id,type,payload,notify_state`,
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

async function saveNotifyState(reminderId, notifyState) {
  const res = await fetchWithTimeout(`${SB_URL}/rest/v1/reminders?id=eq.${reminderId}`, {
    method: "PATCH",
    headers: serviceHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify({ notify_state: notifyState }),
  });
  if (!res.ok) throw new Error(`Supabase save ${res.status}: ${await res.text()}`);
}

// A 404/410 from the push service means the browser threw the subscription
// away (uninstall, cleared data). Drop the row rather than retrying it every
// minute forever.
async function dropSub(subId) {
  await fetchWithTimeout(`${SB_URL}/rest/v1/push_subs?id=eq.${subId}`, {
    method: "DELETE",
    headers: serviceHeaders({ Prefer: "return=minimal" }),
  });
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

// Sends one payload to every device on an account. Returns how many landed and
// removes any subscription the push service has retired.
async function pushToUser(subs, payload, errors, label) {
  let sent = 0;
  for (const sub of subs) {
    if (!sub.subscription || !sub.subscription.endpoint) continue;
    try {
      await webpush.sendNotification(sub.subscription, payload);
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        try {
          await dropSub(sub.id);
        } catch (e) {
          errors.push(`Drop sub ${sub.device_id}: ${e.message}`);
        }
      } else {
        errors.push(`Push ${label}/${sub.device_id}: ${err.message}`);
      }
    }
  }
  return sent;
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
      SUPABASE_ANON_KEY: !!process.env.SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      CRON_SECRET: !!CRON_SECRET,
    };
    let dbRows = null;
    let dbError = null;
    try {
      const rows = await getReminders();
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

  let reminders;
  let subs;
  try {
    [reminders, subs] = await Promise.all([getReminders(), getSubs()]);
  } catch (e) {
    return res.status(500).json({ error: "DB read failed", details: e.message });
  }

  const subsByUser = new Map();
  for (const s of subs || []) {
    if (!subsByUser.has(s.user_id)) subsByUser.set(s.user_id, []);
    subsByUser.get(s.user_id).push(s);
  }

  let sent = 0;
  let checked = 0;
  const errors = [];

  // Reminders are independent of one another, so they all run in parallel.
  await Promise.all(
    (reminders || []).map(async (row) => {
      if (row.type !== "scheduled") return;
      const r = row.payload || {};
      const notifyState = row.notify_state || {};
      const userSubs = subsByUser.get(row.user_id) || [];
      if (userSubs.length === 0) return;

      if (!r.enabled || !r.time) return;
      if (Array.isArray(r.days) && r.days.length && !r.days.includes(todayDow)) return;
      const [h, m] = r.time.split(":").map(Number);
      const targetMins = h * 60 + m;
      if (nowMins < targetMins - 30 || nowMins > targetMins + 10) return;

      if (now - (notifyState.lastFired || 0) < COOLDOWN_MS) return;

      checked++;
      let min;
      try {
        min = await fetchArrivalMin(r.stop, r.service);
      } catch (e) {
        errors.push(`LTA ${r.stop}/${r.service}: ${e.message}`);
        return;
      }
      if (min === null || min > (r.leadMin || 5)) return;

      const payload = JSON.stringify({
        title: `Bus ${r.service} arriving in ${min} min!`,
        body: `${r.nickname || "Departure reminder"} — head to stop ${r.stop}`,
        tag: `bb-dep-${row.id}`,
        url: "/",
      });

      const delivered = await pushToUser(userSubs, payload, errors, row.id);
      if (delivered === 0) return;
      sent += delivered;

      try {
        await saveNotifyState(row.id, { ...notifyState, lastFired: now });
      } catch (e) {
        errors.push(`DB save ${row.id}: ${e.message}`);
      }
    })
  );

  res.json({
    ok: true,
    reminders: (reminders || []).length,
    devices: (subs || []).length,
    checked,
    sent,
    errors,
  });
};
