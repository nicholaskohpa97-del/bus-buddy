const webpush = require("web-push");

const { SB_URL, fetchWithTimeout, userHeaders, requireUser, cors } = require("./_auth");

// Fans the test out to every device on the account, not just the one that
// asked. That is the point of the test — if you registered a phone and a
// laptop, you want to know both are reachable.
async function getSubs(req, userId) {
  const res = await fetchWithTimeout(
    `${SB_URL}/rest/v1/push_subs?user_id=eq.${userId}&select=device_id,subscription`,
    { headers: userHeaders(req) }
  );
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return rows.filter((r) => r.subscription && r.subscription.endpoint);
}

module.exports = async (req, res) => {
  if (cors(req, res, "POST, OPTIONS")) return;
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

  let subs;
  try {
    subs = await getSubs(req, user.id);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  if (subs.length === 0)
    return res
      .status(404)
      .json({ error: "No push subscription stored for this account" });

  const payload = JSON.stringify({
    title: "Bus Buddy background alert ✅",
    body: "This was pushed from the server — real alerts will reach you even with the app closed.",
    tag: "bb-test",
    url: "/",
  });

  const results = await Promise.all(
    subs.map(async (row) => {
      try {
        await webpush.sendNotification(row.subscription, payload);
        return { deviceId: row.device_id, ok: true };
      } catch (err) {
        return { deviceId: row.device_id, ok: false, statusCode: err.statusCode };
      }
    })
  );

  const sent = results.filter((r) => r.ok).length;
  if (sent === 0)
    return res.status(502).json({ error: "Push failed", results });
  return res.json({ ok: true, sent, devices: results.length, results });
};
