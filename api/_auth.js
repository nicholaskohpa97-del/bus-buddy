// Shared Supabase helpers for the API routes.
//
// Vercel ignores files under api/ whose name starts with "_", so this is a
// plain module rather than an endpoint.
//
// Two Supabase keys are used here and they are NOT interchangeable:
//   • anon key    — public, safe to ship to the browser. Requests made with a
//                   user's access token are subject to RLS.
//   • service key — bypasses RLS entirely. Only for server-only jobs (the
//                   reminder cron) that must read across every user's rows.
//                   Never return it to a client.
//
// Env is read on every call rather than captured at module load: a cached
// module would otherwise pin whatever values happened to exist at first import,
// which breaks both serverless env updates and the test suite's per-case setup.

const FETCH_TIMEOUT_MS = 8000;

function sbUrl() {
  return process.env.SUPABASE_URL;
}

function anonKey() {
  return process.env.SUPABASE_ANON_KEY;
}

function serviceKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY;
}

function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

// Headers for server-only queries that must span all users (the cron).
function serviceHeaders(extra = {}) {
  return {
    apikey: serviceKey(),
    Authorization: `Bearer ${serviceKey()}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

// Headers that act as the signed-in user, so RLS applies normally.
function userHeaders(token, extra = {}) {
  return {
    apikey: anonKey(),
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

// Resolve the caller's Supabase user from their access token. Returns null for
// anything that isn't a live session; the caller decides how to respond.
async function getUser(req) {
  const token = bearerToken(req);
  if (!token || !sbUrl() || !anonKey()) return null;
  try {
    const res = await fetchWithTimeout(`${sbUrl()}/auth/v1/user`, {
      headers: { apikey: anonKey(), Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? { id: user.id, email: user.email, token } : null;
  } catch {
    return null;
  }
}

// Verify the caller and short-circuit with 401 when there is no session.
// Returns the user, or null once a response has already been sent.
async function requireUser(req, res) {
  const user = await getUser(req);
  if (!user) {
    res.status(401).json({ error: "Sign in required" });
    return null;
  }
  return user;
}

// Same-origin in production, but the existing endpoints set CORS headers, so
// keep that behaviour and make sure Authorization is an allowed header.
function applyCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return true;
  }
  return false;
}

module.exports = {
  sbUrl,
  anonKey,
  serviceKey,
  fetchWithTimeout,
  serviceHeaders,
  userHeaders,
  bearerToken,
  getUser,
  requireUser,
  applyCors,
};
