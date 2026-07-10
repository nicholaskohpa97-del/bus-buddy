// ── Settings tab: account/sync, goals, notifications, units, theme, data ──
import { store, PROTOCOLS, saveProfile } from "./state.js";
import * as sb from "./supabase.js";
import { cfg } from "./env.js";
import { qs, toast, esc } from "./ui.js";
import { pushSupported, isPushEnabled, enablePush, disablePush } from "./pushclient.js";

let acctStep = "email";   // 'email' | 'code'
let pendingEmail = "";
let pushOn = false;

export function renderSettings() {
  const c = qs("#settingsContent");
  const p = store.profile;
  isPushEnabled().then((v) => { pushOn = v; const el = qs("#pushToggle"); if (el) el.checked = v; }).catch(() => {});

  c.innerHTML = `
    ${accountCard()}

    <div class="section-title">Daily goals</div>
    <div class="card">
      <div class="row">
        <label class="field"><span>Calories (kcal)</span><input type="number" id="gCal" min="0" value="${p.calorieGoal}"></label>
        <label class="field"><span>Protein (g)</span><input type="number" id="gP" min="0" value="${p.proteinGoal}"></label>
      </div>
      <div class="row">
        <label class="field"><span>Carbs (g)</span><input type="number" id="gC" min="0" value="${p.carbsGoal}"></label>
        <label class="field"><span>Fat (g)</span><input type="number" id="gF" min="0" value="${p.fatGoal}"></label>
      </div>
      <button class="btn ghost" id="calcMacros" style="padding:6px 0">Calculate macros from calories</button>
    </div>

    <div class="section-title">Fasting & body</div>
    <div class="card">
      <label class="field"><span>Default protocol</span>
        <select id="gProto">${Object.keys(PROTOCOLS).map((k) => `<option value="${k}" ${k === p.protocol ? "selected" : ""}>${esc(PROTOCOLS[k].label)} — ${esc(PROTOCOLS[k].desc)}</option>`).join("")}</select>
      </label>
      <div class="row">
        <label class="field"><span>Units</span>
          <select id="gUnits"><option value="kg" ${p.units === "kg" ? "selected" : ""}>Kilograms</option><option value="lb" ${p.units === "lb" ? "selected" : ""}>Pounds</option></select>
        </label>
        <label class="field"><span>Goal weight (${p.units})</span><input type="number" id="gGoalW" step="0.1" min="0" value="${p.goalWeight ?? ""}" placeholder="—"></label>
      </div>
    </div>

    <div class="section-title">Reminders</div>
    <div class="card">
      ${pushSupported() ? `
      <div class="toggle-row">
        <div><div class="tr-label">Push notifications</div><div class="tr-sub">${sb.isConfigured() ? "Get alerts even when the app is closed" : "Sign in with cloud sync to enable"}</div></div>
        <label class="switch"><input type="checkbox" id="pushToggle" ${pushOn ? "checked" : ""}><span class="slider"></span></label>
      </div>
      <div class="toggle-row">
        <div><div class="tr-label">Fast complete</div><div class="tr-sub">When you reach your fasting goal</div></div>
        <label class="switch"><input type="checkbox" id="nFast" ${p.notif.fastComplete ? "checked" : ""}><span class="slider"></span></label>
      </div>
      <div class="toggle-row">
        <div><div class="tr-label">Daily weigh-in</div><div class="tr-sub">Remind me to log my weight</div></div>
        <label class="switch"><input type="checkbox" id="nWeigh" ${p.notif.weighIn ? "checked" : ""}><span class="slider"></span></label>
      </div>
      <label class="field" style="margin-top:12px"><span>Weigh-in time</span><input type="time" id="nWeighTime" value="${p.notif.weighInTime}"></label>
      ` : `<div class="muted center" style="padding:12px">Notifications aren’t supported on this device/browser.</div>`}
    </div>

    <div class="section-title">Appearance & data</div>
    <div class="card">
      <div class="toggle-row" style="border:0">
        <div class="tr-label">Dark mode</div>
        <label class="switch"><input type="checkbox" id="darkToggle"><span class="slider"></span></label>
      </div>
      <button class="btn danger block" id="clearData" style="margin-top:12px">Clear all local data</button>
      <div class="muted center" style="font-size:12px;margin-top:12px">FastTrack · fasting & nutrition tracker</div>
    </div>
  `;
  wire();
}

