// Active rides — the server-tracked half of a drop-off alert.
//
// The foreground watcher in app.js can only run while the app is open and the
// screen is on. A ride row lets the cron follow the *bus* instead of the
// phone, using the vehicle position LTA already publishes, so the alert still
// lands with the app closed and the handset locked.
const { SB_URL, fetchWithTimeout, userHeaders, requireUser, cors } = require("./_auth");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function listRides(req, userId) {
  const res = await fetchWithTimeout(
    `${SB_URL}/rest/v1/rides?user_id=eq.${userId}&select=id,data,created_at`,
    { headers: userHeaders(req) }
  );
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

module.exports = async (req, res) => {
  if (cors(req, res, "GET, POST, DELETE, OPTIONS")) return;

  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === "GET") {
    try {
      const rows = await listRides(req, user.id);
      return res.json({ rides: rows.map((r) => ({ ...r.data, id: r.id, createdAt: r.created_at })) });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "POST") {
    const ride = req.body || {};
    if (!UUID_RE.test(ride.id || "")) {
      return res.status(400).json({ error: "uuid id required" });
    }
    // prevStop is what makes the alert useful: warning you *at* your stop is
    // too late to stand up and reach the door.
    for (const field of ["service", "destStop", "prevStop"]) {
      if (!ride[field]) return res.status(400).json({ error: `${field} required` });
    }
    if (!Number.isFinite(ride.prevLat) || !Number.isFinite(ride.prevLng)) {
      return res.status(400).json({ error: "prevLat/prevLng required" });
    }
    try {
      const r = await fetchWithTimeout(`${SB_URL}/rest/v1/rides?on_conflict=id`, {
        method: "POST",
        headers: userHeaders(req, {
          Prefer: "resolution=merge-duplicates,return=minimal",
        }),
        body: JSON.stringify({
          id: ride.id,
          user_id: user.id,
          data: { ...ride, startedAt: ride.startedAt || new Date().toISOString() },
        }),
      });
      if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "DELETE") {
    const id = req.query.id || (req.body || {}).id;
    if (!id) return res.status(400).json({ error: "id required" });
    try {
      await fetchWithTimeout(
        `${SB_URL}/rest/v1/rides?id=eq.${encodeURIComponent(id)}&user_id=eq.${user.id}`,
        { method: "DELETE", headers: userHeaders(req, { Prefer: "return=minimal" }) }
      );
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: "Method not allowed" });
};
