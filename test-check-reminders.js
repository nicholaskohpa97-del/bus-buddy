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

function makeMockFetch({ supabaseRows = [], supabaseSaveOk = true, ltaMinutes = 3, ltaError = false, ltaStatus = 200 } = {}) {
  return async function mockFetch(url, opts = {}) {
    const urlStr = url.toString();
    if (urlStr.includes("push_subs?select=device_id")) {
      return { ok: true, json: async () => supabaseRows, text: async () => JSON.stringify(supabaseRows) };
    }
    if (urlStr.includes("/rest/v1/push_subs") && opts.method === "POST") {
      if (!supabaseSaveOk) return { ok: false, status: 500, text: async () => "Internal Server Error" };
      return { ok: true, status: 200, text: async () => "" };
    }
    if (urlStr.includes("BusArrival")) {
      if (ltaError) throw new Error("LTA network error");
      if (ltaStatus !== 200) return { ok: false, status: ltaStatus, json: async () => ({}), text: async () => "Bad Request" };
      const eta = new Date(Date.now() + ltaMinutes * 60000).toISOString();
      return { ok: true, status: 200, json: async () => ({ Services: [{ NextBus: { EstimatedArrival: eta } }] }) };
    }
    throw new Error(`Unmocked fetch: ${urlStr}`);
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

function makeRow(reminderOverrides = {}, subOverrides = {}) {
  return { device_id: "dev-1", data: { subscription: { ...GOOD_SUB, ...subOverrides }, reminders: [makeReminder(reminderOverrides)], notifyState: {} } };
}

const HANDLER_PATH = path.join(__dirname, "api/check-reminders.js");

function loadHandler() {
  delete require.cache[require.resolve(HANDLER_PATH)];
  return require(HANDLER_PATH);
}

function resetEnv() {
  process.env.SUPABASE_URL = "https://fake.supabase.co";
  process.env.SUPABASE_ANON_KEY = "anon-key";
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
    global.fetch = makeMockFetch({ supabaseRows: [] });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().status, 200);
  });

  await test("x-vercel-cron header (no CRON_SECRET) → 200", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ supabaseRows: [] });
    const { req, res } = makeReqRes({ auth: "" });
    req.headers["x-vercel-cron"] = "1";
    await loadHandler()(req, res);
    assert.strictEqual(res._get().status, 200);
  });

  // ── 2. Probe mode ──────────────────────────────────────────────────────

  console.log("\nProbe mode");

  await test("probe=1 all env vars set → ok:true, all checks true", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ supabaseRows: [] });
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
    global.fetch = makeMockFetch({ supabaseRows: [] });
    const { req, res } = makeReqRes({ query: { probe: "1" } });
    await loadHandler()(req, res);
    const { body } = res._get();
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.checks.VAPID_PUBLIC_KEY, false);
  });

  await test("probe=1 Supabase 401 → ok:false with dbError", async () => {
    resetEnv();
    global.fetch = async (url) => {
      if (url.includes("push_subs")) return { ok: false, status: 401, text: async () => "Unauthorized" };
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
    global.fetch = makeMockFetch({ supabaseRows: [] });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().status, 400);
    assert.ok(res._get().body.error.includes("LTA_API_KEY"));
  });

  await test("missing VAPID keys → 400", async () => {
    resetEnv();
    delete process.env.VAPID_PUBLIC_KEY;
    global.fetch = makeMockFetch({ supabaseRows: [] });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().status, 400);
    assert.ok(res._get().body.error.includes("VAPID"));
  });

  // ── 4. DB failures ─────────────────────────────────────────────────────

  console.log("\nDB failures");

  await test("Supabase getRows 500 → 500 with details", async () => {
    resetEnv();
    global.fetch = async (url) => {
      if (url.includes("push_subs?select")) return { ok: false, status: 500, text: async () => "Server Error" };
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
    global.fetch = makeMockFetch({ supabaseRows: [makeRow()], supabaseSaveOk: false, ltaMinutes: 2 });
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
    global.fetch = makeMockFetch({ supabaseRows: [makeRow({ enabled: false })], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.checked, 0);
    assert.strictEqual(pushCallCount, 0);
  });

  await test("reminder without time field → skipped", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ supabaseRows: [makeRow({ time: undefined })], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.checked, 0);
    assert.strictEqual(pushCallCount, 0);
  });

  await test("reminder 35 min past window → skipped", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ supabaseRows: [makeRow({ time: reminderAt(-35) })], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.checked, 0);
    assert.strictEqual(pushCallCount, 0);
  });

  await test("reminder for wrong day of week → skipped", async () => {
    resetEnv();
    const otherDay = (sgtNowDow() + 1) % 7;
    global.fetch = makeMockFetch({ supabaseRows: [makeRow({ days: [otherDay] })], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.checked, 0);
  });

  await test("reminder for today → checked", async () => {
    resetEnv();
    const todayDow = sgtNowDow();
    global.fetch = makeMockFetch({ supabaseRows: [makeRow({ days: [todayDow] })], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.ok(res._get().body.checked >= 1);
  });

  await test("cooldown active (fired 1s ago) → skipped", async () => {
    resetEnv();
    const row = makeRow();
    row.data.notifyState = { r1: { lastFired: Date.now() - 1000 } };
    global.fetch = makeMockFetch({ supabaseRows: [row], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.checked, 0);
    assert.strictEqual(pushCallCount, 0);
  });

  await test("cooldown expired (fired 2h ago) → checked", async () => {
    resetEnv();
    const row = makeRow();
    row.data.notifyState = { r1: { lastFired: Date.now() - 2 * 3600 * 1000 } };
    global.fetch = makeMockFetch({ supabaseRows: [row], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.ok(res._get().body.checked >= 1);
  });

  // ── 6. LTA / bus arrival ───────────────────────────────────────────────

  console.log("\nLTA / bus arrival");

  await test("LTA network error → surfaced in errors[], no crash", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ supabaseRows: [makeRow()], ltaError: true });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    const { status, body } = res._get();
    assert.strictEqual(status, 200);
    assert.ok(body.errors.length > 0, "Expected LTA error");
    assert.ok(body.errors[0].includes("LTA"), `Got: ${body.errors[0]}`);
  });

  await test("LTA 401 status → surfaced in errors[]", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ supabaseRows: [makeRow()], ltaStatus: 401 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.ok(res._get().body.errors.length > 0);
    assert.ok(res._get().body.errors[0].includes("LTA 401"));
  });

  await test("bus 7 min away (leadMin=5) → checked but not sent", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ supabaseRows: [makeRow({ leadMin: 5 })], ltaMinutes: 7 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    const { body } = res._get();
    assert.strictEqual(body.checked, 1);
    assert.strictEqual(body.sent, 0);
    assert.strictEqual(pushCallCount, 0);
  });

  await test("bus 3 min away (leadMin=5) → push sent", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ supabaseRows: [makeRow({ leadMin: 5 })], ltaMinutes: 3 });
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

  await test("push 410 → subscription nulled in DB", async () => {
    resetEnv();
    pushShouldFail = true;
    pushFailStatusCode = 410;
    let savedData = null;
    global.fetch = async (url, opts = {}) => {
      if (url.includes("push_subs?select=device_id")) return { ok: true, json: async () => [makeRow()], text: async () => "" };
      if (url.includes("/rest/v1/push_subs") && opts?.method === "POST") { savedData = JSON.parse(opts.body); return { ok: true, status: 200, text: async () => "" }; }
      if (url.includes("BusArrival")) { const eta = new Date(Date.now() + 3 * 60000).toISOString(); return { ok: true, status: 200, json: async () => ({ Services: [{ NextBus: { EstimatedArrival: eta } }] }) }; }
      throw new Error(`Unmocked: ${url}`);
    };
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.ok(savedData, "Expected DB save call");
    assert.strictEqual(savedData.data.subscription, null, "subscription should be nulled");
  });

  await test("push 404 → subscription nulled in DB", async () => {
    resetEnv();
    pushShouldFail = true;
    pushFailStatusCode = 404;
    let savedData = null;
    global.fetch = async (url, opts = {}) => {
      if (url.includes("push_subs?select=device_id")) return { ok: true, json: async () => [makeRow()], text: async () => "" };
      if (url.includes("/rest/v1/push_subs") && opts?.method === "POST") { savedData = JSON.parse(opts.body); return { ok: true, status: 200, text: async () => "" }; }
      if (url.includes("BusArrival")) { const eta = new Date(Date.now() + 3 * 60000).toISOString(); return { ok: true, status: 200, json: async () => ({ Services: [{ NextBus: { EstimatedArrival: eta } }] }) }; }
      throw new Error(`Unmocked: ${url}`);
    };
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.ok(savedData);
    assert.strictEqual(savedData.data.subscription, null);
  });

  await test("push 500 → surfaced in errors[], no crash", async () => {
    resetEnv();
    pushShouldFail = true;
    pushFailStatusCode = 500;
    global.fetch = makeMockFetch({ supabaseRows: [makeRow()], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    const { status, body } = res._get();
    assert.strictEqual(status, 200);
    assert.ok(body.errors.length > 0);
    assert.ok(body.errors[0].includes("Push dev-1"), `Got: ${body.errors[0]}`);
  });

  // ── 8. Parallel processing ─────────────────────────────────────────────

  console.log("\nParallel processing");

  await test("3 devices all get push", async () => {
    resetEnv();
    const rows = ["dev-1","dev-2","dev-3"].map(id => ({
      device_id: id,
      data: { subscription: GOOD_SUB, reminders: [makeReminder()], notifyState: {} },
    }));
    global.fetch = makeMockFetch({ supabaseRows: rows, ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    const { body } = res._get();
    assert.strictEqual(body.devices, 3);
    assert.strictEqual(body.sent, 3);
    assert.strictEqual(pushCallCount, 3);
  });

  await test("device with no subscription → skipped, others still fire", async () => {
    resetEnv();
    const rows = [
      { device_id: "no-sub", data: { subscription: null, reminders: [makeReminder()], notifyState: {} } },
      { device_id: "ok",     data: { subscription: GOOD_SUB, reminders: [makeReminder()], notifyState: {} } },
    ];
    global.fetch = makeMockFetch({ supabaseRows: rows, ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.sent, 1);
  });

  await test("device with empty reminders → skipped, others still fire", async () => {
    resetEnv();
    const rows = [
      { device_id: "no-rem", data: { subscription: GOOD_SUB, reminders: [], notifyState: {} } },
      { device_id: "ok",     data: { subscription: GOOD_SUB, reminders: [makeReminder()], notifyState: {} } },
    ];
    global.fetch = makeMockFetch({ supabaseRows: rows, ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.sent, 1);
  });

  // ── 9. Response shape ──────────────────────────────────────────────────

  console.log("\nResponse shape");

  await test("success response has ok/devices/checked/sent/errors", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ supabaseRows: [makeRow()], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    const { body } = res._get();
    assert.strictEqual(body.ok, true);
    for (const field of ["devices","checked","sent","errors"]) {
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
