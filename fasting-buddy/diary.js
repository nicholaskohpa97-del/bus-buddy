// ── Diary tab: food logging, search (Open Food Facts), macros vs goals ──
import { store, MEAL_TYPES, addFood, deleteFood, dayTotals, foodForDate, addCustomFood, deleteCustomFood } from "./state.js";
import { qs, toast, openSheet, closeSheet, esc, round, todayKey, shiftDateKey, fmtDateLabel } from "./ui.js";

let currentDate = todayKey();
let searchTimer = null;
let addFlow = { mealType: "Breakfast", mode: "search", selected: null };

export function renderDiary() {
  const c = qs("#diaryContent");
  const t = dayTotals(currentDate);
  const p = store.profile;

  c.innerHTML = `
    <div class="date-nav">
      <button id="datePrev" aria-label="Previous day">‹</button>
      <div class="dn-label">${esc(fmtDateLabel(currentDate))}</div>
      <button id="dateNext" aria-label="Next day">›</button>
    </div>
    ${summaryCard(t, p)}
    <button class="btn block lg" id="addFoodBtn" style="margin-bottom:16px">＋ Add food</button>
    ${mealsView()}
  `;
  wire();
}

function macroBar(cls, val, goal) {
  const pct = goal > 0 ? Math.min(100, (val / goal) * 100) : 0;
  const over = goal > 0 && val > goal;
  return `<div class="bar ${cls} ${over ? "over" : ""}"><span style="width:${pct}%"></span></div>`;
}

function summaryCard(t, p) {
  const remaining = p.calorieGoal - t.calories;
  return `
  <div class="card">
    <div class="cal-summary">
      <div class="cs-big">${Math.round(t.calories)}</div>
      <div class="cs-sub"><b>${Math.round(Math.abs(remaining))}</b> kcal ${remaining >= 0 ? "remaining" : "over"} · goal ${p.calorieGoal}</div>
    </div>
    ${macroBar("cal", t.calories, p.calorieGoal)}
    <div class="macro-grid" style="margin-top:16px">
      <div class="macro-cell">
        <div class="m-val">${Math.round(t.protein)}<span class="m-goal">/${p.proteinGoal}g</span></div>
        <div class="m-lbl">Protein</div>${macroBar("protein", t.protein, p.proteinGoal)}
      </div>
      <div class="macro-cell">
        <div class="m-val">${Math.round(t.carbs)}<span class="m-goal">/${p.carbsGoal}g</span></div>
        <div class="m-lbl">Carbs</div>${macroBar("carbs", t.carbs, p.carbsGoal)}
      </div>
      <div class="macro-cell">
        <div class="m-val">${Math.round(t.fat)}<span class="m-goal">/${p.fatGoal}g</span></div>
        <div class="m-lbl">Fat</div>${macroBar("fat", t.fat, p.fatGoal)}
      </div>
      <div class="macro-cell">
        <div class="m-val">${Math.round(t.calories)}<span class="m-goal">/${p.calorieGoal}</span></div>
        <div class="m-lbl">Calories</div>${macroBar("cal", t.calories, p.calorieGoal)}
      </div>
    </div>
  </div>`;
}

function mealsView() {
  const entries = foodForDate(currentDate);
  if (!entries.length) {
    return `<div class="empty"><span class="e-emoji">🍽️</span>Nothing logged for this day yet.<br>Tap “Add food” to start.</div>`;
  }
  return MEAL_TYPES.map((meal) => {
    const items = entries.filter((e) => e.mealType === meal);
    if (!items.length) return "";
    const cal = items.reduce((s, e) => s + e.calories, 0);
    const rows = items.map((e) => `
      <div class="list-item">
        <div class="li-main">
          <div class="li-title">${esc(e.name)}${e.qty && e.qty !== 1 ? ` <span class="muted">×${e.qty}</span>` : ""}</div>
          <div class="li-sub">${e.brand ? esc(e.brand) + " · " : ""}P ${round(e.protein)} · C ${round(e.carbs)} · F ${round(e.fat)}</div>
        </div>
        <div class="li-right"><div class="li-cal">${Math.round(e.calories)}</div></div>
        <button class="li-del" data-del="${e.id}" aria-label="Delete">✕</button>
      </div>`).join("");
    return `
      <div class="card">
        <div class="meal-group-title"><h3>${meal}</h3><span class="mg-cal">${Math.round(cal)} kcal</span></div>
        ${rows}
      </div>`;
  }).join("");
}

function wire() {
  qs("#datePrev").addEventListener("click", () => { currentDate = shiftDateKey(currentDate, -1); renderDiary(); });
  qs("#dateNext").addEventListener("click", () => {
    if (currentDate >= todayKey()) return;
    currentDate = shiftDateKey(currentDate, 1); renderDiary();
  });
  qs("#addFoodBtn").addEventListener("click", () => openAddFood("Breakfast"));
  qs("#diaryContent").querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => { deleteFood(b.dataset.del); toast("Removed"); }));
}

