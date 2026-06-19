const { kv } = require("@vercel/kv");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    try {
      const modes = (await kv.get("modes")) || [];
      return res.json(modes);
    } catch {
      return res.json([]);
    }
  }

  if (req.method === "POST") {
    try {
      const modes = req.body;
      if (!Array.isArray(modes))
        return res.status(400).json({ error: "Expected array" });
      await kv.set("modes", modes);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: "Method not allowed" });
};
