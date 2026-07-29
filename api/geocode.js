const FETCH_TIMEOUT_MS = 8000;

function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

// Proxies OneMap Singapore's public Search API (no key required) so the
// client can resolve an address, road name, or postal code to a
// latitude/longitude without needing its own OneMap credentials.
module.exports = async function handler(req, res) {
  const q = (req.query.q || "").toString().trim();
  if (!q) return res.status(400).json({ error: "q required" });

  try {
    const url = `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${encodeURIComponent(q)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
    const resp = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
    if (!resp.ok) throw new Error(`OneMap ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    const results = (data.results || [])
      .map((r) => ({
        address: r.ADDRESS,
        postal: r.POSTAL,
        latitude: parseFloat(r.LATITUDE),
        longitude: parseFloat(r.LONGITUDE),
      }))
      .filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude))
      .slice(0, 5);
    res.json({ results });
  } catch (err) {
    res.status(502).json({ error: "Failed to geocode", details: err.message });
  }
};
