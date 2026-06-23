const webpush = require("web-push");

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_ANON_KEY;

async function getSub(deviceId) {
  const res = await fetch(
    `${SB_URL}/rest/v1/push_subs?device_id=eq.${encodeURIComponent(
      deviceId
    )}&select=data`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
  );
  const rows = await res.json();
  return rows[0]?.data?.subscription || null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY)
    return res.status(400).json({ error: "VAPID keys not configured" });

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:alerts@bus-buddy.app",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });

  let sub;
  try {
    sub = await getSub(deviceId);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  if (!sub)
    return res
      .status(404)
      .json({ error: "No push subscription stored for this device" });

  try {
    await webpush.sendNotification(
      sub,
      JSON.stringify({
        title: "Bus Buddy background alert ✅",
        body: "This was pushed from the server — real alerts will reach you even with the app closed.",
        tag: "bb-test",
        url: "/",
      })
    );
    return res.json({ ok: true });
  } catch (err) {
    return res
      .status(502)
      .json({ error: "Push failed", statusCode: err.statusCode });
  }
};
