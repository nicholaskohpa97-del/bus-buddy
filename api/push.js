const {
  sbUrl,
  fetchWithTimeout,
  userHeaders,
  requireUser,
  applyCors,
} = require("./_auth");

// Preferences (favourites, places, reminders) belong to the account and are
// shared across every device signed into it. Push subscriptions are per-device,
// so a user with a phone and a laptop gets alerts on both.
//
// All queries run as the caller with their own token, so RLS — not this code —
// is what actually keeps one account out of another's rows.

async function getPrefs(user) {
  const res = await fetchWithTimeout(
    `${sbUrl()}/rest/v1/user_prefs?user_id=eq.${user.id}&select=data`,
    { headers: userHeaders(user.token) }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0]?.data || null;
}

async function savePrefs(user, data) {
  const res = await fetchWithTimeout(`${sbUrl()}/rest/v1/user_prefs`, {
    method: "POST",
    headers: userHeaders(user.token, {
      Prefer: "resolution=merge-duplicates,return=minimal",
    }),
    body: JSON.stringify({
      user_id: user.id,
      data,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}

async function saveSubscription(user, deviceId, subscription) {
  const res = await fetchWithTimeout(`${sbUrl()}/rest/v1/push_subs`, {
    method: "POST",
    headers: userHeaders(user.token, {
      Prefer: "resolution=merge-duplicates,return=minimal",
    }),
    body: JSON.stringify({
      user_id: user.id,
      device_id: deviceId,
      subscription,
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
      return res.json((await getPrefs(user)) || {});
    } catch {
      return res.json({});
    }
  }

  if (req.method === "POST") {
    try {
      const { deviceId, subscription, reminders, favourites, places } =
        req.body || {};

      const existing = (await getPrefs(user)) || {};
      const data = {
        reminders: Array.isArray(reminders) ? reminders : existing.reminders || [],
        favourites: Array.isArray(favourites)
          ? favourites
          : existing.favourites || [],
        places:
          places && typeof places === "object" ? places : existing.places || {},
        notifyState: existing.notifyState || {},
      };
      await savePrefs(user, data);

      // Only sent when the browser has a live push subscription to register.
      if (deviceId && subscription) {
        await saveSubscription(user, deviceId, subscription);
      }

      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: "Method not allowed" });
};
