// Vercel cron (every minute): send fasting + weigh-in reminders via Web Push.
// Reads self-contained push_subs rows (service role bypasses RLS), mirroring the
// bus-buddy pattern: cooldown via notifyState, dead-subscription cleanup.
const webpush = require("web-push");

const SB_URL = process.env.SUPABASE_URL;
const SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const FETCH_TIMEOUT = 8000;

function ft(url, opts = {}) { return fetch(url, { ...opts, signal: AbortSignal.timeout(FETCH_TIMEOUT) }); }

function vapidReady() {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:alerts@fasttrack.app",
    process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  return true;
}

async function getRows() {
  const r = await ft(`${SB_URL}/rest/v1/push_subs?select=user_id,data`, {
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}

async function saveRow(userId, data) {
  const r = await ft(`${SB_URL}/rest/v1/push_subs`, {
    method: "POST",
    headers: {
      apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`,
      "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ user_id: userId, data, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error(`save ${r.status}: ${await r.text()}`);
}

function pad2(n) { return String(n).padStart(2, "0"); }

module.exports = async (req, res) => {
  const auth = req.headers.authorization || "";
  const okAuth = (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) || !!req.headers["x-vercel-cron"];
  if (!okAuth) return res.status(401).json({ error: "Unauthorized" });

  if (req.query.probe === "1") {
    const checks = {
      SUPABASE_URL: !!SB_URL, SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      SUPABASE_ANON_KEY: !!process.env.SUPABASE_ANON_KEY,
      VAPID_PUBLIC_KEY: !!process.env.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: !!process.env.VAPID_PRIVATE_KEY,
      CRON_SECRET: !!CRON_SECRET,
    };
    let dbRows = null, dbError = null;
    try { dbRows = (await getRows()).length; } catch (e) { dbError = e.message; }
    return res.json({ ok: !dbError && Object.values(checks).every(Boolean), checks, dbRows, dbError });
  }

  if (!vapidReady()) return res.status(400).json({ error: "VAPID keys not set" });
  if (!SB_URL || !SB_SERVICE) return res.status(400).json({ error: "Supabase not configured" });

  let rows;
  try { rows = await getRows(); } catch (e) { return res.status(500).json({ error: "DB read failed", details: e.message }); }

  const now = Date.now();
  let sent = 0; const errors = [];

  await Promise.all((rows || []).map(async (row) => {
    const data = row.data || {};
    const sub = data.subscription;
    if (!sub) return;
    const prefs = data.prefs || {};
    const notifyState = data.notifyState || {};
    const tzOff = Number(data.tzOffsetMin) || 0;
    const localMs = now - tzOff * 60000;
    const local = new Date(localMs);
    const localKey = `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())}`;

    const queue = [];

    // 1) Fast complete
    if (prefs.fastComplete && data.fast && data.fast.startedAt) {
      const start = new Date(data.fast.startedAt).getTime();
      const end = start + (Number(data.fast.targetHours) || 0) * 3600000;
      const key = `fc_${start}`;
      if (now >= end && now <= end + 2 * 3600000 && !notifyState[key]) {
        queue.push({ key, title: "🎉 Fast complete!", body: `You hit your ${data.fast.targetHours}h fasting goal. Time to refuel.` });
      }
    }

    // 2) Daily weigh-in
    if (prefs.weighIn && prefs.weighInTime) {
      const [h, m] = prefs.weighInTime.split(":").map(Number);
      const target = h * 60 + m;
      const cur = local.getUTCHours() * 60 + local.getUTCMinutes();
      const key = `wi_${localKey}`;
      if (cur >= target && cur <= target + 15 && !notifyState[key]) {
        queue.push({ key, title: "⚖️ Time to weigh in", body: "Log today's weight to keep your trend up to date." });
      }
    }

    if (!queue.length) return;

    let subDead = false, changed = false;
    for (const n of queue) {
      try {
        await webpush.sendNotification(sub, JSON.stringify({ title: n.title, body: n.body, tag: n.key, url: "/" }));
        notifyState[n.key] = now; changed = true; sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) { subDead = true; break; }
        errors.push(`push ${row.user_id}: ${err.message}`);
      }
    }

    try {
      if (subDead) { data.subscription = null; await saveRow(row.user_id, data); }
      else if (changed) { data.notifyState = notifyState; await saveRow(row.user_id, data); }
    } catch (e) { errors.push(`save ${row.user_id}: ${e.message}`); }
  }));

  res.json({ ok: true, devices: (rows || []).length, sent, errors });
};
