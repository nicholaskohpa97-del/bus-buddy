"use strict";
const assert = require("assert");
const path = require("path");

// ── helpers ────────────────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓  ${name}`);
    passCount++;
  } catch (e) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${e.message}`);
    failCount++;
  }
}

// ── mock infrastructure ────────────────────────────────────────────────────

const SECRET = "test-secret-abc";
const GOOD_SUB = { endpoint: "https://fcm.example.com/send/abc", keys: { p256dh: "x", auth: "y" } };
const SGT_OFFSET = 8 * 3600 * 1000;
const USER_1 = "user-aaa";

// Preferences (reminders) live on user_prefs keyed by user_id; push
// subscriptions live on push_subs, one row per device per user.
function makeMockFetch({
  prefRows = [],
  subRows = [],
  supabaseSaveOk = true,
  ltaMinutes = 3,
  ltaError = false,
  ltaStatus = 200,
  onSave = null,
  onDelete = null,
} = {}) {
  return async function mockFetch(url, opts = {}) {
    const urlStr = url.toString();
    const method = opts.method || "GET";

    if (urlStr.includes("user_prefs?select=")) {
      return { ok: true, json: async () => prefRows, text: async () => JSON.stringify(prefRows) };
    }
    if (urlStr.includes("push_subs?select=")) {
      return { ok: true, json: async () => subRows, text: async () => JSON.stringify(subRows) };
    }
    if (urlStr.includes("/rest/v1/user_prefs") && method === "POST") {
      if (onSave) onSave(JSON.parse(opts.body));
      if (!supabaseSaveOk) return { ok: false, status: 500, text: async () => "Internal Server Error" };
      return { ok: true, status: 200, text: async () => "" };
    }
    if (urlStr.includes("/rest/v1/push_subs") && method === "DELETE") {
      if (onDelete) onDelete(urlStr);
      return { ok: true, status: 204, text: async () => "" };
    }
    if (urlStr.includes("BusArrival")) {
      if (ltaError) throw new Error("LTA network error");
      if (ltaStatus !== 200) return { ok: false, status: ltaStatus, json: async () => ({}), text: async () => "Bad Request" };
      const eta = new Date(Date.now() + ltaMinutes * 60000).toISOString();
      return { ok: true, status: 200, json: async () => ({ Services: [{ NextBus: { EstimatedArrival: eta } }] }) };
    }
    throw new Error(`Unmocked fetch: ${method} ${urlStr}`);
  };
}

let pushCallCount = 0;
let lastPushPayload = null;
let pushShouldFail = false;
let pushFailStatusCode = 500;

const mockWebpush = {
  setVapidDetails: () => {},
  sendNotification: async (sub, payload) => {
    if (pushShouldFail) {
      const err = new Error("Push error");
      err.statusCode = pushFailStatusCode;
      throw err;
    }
    pushCallCount++;
    lastPushPayload = JSON.parse(payload);
    return {};
  },
};

const Module = require("module");
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "web-push") return mockWebpush;
  return origLoad.apply(this, arguments);
};

function makeReqRes({ auth = `Bearer ${SECRET}`, query = {} } = {}) {
  let status = 200;
  let body = null;
  const res = {
    status(s) { status = s; return res; },
    json(b) { body = b; return res; },
    end() { return res; },
    _get() { return { status, body }; },
  };
  const req = { method: "GET", headers: { authorization: auth }, query, body: {} };
  return { req, res };
}

function sgtNowMins() {
  const sgt = new Date(Date.now() + SGT_OFFSET);
  return sgt.getUTCHours() * 60 + sgt.getUTCMinutes();
}

function sgtNowDow() {
  return new Date(Date.now() + SGT_OFFSET).getUTCDay();
}

function reminderAt(offsetMins = 0) {
  const totalMins = (sgtNowMins() + offsetMins + 1440) % 1440;
  const h = Math.floor(totalMins / 60).toString().padStart(2, "0");
  const m = (totalMins % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

function makeReminder(overrides = {}) {
  return { id: "r1", stop: "12345", service: "65", time: reminderAt(0), leadMin: 5, nickname: "Home", days: [], enabled: true, ...overrides };
}

function makePrefRow(reminderOverrides = {}, userId = USER_1) {
  return { user_id: userId, data: { reminders: [makeReminder(reminderOverrides)], notifyState: {} } };
}

function makeSubRow(deviceId = "dev-1", userId = USER_1, subscription = GOOD_SUB) {
  return { user_id: userId, device_id: deviceId, subscription };
}

const HANDLER_PATH = path.join(__dirname, "api/check-reminders.js");

function loadHandler() {
  delete require.cache[require.resolve(HANDLER_PATH)];
  return require(HANDLER_PATH);
}

function resetEnv() {
  process.env.SUPABASE_URL = "https://fake.supabase.co";
  process.env.SUPABASE_ANON_KEY = "anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  process.env.LTA_API_KEY = "lta-key";
  process.env.VAPID_PUBLIC_KEY = "BNtest" + "A".repeat(83);
  process.env.VAPID_PRIVATE_KEY = "privkey" + "A".repeat(36);
  process.env.VAPID_SUBJECT = "mailto:test@example.com";
  process.env.CRON_SECRET = SECRET;
  pushCallCount = 0;
  lastPushPayload = null;
  pushShouldFail = false;
  pushFailStatusCode = 500;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {

  // ── 1. Auth ────────────────────────────────────────────────────────────

  console.log("\nAuth checks");

  await test("no auth header → 401", async () => {
    resetEnv();
    global.fetch = makeMockFetch();
    const { req, res } = makeReqRes({ auth: "" });
    await loadHandler()(req, res);
    assert.strictEqual(res._get().status, 401);
    assert.strictEqual(res._get().body.error, "Unauthorized");
  });

  await test("wrong secret → 401", async () => {
    resetEnv();
    global.fetch = makeMockFetch();
    const { req, res } = makeReqRes({ auth: "Bearer wrong-secret" });
    await loadHandler()(req, res);
    assert.strictEqual(res._get().status, 401);
  });

  await test("correct Bearer secret → 200", async () => {
    resetEnv();
    global.fetch = makeMockFetch();
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().status, 200);
  });

  await test("x-vercel-cron header (no CRON_SECRET) → 200", async () => {
    resetEnv();
    global.fetch = makeMockFetch();
    const { req, res } = makeReqRes({ auth: "" });
    req.headers["x-vercel-cron"] = "1";
    await loadHandler()(req, res);
    assert.strictEqual(res._get().status, 200);
  });

  // ── 2. Probe mode ──────────────────────────────────────────────────────

  console.log("\nProbe mode");

  await test("probe=1 all env vars set → ok:true, all checks true", async () => {
    resetEnv();
    global.fetch = makeMockFetch();
    const { req, res } = makeReqRes({ query: { probe: "1" } });
    await loadHandler()(req, res);
    const { status, body } = res._get();
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.ok(Object.values(body.checks).every(Boolean), `Some checks false: ${JSON.stringify(body.checks)}`);
    assert.strictEqual(body.dbRows, 0);
    assert.strictEqual(body.dbError, null);
  });

  await test("probe=1 missing VAPID_PUBLIC_KEY → ok:false", async () => {
    resetEnv();
    delete process.env.VAPID_PUBLIC_KEY;
    global.fetch = makeMockFetch();
    const { req, res } = makeReqRes({ query: { probe: "1" } });
    await loadHandler()(req, res);
    const { body } = res._get();
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.checks.VAPID_PUBLIC_KEY, false);
  });

  await test("probe=1 missing SUPABASE_SERVICE_ROLE_KEY → ok:false", async () => {
    resetEnv();
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    global.fetch = makeMockFetch();
    const { req, res } = makeReqRes({ query: { probe: "1" } });
    await loadHandler()(req, res);
    const { body } = res._get();
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.checks.SUPABASE_SERVICE_ROLE_KEY, false);
  });

  await test("probe=1 Supabase 401 → ok:false with dbError", async () => {
    resetEnv();
    global.fetch = async (url) => {
      if (url.includes("user_prefs")) return { ok: false, status: 401, text: async () => "Unauthorized" };
      throw new Error(`Unmocked: ${url}`);
    };
    const { req, res } = makeReqRes({ query: { probe: "1" } });
    await loadHandler()(req, res);
    const { body } = res._get();
    assert.strictEqual(body.ok, false);
    assert.ok(body.dbError, "Expected dbError to be set");
  });

  // ── 3. Env var guards ──────────────────────────────────────────────────

  console.log("\nEnv var guards");

  await test("missing LTA_API_KEY → 400", async () => {
    resetEnv();
    delete process.env.LTA_API_KEY;
    global.fetch = makeMockFetch();
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().status, 400);
    assert.ok(res._get().body.error.includes("LTA_API_KEY"));
  });

  await test("missing SUPABASE_SERVICE_ROLE_KEY → 400", async () => {
    resetEnv();
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    global.fetch = makeMockFetch();
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().status, 400);
    assert.ok(res._get().body.error.includes("SERVICE_ROLE"));
  });

  await test("missing VAPID keys → 400", async () => {
    resetEnv();
    delete process.env.VAPID_PUBLIC_KEY;
    global.fetch = makeMockFetch();
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().status, 400);
    assert.ok(res._get().body.error.includes("VAPID"));
  });

  // ── 4. DB failures ─────────────────────────────────────────────────────

  console.log("\nDB failures");

  await test("Supabase read 500 → 500 with details", async () => {
    resetEnv();
    global.fetch = async (url) => {
      if (url.includes("user_prefs?select")) return { ok: false, status: 500, text: async () => "Server Error" };
      if (url.includes("push_subs?select")) return { ok: true, json: async () => [] };
      throw new Error(`Unmocked: ${url}`);
    };
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    const { status, body } = res._get();
    assert.strictEqual(status, 500);
    assert.ok(body.error.includes("DB read failed"));
    assert.ok(body.details, "Expected details");
  });

  await test("Supabase save fails → error in errors[], no crash", async () => {
    resetEnv();
    global.fetch = makeMockFetch({
      prefRows: [makePrefRow()], subRows: [makeSubRow()], supabaseSaveOk: false, ltaMinutes: 2,
    });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    const { status, body } = res._get();
    assert.strictEqual(status, 200);
    assert.ok(body.errors.length > 0, "Expected DB save error");
    assert.ok(body.errors[0].includes("DB save"), `Got: ${body.errors[0]}`);
  });

  // ── 5. Reminder filtering ──────────────────────────────────────────────

  console.log("\nReminder filtering");

  await test("disabled reminder → not checked, no push", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ prefRows: [makePrefRow({ enabled: false })], subRows: [makeSubRow()], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.checked, 0);
    assert.strictEqual(pushCallCount, 0);
  });

  await test("reminder without time field → skipped", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ prefRows: [makePrefRow({ time: undefined })], subRows: [makeSubRow()], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.checked, 0);
    assert.strictEqual(pushCallCount, 0);
  });

  await test("reminder 35 min past window → skipped", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ prefRows: [makePrefRow({ time: reminderAt(-35) })], subRows: [makeSubRow()], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.checked, 0);
    assert.strictEqual(pushCallCount, 0);
  });

  await test("reminder for wrong day of week → skipped", async () => {
    resetEnv();
    const otherDay = (sgtNowDow() + 1) % 7;
    global.fetch = makeMockFetch({ prefRows: [makePrefRow({ days: [otherDay] })], subRows: [makeSubRow()], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.checked, 0);
  });

  await test("reminder for today → checked", async () => {
    resetEnv();
    const todayDow = sgtNowDow();
    global.fetch = makeMockFetch({ prefRows: [makePrefRow({ days: [todayDow] })], subRows: [makeSubRow()], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.ok(res._get().body.checked >= 1);
  });

  await test("cooldown active (fired 1s ago) → skipped", async () => {
    resetEnv();
    const row = makePrefRow();
    row.data.notifyState = { r1: { lastFired: Date.now() - 1000 } };
    global.fetch = makeMockFetch({ prefRows: [row], subRows: [makeSubRow()], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.checked, 0);
    assert.strictEqual(pushCallCount, 0);
  });

  await test("cooldown expired (fired 2h ago) → checked", async () => {
    resetEnv();
    const row = makePrefRow();
    row.data.notifyState = { r1: { lastFired: Date.now() - 2 * 3600 * 1000 } };
    global.fetch = makeMockFetch({ prefRows: [row], subRows: [makeSubRow()], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.ok(res._get().body.checked >= 1);
  });

  // ── 6. LTA / bus arrival ───────────────────────────────────────────────

  console.log("\nLTA / bus arrival");

  await test("LTA network error → surfaced in errors[], no crash", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ prefRows: [makePrefRow()], subRows: [makeSubRow()], ltaError: true });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    const { status, body } = res._get();
    assert.strictEqual(status, 200);
    assert.ok(body.errors.length > 0, "Expected LTA error");
    assert.ok(body.errors[0].includes("LTA"), `Got: ${body.errors[0]}`);
  });

  await test("LTA 401 status → surfaced in errors[]", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ prefRows: [makePrefRow()], subRows: [makeSubRow()], ltaStatus: 401 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.ok(res._get().body.errors.length > 0);
    assert.ok(res._get().body.errors[0].includes("LTA 401"));
  });

  await test("bus 7 min away (leadMin=5) → checked but not sent", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ prefRows: [makePrefRow({ leadMin: 5 })], subRows: [makeSubRow()], ltaMinutes: 7 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    const { body } = res._get();
    assert.strictEqual(body.checked, 1);
    assert.strictEqual(body.sent, 0);
    assert.strictEqual(pushCallCount, 0);
  });

  await test("bus 3 min away (leadMin=5) → push sent", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ prefRows: [makePrefRow({ leadMin: 5 })], subRows: [makeSubRow()], ltaMinutes: 3 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    const { body } = res._get();
    assert.strictEqual(body.checked, 1);
    assert.strictEqual(body.sent, 1);
    assert.strictEqual(pushCallCount, 1);
    assert.ok(lastPushPayload.title.includes("Bus 65"));
    assert.ok(lastPushPayload.title.includes("3 min"));
  });

  // ── 7. Push failures ───────────────────────────────────────────────────

  console.log("\nPush failures");

  await test("push 410 → dead device row deleted", async () => {
    resetEnv();
    pushShouldFail = true;
    pushFailStatusCode = 410;
    let deletedUrl = null;
    global.fetch = makeMockFetch({
      prefRows: [makePrefRow()], subRows: [makeSubRow()], ltaMinutes: 3,
      onDelete: (url) => { deletedUrl = url; },
    });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.ok(deletedUrl, "Expected a DELETE on push_subs");
    assert.ok(deletedUrl.includes("device_id=eq.dev-1"), `Got: ${deletedUrl}`);
  });

  await test("push 404 → dead device row deleted", async () => {
    resetEnv();
    pushShouldFail = true;
    pushFailStatusCode = 404;
    let deletedUrl = null;
    global.fetch = makeMockFetch({
      prefRows: [makePrefRow()], subRows: [makeSubRow()], ltaMinutes: 3,
      onDelete: (url) => { deletedUrl = url; },
    });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.ok(deletedUrl, "Expected a DELETE on push_subs");
  });

  await test("push 500 → surfaced in errors[], no crash", async () => {
    resetEnv();
    pushShouldFail = true;
    pushFailStatusCode = 500;
    global.fetch = makeMockFetch({ prefRows: [makePrefRow()], subRows: [makeSubRow()], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    const { status, body } = res._get();
    assert.strictEqual(status, 200);
    assert.ok(body.errors.length > 0);
    assert.ok(body.errors[0].includes("Push dev-1"), `Got: ${body.errors[0]}`);
  });

  await test("push failure → cooldown NOT started, so it can retry", async () => {
    resetEnv();
    pushShouldFail = true;
    pushFailStatusCode = 500;
    let saved = null;
    global.fetch = makeMockFetch({
      prefRows: [makePrefRow()], subRows: [makeSubRow()], ltaMinutes: 2,
      onSave: (b) => { saved = b; },
    });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(saved, null, "Should not persist a cooldown when nothing was delivered");
  });

  // ── 8. Per-user fan-out ────────────────────────────────────────────────

  console.log("\nPer-user fan-out");

  await test("one user with 3 devices → all 3 get the push", async () => {
    resetEnv();
    global.fetch = makeMockFetch({
      prefRows: [makePrefRow()],
      subRows: ["dev-1", "dev-2", "dev-3"].map((d) => makeSubRow(d)),
      ltaMinutes: 2,
    });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    const { body } = res._get();
    assert.strictEqual(body.users, 1);
    assert.strictEqual(body.sent, 3);
    assert.strictEqual(pushCallCount, 3);
  });

  await test("3 separate users each get one push", async () => {
    resetEnv();
    const users = ["u1", "u2", "u3"];
    global.fetch = makeMockFetch({
      prefRows: users.map((u) => makePrefRow({}, u)),
      subRows: users.map((u) => makeSubRow(`dev-${u}`, u)),
      ltaMinutes: 2,
    });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    const { body } = res._get();
    assert.strictEqual(body.users, 3);
    assert.strictEqual(body.sent, 3);
  });

  await test("user with no device → skipped, others still fire", async () => {
    resetEnv();
    global.fetch = makeMockFetch({
      prefRows: [makePrefRow({}, "no-device"), makePrefRow({}, "has-device")],
      subRows: [makeSubRow("dev-1", "has-device")],
      ltaMinutes: 2,
    });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.sent, 1);
  });

  await test("row with a null subscription is ignored", async () => {
    resetEnv();
    global.fetch = makeMockFetch({
      prefRows: [makePrefRow()],
      subRows: [makeSubRow("dead", USER_1, null), makeSubRow("live")],
      ltaMinutes: 2,
    });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.sent, 1);
  });

  await test("user with empty reminders → skipped, others still fire", async () => {
    resetEnv();
    const empty = { user_id: "empty", data: { reminders: [], notifyState: {} } };
    global.fetch = makeMockFetch({
      prefRows: [empty, makePrefRow({}, "full")],
      subRows: [makeSubRow("d1", "empty"), makeSubRow("d2", "full")],
      ltaMinutes: 2,
    });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.sent, 1);
  });

  await test("one user's reminders never reach another user's device", async () => {
    resetEnv();
    let payloads = [];
    const origSend = mockWebpush.sendNotification;
    mockWebpush.sendNotification = async (sub, payload) => {
      payloads.push({ endpoint: sub.endpoint, body: JSON.parse(payload) });
      pushCallCount++;
      return {};
    };
    try {
      global.fetch = makeMockFetch({
        prefRows: [makePrefRow({ id: "r-a", service: "111" }, "u1")],
        subRows: [
          makeSubRow("d1", "u1", { ...GOOD_SUB, endpoint: "https://fcm.example.com/u1" }),
          makeSubRow("d2", "u2", { ...GOOD_SUB, endpoint: "https://fcm.example.com/u2" }),
        ],
        ltaMinutes: 2,
      });
      const { req, res } = makeReqRes();
      await loadHandler()(req, res);
      assert.strictEqual(payloads.length, 1);
      assert.strictEqual(payloads[0].endpoint, "https://fcm.example.com/u1");
    } finally {
      mockWebpush.sendNotification = origSend;
    }
  });

  // ── 9. Response shape ──────────────────────────────────────────────────

  console.log("\nResponse shape");

  await test("success response has ok/users/checked/sent/errors", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ prefRows: [makePrefRow()], subRows: [makeSubRow()], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    const { body } = res._get();
    assert.strictEqual(body.ok, true);
    for (const field of ["users", "checked", "sent", "errors"]) {
      assert.ok(field in body, `Missing field: ${field}`);
    }
    assert.ok(Array.isArray(body.errors));
  });

  // ── summary ────────────────────────────────────────────────────────────

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
