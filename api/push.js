// Web Push subscription registry, keyed by (user_id, device_id).
//
// The old table was keyed by device_id alone, so one account could only ever
// have one push target and there was no way to tell whose device it was. Now
// an account can register a phone and a laptop and both receive the same
// alerts, and the cron can find every device belonging to the user who owns a
// reminder.
const { SB_URL, fetchWithTimeout, userHeaders, requireUser, cors } = require("./_auth");

async function listSubs(req, userId) {
  const res = await fetchWithTimeout(
    `${SB_URL}/rest/v1/push_subs?user_id=eq.${userId}&select=device_id,subscription,updated_at`,
    { headers: userHeaders(req) }
  );
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

async function upsertSub(req, userId, deviceId, subscription) {
  const res = await fetchWithTimeout(
    `${SB_URL}/rest/v1/push_subs?on_conflict=user_id,device_id`,
    {
      method: "POST",
      headers: userHeaders(req, {
        Prefer: "resolution=merge-duplicates,return=minimal",
      }),
      body: JSON.stringify({
        user_id: userId,
        device_id: deviceId,
        subscription,
        updated_at: new Date().toISOString(),
      }),
    }
  );
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}

async function deleteSub(req, userId, deviceId) {
  await fetchWithTimeout(
    `${SB_URL}/rest/v1/push_subs?user_id=eq.${userId}&device_id=eq.${encodeURIComponent(deviceId)}`,
    { method: "DELETE", headers: userHeaders(req) }
  );
}

module.exports = async (req, res) => {
  if (cors(req, res, "GET, POST, DELETE, OPTIONS")) return;

  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === "GET") {
    try {
      const rows = await listSubs(req, user.id);
      return res.json({
        devices: rows.map((r) => ({
          deviceId: r.device_id,
          hasSubscription: !!r.subscription,
          updatedAt: r.updated_at,
        })),
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "POST") {
    const { deviceId, subscription } = req.body || {};
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: "subscription required" });
    }
    try {
      await upsertSub(req, user.id, deviceId, subscription);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "DELETE") {
    const deviceId = req.query.deviceId || (req.body || {}).deviceId;
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });
    try {
      await deleteSub(req, user.id, deviceId);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: "Method not allowed" });
};
