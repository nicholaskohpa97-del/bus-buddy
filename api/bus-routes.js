export default async function handler(req, res) {
  const key = process.env.LTA_API_KEY;
  if (!key) return res.status(400).json({ error: "LTA_API_KEY not configured" });

  const allRoutes = [];
  let skip = 0;
  try {
    while (true) {
      const url = `https://datamall2.mytransport.sg/ltaodataservice/BusRoutes?$skip=${skip}`;
      const resp = await fetch(url, {
        headers: { AccountKey: key, accept: "application/json" },
      });
      const data = await resp.json();
      if (!data.value || data.value.length === 0) break;
      allRoutes.push(...data.value);
      skip += 500;
    }
    res.json({ value: allRoutes });
  } catch (err) {
    res.status(502).json({ error: "Failed to fetch bus routes", details: err.message });
  }
}
