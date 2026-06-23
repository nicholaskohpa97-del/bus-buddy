const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_ANON_KEY;

const BASE_HEADERS = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
};

async function getSub(deviceId) {
  const res = await fetch(
    `${SB_URL}/rest/v1/push_subs?device_id=eq.${encodeURIComponent(
      deviceId
    )}&select=data`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
  );
  const rows = await res.json();
  return rows[0]?.data || null;
}

async function upsertSub(deviceId, data) {
  await fetch(`${SB_URL}/rest/v1/push_subs`, {
    method: "POST",
    headers: {
      ...BASE_HEADERS,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      device_id: deviceId,
      data,
      updated_at: new Date().toISOString(),
    }),
  });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    const deviceId = req.query.deviceId;
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });
    try {
      return res.json((await getSub(deviceId)) || {});
    } catch {
      return res.json({});
    }
  }

  if (req.method === "POST") {
    try {
      const { deviceId, subscription, reminders } = req.body || {};
      if (!deviceId) return res.status(400).json({ error: "deviceId required" });

      const existing = (await getSub(deviceId)) || {};
      const data = {
        subscription: subscription || existing.subscription || null,
        reminders: Array.isArray(reminders)
          ? reminders
          : existing.reminders || [],
        notifyState: existing.notifyState || {},
      };
      await upsertSub(deviceId, data);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: "Method not allowed" });
};
