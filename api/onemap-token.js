const { SB_URL, fetchWithTimeout, serviceHeaders } = require("./_auth");

// OneMap's routing service needs an access token, unlike its public geocoder.
// The token lasts three days, so minting one per request would be both slow
// and rude. It's cached in a Supabase row rather than module scope because
// serverless functions cold-start constantly — an in-memory cache would be
// empty most of the time.
const TOKEN_KEY = "onemap_token";
// Refresh a little early rather than discovering expiry mid-request.
const REFRESH_MARGIN_MS = 6 * 60 * 60 * 1000;

async function readCached() {
  try {
    const res = await fetchWithTimeout(
      `${SB_URL}/rest/v1/kv?key=eq.${TOKEN_KEY}&select=value`,
      { headers: serviceHeaders() }
    );
    if (!res.ok) return null;
    const row = (await res.json())[0];
    if (!row || !row.value || !row.value.token) return null;
    const expiryMs = Number(row.value.expiry) * 1000;
    if (!Number.isFinite(expiryMs) || expiryMs - Date.now() < REFRESH_MARGIN_MS) return null;
    return row.value.token;
  } catch {
    return null;
  }
}

async function writeCached(token, expiry) {
  await fetchWithTimeout(`${SB_URL}/rest/v1/kv?on_conflict=key`, {
    method: "POST",
    headers: serviceHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({
      key: TOKEN_KEY,
      value: { token, expiry },
      updated_at: new Date().toISOString(),
    }),
  }).catch(() => {
    // A cache write failing is not worth failing the request over — the
    // caller already has a usable token, it just won't be reused.
  });
}

async function mintToken() {
  const email = process.env.ONEMAP_EMAIL;
  const password = process.env.ONEMAP_PASSWORD;
  if (!email || !password) {
    throw new Error("ONEMAP_EMAIL / ONEMAP_PASSWORD not configured");
  }
  const res = await fetchWithTimeout("https://www.onemap.gov.sg/api/auth/post/getToken", {
    method: "POST",
    headers: { "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`OneMap auth ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const token = data.access_token;
  if (!token) throw new Error("OneMap auth returned no access_token");
  return { token, expiry: data.expiry_timestamp };
}

async function getOneMapToken() {
  const cached = await readCached();
  if (cached) return cached;
  const { token, expiry } = await mintToken();
  await writeCached(token, expiry);
  return token;
}

// Health check only — deliberately never returns the token itself. The token
// is a credential; the browser has no business holding one, which is why
// routing goes through /api/route-plan rather than straight to OneMap.
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const token = await getOneMapToken();
    return res.json({ ok: true, hasToken: !!token });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message });
  }
};

module.exports.getOneMapToken = getOneMapToken;
