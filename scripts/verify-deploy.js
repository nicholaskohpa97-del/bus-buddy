#!/usr/bin/env node
//
// Post-deploy smoke check. Confirms the accounts migration ran, the env vars
// landed, and the auth gate actually gates.
//
//   node scripts/verify-deploy.js https://your-app.vercel.app
//
// To also check the cron endpoint (optional):
//   CRON_SECRET=... node scripts/verify-deploy.js https://your-app.vercel.app
//
// Everything it reads is already public — the anon key is publishable by
// design, and no endpoint here returns a secret. It never asks for the service
// role key or the OneMap password, and the CRON_SECRET is read from the
// environment so it stays out of your shell history and off the wire to
// anywhere but your own deployment.

const base = (process.argv[2] || "").replace(/\/+$/, "");
if (!base) {
  console.error("Usage: node scripts/verify-deploy.js https://your-app.vercel.app");
  process.exit(2);
}

const results = [];
let failed = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (ok === false) failed++;
}

async function get(url, options = {}) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON — the body is reported raw instead */
    }
    return { status: res.status, json, text };
  } catch (e) {
    return { status: 0, error: e.message };
  }
}

async function main() {
  console.log(`Checking ${base}\n`);

  // ── 1. The app is served at all ──
  const root = await get(base);
  record("app responds", root.status === 200, `HTTP ${root.status || root.error}`);

  // ── 2. Supabase config reaches the browser ──
  // Without this the auth screen shows a configuration error and the app is
  // unreachable, so it's the single most important check here.
  const cfg = await get(`${base}/api/config`);
  const supabaseUrl = cfg.json?.supabaseUrl || "";
  const anonKey = cfg.json?.supabaseAnonKey || "";
  record(
    "SUPABASE_URL set",
    !!supabaseUrl,
    supabaseUrl ? supabaseUrl : "empty — the sign-in screen will error"
  );
  record(
    "SUPABASE_ANON_KEY set",
    !!anonKey,
    anonKey ? `${anonKey.slice(0, 8)}… (${anonKey.length} chars)` : "empty"
  );

  // ── 3. Other server-side env vars ──
  const key = await get(`${base}/api/check-key`);
  record("LTA_API_KEY set", key.json?.hasKey === true, key.json?.hasKey ? "yes" : "no — arrivals won't load");

  const vapid = await get(`${base}/api/vapid-public-key`);
  record(
    "VAPID_PUBLIC_KEY set",
    !!vapid.json?.key,
    vapid.json?.key ? "yes" : "no — background push disabled"
  );

  // Returns {ok, hasToken} — deliberately never the token itself.
  const onemap = await get(`${base}/api/onemap-token`);
  record(
    "ONEMAP credentials work",
    onemap.json?.ok === true,
    onemap.json?.ok ? "token minted" : onemap.json?.error || `HTTP ${onemap.status}`
  );

  // ── 4. The auth gate gates ──
  // An unauthenticated call to a user-scoped route must be refused. A 200 here
  // would mean anyone can read anyone's data.
  for (const path of ["/api/prefs", "/api/reminders", "/api/modes", "/api/rides", "/api/push"]) {
    const r = await get(`${base}${path}`);
    record(`${path} refuses anonymous callers`, r.status === 401, `HTTP ${r.status}`);
  }

  // ── 5. The migration ran ──
  // Queried with the anon key. A missing table answers 404 (PGRST205); a table
  // that exists but is protected by RLS answers 200 with an empty array,
  // because RLS filters rows rather than erroring. Both are distinguishable,
  // and both are what we want to see.
  if (supabaseUrl && anonKey) {
    for (const table of [
      "user_prefs",
      "push_subs",
      "reminders",
      "modes",
      "rides",
      "kv",
      "tg_links",
      "tg_link_codes",
      "tg_sessions",
    ]) {
      const r = await get(`${supabaseUrl}/rest/v1/${table}?select=*&limit=1`, {
        headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      });
      const exists = r.status !== 404 && r.json?.code !== "PGRST205";
      const leaks = r.status === 200 && Array.isArray(r.json) && r.json.length > 0;
      record(
        `table ${table}`,
        exists && !leaks,
        !exists
          ? "missing — migration didn't run"
          : leaks
          ? "⚠️  RETURNS ROWS TO AN ANONYMOUS CALLER — RLS is not enabled"
          : "exists, RLS holding"
      );
    }
  } else {
    record("migration check", null, "skipped — no Supabase config to query with");
  }

  // ── 6. Cron health (optional) ──
  if (process.env.CRON_SECRET) {
    const probe = await get(`${base}/api/check-reminders?probe=1`, {
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    const checks = probe.json?.checks || {};
    const missing = Object.entries(checks)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    record(
      "cron env vars",
      probe.json?.ok === true,
      missing.length ? `missing: ${missing.join(", ")}` : probe.json?.dbError || "all set"
    );
  } else {
    record("cron health", null, "skipped — run again with CRON_SECRET=... to include it");
  }

  // ── Report ──
  const pad = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    const mark = r.ok === true ? "✓" : r.ok === false ? "✗" : "–";
    console.log(`  ${mark}  ${r.name.padEnd(pad)}  ${r.detail}`);
  }
  console.log(
    `\n${results.filter((r) => r.ok === true).length} passed, ${failed} failed, ` +
      `${results.filter((r) => r.ok === null).length} skipped`
  );
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
