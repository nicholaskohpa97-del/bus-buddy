// Open Food Facts proxy — search by text (?q=) or barcode (?barcode=).
// Normalises each product to a compact { name, brand, servingLabel, per_serving, per_100g }.
const OFF = "https://world.openfoodfacts.org";
const UA = "FastTrack/1.0 (intermittent fasting & nutrition PWA)";
const TIMEOUT = 8000;

function fetchTimeout(url) {
  return fetch(url, { headers: { "User-Agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT) });
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function kcalPer100(nutr) {
  if (nutr["energy-kcal_100g"] != null) return num(nutr["energy-kcal_100g"]);
  if (nutr["energy-kcal"] != null) return num(nutr["energy-kcal"]);
  if (nutr["energy_100g"] != null) return num(nutr["energy_100g"]) / 4.184; // kJ → kcal
  return 0;
}

function normalize(p) {
  const name = (p.product_name || p.generic_name || "").trim();
  if (!name) return null;
  const nutr = p.nutriments || {};
  const per100 = {
    kcal: kcalPer100(nutr),
    p: num(nutr.proteins_100g),
    c: num(nutr.carbohydrates_100g),
    f: num(nutr.fat_100g),
  };
  if (!per100.kcal && !per100.p && !per100.c && !per100.f) return null;

  const servingG = num(p.serving_quantity);
  let per_serving, servingLabel;
  if (servingG > 0) {
    const k = servingG / 100;
    per_serving = { kcal: round(per100.kcal * k), p: round(per100.p * k, 1), c: round(per100.c * k, 1), f: round(per100.f * k, 1) };
    servingLabel = (p.serving_size && String(p.serving_size).trim()) || `${servingG} g`;
  } else {
    per_serving = { kcal: round(per100.kcal), p: round(per100.p, 1), c: round(per100.c, 1), f: round(per100.f, 1) };
    servingLabel = "100 g";
  }

  const brand = (p.brands || "").split(",")[0].trim() || null;
  return {
    name, brand, servingLabel,
    per_serving,
    per_100g: { kcal: round(per100.kcal), p: round(per100.p, 1), c: round(per100.c, 1), f: round(per100.f, 1) },
    barcode: p.code || null,
  };
}

function round(n, dp = 0) { const f = Math.pow(10, dp); return Math.round((Number(n) || 0) * f) / f; }

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const q = (req.query.q || "").toString().trim();
  const barcode = (req.query.barcode || "").toString().trim();

  try {
    if (barcode) {
      const url = `${OFF}/api/v2/product/${encodeURIComponent(barcode)}.json?fields=code,product_name,generic_name,brands,nutriments,serving_size,serving_quantity`;
      const r = await fetchTimeout(url);
      const j = await r.json();
      if (j.status !== 1 || !j.product) return res.json({ results: [] });
      const norm = normalize(j.product);
      return res.json({ results: norm ? [norm] : [] });
    }

    if (!q || q.length < 2) return res.json({ results: [] });
    const url = `${OFF}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=25&fields=code,product_name,generic_name,brands,nutriments,serving_size,serving_quantity`;
    const r = await fetchTimeout(url);
    if (!r.ok) throw new Error(`OFF ${r.status}`);
    const j = await r.json();
    const results = (j.products || []).map(normalize).filter(Boolean).slice(0, 20);
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.json({ results });
  } catch (e) {
    return res.status(502).json({ results: [], error: e.message });
  }
};
