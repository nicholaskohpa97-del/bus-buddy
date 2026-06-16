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
  ".css": "text/css",
};

const ROOT = path.join(__dirname, "..");

async function handleAPI(req, res, pathname) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (pathname === "/api/check-key") {
    return json(res, { hasKey: !!LTA_API_KEY });
  }

  if (pathname === "/api/set-key" && req.method === "POST") {
    const body = await readBody(req);
    LTA_API_KEY = body.key || "";
    return json(res, { ok: true });
  }

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

  json(res, { error: "Not found" }, 404);
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
