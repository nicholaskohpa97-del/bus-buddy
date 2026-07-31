const { sbUrl, serviceHeaders, fetchWithTimeout } = require("./_auth");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_API = `https://api.telegram.org/bot${TOKEN}`;

// The bot is a server-to-server webhook — there is no user JWT in the request,
// so it runs with the service key and scopes every query by the user_id that
// this chat has been linked to. An unlinked chat can't touch anyone's data.

async function sendMessage(chatId, text) {
  await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

// ── Account linking ──

async function getLinkedUser(chatId) {
  const res = await fetchWithTimeout(
    `${sbUrl()}/rest/v1/tg_links?chat_id=eq.${chatId}&select=user_id`,
    { headers: serviceHeaders() }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0]?.user_id || null;
}

// Consume a one-time code generated in the app (Settings → Connect Telegram).
async function redeemLinkCode(chatId, code) {
  const res = await fetchWithTimeout(
    `${sbUrl()}/rest/v1/tg_link_codes?code=eq.${encodeURIComponent(
      code
    )}&select=user_id,expires_at`,
    { headers: serviceHeaders() }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;

  await fetchWithTimeout(`${sbUrl()}/rest/v1/tg_links`, {
    method: "POST",
    headers: serviceHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ chat_id: String(chatId), user_id: row.user_id }),
  });
  await fetchWithTimeout(
    `${sbUrl()}/rest/v1/tg_link_codes?code=eq.${encodeURIComponent(code)}`,
    { method: "DELETE", headers: serviceHeaders() }
  );
  return row.user_id;
}

async function getModes(userId) {
  const res = await fetchWithTimeout(
    `${sbUrl()}/rest/v1/modes?user_id=eq.${userId}&select=data`,
    { headers: serviceHeaders() }
  );
  if (!res.ok) return [];
  const rows = await res.json();
  return rows[0]?.data || [];
}

async function setModes(userId, modes) {
  await fetchWithTimeout(`${sbUrl()}/rest/v1/modes`, {
    method: "POST",
    headers: serviceHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({
      user_id: userId,
      data: modes,
      updated_at: new Date().toISOString(),
    }),
  });
}

async function getSession(chatId) {
  const res = await fetchWithTimeout(
    `${sbUrl()}/rest/v1/tg_sessions?chat_id=eq.${chatId}&select=data,updated_at`,
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
  await fetchWithTimeout(`${sbUrl()}/rest/v1/tg_sessions`, {
    method: "POST",
    headers: serviceHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ chat_id: chatId, data, updated_at: new Date().toISOString() }),
  });
}

async function delSession(chatId) {
  await fetchWithTimeout(`${sbUrl()}/rest/v1/tg_sessions?chat_id=eq.${chatId}`, {
    method: "DELETE",
    headers: serviceHeaders(),
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

const STEPS = [
  { key: "name", prompt: "What would you like to call this mode?\n(e.g. <i>Going home from Beyoncé's house</i>)" },
  { key: "departureStop", prompt: "Departure bus stop code? (e.g. <code>83139</code>)" },
  { key: "service", prompt: "Bus service number? (e.g. <code>14</code>)" },
  { key: "leaveTime", prompt: "Leave by what time? (e.g. <code>18:00</code> or <code>6pm</code>)" },
  { key: "leadMin", prompt: "Alert when bus is within how many minutes? (1–30)\nSend <code>skip</code> for default (5 min)." },
  { key: "dropoffStop", prompt: "Destination bus stop code for the drop-off alert? (e.g. <code>44009</code>)" },
  { key: "dropoffRadius", prompt: "Drop-off alert radius in metres? (100–1000)\nSend <code>skip</code> for default (300m)." },
];

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  const { message } = req.body || {};
  if (!message || !message.text) return res.status(200).end();

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text === "/start" || text === "/help") {
    await sendMessage(chatId,
      "<b>Bus Buddy Bot 🚌</b>\n\n" +
      "Commands:\n" +
      "/link &lt;code&gt; – Connect your Bus Buddy account\n" +
      "/newmode – Create a journey mode\n" +
      "/modes – List saved modes\n" +
      "/deletemode &lt;number&gt; – Delete a mode\n" +
      "/cancel – Cancel current operation"
    );
    return res.status(200).end();
  }

  const linkMatch = text.match(/^\/link\s+([A-Za-z0-9]{4,12})$/);
  if (linkMatch) {
    const userId = await redeemLinkCode(chatId, linkMatch[1].toUpperCase());
    if (userId) {
      await sendMessage(chatId, "✅ Connected to your Bus Buddy account. Try /modes.");
    } else {
      await sendMessage(chatId, "That code is invalid or has expired. Generate a new one in Bus Buddy → Settings → Connect Telegram.");
    }
    return res.status(200).end();
  }

  // Everything past this point reads or writes a specific account's data.
  const linkedUser = await getLinkedUser(chatId);
  if (!linkedUser) {
    await sendMessage(chatId,
      "🔒 This chat isn't connected to a Bus Buddy account yet.\n\n" +
      "Open Bus Buddy → Settings → <b>Connect Telegram</b> to get a code, then send:\n" +
      "<code>/link YOURCODE</code>"
    );
    return res.status(200).end();
  }

  if (text === "/modes") {
    const modes = await getModes(linkedUser);
    if (modes.length === 0) {
      await sendMessage(chatId, "No journey modes saved yet. Use /newmode to create one.");
    } else {
      const list = modes
        .map((m, i) =>
          `${i + 1}. <b>${m.name}</b>\n` +
          `   🚌 Bus ${m.service} from stop ${m.departureStop}, leave by ${m.leaveTime} (${m.leadMin}min alert)\n` +
          `   📍 Drop-off: stop ${m.dropoffStop} (${m.dropoffRadius}m radius)`
        )
        .join("\n\n");
      await sendMessage(chatId, `Your journey modes:\n\n${list}\n\nUse /deletemode &lt;number&gt; to remove one.`);
    }
    return res.status(200).end();
  }

  const deleteMatch = text.match(/^\/deletemode\s+(\d+)$/);
  if (deleteMatch) {
    const idx = parseInt(deleteMatch[1]) - 1;
    const modes = await getModes(linkedUser);
    if (idx < 0 || idx >= modes.length) {
      await sendMessage(chatId, `Invalid number. You have ${modes.length} mode(s). Use /modes to see the list.`);
    } else {
      const deleted = modes.splice(idx, 1)[0];
      await setModes(linkedUser, modes);
      await sendMessage(chatId, `✅ Deleted mode "<b>${deleted.name}</b>".`);
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
      id: Date.now().toString(36),
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
    const modes = await getModes(linkedUser);
    modes.push(mode);
    await setModes(linkedUser, modes);
    await sendMessage(chatId,
      `✅ Mode "<b>${mode.name}</b>" saved!\n\n` +
      `🚌 Bus ${mode.service} from stop ${mode.departureStop}\n` +
      `⏰ Leave by ${mode.leaveTime} · alert ${mode.leadMin} min before\n` +
      `📍 Drop-off at stop ${mode.dropoffStop} · ${mode.dropoffRadius}m radius\n\n` +
      `Open the app to activate it!`
    );
  }

  return res.status(200).end();
};
