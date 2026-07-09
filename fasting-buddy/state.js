// ── App state: single source of truth, localStorage-backed, cloud-sync optional ──
import * as sb from "./supabase.js";
import { todayKey } from "./ui.js";

export const PROTOCOLS = {
  "14:10": { fast: 14, label: "14:10", desc: "14h fast · 10h window" },
  "16:8":  { fast: 16, label: "16:8",  desc: "16h fast · 8h window" },
  "18:6":  { fast: 18, label: "18:6",  desc: "18h fast · 6h window" },
  "20:4":  { fast: 20, label: "20:4",  desc: "20h fast · 4h window (Warrior)" },
  "OMAD":  { fast: 23, label: "OMAD",  desc: "One meal a day" },
  "36h":   { fast: 36, label: "36h",   desc: "Monk fast" },
};

export const MEAL_TYPES = ["Breakfast", "Lunch", "Dinner", "Snack"];

const DEFAULT_PROFILE = {
  calorieGoal: 2000,
  proteinGoal: 150,
  carbsGoal: 200,
  fatGoal: 65,
  protocol: "16:8",
  customFastHours: 16,
  goalWeight: null,
  startWeight: null,
  units: "kg",
  notif: {
    fastComplete: true,
    windowEnding: true,
    fastStart: false,
    weighIn: false,
    weighInTime: "08:00",
  },
};

const KEYS = {
  profile: "ft_profile",
  activeFast: "ft_activeFast",
  fasts: "ft_fasts",
  food: "ft_food",
  custom: "ft_customFoods",
  weight: "ft_weight",
};

export const store = {
  profile: { ...DEFAULT_PROFILE },
  activeFast: null,
  fasts: [],        // completed fasts
  food: [],         // food entries
  customFoods: [],
  weight: [],       // weight entries (one per day)
  userId: null,
  userEmail: null,
};

// ── uid ──
function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── change subscribers ──
const listeners = new Set();
export function onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }
function notify() { listeners.forEach((cb) => { try { cb(); } catch (e) { console.error(e); } }); }

// ── localStorage ──
function readJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function persist() {
  localStorage.setItem(KEYS.profile, JSON.stringify(store.profile));
  localStorage.setItem(KEYS.activeFast, JSON.stringify(store.activeFast));
  localStorage.setItem(KEYS.fasts, JSON.stringify(store.fasts));
  localStorage.setItem(KEYS.food, JSON.stringify(store.food));
  localStorage.setItem(KEYS.custom, JSON.stringify(store.customFoods));
  localStorage.setItem(KEYS.weight, JSON.stringify(store.weight));
}

export function loadLocal() {
  store.profile = { ...DEFAULT_PROFILE, ...readJSON(KEYS.profile, {}) };
  store.profile.notif = { ...DEFAULT_PROFILE.notif, ...(store.profile.notif || {}) };
  store.activeFast = readJSON(KEYS.activeFast, null);
  store.fasts = readJSON(KEYS.fasts, []);
  store.food = readJSON(KEYS.food, []);
  store.customFoods = readJSON(KEYS.custom, []);
  store.weight = readJSON(KEYS.weight, []);
}

// ── cloud helpers (best effort; failures never block local UX) ──
function cloudReady() { return sb.isConfigured() && store.userId; }

async function cloudUpsert(table, row) {
  if (!cloudReady()) return;
  try { await sb.upsert(table, { ...row, user_id: store.userId }); }
  catch (e) { console.warn(`sync ${table} failed:`, e.message); }
}
async function cloudRemove(table, id) {
  if (!cloudReady()) return;
  try { await sb.remove(table, id); } catch (e) { console.warn(`del ${table} failed:`, e.message); }
}

// ── mappers (local camelCase <-> DB snake_case) ──
const fastToDb = (f) => ({
  id: f.id, started_at: new Date(f.startedAt).toISOString(),
  ended_at: f.endedAt ? new Date(f.endedAt).toISOString() : null,
  target_hours: f.targetHours, protocol: f.protocol,
});
const fastFromDb = (r) => ({
  id: r.id, startedAt: new Date(r.started_at).getTime(),
  endedAt: r.ended_at ? new Date(r.ended_at).getTime() : null,
  targetHours: r.target_hours, protocol: r.protocol,
});
const foodToDb = (e) => ({
  id: e.id, logged_on: e.loggedOn, meal_type: e.mealType, name: e.name, brand: e.brand || null,
  qty: e.qty, serving_label: e.servingLabel || null, calories: e.calories,
  protein_g: e.protein, carbs_g: e.carbs, fat_g: e.fat, source: e.source || "manual",
});
const foodFromDb = (r) => ({
  id: r.id, loggedOn: r.logged_on, mealType: r.meal_type, name: r.name, brand: r.brand,
  qty: r.qty, servingLabel: r.serving_label, calories: r.calories,
  protein: r.protein_g, carbs: r.carbs_g, fat: r.fat_g, source: r.source,
});
const customToDb = (c) => ({
  id: c.id, name: c.name, brand: c.brand || null, serving_label: c.servingLabel || null,
  calories: c.calories, protein_g: c.protein, carbs_g: c.carbs, fat_g: c.fat,
});
const customFromDb = (r) => ({
  id: r.id, name: r.name, brand: r.brand, servingLabel: r.serving_label,
  calories: r.calories, protein: r.protein_g, carbs: r.carbs_g, fat: r.fat_g,
});
const weightToDb = (w) => ({ id: w.id, logged_on: w.loggedOn, weight: w.weight, unit: w.unit });
const weightFromDb = (r) => ({ id: r.id, loggedOn: r.logged_on, weight: r.weight, unit: r.unit });

