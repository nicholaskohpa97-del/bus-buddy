// Journey modes, one row per mode, scoped to the signed-in account.
//
// This table used to be a single global row (`modes?id=eq.1`) that every
// visitor to the deployment read and overwrote — one user's saved journeys
// were visible to, and destroyable by, everyone else. Each mode now carries a
// user_id and RLS keeps it there.
const { SB_URL, fetchWithTimeout, userHeaders, requireUser, cors } = require("./_auth");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function listModes(req, userId) {
  const res = await fetchWithTimeout(
    `${SB_URL}/rest/v1/modes?user_id=eq.${userId}&select=id,data`,
    { headers: userHeaders(req) }
  );
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return rows.map((r) => ({ ...r.data, id: r.id }));
}

async function syncModes(req, userId, incoming) {
  const res0 = await fetchWithTimeout(
    `${SB_URL}/rest/v1/modes?user_id=eq.${userId}&select=id`,
    { headers: userHeaders(req) }
  );
  if (!res0.ok) throw new Error(`Supabase ${res0.status}: ${await res0.text()}`);
  const existingIds = new Set((await res0.json()).map((r) => r.id));
  const incomingIds = new Set(incoming.map((m) => m.id));

  const toInsert = incoming.filter((m) => !existingIds.has(m.id));
  const toUpdate = incoming.filter((m) => existingIds.has(m.id));
  const toDelete = [...existingIds].filter((id) => !incomingIds.has(id));

  if (toInsert.length) {
    const res = await fetchWithTimeout(`${SB_URL}/rest/v1/modes`, {
      method: "POST",
      headers: userHeaders(req, { Prefer: "return=minimal" }),
      body: JSON.stringify(
        toInsert.map((m) => ({ id: m.id, user_id: userId, data: m }))
      ),
    });
    if (!res.ok) throw new Error(`Insert ${res.status}: ${await res.text()}`);
  }

  for (const m of toUpdate) {
    const res = await fetchWithTimeout(
      `${SB_URL}/rest/v1/modes?id=eq.${m.id}&user_id=eq.${userId}`,
      {
        method: "PATCH",
        headers: userHeaders(req, { Prefer: "return=minimal" }),
        body: JSON.stringify({ data: m, updated_at: new Date().toISOString() }),
      }
    );
    if (!res.ok) throw new Error(`Update ${res.status}: ${await res.text()}`);
  }

  if (toDelete.length) {
    const ids = toDelete.map((id) => `"${id}"`).join(",");
    const res = await fetchWithTimeout(
      `${SB_URL}/rest/v1/modes?user_id=eq.${userId}&id=in.(${ids})`,
      { method: "DELETE", headers: userHeaders(req, { Prefer: "return=minimal" }) }
    );
    if (!res.ok) throw new Error(`Delete ${res.status}: ${await res.text()}`);
  }
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;

  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === "GET") {
    try {
      return res.json(await listModes(req, user.id));
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "POST") {
    const modes = req.body;
    if (!Array.isArray(modes)) {
      return res.status(400).json({ error: "Expected array" });
    }
    for (const m of modes) {
      if (!m || !UUID_RE.test(m.id || "")) {
        return res.status(400).json({ error: "each mode needs a uuid id" });
      }
    }
    try {
      await syncModes(req, user.id, modes);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: "Method not allowed" });
};
