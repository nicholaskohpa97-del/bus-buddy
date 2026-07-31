const webpush = require("web-push");
const {
  sbUrl,
  fetchWithTimeout,
  userHeaders,
  requireUser,
  applyCors,
} = require("./_auth");

async function getSubscription(user, deviceId) {
  const res = await fetchWithTimeout(
    `${sbUrl()}/rest/v1/push_subs?user_id=eq.${user.id}&device_id=eq.${encodeURIComponent(
      deviceId
    )}&select=subscription`,
    { headers: userHeaders(user.token) }
  );
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  const rows = await res.json();
  return rows[0]?.subscription || null;
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const user = await requireUser(req, res);
  if (!user) return;

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
    sub = await getSubscription(user, deviceId);
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
