// ── Authentication (Supabase Auth) ──
//
// Sign-in is required: app.js does not boot until startAuth() resolves a live
// session. Supabase's JS client is loaded from a CDN in index.html, matching how
// Leaflet is already loaded — this project has no bundler, so every function
// here is a top-level global so inline onclick handlers can reach it.

let sbClient = null;
let currentSession = null;
let authMode = "signin"; // "signin" | "signup"

const USER_KEY = "bb_userId";

// Keys holding per-user data. Cleared when a different account signs in on the
// same browser, so one person's favourites never surface under another's login.
const USER_SCOPED_KEYS = [
  "bb_favourites",
  "bb_deptReminders",
  "bb_dropoffAlerts",
  "bb_modes",
  "bb_places",
  "bb_onboarded",
  "bb_deptNotifyState",
];

const PASSWORD_RULES = [
  { test: (p) => p.length >= 8, label: "at least 8 characters" },
  { test: (p) => /[A-Za-z]/.test(p), label: "a letter" },
  { test: (p) => /[0-9]/.test(p), label: "a number" },
];

function passwordProblems(password) {
  return PASSWORD_RULES.filter((r) => !r.test(password)).map((r) => r.label);
}

// ── Session plumbing ──

function authToken() {
  return (currentSession && currentSession.access_token) || "";
}

function currentUserId() {
  return (currentSession && currentSession.user && currentSession.user.id) || "";
}

function currentUserEmail() {
  return (currentSession && currentSession.user && currentSession.user.email) || "";
}

// Every request to our own user-scoped endpoints must carry the session token;
// the server rejects anything unauthenticated.
async function authedFetch(url, options = {}) {
  const headers = Object.assign({}, options.headers || {});
  const token = authToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, Object.assign({}, options, { headers }));
}

// A different account on this browser must not inherit the previous one's
// locally cached data.
function clearUserScopedStorage() {
  USER_SCOPED_KEYS.forEach((k) => localStorage.removeItem(k));
}

function reconcileStoredUser(userId) {
  const previous = localStorage.getItem(USER_KEY);
  if (previous && previous !== userId) clearUserScopedStorage();
  localStorage.setItem(USER_KEY, userId);
}

// ── Boot ──

async function startAuth() {
  let cfg = {};
  try {
    cfg = await fetch("/api/config").then((r) => r.json());
  } catch {
    cfg = {};
  }

  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.supabase) {
    showAuthScreen();
    setAuthError(
      "Sign-in is unavailable — the app is missing its Supabase configuration."
    );
    if (window.__hideSplash) window.__hideSplash();
    return;
  }

  sbClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true, // completes the Google OAuth redirect
    },
  });

  const { data } = await sbClient.auth.getSession();
  currentSession = data ? data.session : null;

  // Fires on token refresh and on the OAuth redirect landing back here.
  sbClient.auth.onAuthStateChange((event, session) => {
    currentSession = session;
    if (event === "SIGNED_OUT" || !session) {
      showAuthScreen();
    } else {
      reconcileStoredUser(session.user.id);
      hideAuthScreen();
      bootstrapApp();
    }
  });

  if (currentSession) {
    reconcileStoredUser(currentSession.user.id);
    hideAuthScreen();
    bootstrapApp();
  } else {
    showAuthScreen();
    if (window.__hideSplash) window.__hideSplash();
  }
}

// ── Screen ──

function showAuthScreen() {
  const el = document.getElementById("authScreen");
  if (el) el.classList.remove("hidden");
  document.body.classList.add("auth-locked");
}

function hideAuthScreen() {
  const el = document.getElementById("authScreen");
  if (el) el.classList.add("hidden");
  document.body.classList.remove("auth-locked");
  setAuthError("");
}

function setAuthError(msg) {
  const el = document.getElementById("authError");
  if (!el) return;
  el.textContent = msg || "";
  el.classList.toggle("hidden", !msg);
}

function setAuthBusy(busy) {
  document
    .querySelectorAll("#authScreen button, #authScreen input")
    .forEach((el) => {
      el.disabled = busy;
    });
}

function setAuthMode(mode) {
  authMode = mode === "signup" ? "signup" : "signin";
  const signingUp = authMode === "signup";
  const submit = document.getElementById("authSubmit");
  const title = document.getElementById("authTitle");
  const toggle = document.getElementById("authToggle");
  const hint = document.getElementById("authPasswordHint");
  if (submit) submit.textContent = signingUp ? "Create account" : "Sign in";
  if (title) title.textContent = signingUp ? "Create your account" : "Welcome back";
  if (toggle) {
    toggle.textContent = signingUp
      ? "Already have an account? Sign in"
      : "New here? Create an account";
  }
  if (hint) hint.classList.toggle("hidden", !signingUp);
  setAuthError("");
}

function toggleAuthMode() {
  setAuthMode(authMode === "signup" ? "signin" : "signup");
}

// ── Actions (called from markup) ──

async function submitAuth(event) {
  if (event) event.preventDefault();
  if (!sbClient) {
    // Don't let the button look inert — say why nothing can happen.
    return setAuthError(
      "Sign-in is unavailable — the app is missing its Supabase configuration."
    );
  }

  const email = (document.getElementById("authEmail").value || "").trim();
  const password = document.getElementById("authPassword").value || "";

  if (!email) return setAuthError("Enter your email address.");

  if (authMode === "signup") {
    const problems = passwordProblems(password);
    if (problems.length) {
      return setAuthError(`Password needs ${problems.join(", ")}.`);
    }
  } else if (!password) {
    return setAuthError("Enter your password.");
  }

  setAuthBusy(true);
  setAuthError("");
  try {
    if (authMode === "signup") {
      const { data, error } = await sbClient.auth.signUp({ email, password });
      if (error) throw error;
      // With email confirmation enabled Supabase returns a user but no session.
      if (!data.session) {
        setAuthError("Check your inbox to confirm your email, then sign in.");
        setAuthMode("signin");
        return;
      }
    } else {
      const { error } = await sbClient.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
    // onAuthStateChange boots the app.
  } catch (e) {
    setAuthError(e.message || "Sign-in failed. Try again.");
  } finally {
    setAuthBusy(false);
  }
}

async function signInWithGoogle() {
  if (!sbClient) return;
  setAuthError("");
  try {
    const { error } = await sbClient.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) throw error;
  } catch (e) {
    setAuthError(e.message || "Google sign-in failed.");
  }
}

async function signOut() {
  if (!sbClient) return;
  try {
    await sbClient.auth.signOut();
  } catch {
    /* fall through — reload clears local session state regardless */
  }
  clearUserScopedStorage();
  localStorage.removeItem(USER_KEY);
  window.location.reload();
}

async function sendPasswordReset() {
  if (!sbClient) return;
  const email = (document.getElementById("authEmail").value || "").trim();
  if (!email) return setAuthError("Enter your email address first.");
  try {
    const { error } = await sbClient.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });
    if (error) throw error;
    setAuthError("Password reset link sent — check your inbox.");
  } catch (e) {
    setAuthError(e.message || "Could not send reset email.");
  }
}