// ══════════ Add-food sheet ══════════
function openAddFood(mealType) {
  addFlow = { mealType, mode: "search", selected: null };
  openSheet(sheetHtml());
  wireSheet();
}

function sheetHtml() {
  if (addFlow.selected) return confirmHtml(addFlow.selected);
  const mealOpts = MEAL_TYPES.map((m) => `<option value="${m}" ${m === addFlow.mealType ? "selected" : ""}>${m}</option>`).join("");
  const seg = (id, label) => `<button data-mode="${id}" class="${addFlow.mode === id ? "active" : ""}">${label}</button>`;
  let body = "";
  if (addFlow.mode === "search") {
    body = `
      <input type="text" id="foodSearch" placeholder="Search foods (e.g. banana, greek yogurt)…" autocomplete="off">
      <div id="searchResults" style="margin-top:8px"></div>`;
  } else if (addFlow.mode === "custom") {
    body = customListHtml();
  } else {
    body = manualHtml();
  }
  return `
    <h2>Add food</h2>
    <label class="field"><span>Meal</span><select id="mealSelect">${mealOpts}</select></label>
    <div class="segmented" id="modeSeg">${seg("search", "🔍 Search")}${seg("custom", "⭐ My foods")}${seg("manual", "✏️ Manual")}</div>
    <div style="height:14px"></div>
    ${body}`;
}

function customListHtml() {
  if (!store.customFoods.length) {
    return `<div class="empty"><span class="e-emoji">⭐</span>No saved foods yet.<br>Add one via “Manual” and tick “Save to my foods”.</div>`;
  }
  return store.customFoods.map((c) => `
    <div class="search-result" data-custom="${c.id}">
      <div class="sr-main">
        <div class="li-title">${esc(c.name)}</div>
        <div class="li-sub">${c.servingLabel ? esc(c.servingLabel) + " · " : ""}${Math.round(c.calories)} kcal · P${round(c.protein)} C${round(c.carbs)} F${round(c.fat)}</div>
      </div>
      <button class="li-del" data-delcustom="${c.id}" aria-label="Delete">✕</button>
    </div>`).join("");
}

function manualHtml() {
  return `
    <label class="field"><span>Food name</span><input type="text" id="mName" placeholder="e.g. Homemade smoothie"></label>
    <div class="row">
      <label class="field"><span>Calories</span><input type="number" id="mCal" min="0" placeholder="0"></label>
      <label class="field"><span>Protein (g)</span><input type="number" id="mP" min="0" placeholder="0"></label>
    </div>
    <div class="row">
      <label class="field"><span>Carbs (g)</span><input type="number" id="mC" min="0" placeholder="0"></label>
      <label class="field"><span>Fat (g)</span><input type="number" id="mF" min="0" placeholder="0"></label>
    </div>
    <label class="toggle-row" style="border:0;padding:6px 0">
      <span class="tr-label">Save to my foods</span>
      <span class="switch"><input type="checkbox" id="mSave"><span class="slider"></span></span>
    </label>
    <button class="btn block" id="manualAdd">Add to diary</button>`;
}

function confirmHtml(food) {
  const qty = food._qty || 1;
  const m = scale(food, qty);
  return `
    <h2>${esc(food.name)}</h2>
    ${food.brand ? `<div class="muted" style="margin:-8px 0 12px">${esc(food.brand)}</div>` : ""}
    <label class="field"><span>Serving${food.servingLabel ? " — " + esc(food.servingLabel) : ""}</span>
      <input type="number" id="qty" min="0" step="0.25" value="${qty}"></label>
    <div class="card pad-sm" style="margin:0 0 14px">
      <div class="macro-grid">
        <div class="macro-cell"><div class="m-val" id="cCal">${Math.round(m.calories)}</div><div class="m-lbl">kcal</div></div>
        <div class="macro-cell"><div class="m-val" id="cP">${round(m.protein)}</div><div class="m-lbl">Protein</div></div>
        <div class="macro-cell"><div class="m-val" id="cC">${round(m.carbs)}</div><div class="m-lbl">Carbs</div></div>
        <div class="macro-cell"><div class="m-val" id="cF">${round(m.fat)}</div><div class="m-lbl">Fat</div></div>
      </div>
    </div>
    <div class="row">
      <button class="btn secondary" id="backBtn">← Back</button>
      <button class="btn" id="confirmAdd">Add to ${esc(addFlow.mealType)}</button>
    </div>`;
}

function scale(food, qty) {
  const s = food.per_serving || {};
  return {
    calories: (s.kcal || 0) * qty,
    protein: (s.p || 0) * qty,
    carbs: (s.c || 0) * qty,
    fat: (s.f || 0) * qty,
  };
}

function rerenderSheet() { qs("#sheetBody").innerHTML = sheetHtml(); wireSheet(); }

