const crypto = require("crypto");

const { SB_URL, fetchWithTimeout, serviceHeaders } = require("./_auth");

// Cancels a one-shot reminder from the notification's Dismiss button.
//
// This is the one user action that can't present a JWT: it happens inside the
// service worker's notificationclick handler, which has no Supabase session
// and may run while the app isn't open at all. So authorisation rides on a
// per-reminder token that the server generated and only ever sent inside that
// reminder's own push payload — knowing it proves you received the
// notification, which is exactly the right bar for "stop sending me this".
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const { reminderId, dismissToken } = req.body || {};
  if (!reminderId || !dismissToken)
    return res.status(400).json({ error: "reminderId and dismissToken required" });

  try {
    const lookup = await fetchWithTimeout(
      `${SB_URL}/rest/v1/reminders?id=eq.${encodeURIComponent(reminderId)}&select=id,notify_state`,
      { headers: serviceHeaders() }
    );
    if (!lookup.ok) throw new Error(`Supabase ${lookup.status}: ${await lookup.text()}`);
    const row = (await lookup.json())[0];

    // Already gone (the bus arrived and the cron cleaned up first) is a
    // success from the caller's point of view — the alerts have stopped.
    if (!row) return res.json({ ok: true, alreadyGone: true });

    const expected = row.notify_state?.dismissToken || "";
    const a = Buffer.from(String(dismissToken));
    const b = Buffer.from(expected);
    if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).json({ error: "Invalid token" });
    }

    const del = await fetchWithTimeout(
      `${SB_URL}/rest/v1/reminders?id=eq.${encodeURIComponent(reminderId)}`,
      { method: "DELETE", headers: serviceHeaders({ Prefer: "return=minimal" }) }
    );
    if (!del.ok) throw new Error(`Supabase delete ${del.status}: ${await del.text()}`);

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
