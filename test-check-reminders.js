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

// Reminders and push subscriptions live in two tables now, so the mock has to
// answer both reads. `subRows` defaults to a single device owned by USER_A, so
// existing tests that only care about reminder logic don't have to spell it
// out.
function makeMockFetch({ reminderRows = [], subRows = null, rideRows = [], vehicle = null, trainAlerts = null, kvState = {}, prefsRows = [], supabaseSaveOk = true, ltaMinutes = 3, ltaTimes = null, ltaError = false, ltaStatus = 200 } = {}) {
  const alerts = trainAlerts || { Status: 1, AffectedSegments: [] };
  const subs = subRows === null ? [makeSub()] : subRows;
  return async function mockFetch(url, opts = {}) {
    const urlStr = url.toString();
    if (urlStr.includes("/rest/v1/reminders?select=")) {
      return { ok: true, json: async () => reminderRows, text: async () => JSON.stringify(reminderRows) };
    }
    if (urlStr.includes("/rest/v1/push_subs?select=")) {
      return { ok: true, json: async () => subs, text: async () => JSON.stringify(subs) };
    }
    if (urlStr.includes("TrainServiceAlerts")) {
      return { ok: true, status: 200, json: async () => ({ value: alerts }) };
    }
    if (urlStr.includes("/rest/v1/kv") && (!opts.method || opts.method === "GET")) {
      const rows = kvState.value ? [{ value: kvState.value }] : [];
      return { ok: true, json: async () => rows, text: async () => JSON.stringify(rows) };
    }
    if (urlStr.includes("/rest/v1/kv") && opts.method === "POST") {
      kvWrites.push(JSON.parse(opts.body));
      return { ok: true, status: 200, text: async () => "" };
    }
    if (urlStr.includes("/rest/v1/user_prefs?select=")) {
      return { ok: true, json: async () => prefsRows, text: async () => JSON.stringify(prefsRows) };
    }
    if (urlStr.includes("/rest/v1/rides?select=")) {
      return { ok: true, json: async () => rideRows, text: async () => JSON.stringify(rideRows) };
    }
    if (urlStr.includes("/rest/v1/rides") && opts.method === "DELETE") {
      endedRides.push(urlStr);
      return { ok: true, status: 200, text: async () => "" };
    }
    if (urlStr.includes("/rest/v1/reminders") && opts.method === "PATCH") {
      if (!supabaseSaveOk) return { ok: false, status: 500, text: async () => "Internal Server Error" };
      patchedReminders.push({ url: urlStr, body: JSON.parse(opts.body) });
      return { ok: true, status: 200, text: async () => "" };
    }
    if (urlStr.includes("/rest/v1/push_subs") && opts.method === "DELETE") {
      return { ok: true, status: 200, text: async () => "" };
    }
    if (urlStr.includes("/rest/v1/reminders") && opts.method === "DELETE") {
      deletedReminders.push(urlStr);
      return { ok: true, status: 200, text: async () => "" };
    }
    if (urlStr.includes("BusArrival") && vehicle && urlStr.includes(`BusStopCode=${vehicle.forStop}`)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          Services: [{
            NextBus: {
              Latitude: String(vehicle.lat),
              Longitude: String(vehicle.lng),
              EstimatedArrival: new Date(Date.now() + vehicle.etaMin * 60000).toISOString(),
            },
          }],
        }),
      };
    }
    if (urlStr.includes("BusArrival")) {
      if (ltaError) throw new Error("LTA network error");
      if (ltaStatus !== 200) return { ok: false, status: ltaStatus, json: async () => ({}), text: async () => "Bad Request" };
      if (ltaTimes) {
        const svc = { NextBus: {}, NextBus2: {}, NextBus3: {} };
        ltaTimes.forEach((mins, i) => {
          svc[["NextBus", "NextBus2", "NextBus3"][i]] = {
            EstimatedArrival: new Date(Date.now() + mins * 60000).toISOString(),
          };
        });
        return { ok: true, status: 200, json: async () => ({ Services: [svc] }) };
      }
      const eta = new Date(Date.now() + ltaMinutes * 60000).toISOString();
      return { ok: true, status: 200, json: async () => ({ Services: [{ NextBus: { EstimatedArrival: eta } }] }) };
    }
    throw new Error(`Unmocked fetch: ${urlStr}`);
  };
}