function accountCard() {
  if (!sb.isConfigured()) {
    return `<div class="card"><div class="tr-label">Running locally</div>
      <div class="tr-sub" style="margin-top:4px">Cloud sync isn’t configured on this deployment. Your data is saved on this device only.</div></div>`;
  }
  if (store.userId) {
    return `<div class="card">
      <div class="toggle-row" style="border:0">
        <div><div class="tr-label">Synced ✓</div><div class="tr-sub">${esc(store.userEmail || "Signed in")}</div></div>
        <button class="btn secondary" id="signOut">Sign out</button>
      </div></div>`;
  }
  if (acctStep === "code") {
    return `<div class="card">
      <div class="tr-label">Enter the code</div>
      <div class="tr-sub" style="margin:4px 0 12px">We emailed a 6-digit code to ${esc(pendingEmail)}.</div>
      <label class="field"><span>Login code</span><input type="text" id="acctCode" inputmode="numeric" placeholder="123456"></label>
      <button class="btn block" id="verifyCode">Verify & sync</button>
      <button class="btn ghost block" id="acctBack" style="margin-top:6px">Use a different email</button>
    </div>`;
  }
  return `<div class="card">
    <div class="tr-label">Sync across devices</div>
    <div class="tr-sub" style="margin:4px 0 12px">Sign in with your email to back up and sync your data.</div>
    <label class="field"><span>Email</span><input type="email" id="acctEmail" placeholder="you@example.com"></label>
    <button class="btn block" id="sendCode">Email me a login code</button>
  </div>`;
}

function wire() {
  // Goals — save on change
  const saveGoals = () => saveProfile({
    calorieGoal: +qs("#gCal").value || 0, proteinGoal: +qs("#gP").value || 0,
    carbsGoal: +qs("#gC").value || 0, fatGoal: +qs("#gF").value || 0,
  });
  ["gCal", "gP", "gC", "gF"].forEach((id) => qs("#" + id).addEventListener("change", saveGoals));
  qs("#calcMacros").addEventListener("click", () => {
    const cal = +qs("#gCal").value || 2000;
    // 30% protein / 40% carbs / 30% fat by calories (4/4/9 kcal per g)
    saveProfile({ proteinGoal: Math.round((cal * 0.3) / 4), carbsGoal: Math.round((cal * 0.4) / 4), fatGoal: Math.round((cal * 0.3) / 9) });
    toast("Macros calculated");
  });

  qs("#gProto").addEventListener("change", (e) => saveProfile({ protocol: e.target.value }));
  qs("#gUnits").addEventListener("change", (e) => saveProfile({ units: e.target.value }));
  qs("#gGoalW").addEventListener("change", (e) => saveProfile({ goalWeight: e.target.value === "" ? null : +e.target.value }));

  // Notifications
  const pushToggle = qs("#pushToggle");
  if (pushToggle) pushToggle.addEventListener("change", async () => {
    try {
      if (pushToggle.checked) { await enablePush(); toast("Notifications enabled"); }
      else { await disablePush(); toast("Notifications disabled"); }
    } catch (e) { pushToggle.checked = false; toast(e.message); }
  });
  const nFast = qs("#nFast"); if (nFast) nFast.addEventListener("change", () => saveProfile({ notif: { fastComplete: nFast.checked } }));
  const nWeigh = qs("#nWeigh"); if (nWeigh) nWeigh.addEventListener("change", () => saveProfile({ notif: { weighIn: nWeigh.checked } }));
  const nWeighTime = qs("#nWeighTime"); if (nWeighTime) nWeighTime.addEventListener("change", () => saveProfile({ notif: { weighInTime: nWeighTime.value } }));

  // Appearance
  const dark = qs("#darkToggle");
  const isDark = document.documentElement.getAttribute("data-theme") === "dark" ||
    (!document.documentElement.hasAttribute("data-theme") && window.matchMedia("(prefers-color-scheme: dark)").matches);
  dark.checked = isDark;
  dark.addEventListener("change", () => {
    localStorage.setItem("ft_theme", dark.checked ? "dark" : "light");
    location.reload();
  });

  qs("#clearData").addEventListener("click", () => {
    if (confirm("Delete ALL local data on this device? This can't be undone.")) {
      ["ft_profile","ft_activeFast","ft_fasts","ft_food","ft_customFoods","ft_weight"].forEach((k) => localStorage.removeItem(k));
      location.reload();
    }
  });

  // Account
  const sendCode = qs("#sendCode");
  if (sendCode) sendCode.addEventListener("click", async () => {
    const email = qs("#acctEmail").value.trim();
    if (!email || !email.includes("@")) { toast("Enter a valid email"); return; }
    sendCode.disabled = true; sendCode.textContent = "Sending…";
    try { await sb.sendLoginCode(email); pendingEmail = email; acctStep = "code"; renderSettings(); }
    catch (e) { toast(e.message || "Failed to send code"); sendCode.disabled = false; sendCode.textContent = "Email me a login code"; }
  });
  const verifyCode = qs("#verifyCode");
  if (verifyCode) verifyCode.addEventListener("click", async () => {
    const code = qs("#acctCode").value.trim();
    if (!code) { toast("Enter the code"); return; }
    verifyCode.disabled = true; verifyCode.textContent = "Verifying…";
    try { await sb.verifyLoginCode(pendingEmail, code); acctStep = "email"; toast("Signed in — syncing"); }
    catch (e) { toast(e.message || "Invalid code"); verifyCode.disabled = false; verifyCode.textContent = "Verify & sync"; }
  });
  const acctBack = qs("#acctBack");
  if (acctBack) acctBack.addEventListener("click", () => { acctStep = "email"; renderSettings(); });
  const signOut = qs("#signOut");
  if (signOut) signOut.addEventListener("click", async () => { await sb.signOut(); toast("Signed out"); });
}
