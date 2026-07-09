// ── Supabase wrapper: lazy CDN load, email-code auth, generic table CRUD ──
// The app is fully functional offline (localStorage) without Supabase. Cloud
// sync is additive and only engages when config + a signed-in user exist.

let client = null;
let configured = false;

// Lazily import supabase-js from a CDN (no build step / bundler required).
async function loadLib() {
  const mod = await import("https://esm.sh/@supabase/supabase-js@2.45.4");
  return mod.createClient;
}

export function isConfigured() { return configured; }
export function getClient() { return client; }

// Initialise once we have a URL + anon key from /api/config.
export async function initSupabase(url, anonKey) {
  if (client || !url || !anonKey) return client;
  try {
    const createClient = await loadLib();
    client = createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    configured = true;
    return client;
  } catch (e) {
    console.warn("Supabase init failed (offline mode):", e.message);
    configured = false;
    return null;
  }
}

export async function getUser() {
  if (!client) return null;
  const { data } = await client.auth.getUser();
  return data?.user || null;
}

export function onAuthChange(cb) {
  if (!client) return;
  client.auth.onAuthStateChange((_event, session) => cb(session?.user || null));
}

// Send a 6-digit login code to the email (also works as a magic link).
export async function sendLoginCode(email) {
  if (!client) throw new Error("Cloud sync not configured");
  const { error } = await client.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true },
  });
  if (error) throw error;
}

export async function verifyLoginCode(email, token) {
  if (!client) throw new Error("Cloud sync not configured");
  const { data, error } = await client.auth.verifyOtp({ email, token, type: "email" });
  if (error) throw error;
  return data.user;
}

export async function signOut() {
  if (client) await client.auth.signOut();
}

// ── Generic CRUD (typed columns; see supabase/schema.sql) ──
export async function fetchAll(table, orderCol = null) {
  if (!client) return [];
  let q = client.from(table).select("*");
  if (orderCol) q = q.order(orderCol, { ascending: true });
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function upsert(table, row) {
  if (!client) return;
  const { error } = await client.from(table).upsert(row);
  if (error) throw error;
}

export async function remove(table, id) {
  if (!client) return;
  const { error } = await client.from(table).delete().eq("id", id);
  if (error) throw error;
}

// Save the current auth token so we can call our own /api endpoints authenticated.
export async function getAccessToken() {
  if (!client) return null;
  const { data } = await client.auth.getSession();
  return data?.session?.access_token || null;
}
