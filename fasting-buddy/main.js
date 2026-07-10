// ── Bootstrap: theme, tab router, config, auth, service worker ──
import { cfg } from "./env.js";
import * as store from "./state.js";
import * as sb from "./supabase.js";
import { qs, closeSheet } from "./ui.js";
import { renderFast, stopFastTicker } from "./fasting.js";
import { renderDiary } from "./diary.js";
import { renderWeight } from "./weight.js";
import { renderSettings } from "./settings.js";
import { syncPushSub } from "./pushclient.js";

// ── Theme ──
const THEME_KEY = "ft_theme";
function applyTheme(theme) {
  const meta = qs('meta[name="theme-color"]');
  const btn = qs("#themeToggle");
  if (theme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
    meta.setAttribute("content", "#1c1917");
    if (btn) btn.textContent = "☀️";
  } else if (theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
    meta.setAttribute("content", "#6366f1");
    if (btn) btn.textContent = "🌙";
  } else {
    document.documentElement.removeAttribute("data-theme");
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    meta.setAttribute("content", dark ? "#1c1917" : "#6366f1");
    if (btn) btn.textContent = dark ? "☀️" : "🌙";
  }
}
function toggleTheme() {
  const cur = localStorage.getItem(THEME_KEY);
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = cur === "dark" || (cur === null && dark);
  const next = isDark ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}
function initTheme() {
  applyTheme(localStorage.getItem(THEME_KEY) || null);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!localStorage.getItem(THEME_KEY)) applyTheme(null);
  });
}

// ── Tab router ──
const TABS = { fast: renderFast, diary: renderDiary, weight: renderWeight, settings: renderSettings };
let activeTab = "fast";

export function switchTab(name) {
  if (!TABS[name]) return;
  if (activeTab === "fast" && name !== "fast") stopFastTicker();
  activeTab = name;
  document.querySelectorAll(".tab-page").forEach((s) => s.classList.add("hidden"));
  qs(`#tab-${name}`).classList.remove("hidden");
  document.querySelectorAll(".nav-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === name));
  TABS[name]();
  window.scrollTo(0, 0);
}

export function refreshActiveTab() { TABS[activeTab](); }

// ── Boot ──
async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) return;
    const j = await res.json();
    cfg.supabaseUrl = j.supabaseUrl || null;
    cfg.supabaseAnonKey = j.supabaseAnonKey || null;
    cfg.vapidPublicKey = j.vapidPublicKey || null;
    cfg.loaded = true;
  } catch { /* offline / no backend — local mode */ }
}

async function initCloud() {
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) return;
  await sb.initSupabase(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const user = await sb.getUser();
  if (user) await store.attachCloud(user);
  sb.onAuthChange(async (u) => {
    if (u && u.id !== store.store.userId) { await store.attachCloud(u); refreshActiveTab(); }
    else if (!u && store.store.userId) { store.detachCloud(); refreshActiveTab(); }
  });
  refreshActiveTab();
}

function init() {
  initTheme();
  store.loadLocal();

  qs("#themeToggle").addEventListener("click", toggleTheme);
  document.querySelectorAll(".nav-btn").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.tab)));

  // Close sheet on backdrop tap
  qs("#sheetBackdrop").addEventListener("click", (e) => {
    if (e.target === qs("#sheetBackdrop")) closeSheet();
  });

  // Re-render active tab whenever data changes; keep push snapshot fresh
  store.onChange(() => { refreshActiveTab(); syncPushSub(); });

  switchTab("fast");

  // Service worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  // Cloud (non-blocking)
  loadConfig().then(initCloud);
}

document.addEventListener("DOMContentLoaded", init);
