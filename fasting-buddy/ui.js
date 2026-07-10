// ── Small DOM / UI helpers shared across feature modules ──

export function qs(sel, root = document) { return root.querySelector(sel); }

// Create an element from an HTML string (returns first element).
export function html(str) {
  const t = document.createElement("template");
  t.innerHTML = str.trim();
  return t.content.firstElementChild;
}

// Escape user/API text before injecting into innerHTML.
export function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

let toastTimer = null;
export function toast(msg) {
  const t = qs("#toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

// ── Bottom sheet ──
export function openSheet(innerHtml) {
  const backdrop = qs("#sheetBackdrop");
  qs("#sheetBody").innerHTML = innerHtml;
  backdrop.classList.add("open");
  document.body.style.overflow = "hidden";
  return qs("#sheetBody");
}
export function closeSheet() {
  qs("#sheetBackdrop").classList.remove("open");
  document.body.style.overflow = "";
}

// ── Formatting ──
export function pad2(n) { return String(n).padStart(2, "0"); }

// Duration in ms → "12h 03m" (or with seconds when < 1h and withSec).
export function fmtDur(ms, withSec = false) {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${pad2(m)}m`;
  if (withSec) return `${m}m ${pad2(s)}s`;
  return `${m}m`;
}

// Full clock "07:14:52" for the live ring.
export function fmtClock(ms) {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

export function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function fmtDateLabel(key) {
  const t = todayKey();
  if (key === t) return "Today";
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (key === todayKey(y)) return "Yesterday";
  const [yr, mo, da] = key.split("-").map(Number);
  const dt = new Date(yr, mo - 1, da);
  return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function fmtTimeOfDay(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function shiftDateKey(key, deltaDays) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  return todayKey(dt);
}

export function round(n, dp = 0) {
  const f = Math.pow(10, dp);
  return Math.round((Number(n) || 0) * f) / f;
}
