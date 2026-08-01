// Reminder store, one row per reminder.
//
// Reminders used to live inside the device's preference blob, which meant the
// cron's "when did this last fire" bookkeeping and the client's edits wrote to
// the same JSON document and clobbered each other. Splitting them out gives
// the cron its own `notify_state` column per reminder, so a firing never
// races a user edit.
//
// `type` is 'scheduled' (a recurring time-of-day reminder) or 'oneshot' (a
// single named bus the user tapped, which deletes itself once it arrives).
const { SB_URL, fetchWithTimeout, userHeaders, requireUser, cors } = require("./_auth");

const TYPES = new Set(["scheduled", "oneshot"]);

async function listReminders(req, userId) {
  const res = await fetchWithTimeout(
    `${SB_URL}/rest/v1/reminders?user_id=eq.${userId}&select=id,type,payload`,
    { headers: userHeaders(req) }
  );
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

// Reconciles the user's rows against the array the client just sent.
// Deliberately not a delete-all-then-insert: an UPDATE leaves `notify_state`
// alone, so re-saving an unrelated reminder can't reset another one's cooldown
// and re-fire it.
async function syncReminders(req, userId, incoming) {
  const existing = await listReminders(req, userId);
  const existingIds = new Set(existing.map((r) => r.id));
  const incomingIds = new Set(incoming.map((r) => r.id));

  const toInsert = incoming.filter((r) => !existingIds.has(r.id));
  const toUpdate = incoming.filter((r) => existingIds.has(r.id));
  const toDelete = existing.filter((r) => !incomingIds.has(r.id));

  if (toInsert.length) {
    const res = await fetchWithTimeout(`${SB_URL}/rest/v1/reminders`, {
      method: "POST",
      headers: userHeaders(req, { Prefer: "return=minimal" }),
      body: JSON.stringify(
        toInsert.map((r) => ({
          id: r.id,
          user_id: userId,
          type: r.type,
          payload: r.payload,
        }))
      ),
    });
    if (!res.ok) throw new Error(`Insert ${res.status}: ${await res.text()}`);
  }

  for (const r of toUpdate) {
    const res = await fetchWithTimeout(
      `${SB_URL}/rest/v1/reminders?id=eq.${r.id}&user_id=eq.${userId}`,
      {
        method: "PATCH",
        headers: userHeaders(req, { Prefer: "return=minimal" }),
        body: JSON.stringify({
          type: r.type,
          payload: r.payload,
          updated_at: new Date().toISOString(),
        }),
      }
    );
    if (!res.ok) throw new Error(`Update ${res.status}: ${await res.text()}`);
  }

  if (toDelete.length) {
    const ids = toDelete.map((r) => `"${r.id}"`).join(",");
    const res = await fetchWithTimeout(
      `${SB_URL}/rest/v1/reminders?user_id=eq.${userId}&id=in.(${ids})`,
      { method: "DELETE", headers: userHeaders(req, { Prefer: "return=minimal" }) }
    );
    if (!res.ok) throw new Error(`Delete ${res.status}: ${await res.text()}`);
  }

  return { inserted: toInsert.length, updated: toUpdate.length, deleted: toDelete.length };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async (req, res) => {
  if (cors(req, res)) return;

  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === "GET") {
    try {
      const rows = await listReminders(req, user.id);
      return res.json({ reminders: rows });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "POST") {
    const incoming = (req.body || {}).reminders;
    if (!Array.isArray(incoming)) {
      return res.status(400).json({ error: "reminders array required" });
    }
    for (const r of incoming) {
      if (!r || !UUID_RE.test(r.id || "")) {
        return res.status(400).json({ error: "each reminder needs a uuid id" });
      }
      if (!TYPES.has(r.type)) {
        return res.status(400).json({ error: `unknown reminder type: ${r.type}` });
      }
      if (!r.payload || typeof r.payload !== "object") {
        return res.status(400).json({ error: "each reminder needs a payload object" });
      }
    }
    try {
      const result = await syncReminders(req, user.id, incoming);
      return res.json({ ok: true, ...result });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: "Method not allowed" });
};
