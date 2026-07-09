// ── Fast tab: timer ring, protocol presets, history & streak ──
import { store, PROTOCOLS, startFast, endFast, cancelFast, adjustFastStart, deleteFast } from "./state.js";
import { qs, toast, openSheet, closeSheet, fmtClock, fmtDur, fmtTimeOfDay, esc, pad2, todayKey } from "./ui.js";

const R = 104;
const CIRC = 2 * Math.PI * R;

let ticker = null;
let selectedProtocol = null;

export function stopFastTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }

function targetMs(f) { return f.targetHours * 3600 * 1000; }

export function renderFast() {
  stopFastTicker();
  const c = qs("#fastContent");
  const f = store.activeFast;
  if (f) c.innerHTML = activeView(f) + historyView();
  else c.innerHTML = idleView() + historyView();
  wire();
  if (f) { tick(); ticker = setInterval(tick, 1000); }
}

// ── Active fasting view ──
function activeView(f) {
  const end = f.startedAt + targetMs(f);
  return `
  <div class="card">
    <div class="ring-wrap">
      <div class="ring">
        <svg viewBox="0 0 240 240">
          <circle class="track" cx="120" cy="120" r="${R}" stroke-dasharray="${CIRC}"></circle>
          <circle id="fastProg" class="prog" cx="120" cy="120" r="${R}" stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC}"></circle>
        </svg>
        <div class="ring-center">
          <div class="ring-state" id="fastState">FASTING</div>
          <div class="ring-time" id="fastTime">00:00:00</div>
          <div class="ring-sub" id="fastSub">elapsed</div>
          <div class="ring-pct" id="fastPct"></div>
        </div>
      </div>
    </div>
    <div class="stat-inline">
      <div><div class="si-val">${fmtTimeOfDay(f.startedAt)}</div><div class="si-lbl">Started</div></div>
      <div><div class="si-val">${f.targetHours}h</div><div class="si-lbl">Goal</div></div>
      <div><div class="si-val">${fmtTimeOfDay(end)}</div><div class="si-lbl">Ends</div></div>
    </div>
    <div style="height:14px"></div>
    <button class="btn block lg" id="endBtn">End fast</button>
    <div class="row" style="margin-top:10px">
      <button class="btn secondary" id="editStartBtn">Edit start time</button>
      <button class="btn secondary" id="cancelBtn">Cancel</button>
    </div>
  </div>`;
}

// ── Idle (not fasting) view ──
function idleView() {
  const def = selectedProtocol || store.profile.protocol || "16:8";
  selectedProtocol = def;
  const chips = Object.keys(PROTOCOLS).map((k) => {
    const p = PROTOCOLS[k];
    return `<button class="chip ${k === def ? "active" : ""}" data-proto="${k}">${esc(p.label)}</button>`;
  }).join("");
  const lastEnd = store.fasts[0]?.endedAt;
  const since = lastEnd ? `Last fast ended ${fmtDur(Date.now() - lastEnd)} ago` : "Ready when you are";
  return `
  <div class="card">
    <div class="ring-wrap">
      <div class="ring">
        <svg viewBox="0 0 240 240">
          <circle class="track" cx="120" cy="120" r="${R}" stroke-dasharray="${CIRC}"></circle>
        </svg>
        <div class="ring-center">
          <div class="ring-state eating">NOT FASTING</div>
          <div class="ring-time" style="font-size:34px">Ready</div>
          <div class="ring-sub">${esc(since)}</div>
        </div>
      </div>
    </div>
    <div class="section-title">Choose a protocol</div>
    <div class="chips" id="protoChips">${chips}</div>
    <label class="field" style="margin-top:14px">
      <span>Custom fast length (hours)</span>
      <input type="number" id="customHours" min="1" max="72" step="1" value="${PROTOCOLS[def]?.fast || 16}">
    </label>
    <button class="btn block lg" id="startBtn">Start fasting</button>
  </div>`;
}

// ── History + streak ──
function computeStats() {
  const fasts = store.fasts;
  const completed = fasts.length;
  if (!completed) return { completed: 0, streak: 0, avgH: 0, goalRate: 0 };
  const totalMs = fasts.reduce((s, f) => s + (f.endedAt - f.startedAt), 0);
  const avgH = totalMs / completed / 3600000;
  const goalMet = fasts.filter((f) => (f.endedAt - f.startedAt) >= targetMs(f)).length;

  // streak: consecutive days (ending today/yesterday) with >=1 completed fast
  const days = new Set(fasts.map((f) => todayKey(new Date(f.endedAt))));
  let streak = 0;
  const d = new Date();
  if (!days.has(todayKey(d))) d.setDate(d.getDate() - 1); // allow streak to hold if none today yet
  while (days.has(todayKey(d))) { streak++; d.setDate(d.getDate() - 1); }
  return { completed, streak, avgH, goalRate: Math.round((goalMet / completed) * 100) };
}

