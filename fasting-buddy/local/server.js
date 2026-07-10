// Minimal local dev server: serves static files and routes /api/* to the
// Vercel-style handlers in ../api via a small req/res adapter.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const ROOT = path.join(__dirname, "..");
const PORT = process.env.PORT || 3456;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Wrap a Node res so Vercel-style handlers (res.status().json()) work.
function adaptRes(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); return res; };
  return res;
}

async function handleApi(name, req, res) {
  const file = path.join(ROOT, "api", name + ".js");
  if (!fs.existsSync(file)) { res.statusCode = 404; return res.end("Not found"); }
  const u = new URL(req.url, "http://localhost");
  req.query = Object.fromEntries(u.searchParams.entries());
  // collect body
  let body = "";
  for await (const chunk of req) body += chunk;
  try { req.body = body ? JSON.parse(body) : undefined; } catch { req.body = body; }
  const handler = require(file);
  try { await handler(req, adaptRes(res)); }
  catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); }
}

function serveStatic(pathname, res) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end("Forbidden"); }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(ROOT, "index.html"), (e2, html) => {
        if (e2) { res.statusCode = 404; return res.end("Not found"); }
        res.setHeader("Content-Type", MIME[".html"]); res.end(html);
      });
      return;
    }
    res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
    res.end(data);
  });
}

http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname.startsWith("/api/")) {
    return handleApi(u.pathname.slice(5).replace(/\/$/, ""), req, res);
  }
  serveStatic(u.pathname, res);
}).listen(PORT, () => console.log(`FastTrack dev server → http://localhost:${PORT}`));