// ── Cloud attach: push local, then pull authoritative set ──
export async function attachCloud(user) {
  store.userId = user.id;
  store.userEmail = user.email;
  try {
    // Push everything local so pre-login data isn't lost.
    await cloudUpsert("profiles", { user_id: store.userId, data: store.profile });
    for (const f of allFastsIncludingActive()) await sb.upsert("fasts", { ...fastToDb(f), user_id: store.userId });
    for (const e of store.food) await sb.upsert("food_entries", { ...foodToDb(e), user_id: store.userId });
    for (const c of store.customFoods) await sb.upsert("custom_foods", { ...customToDb(c), user_id: store.userId });
    for (const w of store.weight) await sb.upsert("weight_entries", { ...weightToDb(w), user_id: store.userId });
    await pullAll();
  } catch (e) {
    console.warn("attachCloud:", e.message);
  }
  persist();
  notify();
}

export function detachCloud() {
  store.userId = null;
  store.userEmail = null;
  notify();
}

async function pullAll() {
  // profile
  try {
    const prof = await sb.fetchAll("profiles");
    if (prof[0]?.data) store.profile = { ...DEFAULT_PROFILE, ...prof[0].data, notif: { ...DEFAULT_PROFILE.notif, ...(prof[0].data.notif || {}) } };
  } catch (e) { console.warn(e.message); }

  const fasts = (await sb.fetchAll("fasts")).map(fastFromDb);
  store.activeFast = fasts.find((f) => !f.endedAt) || null;
  store.fasts = fasts.filter((f) => f.endedAt).sort((a, b) => b.startedAt - a.startedAt);
  store.food = (await sb.fetchAll("food_entries")).map(foodFromDb);
  store.customFoods = (await sb.fetchAll("custom_foods")).map(customFromDb);
  store.weight = (await sb.fetchAll("weight_entries")).map(weightFromDb).sort((a, b) => a.loggedOn.localeCompare(b.loggedOn));
}

function allFastsIncludingActive() {
  return store.activeFast ? [store.activeFast, ...store.fasts] : store.fasts;
}

// ══════════ FASTING ══════════
export function startFast(targetHours, protocol) {
  if (store.activeFast) return store.activeFast;
  store.activeFast = { id: uid(), startedAt: Date.now(), targetHours, protocol };
  persist(); notify();
  cloudUpsert("fasts", fastToDb(store.activeFast));
  return store.activeFast;
}

export function endFast() {
  if (!store.activeFast) return null;
  const done = { ...store.activeFast, endedAt: Date.now() };
  store.fasts.unshift(done);
  store.activeFast = null;
  persist(); notify();
  cloudUpsert("fasts", fastToDb(done));
  return done;
}

export function cancelFast() {
  if (!store.activeFast) return;
  const id = store.activeFast.id;
  store.activeFast = null;
  persist(); notify();
  cloudRemove("fasts", id);
}

export function adjustFastStart(newStartMs) {
  if (!store.activeFast) return;
  store.activeFast.startedAt = newStartMs;
  persist(); notify();
  cloudUpsert("fasts", fastToDb(store.activeFast));
}

export function deleteFast(id) {
  store.fasts = store.fasts.filter((f) => f.id !== id);
  persist(); notify();
  cloudRemove("fasts", id);
}

// ══════════ FOOD ══════════
export function addFood(entry) {
  const e = { id: uid(), source: "manual", ...entry };
  store.food.push(e);
  persist(); notify();
  cloudUpsert("food_entries", foodToDb(e));
  return e;
}
export function deleteFood(id) {
  store.food = store.food.filter((e) => e.id !== id);
  persist(); notify();
  cloudRemove("food_entries", id);
}
export function foodForDate(dateKey) {
  return store.food.filter((e) => e.loggedOn === dateKey);
}
export function dayTotals(dateKey) {
  return foodForDate(dateKey).reduce((t, e) => {
    t.calories += e.calories || 0; t.protein += e.protein || 0;
    t.carbs += e.carbs || 0; t.fat += e.fat || 0;
    return t;
  }, { calories: 0, protein: 0, carbs: 0, fat: 0 });
}

// ══════════ CUSTOM FOODS ══════════
export function addCustomFood(food) {
  const c = { id: uid(), ...food };
  store.customFoods.unshift(c);
  persist(); notify();
  cloudUpsert("custom_foods", customToDb(c));
  return c;
}
export function deleteCustomFood(id) {
  store.customFoods = store.customFoods.filter((c) => c.id !== id);
  persist(); notify();
  cloudRemove("custom_foods", id);
}

// ══════════ WEIGHT ══════════
export function logWeight(weight, unit, dateKey = todayKey()) {
  let entry = store.weight.find((w) => w.loggedOn === dateKey);
  if (entry) { entry.weight = weight; entry.unit = unit; }
  else { entry = { id: uid(), loggedOn: dateKey, weight, unit }; store.weight.push(entry); }
  store.weight.sort((a, b) => a.loggedOn.localeCompare(b.loggedOn));
  if (!store.profile.startWeight) { store.profile.startWeight = weight; saveProfile({}); }
  persist(); notify();
  cloudUpsert("weight_entries", weightToDb(entry));
  return entry;
}
export function deleteWeight(id) {
  store.weight = store.weight.filter((w) => w.id !== id);
  persist(); notify();
  cloudRemove("weight_entries", id);
}
export function latestWeight() {
  return store.weight.length ? store.weight[store.weight.length - 1] : null;
}

// ══════════ PROFILE ══════════
export function saveProfile(patch) {
  store.profile = { ...store.profile, ...patch };
  if (patch.notif) store.profile.notif = { ...store.profile.notif, ...patch.notif };
  persist(); notify();
  cloudUpsert("profiles", { user_id: store.userId, data: store.profile });
}
