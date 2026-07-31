const crypto = require("crypto");
const webpush = require("web-push");

const { SB_URL, fetchWithTimeout, serviceHeaders } = require("./_auth");

const LTA_KEY = process.env.LTA_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

// LTA DataMall's TrainServiceAlerts is the only official real-time rail
// disruption feed: Status 1 = normal, 2 = disrupted, with the affected Line
// and stations. It updates ad-hoc, so this polls and diffs rather than
// assuming a schedule.
//
// There is no equivalent for buses. LTA publishes no bus-disruption API at
// all. The nearest thing is TrafficIncidents, which is road-level (vehicle
// breakdowns, road blocks) rather than service-level, and everything else —
// SMRT on X, SBS Transit's disruption page, LTA's Telegram — is scrape-only:
// fragile and questionable under their terms. So bus alerts are deliberately
// out of scope, and the settings UI says so plainly rather than implying
// they're covered.
const ALERTS_URL =
  "https://datamall2.mytransport.sg/ltaodataservice/TrainServiceAlerts";

const STATE_KEY = "train_alerts_hash";

function vapidReady() {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:alerts@bus-buddy.app",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  return true;
}

const LINE_NAMES = {
  NSL: "North South Line",
  EWL: "East West Line",
  CCL: "Circle Line",
  DTL: "Downtown Line",
  NEL: "North East Line",
  TEL: "Thomson–East Coast Line",
  BPL: "Bukit Panjang LRT",
  SLRT: "Sengkang LRT",
  PLRT: "Punggol LRT",
  CGL: "Changi Airport Branch",
  CEL: "Circle Line Extension",
};

async function fetchAlerts() {
  const res = await fetchWithTimeout(ALERTS_URL, {
    headers: { AccountKey: LTA_KEY, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`LTA ${res.status}`);
  const data = await res.json();
  return data.value || {};
}

async function readState() {
  const res = await fetchWithTimeout(
    `${SB_URL}/rest/v1/kv?key=eq.${STATE_KEY}&select=value`,
    { headers: serviceHeaders() }
  );
  if (!res.ok) return {};
  const row = (await res.json())[0];
  return row?.value || {};
}

async function writeState(value) {
  await fetchWithTimeout(`${SB_URL}/rest/v1/kv?on_conflict=key`, {
    method: "POST",
    headers: serviceHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({
      key: STATE_KEY,
      value,
      updated_at: new Date().toISOString(),
    }),
  });
}

async function getSubscribers() {
  // Everyone with a push target and a preference blob. `data.alertLines` holds
  // the lines they follow; missing means "the ones touching my favourites",
  // which is computed client-side and written into the same field.
  const [prefsRes, subsRes] = await Promise.all([
    fetchWithTimeout(`${SB_URL}/rest/v1/user_prefs?select=user_id,data`, {
      headers: serviceHeaders(),
    }),
    fetchWithTimeout(`${SB_URL}/rest/v1/push_subs?select=id,user_id,device_id,subscription`, {
      headers: serviceHeaders(),
    }),
  ]);
  if (!prefsRes.ok) throw new Error(`Supabase prefs ${prefsRes.status}`);
  if (!subsRes.ok) throw new Error(`Supabase subs ${subsRes.status}`);

  const prefs = new Map((await prefsRes.json()).map((r) => [r.user_id, r.data || {}]));
  const byUser = new Map();
  for (const s of await subsRes.json()) {
    if (!s.subscription || !s.subscription.endpoint) continue;
    if (!byUser.has(s.user_id)) byUser.set(s.user_id, []);
    byUser.get(s.user_id).push(s);
  }
  return [...byUser.entries()].map(([userId, subs]) => ({
    userId,
    subs,
    lines: prefs.get(userId)?.alertLines || null,
  }));
}

function affectedLines(alerts) {
  const set = new Set();
  for (const msg of alerts.AffectedSegments || []) {
    if (msg.Line) set.add(msg.Line);
  }
  return [...set];
}

// A stable fingerprint of the current disruption picture. Diffing on this is
// what stops a minute-by-minute poll from re-pushing the same outage sixty
// times an hour.
function fingerprint(alerts) {
  const payload = {
    status: alerts.Status,
    segments: (alerts.AffectedSegments || [])
      .map((s) => `${s.Line}|${s.Direction}|${s.Stations}`)
      .sort(),
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function describe(alerts) {
  const segments = alerts.AffectedSegments || [];
  if (segments.length === 0) return "Service disruption reported.";
  return segments
    .slice(0, 3)
    .map((s) => {
      const line = LINE_NAMES[s.Line] || s.Line;
      const stations = (s.Stations || "").split(",").filter(Boolean).length;
      return stations
        ? `${line}: ${stations} station${stations === 1 ? "" : "s"} affected`
        : line;
    })
    .join(" · ");
}

async function pushTo(subs, payload, errors) {
  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub.subscription, payload);
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await fetchWithTimeout(`${SB_URL}/rest/v1/push_subs?id=eq.${sub.id}`, {
          method: "DELETE",
          headers: serviceHeaders({ Prefer: "return=minimal" }),
        }).catch(() => {});
      } else {
        errors.push(`Push ${sub.device_id}: ${err.message}`);
      }
    }
  }
  return sent;
}

