const {
  sbUrl,
  fetchWithTimeout,
  userHeaders,
  requireUser,
  applyCors,
} = require("./_auth");

const CODE_TTL_MS = 10 * 60 * 1000;
// No I/O/0/1 — these are read off a screen and typed into a chat.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeCode() {
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

// Issues a short-lived one-time code the user sends to the Telegram bot as
// "/link CODE", which is how a chat gets bound to their account.
module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const user = await requireUser(req, res);
  if (!user) return;

  const code = makeCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();

  try {
    const resp = await fetchWithTimeout(`${sbUrl()}/rest/v1/tg_link_codes`, {
      method: "POST",
      headers: userHeaders(user.token, { Prefer: "return=minimal" }),
      body: JSON.stringify({ code, user_id: user.id, expires_at: expiresAt }),
    });
    if (!resp.ok) throw new Error(`Supabase ${resp.status}: ${await resp.text()}`);
    return res.json({ code, expiresAt });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
