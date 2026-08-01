const crypto = require("crypto");
const webpush = require("web-push");

const { SB_URL, fetchWithTimeout, serviceHeaders } = require("./_auth");
const { trackRides } = require("./track-rides");
const { checkTrainAlerts } = require("./train-alerts");

const LTA_KEY = process.env.LTA_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

// Cooldown is per type, not global. An hour is right for "every weekday at
// 08:00, tell me when the bus is close" — you only want telling once. It is
// exactly wrong for a one-shot, which is following one vehicle in and needs to
// update you as it approaches; an hour would let it fire once and then go
// quiet for the entire ride.
const COOLDOWNS = {
  scheduled: 60 * 60 * 1000,
  oneshot: 3 * 60 * 1000,
};

// LTA's EstimatedArrival for a given bus drifts by a minute or two between
// polls as the vehicle speeds up and slows down, so a one-shot can't match its
// bus by timestamp equality — it takes the closest arrival within this window
// and re-anchors to it.
const ONESHOT_MATCH_TOLERANCE_MS = 5 * 60 * 1000;
// Once the target time is this far past with no matching arrival, the bus has
// been and gone (or was cancelled) and the reminder is garbage.
const ONESHOT_ABANDON_MS = 30 * 60 * 1000;
// Hard spam cap, independent of the cooldown.
const ONESHOT_MAX_FIRES = 10;

function vapidReady() {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:alerts@bus-buddy.app",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  return true;
}