// Shared by this endpoint and by api/check-reminders.js, so the same
// once-a-minute pinger drives reminders, ride tracking and rail alerts.
// `override` supplies a mocked payload instead of polling LTA.
async function checkTrainAlerts(override) {
  const errors = [];
  const alerts = override || (await fetchAlerts());

  const hash = fingerprint(alerts);
  const prev = await readState().catch(() => ({}));
  if (prev.hash === hash) {
    return { changed: false, status: alerts.Status, sent: 0, errors };
  }

  const disrupted = Number(alerts.Status) === 2;
  const lines = affectedLines(alerts);
  const recovered = !disrupted && prev.disrupted === true;

  // Nothing to say: not disrupted now, and wasn't before. Record the hash so
  // the next poll compares against the current picture.
  if (!disrupted && !recovered) {
    await writeState({ hash, disrupted: false, lines: [] }).catch(() => {});
    return { changed: true, status: alerts.Status, sent: 0, errors };
  }

  const title = disrupted ? "⚠️ Train service disruption" : "✅ Train service restored";
  const body = disrupted
    ? describe(alerts)
    : `${(prev.lines || []).map((l) => LINE_NAMES[l] || l).join(", ") || "Rail service"} is running normally again.`;
  const payload = JSON.stringify({ title, body, tag: "bb-train-alert", url: "/" });

  // A recovery notice goes to whoever was told about the outage, not to
  // whoever happens to follow the lines named in the (now empty) payload.
  const relevantLines = disrupted ? lines : prev.lines || [];

  let sent = 0;
  let notified = 0;
  try {
    for (const user of await getSubscribers()) {
      // null = follow everything; an explicit list narrows it.
      if (Array.isArray(user.lines) && relevantLines.length > 0) {
        if (!relevantLines.some((l) => user.lines.includes(l))) continue;
      }
      if (Array.isArray(user.lines) && user.lines.length === 0) continue;
      notified++;
      sent += await pushTo(user.subs, payload, errors);
    }
  } catch (e) {
    errors.push(e.message);
  }

  await writeState({ hash, disrupted, lines: disrupted ? lines : [] }).catch((e) =>
    errors.push(`State save: ${e.message}`)
  );

  return {
    changed: true,
    status: alerts.Status,
    disrupted,
    lines: relevantLines,
    users: notified,
    sent,
    errors,
  };
}

module.exports = async (req, res) => {
  const auth = req.headers.authorization || "";
  const okAuth =
    (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) ||
    !!req.headers["x-vercel-cron"];
  if (!okAuth) return res.status(401).json({ error: "Unauthorized" });

  if (!LTA_KEY) return res.status(400).json({ error: "LTA_API_KEY not set" });
  if (!vapidReady()) return res.status(400).json({ error: "VAPID keys not set" });

  try {
    // A mocked payload can be POSTed in to exercise the diff-and-push path —
    // real disruptions can't be summoned on demand, and this is the half of
    // the feature worth being sure about.
    const override = req.method === "POST" && req.body && req.body.value ? req.body.value : null;
    return res.json({ ok: true, ...(await checkTrainAlerts(override)) });
  } catch (e) {
    return res.status(502).json({ error: "Train alert check failed", details: e.message });
  }
};

module.exports.checkTrainAlerts = checkTrainAlerts;
