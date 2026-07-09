// ── Weight tab: log entries, trend chart, goal & change stats ──
import { store, logWeight, deleteWeight, latestWeight, saveProfile } from "./state.js";
import { qs, toast, openSheet, closeSheet, esc, round, todayKey } from "./ui.js";
import { lineChart } from "./charts.js";

let range = "30d";

function conv(w, from, to) {
  if (from === to) return w;
  return to === "lb" ? w * 2.20462 : w / 2.20462;
}

export function renderWeight() {
  const c = qs("#weightContent");
  const unit = store.profile.units;
  const entries = store.weight.map((w) => ({ ...w, disp: round(conv(w.weight, w.unit, unit), 1) }));
  const latest = latestWeight();
  const latestDisp = latest ? round(conv(latest.weight, latest.unit, unit), 1) : null;
  const goal = store.profile.goalWeight;
  const start = entries.length ? entries[0].disp : null;
  const change = latestDisp != null && start != null ? round(latestDisp - start, 1) : null;
  const toGoal = latestDisp != null && goal != null ? round(latestDisp - goal, 1) : null;

  c.innerHTML = `
    <div class="card">
      <div class="cal-summary">
        <div class="cs-big">${latestDisp != null ? latestDisp : "—"}<span style="font-size:20px"> ${unit}</span></div>
        <div class="cs-sub">${latest ? "as of " + esc(new Date(latest.loggedOn).toLocaleDateString(undefined, { month: "short", day: "numeric" })) : "No weight logged yet"}</div>
      </div>
      <div class="stat-inline" style="margin-top:14px">
        <div><div class="si-val">${change != null ? (change > 0 ? "+" : "") + change : "—"}</div><div class="si-lbl">Change</div></div>
        <div><div class="si-val">${goal != null ? goal + " " + unit : "—"}</div><div class="si-lbl">Goal</div></div>
        <div><div class="si-val">${toGoal != null ? (toGoal > 0 ? toGoal + " to go" : "reached 🎉") : "—"}</div><div class="si-lbl">To goal</div></div>
      </div>
      <button class="btn block lg" id="logWeightBtn" style="margin-top:16px">＋ Log weight</button>
    </div>

    <div class="card">
      <div class="segmented" id="rangeSeg" style="margin-bottom:14px">
        <button data-range="7d" class="${range === "7d" ? "active" : ""}">7 days</button>
        <button data-range="30d" class="${range === "30d" ? "active" : ""}">30 days</button>
        <button data-range="all" class="${range === "all" ? "active" : ""}">All</button>
      </div>
      ${chartHtml(entries, unit, goal)}
    </div>

    <div class="section-title">History</div>
    <div class="card">${historyHtml(entries, unit)}</div>
  `;
  wire();
}

function filterByRange(entries) {
  if (range === "all") return entries;
  const days = range === "7d" ? 7 : 30;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
  const cutKey = todayKey(cutoff);
  return entries.filter((e) => e.loggedOn >= cutKey);
}

function chartHtml(entries, unit, goal) {
  const filtered = filterByRange(entries);
  const pts = filtered.map((e) => {
    const [y, m, d] = e.loggedOn.split("-").map(Number);
    return { x: new Date(y, m - 1, d).getTime(), v: e.disp, label: new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" }) };
  });
  return lineChart(pts, { goal, unit, format: (v) => round(v, 1) });
}

function historyHtml(entries, unit) {
  if (!entries.length) return `<div class="empty"><span class="e-emoji">⚖️</span>Log your weight to track progress.</div>`;
  return [...entries].reverse().slice(0, 30).map((e, i, arr) => {
    const prev = arr[i + 1];
    const delta = prev ? round(e.disp - prev.disp, 1) : null;
    return `<div class="list-item">
      <div class="li-main"><div class="li-title">${e.disp} ${unit}</div>
      <div class="li-sub">${new Date(e.loggedOn).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</div></div>
      <div class="li-right"><div class="li-sub">${delta != null ? (delta > 0 ? "▲ +" : delta < 0 ? "▼ " : "") + delta : ""}</div></div>
      <button class="li-del" data-del="${e.id}" aria-label="Delete">✕</button>
    </div>`;
  }).join("");
}

function wire() {
  qs("#logWeightBtn").addEventListener("click", logSheet);
  qs("#rangeSeg").querySelectorAll("[data-range]").forEach((b) =>
    b.addEventListener("click", () => { range = b.dataset.range; renderWeight(); }));
  qs("#weightContent").querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => { deleteWeight(b.dataset.del); toast("Deleted"); }));
}

function logSheet() {
  const unit = store.profile.units;
  const latest = latestWeight();
  const prefill = latest ? round(conv(latest.weight, latest.unit, unit), 1) : "";
  openSheet(`
    <h2>Log weight</h2>
    <div class="row">
      <label class="field"><span>Weight (${unit})</span><input type="number" id="wVal" inputmode="decimal" step="0.1" min="0" value="${prefill}" placeholder="0.0"></label>
      <label class="field"><span>Date</span><input type="date" id="wDate" value="${todayKey()}" max="${todayKey()}"></label>
    </div>
    <button class="btn block" id="saveWeight">Save</button>
    ${store.profile.goalWeight == null ? `<button class="btn ghost block" id="setGoalBtn" style="margin-top:8px">Set a goal weight</button>` : ""}
  `);
  qs("#saveWeight").addEventListener("click", () => {
    const val = parseFloat(qs("#wVal").value);
    if (!val || val <= 0) { toast("Enter a valid weight"); return; }
    logWeight(round(val, 1), unit, qs("#wDate").value || todayKey());
    closeSheet();
    toast("Weight logged");
  });
  const gb = qs("#setGoalBtn");
  if (gb) gb.addEventListener("click", () => {
    const g = prompt(`Goal weight (${unit})`);
    const gv = parseFloat(g);
    if (gv > 0) { saveProfile({ goalWeight: round(gv, 1) }); closeSheet(); renderWeight(); }
  });
}