let deletedReminders = [];
let endedRides = [];
let kvWrites = [];
let patchedReminders = [];
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

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

function makeReminder(overrides = {}) {
  return { stop: "12345", service: "65", time: reminderAt(0), leadMin: 5, nickname: "Home", days: [], enabled: true, ...overrides };
}

function makeRow(payloadOverrides = {}, rowOverrides = {}) {
  return {
    id: "r1",
    user_id: USER_A,
    type: "scheduled",
    payload: makeReminder(payloadOverrides),
    notify_state: {},
    ...rowOverrides,
  };
}

function makeSub(overrides = {}) {
  return { id: "s1", user_id: USER_A, device_id: "dev-1", subscription: GOOD_SUB, ...overrides };
}

const HANDLER_PATH = path.join(__dirname, "api/check-reminders.js");

const TRACK_RIDES_PATH = path.join(__dirname, "api/track-rides.js");
const TRAIN_ALERTS_PATH = path.join(__dirname, "api/train-alerts.js");

function loadHandler() {
  // Both are required *by* check-reminders, so they have to be evicted too or
  // they keep the env vars from whichever test loaded them first.
  delete require.cache[require.resolve(TRACK_RIDES_PATH)];
  delete require.cache[require.resolve(TRAIN_ALERTS_PATH)];
  delete require.cache[require.resolve(HANDLER_PATH)];
  return require(HANDLER_PATH);
}

