const crypto = require("crypto");

const { SB_URL, fetchWithTimeout, serviceHeaders } = require("./_auth");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_API = `https://api.telegram.org/bot${TOKEN}`;

// The bot runs without a Supabase session — a webhook body carries a chat id
// and nothing else — so every query here uses the service key and filters on a
// user_id resolved from the chat↔account pairing. Unlinked chats can't touch
// anyone's data.
async function sendMessage(chatId, text) {
  await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

async function getLinkedUser(chatId) {
  const res = await fetchWithTimeout(
    `${SB_URL}/rest/v1/tg_links?chat_id=eq.${chatId}&select=user_id`,
    { headers: serviceHeaders() }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0]?.user_id || null;
}

async function redeemLinkCode(chatId, code) {
  const res = await fetchWithTimeout(
    `${SB_URL}/rest/v1/tg_link_codes?code=eq.${encodeURIComponent(code)}&select=code,user_id,expires_at`,
    { headers: serviceHeaders() }
  );
  if (!res.ok) return null;
  const row = (await res.json())[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;

  await fetchWithTimeout(`${SB_URL}/rest/v1/tg_links?on_conflict=chat_id`, {
    method: "POST",
    headers: serviceHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({
      chat_id: chatId,
      user_id: row.user_id,
      linked_at: new Date().toISOString(),
    }),
  });
  await fetchWithTimeout(
    `${SB_URL}/rest/v1/tg_link_codes?code=eq.${encodeURIComponent(row.code)}`,
    { method: "DELETE", headers: serviceHeaders({ Prefer: "return=minimal" }) }
  );
  return row.user_id;
}

async function unlinkChat(chatId) {
  await fetchWithTimeout(`${SB_URL}/rest/v1/tg_links?chat_id=eq.${chatId}`, {
    method: "DELETE",
    headers: serviceHeaders({ Prefer: "return=minimal" }),
  });
}

async function getModes(userId) {
  const res = await fetchWithTimeout(
    `${SB_URL}/rest/v1/modes?user_id=eq.${userId}&select=id,data`,
    { headers: serviceHeaders() }
  );
  if (!res.ok) return [];
  const rows = await res.json();
  return rows.map((r) => ({ ...r.data, id: r.id }));
}

async function addMode(userId, mode) {
  await fetchWithTimeout(`${SB_URL}/rest/v1/modes`, {
    method: "POST",
    headers: serviceHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify({ id: mode.id, user_id: userId, data: mode }),
  });
}

async function deleteMode(userId, modeId) {
  await fetchWithTimeout(
    `${SB_URL}/rest/v1/modes?id=eq.${modeId}&user_id=eq.${userId}`,
    { method: "DELETE", headers: serviceHeaders({ Prefer: "return=minimal" }) }
  );
}

async function getSession(chatId) {
  const res = await fetchWithTimeout(
    `${SB_URL}/rest/v1/tg_sessions?chat_id=eq.${chatId}&select=data,updated_at`,
    { headers: serviceHeaders() }
  );
  const rows = await res.json();
  if (!rows[0]) return null;
  // Expire sessions older than 10 minutes
  const age = Date.now() - new Date(rows[0].updated_at).getTime();
  if (age > 10 * 60 * 1000) {
    await delSession(chatId);
    return null;
  }
  return rows[0].data;
}

async function setSession(chatId, data) {
  await fetchWithTimeout(`${SB_URL}/rest/v1/tg_sessions?on_conflict=chat_id`, {
    method: "POST",
    headers: serviceHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ chat_id: chatId, data, updated_at: new Date().toISOString() }),
  });
}

async function delSession(chatId) {
  await fetchWithTimeout(`${SB_URL}/rest/v1/tg_sessions?chat_id=eq.${chatId}`, {
    method: "DELETE",
    headers: serviceHeaders({ Prefer: "return=minimal" }),
  });
}

