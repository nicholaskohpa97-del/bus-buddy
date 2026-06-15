const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3456;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let LTA_API_KEY = process.env.LTA_API_KEY || "";

app.post("/api/set-key", (req, res) => {
  LTA_API_KEY = req.body.key || "";
  res.json({ ok: true });
});

app.get("/api/bus-arrival", async (req, res) => {
  const { BusStopCode, ServiceNo } = req.query;
  if (!LTA_API_KEY) return res.status(400).json({ error: "API key not set" });
  if (!BusStopCode) return res.status(400).json({ error: "BusStopCode required" });

  const url = new URL("https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival");
  url.searchParams.set("BusStopCode", BusStopCode);
  if (ServiceNo) url.searchParams.set("ServiceNo", ServiceNo);

  try {
    const resp = await fetch(url.toString(), {
      headers: { AccountKey: LTA_API_KEY, accept: "application/json" },
    });
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: "LTA API request failed", details: err.message });
  }
});

app.get("/api/bus-stops", async (req, res) => {
  if (!LTA_API_KEY) return res.status(400).json({ error: "API key not set" });

  const allStops = [];
  let skip = 0;
  try {
    while (true) {
      const url = `https://datamall2.mytransport.sg/ltaodataservice/BusStops?$skip=${skip}`;
      const resp = await fetch(url, {
        headers: { AccountKey: LTA_API_KEY, accept: "application/json" },
      });
      const data = await resp.json();
      if (!data.value || data.value.length === 0) break;
      allStops.push(...data.value);
      skip += 500;
    }
    res.json({ value: allStops });
  } catch (err) {
    res.status(502).json({ error: "Failed to fetch bus stops", details: err.message });
  }
});

app.get("/api/bus-routes", async (req, res) => {
  if (!LTA_API_KEY) return res.status(400).json({ error: "API key not set" });

  const allRoutes = [];
  let skip = 0;
  try {
    while (true) {
      const url = `https://datamall2.mytransport.sg/ltaodataservice/BusRoutes?$skip=${skip}`;
      const resp = await fetch(url, {
        headers: { AccountKey: LTA_API_KEY, accept: "application/json" },
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
});

app.listen(PORT, () => {
  console.log(`Bus Buddy running at http://localhost:${PORT}`);
});