// The cron has no user context, so it reads across every account with the
// service-role key. This is the one place that legitimately bypasses RLS; all
// the user-facing routes go through the caller's own JWT instead.
async function getReminders() {
  const res = await fetchWithTimeout(
    `${SB_URL}/rest/v1/reminders?select=id,user_id,type,payload,notify_state`,
    { headers: serviceHeaders() }
  );
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getSubs() {
  const res = await fetchWithTimeout(
    `${SB_URL}/rest/v1/push_subs?select=id,user_id,device_id,subscription`,
    { headers: serviceHeaders() }
  );
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

async function saveReminder(reminderId, patch) {
  const res = await fetchWithTimeout(`${SB_URL}/rest/v1/reminders?id=eq.${reminderId}`, {
    method: "PATCH",
    headers: serviceHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Supabase save ${res.status}: ${await res.text()}`);
}

async function deleteReminder(reminderId) {
  const res = await fetchWithTimeout(`${SB_URL}/rest/v1/reminders?id=eq.${reminderId}`, {
    method: "DELETE",
    headers: serviceHeaders({ Prefer: "return=minimal" }),
  });
  if (!res.ok) throw new Error(`Supabase delete ${res.status}: ${await res.text()}`);
}

// A 404/410 from the push service means the browser threw the subscription
// away (uninstall, cleared data). Drop the row rather than retrying it every
// minute forever.
async function dropSub(subId) {
  await fetchWithTimeout(`${SB_URL}/rest/v1/push_subs?id=eq.${subId}`, {
    method: "DELETE",
    headers: serviceHeaders({ Prefer: "return=minimal" }),
  });
}

async function fetchArrivals(stop, service) {
  const url = new URL("https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival");
  url.searchParams.set("BusStopCode", stop);
  if (service) url.searchParams.set("ServiceNo", service);
  const resp = await fetchWithTimeout(url.toString(), {
    headers: { AccountKey: LTA_KEY, accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`LTA ${resp.status}`);
  return resp.json();
}

async function fetchArrivalMin(stop, service) {
  const data = await fetchArrivals(stop, service);
  const svc = data.Services && data.Services[0];
  if (!svc || !svc.NextBus || !svc.NextBus.EstimatedArrival) return null;
  return Math.max(0, Math.round((new Date(svc.NextBus.EstimatedArrival) - new Date()) / 60000));
}

// All three upcoming arrivals for a service, as ISO strings.
function arrivalTimes(data) {
  const svc = data.Services && data.Services[0];
  if (!svc) return [];
  return [svc.NextBus, svc.NextBus2, svc.NextBus3]
    .map((b) => b && b.EstimatedArrival)
    .filter(Boolean);
}

// The arrival closest to `targetIso`, if any is within tolerance.
function matchArrival(times, targetIso) {
  const target = new Date(targetIso).getTime();
  let best = null;
  let bestGap = Infinity;
  for (const iso of times) {
    const gap = Math.abs(new Date(iso).getTime() - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = iso;
    }
  }
  return bestGap <= ONESHOT_MATCH_TOLERANCE_MS ? best : null;
}

// Sends one payload to every device on an account. Returns how many landed and
// removes any subscription the push service has retired.
async function pushToUser(subs, payload, errors, label) {
  let sent = 0;
  for (const sub of subs) {
    if (!sub.subscription || !sub.subscription.endpoint) continue;
    try {
      await webpush.sendNotification(sub.subscription, payload);
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        try {
          await dropSub(sub.id);
        } catch (e) {
          errors.push(`Drop sub ${sub.device_id}: ${e.message}`);
        }
      } else {
        errors.push(`Push ${label}/${sub.device_id}: ${err.message}`);
      }
    }
  }
  return sent;
}

module.exports = async (req, res) => {
  const auth = req.headers.authorization || "";
  const okAuth =
    (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) ||
    !!req.headers["x-vercel-cron"];
  if (!okAuth) return res.status(401).json({ error: "Unauthorized" });

  // Diagnostic mode: check env vars + DB connectivity without firing notifications.
  // Hit /api/check-reminders?probe=1 (with auth header) to debug config issues.
  if (req.query.probe === "1") {
    const checks = {
      LTA_API_KEY: !!LTA_KEY,
      VAPID_PUBLIC_KEY: !!process.env.VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: !!process.env.VAPID_PRIVATE_KEY,
      VAPID_SUBJECT: !!process.env.VAPID_SUBJECT,
      SUPABASE_URL: !!SB_URL,
      SUPABASE_ANON_KEY: !!process.env.SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      CRON_SECRET: !!CRON_SECRET,
    };
    let dbRows = null;
    let dbError = null;
    try {
      const rows = await getReminders();
      dbRows = Array.isArray(rows) ? rows.length : rows;
    } catch (e) {
      dbError = e.message;
    }
    const allOk = !dbError && Object.values(checks).every(Boolean);
    return res.json({ ok: allOk, checks, dbRows, dbError });
  }

  if (!LTA_KEY) return res.status(400).json({ error: "LTA_API_KEY not set" });
  if (!vapidReady()) return res.status(400).json({ error: "VAPID keys not set" });

  const sgt = new Date(Date.now() + 8 * 3600 * 1000);
  const nowMins = sgt.getUTCHours() * 60 + sgt.getUTCMinutes();
  const todayDow = sgt.getUTCDay();
  const now = Date.now();

  let reminders;
  let subs;
  try {
    [reminders, subs] = await Promise.all([getReminders(), getSubs()]);
  } catch (e) {
    return res.status(500).json({ error: "DB read failed", details: e.message });
  }

  const subsByUser = new Map();
  for (const s of subs || []) {
    if (!subsByUser.has(s.user_id)) subsByUser.set(s.user_id, []);
    subsByUser.get(s.user_id).push(s);
  }

  let sent = 0;
  let checked = 0;
  let expired = 0;
  const errors = [];

  // A recurring reminder: fires inside a time-of-day window, on the chosen
  // days, at most once an hour.
  async function runScheduled(row, userSubs) {
    const r = row.payload || {};
    const notifyState = row.notify_state || {};

    if (!r.enabled || !r.time) return;
    if (Array.isArray(r.days) && r.days.length && !r.days.includes(todayDow)) return;
    const [h, m] = r.time.split(":").map(Number);
    const targetMins = h * 60 + m;
    if (nowMins < targetMins - 30 || nowMins > targetMins + 10) return;

    if (now - (notifyState.lastFired || 0) < COOLDOWNS.scheduled) return;

    checked++;
    let min;
    try {
      min = await fetchArrivalMin(r.stop, r.service);
    } catch (e) {
      errors.push(`LTA ${r.stop}/${r.service}: ${e.message}`);
      return;
    }
    if (min === null || min > (r.leadMin || 5)) return;

    const payload = JSON.stringify({
      title: `Bus ${r.service} arriving in ${min} min!`,
      body: `${r.nickname || "Departure reminder"} — head to stop ${r.stop}`,
      tag: `bb-dep-${row.id}`,
      url: "/",
    });

    const delivered = await pushToUser(userSubs, payload, errors, row.id);
    if (delivered === 0) return;
    sent += delivered;

    try {
      await saveReminder(row.id, { notify_state: { ...notifyState, lastFired: now } });
    } catch (e) {
      errors.push(`DB save ${row.id}: ${e.message}`);
    }
  }

  // A one-shot: no time window and no day filter — it follows one named
  // vehicle by its arrival time, re-anchoring as LTA's estimate drifts, and
  // deletes itself when that bus arrives.
  async function runOneShot(row, userSubs) {
    const r = row.payload || {};
    const notifyState = row.notify_state || {};
    if (!r.stop || !r.service || !r.targetArrival) return;

    checked++;
    let times;
    try {
      times = arrivalTimes(await fetchArrivals(r.stop, r.service));
    } catch (e) {
      errors.push(`LTA ${r.stop}/${r.service}: ${e.message}`);
      return;
    }

    const matched = matchArrival(times, r.targetArrival);
    if (!matched) {
      // No candidate arrival. Either LTA is briefly empty (keep waiting) or
      // the bus is long past (give up, so it can't sit here forever).
      if (now - new Date(r.targetArrival).getTime() > ONESHOT_ABANDON_MS) {
        try {
          await deleteReminder(row.id);
          expired++;
        } catch (e) {
          errors.push(`DB delete ${row.id}: ${e.message}`);
        }
      }
      return;
    }

    const min = Math.max(0, Math.round((new Date(matched) - now) / 60000));
    const arrived = min <= 1;
    const fired = notifyState.firedCount || 0;
    const cooledDown = now - (notifyState.lastFired || 0) >= COOLDOWNS.oneshot;

    // The arrival alert always goes out, cooldown or not — it's the one the
    // whole reminder exists for, and it's also the last.
    if (!arrived && (!cooledDown || fired >= ONESHOT_MAX_FIRES)) {
      if (matched !== r.targetArrival) {
        try {
          await saveReminder(row.id, { payload: { ...r, targetArrival: matched } });
        } catch (e) {
          errors.push(`DB save ${row.id}: ${e.message}`);
        }
      }
      return;
    }

    // A token, not a session: the notification's Dismiss button is handled in
    // the service worker, which has no access token to present.
    const dismissToken = notifyState.dismissToken || crypto.randomBytes(16).toString("hex");

    const payload = JSON.stringify({
      title: arrived
        ? `Bus ${r.service} is arriving!`
        : `Bus ${r.service} in ${min} min`,
      body: arrived
        ? `It's pulling in at stop ${r.stop}.`
        : `Tracking it to stop ${r.stop}. Tap Dismiss to stop these alerts.`,
      tag: `bb-oneshot-${row.id}`,
      url: "/",
      reminderId: row.id,
      dismissToken,
      actions: arrived ? [] : [{ action: "dismiss", title: "Dismiss" }],
    });

    const delivered = await pushToUser(userSubs, payload, errors, row.id);
    sent += delivered;

    const nextFired = fired + 1;
    try {
      if (arrived || nextFired >= ONESHOT_MAX_FIRES) {
        await deleteReminder(row.id);
        expired++;
      } else {
        await saveReminder(row.id, {
          payload: { ...r, targetArrival: matched, firedCount: nextFired },
          notify_state: { ...notifyState, lastFired: now, firedCount: nextFired, dismissToken },
        });
      }
    } catch (e) {
      errors.push(`DB save ${row.id}: ${e.message}`);
    }
  }

  // Reminders are independent of one another, so they all run in parallel.
  await Promise.all(
    (reminders || []).map(async (row) => {
      const userSubs = subsByUser.get(row.user_id) || [];
      if (userSubs.length === 0) return;
      if (row.type === "scheduled") return runScheduled(row, userSubs);
      if (row.type === "oneshot") return runOneShot(row, userSubs);
    })
  );

  // Ride tracking rides along on the same minute tick, so one external pinger
  // drives both. /api/track-rides exists as its own endpoint too, for anyone
  // who wants it on a separate schedule.
  let rides = null;
  try {
    rides = await trackRides();
    errors.push(...rides.errors);
  } catch (e) {
    errors.push(`Ride tracking: ${e.message}`);
  }

  // Rail disruption alerts poll on the same tick, for the same reason.
  let trains = null;
  try {
    trains = await checkTrainAlerts();
    errors.push(...trains.errors);
  } catch (e) {
    errors.push(`Train alerts: ${e.message}`);
  }

  res.json({
    ok: true,
    reminders: (reminders || []).length,
    devices: (subs || []).length,
    checked,
    sent,
    expired,
    rides: rides ? { tracked: rides.rides, sent: rides.sent, ended: rides.ended } : null,
    trains: trains ? { changed: trains.changed, disrupted: !!trains.disrupted, sent: trains.sent } : null,
    errors,
  });
};