function historyView() {
  const s = computeStats();
  const statCard = `
  <div class="card">
    <div class="macro-grid" style="grid-template-columns:repeat(3,1fr)">
      <div class="macro-cell"><div class="m-val">${s.streak}🔥</div><div class="m-lbl">Day streak</div></div>
      <div class="macro-cell"><div class="m-val">${s.avgH ? s.avgH.toFixed(1) + "h" : "—"}</div><div class="m-lbl">Avg fast</div></div>
      <div class="macro-cell"><div class="m-val">${s.completed}</div><div class="m-lbl">Total fasts</div></div>
    </div>
  </div>`;

  const recent = store.fasts.slice(0, 8);
  const list = recent.length ? recent.map((f) => {
    const dur = f.endedAt - f.startedAt;
    const met = dur >= targetMs(f);
    return `<div class="list-item">
      <div class="li-main">
        <div class="li-title">${fmtDur(dur)} <span class="pill ${met ? "green" : ""}">${met ? "Goal met" : f.targetHours + "h goal"}</span></div>
        <div class="li-sub">${new Date(f.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${fmtTimeOfDay(f.startedAt)} → ${fmtTimeOfDay(f.endedAt)}</div>
      </div>
      <button class="li-del" data-del="${f.id}" aria-label="Delete">✕</button>
    </div>`;
  }).join("") : `<div class="empty"><span class="e-emoji">📋</span>No fasts logged yet.</div>`;

  return statCard + `<div class="section-title">History</div><div class="card">${list}</div>`;
}

// ── Live tick ──
function tick() {
  const f = store.activeFast;
  if (!f) { stopFastTicker(); return; }
  const elapsed = Date.now() - f.startedAt;
  const tgt = targetMs(f);
  const prog = Math.min(1, elapsed / tgt);
  const done = elapsed >= tgt;

  const timeEl = qs("#fastTime");
  const progEl = qs("#fastProg");
  const stateEl = qs("#fastState");
  const subEl = qs("#fastSub");
  const pctEl = qs("#fastPct");
  if (!timeEl || !progEl) return;

  if (done) {
    timeEl.textContent = fmtClock(elapsed);
    stateEl.textContent = "GOAL REACHED 🎉";
    stateEl.classList.add("eating");
    progEl.classList.add("done");
    subEl.textContent = "+" + fmtDur(elapsed - tgt) + " over goal";
    pctEl.textContent = "100% · you can keep going";
  } else {
    timeEl.textContent = fmtClock(elapsed);
    subEl.textContent = fmtDur(tgt - elapsed) + " until goal";
    pctEl.textContent = Math.floor(prog * 100) + "% complete";
  }
  progEl.setAttribute("stroke-dashoffset", (CIRC * (1 - prog)).toFixed(1));
}

// ── Wiring ──
function wire() {
  const startBtn = qs("#startBtn");
  if (startBtn) {
    qs("#protoChips").querySelectorAll(".chip").forEach((chip) =>
      chip.addEventListener("click", () => {
        selectedProtocol = chip.dataset.proto;
        qs("#protoChips").querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === chip));
        qs("#customHours").value = PROTOCOLS[selectedProtocol].fast;
      }));
    startBtn.addEventListener("click", () => {
      const hours = Math.max(1, Math.min(72, parseInt(qs("#customHours").value) || 16));
      startFast(hours, selectedProtocol);
      toast(`Fast started — ${hours}h goal`);
    });
  }

  const endBtn = qs("#endBtn");
  if (endBtn) {
    endBtn.addEventListener("click", () => {
      const f = store.activeFast;
      const dur = Date.now() - f.startedAt;
      const done = endFast();
      toast(`Fast ended: ${fmtDur(dur)}${dur >= targetMs(done) ? " · goal met! 🎉" : ""}`);
    });
    qs("#cancelBtn").addEventListener("click", () => {
      if (confirm("Cancel this fast? It won't be saved.")) { cancelFast(); toast("Fast cancelled"); }
    });
    qs("#editStartBtn").addEventListener("click", editStartSheet);
  }

  qs("#fastContent").querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => {
      if (confirm("Delete this fast from history?")) deleteFast(b.dataset.del);
    }));
}

function editStartSheet() {
  const f = store.activeFast;
  const d = new Date(f.startedAt);
  const localVal = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  openSheet(`
    <h2>Edit start time</h2>
    <label class="field"><span>Fast started at</span>
      <input type="datetime-local" id="editStart" value="${localVal}" max="${localVal}"></label>
    <button class="btn block" id="saveStart">Save</button>
  `);
  qs("#saveStart").addEventListener("click", () => {
    const v = qs("#editStart").value;
    if (!v) return;
    const ms = new Date(v).getTime();
    if (ms > Date.now()) { toast("Start can't be in the future"); return; }
    adjustFastStart(ms);
    closeSheet();
    toast("Start time updated");
  });
}