function wireSheet() {
  const mealSel = qs("#mealSelect");
  if (mealSel) mealSel.addEventListener("change", () => { addFlow.mealType = mealSel.value; });

  const seg = qs("#modeSeg");
  if (seg) seg.querySelectorAll("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => { addFlow.mode = b.dataset.mode; rerenderSheet(); }));

  // Search mode
  const search = qs("#foodSearch");
  if (search) {
    search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      const q = search.value.trim();
      if (q.length < 2) { qs("#searchResults").innerHTML = ""; return; }
      qs("#searchResults").innerHTML = skeletons();
      searchTimer = setTimeout(() => doSearch(q), 350);
    });
    search.focus();
  }

  // Custom list
  qs("#sheetBody").querySelectorAll("[data-custom]").forEach((row) =>
    row.addEventListener("click", (e) => {
      if (e.target.closest("[data-delcustom]")) return;
      const c = store.customFoods.find((x) => x.id === row.dataset.custom);
      if (c) { addFlow.selected = customToFood(c); rerenderSheet(); }
    }));
  qs("#sheetBody").querySelectorAll("[data-delcustom]").forEach((b) =>
    b.addEventListener("click", () => { deleteCustomFood(b.dataset.delcustom); rerenderSheet(); }));

  // Manual
  const manualAdd = qs("#manualAdd");
  if (manualAdd) manualAdd.addEventListener("click", submitManual);

  // Confirm view
  const qty = qs("#qty");
  if (qty) {
    qty.addEventListener("input", () => {
      const q = Math.max(0, parseFloat(qty.value) || 0);
      addFlow.selected._qty = q;
      const m = scale(addFlow.selected, q);
      qs("#cCal").textContent = Math.round(m.calories);
      qs("#cP").textContent = round(m.protein);
      qs("#cC").textContent = round(m.carbs);
      qs("#cF").textContent = round(m.fat);
    });
    qs("#backBtn").addEventListener("click", () => { addFlow.selected = null; rerenderSheet(); });
    qs("#confirmAdd").addEventListener("click", submitConfirm);
  }
}

function skeletons() {
  return Array.from({ length: 4 }).map(() =>
    `<div style="padding:12px 0"><div class="skeleton" style="height:14px;width:60%"></div><div class="skeleton" style="height:11px;width:40%;margin-top:6px"></div></div>`).join("");
}

async function doSearch(q) {
  const box = qs("#searchResults");
  try {
    const res = await fetch(`/api/food-search?q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error("search failed");
    const data = await res.json();
    if (!box) return;
    const results = data.results || [];
    if (!results.length) { box.innerHTML = `<div class="empty">No matches. Try “Manual” to enter it yourself.</div>`; return; }
    box.innerHTML = results.map((r, i) => `
      <div class="search-result" data-idx="${i}">
        <div class="sr-main">
          <div class="li-title">${esc(r.name)}</div>
          <div class="li-sub">${r.brand ? esc(r.brand) + " · " : ""}${r.servingLabel ? esc(r.servingLabel) + " · " : ""}${Math.round(r.per_serving.kcal)} kcal</div>
        </div>
        <button class="sr-add">＋</button>
      </div>`).join("");
    box.querySelectorAll("[data-idx]").forEach((row) =>
      row.addEventListener("click", () => { addFlow.selected = { ...results[+row.dataset.idx], _qty: 1 }; rerenderSheet(); }));
  } catch {
    if (box) box.innerHTML = `<div class="empty">Search unavailable right now.<br>Use “Manual” to enter food directly.</div>`;
  }
}

function customToFood(c) {
  return { name: c.name, brand: c.brand, servingLabel: c.servingLabel, per_serving: { kcal: c.calories, p: c.protein, c: c.carbs, f: c.fat }, source: "custom", _qty: 1 };
}

function submitManual() {
  const name = qs("#mName").value.trim();
  if (!name) { toast("Enter a food name"); return; }
  const calories = Number(qs("#mCal").value) || 0;
  const protein = Number(qs("#mP").value) || 0;
  const carbs = Number(qs("#mC").value) || 0;
  const fat = Number(qs("#mF").value) || 0;
  addFood({ loggedOn: currentDate, mealType: addFlow.mealType, name, brand: null, qty: 1, servingLabel: null, calories, protein, carbs, fat, source: "manual" });
  if (qs("#mSave").checked) addCustomFood({ name, brand: null, servingLabel: null, calories, protein, carbs, fat });
  closeSheet();
  toast("Added to diary");
}

function submitConfirm() {
  const food = addFlow.selected;
  const qty = food._qty || 1;
  const m = scale(food, qty);
  addFood({
    loggedOn: currentDate, mealType: addFlow.mealType, name: food.name, brand: food.brand || null,
    qty, servingLabel: food.servingLabel || null,
    calories: round(m.calories), protein: round(m.protein, 1), carbs: round(m.carbs, 1), fat: round(m.fat, 1),
    source: food.source || "search",
  });
  closeSheet();
  toast(`Added to ${addFlow.mealType}`);
}
