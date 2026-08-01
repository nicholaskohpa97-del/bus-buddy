const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3456;
let LTA_API_KEY = process.env.LTA_API_KEY || "";

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".css": "text/css",
};

const ROOT = path.join(__dirname, "..");

async function handleAPI(req, res, pathname) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (pathname === "/api/check-key") {
    return json(res, { hasKey: !!LTA_API_KEY });
  }

  // Account-backed endpoints (config, prefs, reminders, push, modes) need a
  // real Supabase project, so they are deliberately not stubbed here — a fake
  // session would let bugs in the auth gating pass unnoticed locally. Run
  // those against a preview deployment instead.
  if (pathname === "/api/bus-arrival") {
    if (!LTA_API_KEY) return json(res, { error: "API key not set" }, 400);
    const stop = url.searchParams.get("BusStopCode");
    if (!stop) return json(res, { error: "BusStopCode required" }, 400);
    const ltaUrl = new URL("https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival");
    ltaUrl.searchParams.set("BusStopCode", stop);
    const svc = url.searchParams.get("ServiceNo");
    if (svc) ltaUrl.searchParams.set("ServiceNo", svc);
    try {
      const r = await fetch(ltaUrl.toString(), { headers: { AccountKey: LTA_API_KEY, accept: "application/json" } });
      const data = await r.json();
      return json(res, data);
    } catch (err) {
      return json(res, { error: "LTA API request failed", details: err.message }, 502);
    }
  }

  if (pathname === "/api/bus-stops") {
    if (!LTA_API_KEY) return json(res, { error: "API key not set" }, 400);
    return fetchPaginated(res, "BusStops");
  }

  if (pathname === "/api/bus-routes") {
    if (!LTA_API_KEY) return json(res, { error: "API key not set" }, 400);
    return fetchPaginated(res, "BusRoutes");
  }

  if (pathname === "/api/geocode") {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) return json(res, { error: "q required" }, 400);
    try {
      const geoUrl = `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${encodeURIComponent(q)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
      const r = await fetch(geoUrl, { headers: { accept: "application/json" } });
      const data = await r.json();
      const results = (data.results || [])
        .map((v) => ({
          address: v.ADDRESS,
          postal: v.POSTAL,
          latitude: parseFloat(v.LATITUDE),
          longitude: parseFloat(v.LONGITUDE),
        }))
        .filter((v) => Number.isFinite(v.latitude) && Number.isFinite(v.longitude))
        .slice(0, 5);
      return json(res, { results });
    } catch (err) {
      return json(res, { error: "Failed to geocode", details: err.message }, 502);
    }
  }

  // Journey planning, mirroring api/route-plan.js minus the auth check —
  // there's no Supabase session locally. Needs ONEMAP_EMAIL / ONEMAP_PASSWORD
  // in the environment; the token is re-minted per run rather than cached,
  // which is fine for a dev server and avoids needing the kv table.
  if (pathname === "/api/route-plan") {
    const start = url.searchParams.get("start") || "";
    const end = url.searchParams.get("end") || "";
    if (!start || !end) return json(res, { error: "start and end required" }, 400);
    if (!process.env.ONEMAP_EMAIL || !process.env.ONEMAP_PASSWORD) {
      return json(res, { error: "ONEMAP_EMAIL / ONEMAP_PASSWORD not set" }, 400);
    }
    try {
      const token = await getLocalOneMapToken();
      const sgt = new Date(Date.now() + 8 * 3600 * 1000);
      const routeUrl = new URL("https://www.onemap.gov.sg/api/public/routingsvc/route");
      routeUrl.searchParams.set("start", start);
      routeUrl.searchParams.set("end", end);
      routeUrl.searchParams.set("routeType", "pt");
      routeUrl.searchParams.set("date", sgt.toISOString().slice(0, 10));
      routeUrl.searchParams.set("time", sgt.toISOString().slice(11, 19));
      routeUrl.searchParams.set("mode", "TRANSIT");
      routeUrl.searchParams.set("maxWalkDistance", "1000");
      routeUrl.searchParams.set("numItineraries", "3");
      const r = await fetch(routeUrl.toString(), {
        headers: { Authorization: token, accept: "application/json" },
      });
      return json(res, await r.json(), r.ok ? 200 : 502);
    } catch (err) {
      return json(res, { error: "Failed to plan route", details: err.message }, 502);
    }
  }

  json(res, { error: "Not found" }, 404);
}

let localOneMapToken = null;
async function getLocalOneMapToken() {
  if (localOneMapToken) return localOneMapToken;
  const r = await fetch("https://www.onemap.gov.sg/api/auth/post/getToken", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: process.env.ONEMAP_EMAIL,
      password: process.env.ONEMAP_PASSWORD,
    }),
  });
  if (!r.ok) throw new Error(`OneMap auth ${r.status}`);
  const data = await r.json();
  if (!data.access_token) throw new Error("OneMap auth returned no access_token");
  localOneMapToken = data.access_token;
  return localOneMapToken;
}

async function fetchPaginated(res, endpoint) {
  const all = [];
  let skip = 0;
  try {
    while (true) {
      const r = await fetch(`https://datamall2.mytransport.sg/ltaodataservice/${endpoint}?$skip=${skip}`, {
        headers: { AccountKey: LTA_API_KEY, accept: "application/json" },
      });
      const data = await r.json();
      if (!data.value || data.value.length === 0) break;
      all.push(...data.value);
      skip += 500;
    }
    json(res, { value: all });
  } catch (err) {
    json(res, { error: `Failed to fetch ${endpoint}`, details: err.message }, 502);
  }
}

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (pathname.startsWith("/api/")) {
    return handleAPI(req, res, pathname);
  }

  let filePath = path.join(ROOT, pathname === "/" ? "index.html" : pathname);
  const ext = path.extname(filePath);
  if (!ext) filePath += ".html";

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => console.log(`Bus Buddy running at http://localhost:${PORT}`));
