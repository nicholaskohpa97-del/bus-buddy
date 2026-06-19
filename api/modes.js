const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_ANON_KEY;
const HEADERS = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=minimal",
};

async function getModes() {
  const res = await fetch(`${SB_URL}/rest/v1/modes?id=eq.1&select=data`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  const rows = await res.json();
  return rows[0]?.data || [];
}

async function setModes(modes) {
  await fetch(`${SB_URL}/rest/v1/modes?id=eq.1`, {
    method: "PATCH",
    headers: HEADERS,
    body: JSON.stringify({ data: modes }),
  });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    try {
      return res.json(await getModes());
    } catch {
      return res.json([]);
    }
  }

  if (req.method === "POST") {
    try {
      const modes = req.body;
      if (!Array.isArray(modes))
        return res.status(400).json({ error: "Expected array" });
      await setModes(modes);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: "Method not allowed" });
};
