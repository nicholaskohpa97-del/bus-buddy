const {
  sbUrl,
  fetchWithTimeout,
  userHeaders,
  requireUser,
  applyCors,
} = require("./_auth");

// Journey modes are per-account.
//
// This previously read and wrote a single hardcoded row (`modes?id=eq.1`), so
// every user of a deployment shared one list and overwrote each other's modes.
// Rows are now keyed on user_id and protected by RLS.

async function getModes(user) {
  const res = await fetchWithTimeout(
    `${sbUrl()}/rest/v1/modes?user_id=eq.${user.id}&select=data`,
    { headers: userHeaders(user.token) }
  );
  if (!res.ok) return [];
  const rows = await res.json();
  return rows[0]?.data || [];
}

async function setModes(user, modes) {
  const res = await fetchWithTimeout(`${sbUrl()}/rest/v1/modes`, {
    method: "POST",
    headers: userHeaders(user.token, {
      Prefer: "resolution=merge-duplicates,return=minimal",
    }),
    body: JSON.stringify({
      user_id: user.id,
      data: modes,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === "GET") {
    try {
      return res.json(await getModes(user));
    } catch {
      return res.json([]);
    }
  }

  if (req.method === "POST") {
    try {
      const modes = req.body;
      if (!Array.isArray(modes))
        return res.status(400).json({ error: "Expected array" });
      await setModes(user, modes);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: "Method not allowed" });
};
