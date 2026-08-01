// Issues a short-lived code that links a Telegram chat to a Bus Buddy account.
//
// Journey modes are per-account now, but a Telegram chat carries no Supabase
// session — there is nothing in an incoming webhook that identifies who is
// typing. Rather than drop the bot, the user asks the app for a code and sends
// `/link <code>` to the bot; the bot trades the code for the user_id once and
// stores the pairing.
const { SB_URL, fetchWithTimeout, serviceHeaders, userHeaders, requireUser, cors } = require("./_auth");

const CODE_TTL_MS = 10 * 60 * 1000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 — these get read aloud and typed by hand

function makeCode() {
  const bytes = require("crypto").randomBytes(6);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

module.exports = async (req, res) => {
  if (cors(req, res, "GET, POST, DELETE, OPTIONS")) return;

  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === "GET") {
    try {
      const r = await fetchWithTimeout(
        `${SB_URL}/rest/v1/tg_links?user_id=eq.${user.id}&select=chat_id,linked_at`,
        { headers: userHeaders(req) }
      );
      const rows = r.ok ? await r.json() : [];
      return res.json({ linked: rows.length > 0, chats: rows.length });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "POST") {
    const code = makeCode();
    try {
      // Codes are written with the service key: the bot has to read them back
      // without a session, so they live outside the user-facing RLS policies.
      const r = await fetchWithTimeout(`${SB_URL}/rest/v1/tg_link_codes`, {
        method: "POST",
        headers: serviceHeaders({ Prefer: "return=minimal" }),
        body: JSON.stringify({
          code,
          user_id: user.id,
          expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
        }),
      });
      if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
      return res.json({ code, expiresInMin: Math.round(CODE_TTL_MS / 60000) });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "DELETE") {
    try {
      await fetchWithTimeout(`${SB_URL}/rest/v1/tg_links?user_id=eq.${user.id}`, {
        method: "DELETE",
        headers: userHeaders(req, { Prefer: "return=minimal" }),
      });
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: "Method not allowed" });
};
