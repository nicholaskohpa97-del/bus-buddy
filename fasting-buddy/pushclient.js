// ── Web Push client: permission, subscribe, and keep push_subs row in sync ──
import { store } from "./state.js";
import * as sb from "./supabase.js";
import { cfg } from "./env.js";

function urlB64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export async function isPushEnabled() {
  return Notification.permission === "granted" && !!(await currentSubscription());
}

// Build the self-contained row the cron reads (mirrors bus-buddy's push_subs.data).
function buildData(subscription) {
  const f = store.activeFast;
  return {
    subscription,
    prefs: store.profile.notif,
    fast: f ? { startedAt: new Date(f.startedAt).toISOString(), targetHours: f.targetHours } : null,
    tzOffsetMin: new Date().getTimezoneOffset(),
    notifyState: {},
    updatedAt: new Date().toISOString(),
  };
}

async function upsertRow(data) {
  if (!sb.isConfigured() || !store.userId) return;
  await sb.upsert("push_subs", { user_id: store.userId, data });
}

export async function enablePush() {
  if (!pushSupported()) throw new Error("Notifications not supported on this device");
  if (!cfg.vapidPublicKey) throw new Error("Push not configured on the server");
  if (!sb.isConfigured() || !store.userId) throw new Error("Sign in to enable cloud reminders");

  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notification permission denied");

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(cfg.vapidPublicKey),
    });
  }
  await upsertRow(buildData(sub.toJSON()));
  return true;
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (sub) await sub.unsubscribe();
  if (sb.isConfigured() && store.userId) {
    try { await sb.upsert("push_subs", { user_id: store.userId, data: { subscription: null } }); } catch {}
  }
}

// Re-push the snapshot when a fast starts/ends or prefs change.
export async function syncPushSub() {
  if (!sb.isConfigured() || !store.userId) return;
  if (Notification.permission !== "granted") return;
  const sub = await currentSubscription();
  if (!sub) return;
  try { await upsertRow(buildData(sub.toJSON())); } catch (e) { console.warn("syncPushSub", e.message); }
}
