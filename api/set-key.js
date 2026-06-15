module.exports = async function handler(req, res) {
  res.json({ ok: true, note: "API key is configured via environment variable on Vercel" });
}
