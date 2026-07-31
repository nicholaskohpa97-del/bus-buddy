// ── Accounts ───────────────────────────────────────────────────────────────
//
// Everything in Bus Buddy used to hang off `bb_deviceId`, a random string in
// localStorage. That made "sync across devices" impossible by construction and
// left journey modes in one globally-shared row. This module puts a real
// Supabase session underneath the app: nothing boots until there's a signed-in
// user, and every API call carries that user's JWT.
//
// Loaded as a plain <script>, like the rest of the app — the functions called
// from onclick="..." attributes have to be globals.

let sb = null; // Supabase client, built once /api/config answers
let bbUser = null;
let authMode = "signin"; // "signin" | "signup"
let appBootstrapped = false;

const PASSWORD_MIN = 8;

// Mirror this in Supabase → Authentication → Policies, or a weak password is
// only rejected in the one place an attacker isn't.
function passwordProblem(pw) {
  if (pw.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (!/[A-Za-z]/.test(pw)) return "Password must contain at least one letter.";
  if (!/[0-9]/.test(pw)) return "Password must contain at least one number.";
  return null;
}

// ── Session plumbing ───────────────────────────────────────────────────────

async function getAccessToken() {
  if (!sb) return null;
  // getSession() refreshes an expired token transparently, so this is the only
  // safe way to read it — a cached copy goes stale after an hour.
  const { data } = await sb.auth.getSession();
  return data?.session?.access_token || null;
}

// Drop-in for fetch() on any endpoint that needs the caller identified.
async function authFetch(url, options = {}) {
  const token = await getAccessToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    // The session died underneath us (revoked, password changed elsewhere).
    // Bounce to the login screen rather than letting the UI show empty state
    // that looks like data loss.
    await handleSignedOut();
  }
  return res;
}

function currentUser() {
  return bbUser;
}

// ── Screens ────────────────────────────────────────────────────────────────

function showAuthScreen() {
  const el = document.getElementById("authScreen");
  if (el) el.classList.remove("hidden");
  document.body.classList.add("auth-gate");
  if (window.__hideSplash) window.__hideSplash();
}

function hideAuthScreen() {
  const el = document.getElementById("authScreen");
  if (el) el.classList.add("hidden");
  document.body.classList.remove("auth-gate");
}

function authSetMode(mode) {
  authMode = mode;
  document.getElementById("authTabSignin").classList.toggle("active", mode === "signin");
  document.getElementById("authTabSignup").classList.toggle("active", mode === "signup");
  document.getElementById("authSubmit").textContent =
    mode === "signin" ? "Sign in" : "Create account";
  document.getElementById("authPasswordHint").classList.toggle("hidden", mode !== "signup");
  document.getElementById("authForgot").classList.toggle("hidden", mode !== "signin");
  authError("");
}

function authError(msg) {
  const el = document.getElementById("authError");
  if (!el) return;
  el.textContent = msg || "";
  el.classList.toggle("hidden", !msg);
}

function authNote(msg) {
  const el = document.getElementById("authNote");
  if (!el) return;
  el.textContent = msg || "";
  el.classList.toggle("hidden", !msg);
}

function authBusy(on) {
  const btn = document.getElementById("authSubmit");
  if (btn) {
    btn.disabled = on;
    btn.textContent = on
      ? "Working…"
      : authMode === "signin"
      ? "Sign in"
      : "Create account";
  }
}

// ── Actions (called from onclick) ──────────────────────────────────────────

async function authSubmit(event) {
  if (event) event.preventDefault();
  if (!sb) return authError("Still starting up — try again in a second.");

  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  authError("");
  authNote("");

  if (!email) return authError("Enter your email address.");
  if (!password) return authError("Enter your password.");

  if (authMode === "signup") {
    const problem = passwordProblem(password);
    if (problem) return authError(problem);
  }

  authBusy(true);
  try {
    if (authMode === "signin") {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) return authError(error.message);
    } else {
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) return authError(error.message);
      // With email confirmation on, signUp returns a user but no session.
      if (!data.session) {
        return authNote(
          "Check your inbox for a confirmation link, then come back and sign in."
        );
      }
    }
  } catch (e) {
    authError(e.message || "Something went wrong. Try again.");
  } finally {
    authBusy(false);
  }
}

async function authGoogle() {
  if (!sb) return authError("Still starting up — try again in a second.");
  authError("");
  const { error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
  if (error) authError(error.message);
}

async function authForgotPassword() {
  if (!sb) return;
  const email = document.getElementById("authEmail").value.trim();
  if (!email) return authError("Enter your email address first, then tap Forgot password.");
  authError("");
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin,
  });
  if (error) return authError(error.message);
  authNote("Password reset link sent — check your inbox.");
}

async function authSignOut() {
  if (!sb) return;
  try {
    // Retire this device's push registration first; otherwise the server keeps
    // pushing this account's alerts to a phone that's been signed out of it.
    await unregisterPushForDevice();
  } catch {
    /* best effort — signing out still has to work offline */
  }
  await sb.auth.signOut();
  // A full reload is the honest way to clear in-memory state that belongs to
  // the previous account; there is no teardown path through the whole app.
  window.location.reload();
}

async function handleSignedOut() {
  if (!bbUser) return;
  bbUser = null;
  window.location.reload();
}

// ── Boot ───────────────────────────────────────────────────────────────────

async function initAuth() {
  let cfg;
  try {
    cfg = await fetch("/api/config").then((r) => r.json());
  } catch {
    cfg = null;
  }
  if (!cfg || !cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    showAuthScreen();
    authError(
      "Accounts aren't configured on this deployment (SUPABASE_URL / SUPABASE_ANON_KEY). See SETUP.md."
    );
    document.getElementById("authForm").classList.add("hidden");
    return;
  }
  if (typeof supabase === "undefined") {
    showAuthScreen();
    authError("Couldn't load the auth library. Check your connection and reload.");
    return;
  }

  sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true, // completes the Google OAuth redirect
      storageKey: "bb_auth",
    },
  });

  const { data } = await sb.auth.getSession();
  await applySession(data?.session || null);

  sb.auth.onAuthStateChange(async (event, session) => {
    if (event === "SIGNED_OUT") return handleSignedOut();
    if (session && !bbUser) await applySession(session);
  });
}

async function applySession(session) {
  if (!session || !session.user) {
    showAuthScreen();
    return;
  }
  bbUser = session.user;
  hideAuthScreen();
  renderAccountRow();
  if (!appBootstrapped) {
    appBootstrapped = true;
    await bootstrapApp();
  }
}

// Shows who's signed in, inside the Settings modal.
function renderAccountRow() {
  const el = document.getElementById("accountEmail");
  if (el && bbUser) el.textContent = bbUser.email || bbUser.id;
}

document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  authSetMode("signin");
  initAuth();
});
