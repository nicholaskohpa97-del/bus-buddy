// Per-account preference blob: favourites, places, recent searches, settings.
//
// Replaces the old device_id-keyed `push_subs.data` bag. Because it hangs off
// auth.uid() rather than a random localStorage id, signing in on a second
// device now actually restores the first device's state — the thing
// restorePrefs() claimed to do but never could.
const { SB_URL, fetchWithTimeout, userHeaders, requireUser, cors } = require("./_auth");

async function getPrefs(req, userId) {
  const res = await fetchWithTimeout(
    `${SB_URL}/rest/v1/user_prefs?user_id=eq.${userId}&select=data,updated_at`,
    { headers: userHeaders(req) }
  );
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return rows[0] || null;
}

async function savePrefs(req, userId, data) {
  const res = await fetchWithTimeout(`${SB_URL}/rest/v1/user_prefs`, {
    method: "POST",
    headers: userHeaders(req, {
      Prefer: "resolution=merge-duplicates,return=minimal",
    }),
    body: JSON.stringify({
      user_id: userId,
      data,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;

  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === "GET") {
    try {
      const row = await getPrefs(req, user.id);
      return res.json({ data: row?.data || {}, updatedAt: row?.updated_at || null });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const data = body.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return res.status(400).json({ error: "data object required" });
    }
    try {
      // Merge rather than replace: a client that only knows about some keys
      // (an older tab, a partial sync) must not wipe the rest.
      const existing = (await getPrefs(req, user.id))?.data || {};
      await savePrefs(req, user.id, { ...existing, ...data });
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: "Method not allowed" });
};