function loadTrainAlerts() {
  delete require.cache[require.resolve(TRAIN_ALERTS_PATH)];
  return require(TRAIN_ALERTS_PATH);
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
  deletedReminders = [];
  endedRides = [];
  kvWrites = [];
  patchedReminders = [];
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
    global.fetch = makeMockFetch({ reminderRows: [] });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().status, 200);
  });

  await test("x-vercel-cron header (no CRON_SECRET) → 200", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ reminderRows: [] });
    const { req, res } = makeReqRes({ auth: "" });
    req.headers["x-vercel-cron"] = "1";
    await loadHandler()(req, res);
    assert.strictEqual(res._get().status, 200);
  });

  // ── 2. Probe mode ──────────────────────────────────────────────────────

  console.log("\nProbe mode");

  await test("probe=1 all env vars set → ok:true, all checks true", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ reminderRows: [] });
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
    global.fetch = makeMockFetch({ reminderRows: [] });
    const { req, res } = makeReqRes({ query: { probe: "1" } });
    await loadHandler()(req, res);
    const { body } = res._get();
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.checks.VAPID_PUBLIC_KEY, false);
  });

  await test("probe=1 Supabase 401 → ok:false with dbError", async () => {
    resetEnv();
    global.fetch = async (url) => {
      if (url.includes("/rest/v1/reminders")) return { ok: false, status: 401, text: async () => "Unauthorized" };
      if (url.includes("/rest/v1/push_subs")) return { ok: true, json: async () => [], text: async () => "[]" };
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
    global.fetch = makeMockFetch({ reminderRows: [] });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().status, 400);
    assert.ok(res._get().body.error.includes("LTA_API_KEY"));
  });

  await test("missing VAPID keys → 400", async () => {
    resetEnv();
    delete process.env.VAPID_PUBLIC_KEY;
    global.fetch = makeMockFetch({ reminderRows: [] });
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
      if (url.includes("/rest/v1/reminders")) return { ok: false, status: 500, text: async () => "Server Error" };
      if (url.includes("/rest/v1/push_subs")) return { ok: true, json: async () => [], text: async () => "[]" };
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
    global.fetch = makeMockFetch({ reminderRows: [makeRow()], supabaseSaveOk: false, ltaMinutes: 2 });
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
    global.fetch = makeMockFetch({ reminderRows: [makeRow({ enabled: false })], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.checked, 0);
    assert.strictEqual(pushCallCount, 0);
  });

  await test("reminder without time field → skipped", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ reminderRows: [makeRow({ time: undefined })], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.checked, 0);
    assert.strictEqual(pushCallCount, 0);
  });

  await test("reminder 35 min past window → skipped", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ reminderRows: [makeRow({ time: reminderAt(-35) })], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.checked, 0);
    assert.strictEqual(pushCallCount, 0);
  });

  await test("reminder for wrong day of week → skipped", async () => {
    resetEnv();
    const otherDay = (sgtNowDow() + 1) % 7;
    global.fetch = makeMockFetch({ reminderRows: [makeRow({ days: [otherDay] })], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.checked, 0);
  });

  await test("reminder for today → checked", async () => {
    resetEnv();
    const todayDow = sgtNowDow();
    global.fetch = makeMockFetch({ reminderRows: [makeRow({ days: [todayDow] })], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.ok(res._get().body.checked >= 1);
  });

  await test("cooldown active (fired 1s ago) → skipped", async () => {
    resetEnv();
    const row = makeRow({}, { notify_state: { lastFired: Date.now() - 1000 } });
    global.fetch = makeMockFetch({ reminderRows: [row], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.checked, 0);
    assert.strictEqual(pushCallCount, 0);
  });

  await test("cooldown expired (fired 2h ago) → checked", async () => {
    resetEnv();
    const row = makeRow({}, { notify_state: { lastFired: Date.now() - 2 * 3600 * 1000 } });
    global.fetch = makeMockFetch({ reminderRows: [row], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.ok(res._get().body.checked >= 1);
  });

  // ── 6. LTA / bus arrival ───────────────────────────────────────────────

  console.log("\nLTA / bus arrival");

  await test("LTA network error → surfaced in errors[], no crash", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ reminderRows: [makeRow()], ltaError: true });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    const { status, body } = res._get();
    assert.strictEqual(status, 200);
    assert.ok(body.errors.length > 0, "Expected LTA error");
    assert.ok(body.errors[0].includes("LTA"), `Got: ${body.errors[0]}`);
  });

  await test("LTA 401 status → surfaced in errors[]", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ reminderRows: [makeRow()], ltaStatus: 401 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.ok(res._get().body.errors.length > 0);
    assert.ok(res._get().body.errors[0].includes("LTA 401"));
  });

  await test("bus 7 min away (leadMin=5) → checked but not sent", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ reminderRows: [makeRow({ leadMin: 5 })], ltaMinutes: 7 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    const { body } = res._get();
    assert.strictEqual(body.checked, 1);
    assert.strictEqual(body.sent, 0);
    assert.strictEqual(pushCallCount, 0);
  });

  await test("bus 3 min away (leadMin=5) → push sent", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ reminderRows: [makeRow({ leadMin: 5 })], ltaMinutes: 3 });
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

  // A retired endpoint is now deleted outright rather than having its
  // subscription blob nulled — the row is per-device, so there is nothing
  // else in it worth keeping.
  for (const code of [410, 404]) {
    await test(`push ${code} → dead subscription row deleted`, async () => {
      resetEnv();
      pushShouldFail = true;
      pushFailStatusCode = code;
      let deletedUrl = null;
      global.fetch = async (url, opts = {}) => {
        if (url.includes("/rest/v1/reminders?select=")) return { ok: true, json: async () => [makeRow()], text: async () => "" };
        if (url.includes("/rest/v1/push_subs?select=")) return { ok: true, json: async () => [makeSub()], text: async () => "" };
        if (url.includes("/rest/v1/push_subs") && opts?.method === "DELETE") { deletedUrl = url; return { ok: true, status: 200, text: async () => "" }; }
        if (url.includes("BusArrival")) { const eta = new Date(Date.now() + 3 * 60000).toISOString(); return { ok: true, status: 200, json: async () => ({ Services: [{ NextBus: { EstimatedArrival: eta } }] }) }; }
        throw new Error(`Unmocked: ${url}`);
      };
      const { req, res } = makeReqRes();
      await loadHandler()(req, res);
      assert.ok(deletedUrl, "Expected the dead subscription to be deleted");
      assert.ok(deletedUrl.includes("id=eq.s1"), `Got: ${deletedUrl}`);
    });
  }

  await test("push 500 → surfaced in errors[], no crash", async () => {
    resetEnv();
    pushShouldFail = true;
    pushFailStatusCode = 500;
    global.fetch = makeMockFetch({ reminderRows: [makeRow()], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    const { status, body } = res._get();
    assert.strictEqual(status, 200);
    assert.ok(body.errors.length > 0);
    assert.ok(body.errors[0].includes("dev-1"), `Got: ${body.errors[0]}`);
  });

  // ── 8. Parallel processing ─────────────────────────────────────────────

  console.log("\nParallel processing");

  await test("3 accounts each get one push", async () => {
    resetEnv();
    const users = [USER_A, USER_B, "33333333-3333-4333-8333-333333333333"];
    const reminderRows = users.map((u, i) => makeRow({}, { id: `r${i}`, user_id: u }));
    const subRows = users.map((u, i) => makeSub({ id: `s${i}`, user_id: u, device_id: `dev-${i}` }));
    global.fetch = makeMockFetch({ reminderRows, subRows, ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    const { body } = res._get();
    assert.strictEqual(body.reminders, 3);
    assert.strictEqual(body.sent, 3);
    assert.strictEqual(pushCallCount, 3);
  });

  // The whole point of moving off device-keyed rows: one reminder should now
  // reach every device the account has registered.
  await test("one reminder fans out to all of the account's devices", async () => {
    resetEnv();
    const subRows = [
      makeSub({ id: "s1", device_id: "phone" }),
      makeSub({ id: "s2", device_id: "laptop" }),
    ];
    global.fetch = makeMockFetch({ reminderRows: [makeRow()], subRows, ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.sent, 2);
    assert.strictEqual(pushCallCount, 2);
  });

  await test("reminder whose account has no device → skipped, others still fire", async () => {
    resetEnv();
    const reminderRows = [
      makeRow({}, { id: "r-orphan", user_id: USER_B }),
      makeRow({}, { id: "r-ok", user_id: USER_A }),
    ];
    global.fetch = makeMockFetch({ reminderRows, subRows: [makeSub()], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.sent, 1);
  });

  await test("a device with a null subscription is not pushed to", async () => {
    resetEnv();
    const subRows = [makeSub({ id: "s1", device_id: "stale", subscription: null })];
    global.fetch = makeMockFetch({ reminderRows: [makeRow()], subRows, ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.sent, 0);
    assert.strictEqual(pushCallCount, 0);
  });

  // Guards the multi-tenancy fix: a reminder must never reach an account that
  // doesn't own it.
  await test("account B's device never receives account A's reminder", async () => {
    resetEnv();
    const subRows = [
      makeSub({ id: "sA", user_id: USER_A, device_id: "a-phone" }),
      makeSub({ id: "sB", user_id: USER_B, device_id: "b-phone" }),
    ];
    global.fetch = makeMockFetch({ reminderRows: [makeRow()], subRows, ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.sent, 1, "only account A's device should be pushed to");
  });

  await test("a one-shot with no targetArrival is skipped, not run as scheduled", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ reminderRows: [makeRow({}, { type: "oneshot" })], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.checked, 0);
    assert.strictEqual(pushCallCount, 0);
  });

  // ── 9. One-shot reminders ──────────────────────────────────────────────

  console.log("\nOne-shot reminders");

  // Builds a one-shot targeting a bus `mins` from now.
  function makeOneShot(mins, payloadOverrides = {}, rowOverrides = {}) {
    return {
      id: "os1",
      user_id: USER_A,
      type: "oneshot",
      payload: {
        stop: "12345",
        service: "65",
        targetArrival: new Date(Date.now() + mins * 60000).toISOString(),
        firedCount: 0,
        nickname: "Bus 65 at stop 12345",
        ...payloadOverrides,
      },
      notify_state: {},
      ...rowOverrides,
    };
  }

  await test("one-shot ignores the time-of-day window a scheduled reminder obeys", async () => {
    resetEnv();
    // 35 minutes past would put a scheduled reminder outside its window.
    global.fetch = makeMockFetch({ reminderRows: [makeOneShot(8)], ltaTimes: [8, 20, 35] });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.checked, 1);
    assert.strictEqual(pushCallCount, 1);
  });

  await test("one-shot ignores the day-of-week filter", async () => {
    resetEnv();
    const otherDay = (sgtNowDow() + 1) % 7;
    global.fetch = makeMockFetch({ reminderRows: [makeOneShot(8, { days: [otherDay] })], ltaTimes: [8, 20, 35] });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(pushCallCount, 1);
  });

  await test("one-shot cooldown is 3 min, not the scheduled hour", async () => {
    resetEnv();
    const row = makeOneShot(8, {}, { notify_state: { lastFired: Date.now() - 4 * 60000, firedCount: 1 } });
    global.fetch = makeMockFetch({ reminderRows: [row], ltaTimes: [8, 20, 35] });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(pushCallCount, 1, "4 min after the last fire should be past the one-shot cooldown");
  });

  await test("one-shot inside its 3 min cooldown does not fire", async () => {
    resetEnv();
    const row = makeOneShot(8, {}, { notify_state: { lastFired: Date.now() - 60000, firedCount: 1 } });
    global.fetch = makeMockFetch({ reminderRows: [row], ltaTimes: [8, 20, 35] });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(pushCallCount, 0);
  });

  await test("bus arriving (ETA <= 1 min) → final push, reminder deleted", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ reminderRows: [makeOneShot(1)], ltaTimes: [1, 15, 30] });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(pushCallCount, 1);
    assert.ok(lastPushPayload.title.includes("arriving"), `Got: ${lastPushPayload.title}`);
    assert.strictEqual(res._get().body.expired, 1);
    assert.ok(deletedReminders.some((u) => u.includes("id=eq.os1")), "expected the reminder to be deleted");
  });

  await test("arrival push beats the cooldown — it is the one that matters", async () => {
    resetEnv();
    const row = makeOneShot(1, {}, { notify_state: { lastFired: Date.now() - 1000, firedCount: 2 } });
    global.fetch = makeMockFetch({ reminderRows: [row], ltaTimes: [1, 15, 30] });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(pushCallCount, 1);
    assert.ok(deletedReminders.some((u) => u.includes("id=eq.os1")));
  });

  await test("10th fire deletes the reminder (spam cap)", async () => {
    resetEnv();
    const row = makeOneShot(8, { firedCount: 9 }, { notify_state: { lastFired: Date.now() - 10 * 60000, firedCount: 9 } });
    global.fetch = makeMockFetch({ reminderRows: [row], ltaTimes: [8, 20, 35] });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(pushCallCount, 1);
    assert.ok(deletedReminders.some((u) => u.includes("id=eq.os1")), "expected deletion at the fire cap");
  });

  await test("drift: re-anchors targetArrival to the matched arrival", async () => {
    resetEnv();
    // Target says 8 min; LTA now says 10. Within tolerance, so it should track.
    const row = makeOneShot(8, {}, { notify_state: { lastFired: Date.now() - 60000, firedCount: 1 } });
    global.fetch = makeMockFetch({ reminderRows: [row], ltaTimes: [10, 25, 40] });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(pushCallCount, 0, "still cooling down");
    const patch = patchedReminders.find((p) => p.url.includes("id=eq.os1"));
    assert.ok(patch, "expected the drifted target to be saved");
    assert.notStrictEqual(patch.body.payload.targetArrival, row.payload.targetArrival);
  });

  await test("no arrival within tolerance but target is recent → left alone", async () => {
    resetEnv();
    // Target 8 min out, only a bus 40 min out — way beyond the 5 min window.
    global.fetch = makeMockFetch({ reminderRows: [makeOneShot(8)], ltaTimes: [40] });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(pushCallCount, 0);
    assert.strictEqual(res._get().body.expired, 0);
    assert.strictEqual(deletedReminders.length, 0);
  });

  await test("target long past with no match → reminder abandoned", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ reminderRows: [makeOneShot(-45)], ltaTimes: [40] });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(res._get().body.expired, 1);
    assert.ok(deletedReminders.some((u) => u.includes("id=eq.os1")));
  });

  await test("non-arrival push carries a Dismiss action and its token", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ reminderRows: [makeOneShot(8)], ltaTimes: [8, 20, 35] });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(lastPushPayload.actions.length, 1);
    assert.strictEqual(lastPushPayload.actions[0].action, "dismiss");
    assert.strictEqual(lastPushPayload.reminderId, "os1");
    assert.ok(lastPushPayload.dismissToken, "expected a dismiss token in the payload");
  });

  await test("the dismiss token is stable across fires", async () => {
    resetEnv();
    const row = makeOneShot(8, {}, { notify_state: { dismissToken: "tok-abc", lastFired: Date.now() - 10 * 60000, firedCount: 1 } });
    global.fetch = makeMockFetch({ reminderRows: [row], ltaTimes: [8, 20, 35] });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(lastPushPayload.dismissToken, "tok-abc");
  });

  // ── 10. Ride tracking (server-side drop-off) ───────────────────────────

  console.log("\nRide tracking");

  // Two real Singapore stops ~350 m apart, so "near" and "not near" are
  // meaningful distances rather than made-up ones.
  const PREV = { lat: 1.3300, lng: 103.8500 };
  const DEST = { lat: 1.3330, lng: 103.8520 };

  function makeRide(overrides = {}) {
    return {
      id: "ride-1",
      user_id: USER_A,
      created_at: new Date().toISOString(),
      data: {
        service: "165",
        destStop: "44009",
        destName: "Opp Blk 123",
        prevStop: "44001",
        prevName: "Blk 100",
        prevLat: PREV.lat,
        prevLng: PREV.lng,
        startedAt: new Date().toISOString(),
        ...overrides,
      },
    };
  }

  await test("bus near the previous stop → alert, ride ended", async () => {
    resetEnv();
    global.fetch = makeMockFetch({
      rideRows: [makeRide()],
      vehicle: { forStop: "44009", lat: PREV.lat, lng: PREV.lng, etaMin: 5 },
    });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(pushCallCount, 1);
    assert.ok(lastPushPayload.title.includes("Opp Blk 123"), `Got: ${lastPushPayload.title}`);
    assert.ok(endedRides.some((u) => u.includes("id=eq.ride-1")), "expected the ride to end after alerting");
  });

  await test("bus still far from the previous stop → no alert", async () => {
    resetEnv();
    global.fetch = makeMockFetch({
      rideRows: [makeRide()],
      vehicle: { forStop: "44009", lat: 1.3100, lng: 103.8200, etaMin: 12 },
    });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(pushCallCount, 0);
    assert.strictEqual(endedRides.length, 0);
  });

  // The second trigger: LTA sometimes has no vehicle fix, but a low ETA at the
  // destination still means the bus is on its last leg.
  await test("no vehicle fix but ETA under 2 min → alert anyway", async () => {
    resetEnv();
    global.fetch = makeMockFetch({
      rideRows: [makeRide()],
      vehicle: { forStop: "44009", lat: 0, lng: 0, etaMin: 1 },
    });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(pushCallCount, 1);
  });

  await test("no vehicle fix and a distant ETA → no alert", async () => {
    resetEnv();
    global.fetch = makeMockFetch({
      rideRows: [makeRide()],
      vehicle: { forStop: "44009", lat: 0, lng: 0, etaMin: 14 },
    });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(pushCallCount, 0);
  });

  await test("ride older than 3 hours is abandoned without alerting", async () => {
    resetEnv();
    const stale = makeRide({ startedAt: new Date(Date.now() - 4 * 3600 * 1000).toISOString() });
    global.fetch = makeMockFetch({
      rideRows: [stale],
      vehicle: { forStop: "44009", lat: PREV.lat, lng: PREV.lng, etaMin: 1 },
    });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(pushCallCount, 0, "an abandoned ride should not push");
    assert.ok(endedRides.some((u) => u.includes("id=eq.ride-1")));
  });

  await test("a ride belonging to an account with no device is skipped", async () => {
    resetEnv();
    global.fetch = makeMockFetch({
      rideRows: [makeRide()],
      subRows: [makeSub({ user_id: USER_B })],
      vehicle: { forStop: "44009", lat: PREV.lat, lng: PREV.lng, etaMin: 1 },
    });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(pushCallCount, 0);
  });

  await test("ride alert fans out to every device on the account", async () => {
    resetEnv();
    global.fetch = makeMockFetch({
      rideRows: [makeRide()],
      subRows: [makeSub({ id: "s1", device_id: "phone" }), makeSub({ id: "s2", device_id: "watch" })],
      vehicle: { forStop: "44009", lat: PREV.lat, lng: PREV.lng, etaMin: 3 },
    });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    assert.strictEqual(pushCallCount, 2);
  });

  await test("check-reminders reports ride tracking in its response", async () => {
    resetEnv();
    global.fetch = makeMockFetch({
      rideRows: [makeRide()],
      vehicle: { forStop: "44009", lat: PREV.lat, lng: PREV.lng, etaMin: 3 },
    });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    const { body } = res._get();
    assert.ok(body.rides, "expected a rides summary");
    assert.strictEqual(body.rides.tracked, 1);
    assert.strictEqual(body.rides.sent, 1);
    assert.strictEqual(body.rides.ended, 1);
    assert.deepStrictEqual(body.errors, [], `Unexpected errors: ${JSON.stringify(body.errors)}`);
  });

  // ── 11. Train disruption alerts ────────────────────────────────────────

  console.log("\nTrain disruption alerts");

  const DISRUPTED = {
    Status: 2,
    AffectedSegments: [
      { Line: "EWL", Direction: "Boon Lay", Stations: "EW21,EW22,EW23" },
    ],
  };
  const NORMAL = { Status: 1, AffectedSegments: [] };

  function alertReq(body) {
    const { req, res } = makeReqRes();
    req.method = body ? "POST" : "GET";
    req.body = body || {};
    return { req, res };
  }

  await test("a new disruption pushes to subscribers", async () => {
    resetEnv();
    global.fetch = makeMockFetch({
      trainAlerts: DISRUPTED,
      subRows: [makeSub()],
      prefsRows: [{ user_id: USER_A, data: {} }],
    });
    const { req, res } = alertReq();
    await loadTrainAlerts()(req, res);
    const { body } = res._get();
    assert.strictEqual(body.disrupted, true);
    assert.strictEqual(body.sent, 1);
    assert.ok(lastPushPayload.title.includes("disruption"), `Got: ${lastPushPayload.title}`);
    assert.ok(lastPushPayload.body.includes("East West Line"), `Got: ${lastPushPayload.body}`);
  });

  // The whole point of hashing: a minute-by-minute poll must not re-push the
  // same outage sixty times an hour.
  await test("an unchanged disruption does not push again", async () => {
    resetEnv();
    let stored = {};
    global.fetch = makeMockFetch({
      trainAlerts: DISRUPTED,
      subRows: [makeSub()],
      prefsRows: [{ user_id: USER_A, data: {} }],
      kvState: stored,
    });
    await loadTrainAlerts()(...Object.values(alertReq()));
    const firstHash = kvWrites[0]?.value?.hash;
    assert.ok(firstHash, "expected the first pass to record a hash");

    pushCallCount = 0;
    stored.value = kvWrites[0].value;
    const { req, res } = alertReq();
    await loadTrainAlerts()(req, res);
    assert.strictEqual(res._get().body.changed, false);
    assert.strictEqual(pushCallCount, 0);
  });

  await test("recovery notifies the people who heard about the outage", async () => {
    resetEnv();
    global.fetch = makeMockFetch({
      trainAlerts: NORMAL,
      subRows: [makeSub()],
      prefsRows: [{ user_id: USER_A, data: { alertLines: ["EWL"] } }],
      kvState: { value: { hash: "stale", disrupted: true, lines: ["EWL"] } },
    });
    const { req, res } = alertReq();
    await loadTrainAlerts()(req, res);
    assert.strictEqual(res._get().body.disrupted, false);
    assert.strictEqual(pushCallCount, 1);
    assert.ok(lastPushPayload.title.includes("restored"), `Got: ${lastPushPayload.title}`);
  });

  await test("normal service with no prior outage says nothing", async () => {
    resetEnv();
    global.fetch = makeMockFetch({
      trainAlerts: NORMAL,
      subRows: [makeSub()],
      prefsRows: [{ user_id: USER_A, data: {} }],
    });
    const { req, res } = alertReq();
    await loadTrainAlerts()(req, res);
    assert.strictEqual(res._get().body.sent, 0);
    assert.strictEqual(pushCallCount, 0);
  });

  await test("a user following only other lines is not pushed", async () => {
    resetEnv();
    global.fetch = makeMockFetch({
      trainAlerts: DISRUPTED,
      subRows: [makeSub()],
      prefsRows: [{ user_id: USER_A, data: { alertLines: ["NSL", "DTL"] } }],
    });
    const { req, res } = alertReq();
    await loadTrainAlerts()(req, res);
    assert.strictEqual(pushCallCount, 0);
  });

  await test("a user following the affected line is pushed", async () => {
    resetEnv();
    global.fetch = makeMockFetch({
      trainAlerts: DISRUPTED,
      subRows: [makeSub()],
      prefsRows: [{ user_id: USER_A, data: { alertLines: ["EWL", "NSL"] } }],
    });
    const { req, res } = alertReq();
    await loadTrainAlerts()(req, res);
    assert.strictEqual(pushCallCount, 1);
  });

  await test("an empty line list means opted out entirely", async () => {
    resetEnv();
    global.fetch = makeMockFetch({
      trainAlerts: DISRUPTED,
      subRows: [makeSub()],
      prefsRows: [{ user_id: USER_A, data: { alertLines: [] } }],
    });
    const { req, res } = alertReq();
    await loadTrainAlerts()(req, res);
    assert.strictEqual(pushCallCount, 0);
  });

  // Real disruptions can't be summoned on demand, so a mocked payload is the
  // only way to exercise this path against a live deployment.
  await test("a POSTed payload overrides the LTA poll", async () => {
    resetEnv();
    global.fetch = makeMockFetch({
      trainAlerts: NORMAL,
      subRows: [makeSub()],
      prefsRows: [{ user_id: USER_A, data: {} }],
    });
    const { req, res } = alertReq({ value: DISRUPTED });
    await loadTrainAlerts()(req, res);
    assert.strictEqual(res._get().body.disrupted, true);
    assert.strictEqual(pushCallCount, 1);
  });

  await test("check-reminders reports the train check in its response", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ trainAlerts: NORMAL });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    const { body } = res._get();
    assert.ok(body.trains, "expected a trains summary");
    assert.strictEqual(body.trains.disrupted, false);
    assert.deepStrictEqual(body.errors, [], `Unexpected errors: ${JSON.stringify(body.errors)}`);
  });

  // ── 12. Response shape ─────────────────────────────────────────────────

  console.log("\nResponse shape");

  await test("success response has ok/devices/checked/sent/errors", async () => {
    resetEnv();
    global.fetch = makeMockFetch({ reminderRows: [makeRow()], ltaMinutes: 2 });
    const { req, res } = makeReqRes();
    await loadHandler()(req, res);
    const { body } = res._get();
    assert.strictEqual(body.ok, true);
    for (const field of ["reminders","devices","checked","sent","expired","errors"]) {
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
