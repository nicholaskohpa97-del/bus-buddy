// Shared Supabase access helpers for the API routes.
//
// Two header sets, deliberately different:
//
//   userHeaders(req)  — user-facing paths. The caller's own JWT rides in
//                       Authorization, so Postgres RLS scopes every row to
//                       auth.uid(). Even a buggy filter can't leak another
//                       account's data.
//   serviceHeaders()  — server-only paths (the cron) that must read across
//                       every user, which RLS would otherwise forbid.
const SB_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const FETCH_TIMEOUT_MS = 8000;

function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

// The service key is sent in `apikey` only, never in Authorization. Legacy
// `service_role` JWTs are accepted in either header, but the newer
// `sb_secret_...` keys are not JWTs and are rejected as a bearer token —
// `apikey` alone is the one form valid for both, and the legacy format is
// deprecated at the end of 2026.
function serviceHeaders(extra = {}) {
  return { apikey: SERVICE_KEY, "Content-Type": "application/json", ...extra };
}

function userHeaders(req, extra = {}) {
  return {
    apikey: ANON_KEY,
    Authorization: req.headers.authorization || "",
    "Content-Type": "application/json",
    ...extra,
  };
}

// Verifies the caller's access token against Supabase Auth. Returns the user
// object, or null when the header is missing/expired/forged. This is the only
// thing standing between one account's rows and another's, so every route
// touching user data must call it.
async function getUser(req) {
  const auth = req.headers.authorization || "";
  if (!/^Bearer\s+\S+/i.test(auth)) return null;
  try {
    const res = await fetchWithTimeout(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: auth },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? user : null;
  } catch {
    return null;
  }
}

// Returns the user, or writes a 401 and returns null.
async function requireUser(req, res) {
  const user = await getUser(req);
  if (!user) {
    res.status(401).json({ error: "Sign in required" });
    return null;
  }
  return user;
}

// Preflight + CORS. Authorization has to be allowed now that every user-facing
// route is JWT-authenticated.
function cors(req, res, methods = "GET, POST, OPTIONS") {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return true;
  }
  return false;
}

module.exports = {
  SB_URL,
  ANON_KEY,
  SERVICE_KEY,
  fetchWithTimeout,
  serviceHeaders,
  userHeaders,
  getUser,
  requireUser,
  cors,
};