function normalizeTime(input) {
  const s = input.trim().toLowerCase();
  const m12 = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (m12) {
    let h = parseInt(m12[1]);
    const m = parseInt(m12[2] || "0");
    if (m12[3] === "pm" && h !== 12) h += 12;
    if (m12[3] === "am" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  const m24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) return `${String(parseInt(m24[1])).padStart(2, "0")}:${m24[2]}`;
  return null;
}

// Telegram messages are parse_mode: HTML, so anything the user typed back at
// us has to be escaped before it's echoed into a message.
function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const STEPS = [
  { key: "name", prompt: "What would you like to call this mode?\n(e.g. <i>Going home from Beyoncé's house</i>)" },
  { key: "departureStop", prompt: "Departure bus stop code? (e.g. <code>83139</code>)" },
  { key: "service", prompt: "Bus service number? (e.g. <code>14</code>)" },
  { key: "leaveTime", prompt: "Leave by what time? (e.g. <code>18:00</code> or <code>6pm</code>)" },
  { key: "leadMin", prompt: "Alert when bus is within how many minutes? (1–30)\nSend <code>skip</code> for default (5 min)." },
  { key: "dropoffStop", prompt: "Destination bus stop code for the drop-off alert? (e.g. <code>44009</code>)" },
  { key: "dropoffRadius", prompt: "Drop-off alert radius in metres? (100–1000)\nSend <code>skip</code> for default (300m)." },
];

const LINK_HINT =
  "This chat isn't linked to a Bus Buddy account yet.\n\n" +
  "Open the app → <b>Settings → Telegram</b> to get a link code, then send me " +
  "<code>/link YOURCODE</code>.";

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  // Telegram signs webhook deliveries with the secret token set at
  // registration time; without this check anyone who guesses the URL can
  // impersonate a linked chat and read that account's journey modes.
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret) {
    const got = req.headers["x-telegram-bot-api-secret-token"] || "";
    const a = Buffer.from(String(got));
    const b = Buffer.from(expectedSecret);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).end();
    }
  }

  const { message } = req.body || {};
  if (!message || !message.text) return res.status(200).end();

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text === "/start" || text === "/help") {
    await sendMessage(chatId,
      "<b>Bus Buddy Bot 🚌</b>\n\n" +
      "Commands:\n" +
      "/link &lt;code&gt; – Link this chat to your Bus Buddy account\n" +
      "/unlink – Disconnect this chat\n" +
      "/newmode – Create a journey mode\n" +
      "/modes – List saved modes\n" +
      "/deletemode &lt;number&gt; – Delete a mode\n" +
      "/cancel – Cancel current operation\n\n" +
      "Get your link code from the app: <b>Settings → Telegram</b>."
    );
    return res.status(200).end();
  }

  const linkMatch = text.match(/^\/link\s+([A-Za-z0-9]{4,16})$/);
  if (linkMatch) {
    const userId = await redeemLinkCode(chatId, linkMatch[1].toUpperCase());
    await sendMessage(chatId,
      userId
        ? "✅ Linked! Your journey modes now sync with your Bus Buddy account."
        : "That code isn't valid or has expired. Codes last 10 minutes — grab a fresh one from <b>Settings → Telegram</b>."
    );
    return res.status(200).end();
  }

  if (text === "/unlink") {
    await unlinkChat(chatId);
    await delSession(chatId);
    await sendMessage(chatId, "Unlinked. This chat can no longer see your journey modes.");
    return res.status(200).end();
  }

  const userId = await getLinkedUser(chatId);
  if (!userId) {
    await sendMessage(chatId, LINK_HINT);
    return res.status(200).end();
  }

  if (text === "/modes") {
    const modes = await getModes(userId);
    if (modes.length === 0) {
      await sendMessage(chatId, "No journey modes saved yet. Use /newmode to create one.");
    } else {
      const list = modes
        .map((m, i) =>
          `${i + 1}. <b>${esc(m.name)}</b>\n` +
          `   🚌 Bus ${esc(m.service)} from stop ${esc(m.departureStop)}, leave by ${esc(m.leaveTime)} (${esc(m.leadMin)}min alert)\n` +
          `   📍 Drop-off: stop ${esc(m.dropoffStop)} (${esc(m.dropoffRadius)}m radius)`
        )
        .join("\n\n");
      await sendMessage(chatId, `Your journey modes:\n\n${list}\n\nUse /deletemode &lt;number&gt; to remove one.`);
    }
    return res.status(200).end();
  }

  const deleteMatch = text.match(/^\/deletemode\s+(\d+)$/);
  if (deleteMatch) {
    const idx = parseInt(deleteMatch[1]) - 1;
    const modes = await getModes(userId);
    if (idx < 0 || idx >= modes.length) {
      await sendMessage(chatId, `Invalid number. You have ${modes.length} mode(s). Use /modes to see the list.`);
    } else {
      const target = modes[idx];
      await deleteMode(userId, target.id);
      await sendMessage(chatId, `✅ Deleted mode "<b>${esc(target.name)}</b>".`);
    }
    await delSession(chatId);
    return res.status(200).end();
  }

  if (text === "/newmode") {
    await setSession(chatId, { step: 0, data: {} });
    await sendMessage(chatId, `Let's create a new journey mode! 🚌\n\n${STEPS[0].prompt}`);
    return res.status(200).end();
  }

  if (text === "/cancel") {
    await delSession(chatId);
    await sendMessage(chatId, "Cancelled.");
    return res.status(200).end();
  }

  // Conversation flow
  const conv = await getSession(chatId);
  if (!conv) {
    await sendMessage(chatId, "Use /newmode to create a journey mode, or /help for all commands.");
    return res.status(200).end();
  }

  const step = STEPS[conv.step];
  let value = text;
  const isSkip = /^(skip|default|-)$/i.test(text);

  if (step.key === "leaveTime") {
    value = normalizeTime(text);
    if (!value) {
      await sendMessage(chatId, "Couldn't parse that time. Try something like <code>18:00</code> or <code>6pm</code>.");
      return res.status(200).end();
    }
  } else if (step.key === "leadMin") {
    value = isSkip ? 5 : parseInt(text);
    if (isNaN(value) || value < 1 || value > 30) {
      await sendMessage(chatId, "Please enter a number between 1 and 30, or <code>skip</code> for the default (5 min).");
      return res.status(200).end();
    }
  } else if (step.key === "dropoffRadius") {
    value = isSkip ? 300 : parseInt(text);
    if (isNaN(value) || value < 100 || value > 1000) {
      await sendMessage(chatId, "Please enter a radius between 100 and 1000 metres, or <code>skip</code> for default (300m).");
      return res.status(200).end();
    }
  }

  conv.data[step.key] = value;
  conv.step += 1;

  if (conv.step < STEPS.length) {
    await setSession(chatId, conv);
    await sendMessage(chatId, STEPS[conv.step].prompt);
  } else {
    await delSession(chatId);
    const d = conv.data;
    const mode = {
      id: crypto.randomUUID(),
      name: d.name,
      departureStop: d.departureStop,
      service: d.service,
      leaveTime: d.leaveTime,
      leadMin: d.leadMin,
      dropoffStop: d.dropoffStop,
      dropoffRadius: d.dropoffRadius,
      dropoffLat: null,
      dropoffLng: null,
      active: false,
      createdVia: "telegram",
    };
    await addMode(userId, mode);
    await sendMessage(chatId,
      `✅ Mode "<b>${esc(mode.name)}</b>" saved!\n\n` +
      `🚌 Bus ${esc(mode.service)} from stop ${esc(mode.departureStop)}\n` +
      `⏰ Leave by ${esc(mode.leaveTime)} · alert ${esc(mode.leadMin)} min before\n` +
      `📍 Drop-off at stop ${esc(mode.dropoffStop)} · ${esc(mode.dropoffRadius)}m radius\n\n` +
      `Open the app to activate it!`
    );
  }

  return res.status(200).end();
};
