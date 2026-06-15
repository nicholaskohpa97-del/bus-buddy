export default async function handler(req, res) {
  const key = process.env.LTA_API_KEY;
  if (!key) return res.status(400).json({ error: "LTA_API_KEY not configured" });

  const { BusStopCode, ServiceNo } = req.query;
  if (!BusStopCode) return res.status(400).json({ error: "BusStopCode required" });

  const url = new URL("https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival");
  url.searchParams.set("BusStopCode", BusStopCode);
  if (ServiceNo) url.searchParams.set("ServiceNo", ServiceNo);

  try {
    const resp = await fetch(url.toString(), {
      headers: { AccountKey: key, accept: "application/json" },
    });
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: "LTA API request failed", details: err.message });
  }
}
