const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_API = `https://api.telegram.org/bot${TOKEN}`;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_ANON_KEY;
const SB_HEADERS = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=minimal",
};

async function sendMessage(chatId, text) {
  await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

async function getModes() {
  const res = await fetch(`${SB_URL}/rest/v1/modes?id=eq.1&select=data`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  const rows = await res.json();
  return rows[0]?.data || [];
}

async function setModes(modes) {
  await fetch(`${SB_URL}/rest/v1/modes?id=eq.1`, {
    method: "PATCH",
    headers: SB_HEADERS,
    body: JSON.stringify({ data: modes }),
  });
}

async function getSession(chatId) {
  const res = await fetch(
    `${SB_URL}/rest/v1/tg_sessions?chat_id=eq.${chatId}&select=data,updated_at`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
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
  await fetch(`${SB_URL}/rest/v1/tg_sessions`, {
    method: "POST",
    headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ chat_id: chatId, data, updated_at: new Date().toISOString() }),
  });
}

async function delSession(chatId) {
  await fetch(`${SB_URL}/rest/v1/tg_sessions?chat_id=eq.${chatId}`, {
    method: "DELETE",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
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
      "/newmode – Create a journey mode\n" +
      "/modes – List saved modes\n" +
      "/deletemode &lt;number&gt; – Delete a mode\n" +
      "/cancel – Cancel current operation"
    );
    return res.status(200).end();
  }

  if (text === "/modes") {
    const modes = await getModes();
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
    const modes = await getModes();
    if (idx < 0 || idx >= modes.length) {
      await sendMessage(chatId, `Invalid number. You have ${modes.length} mode(s). Use /modes to see the list.`);
    } else {
      const deleted = modes.splice(idx, 1)[0];
      await setModes(modes);
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
    const modes = await getModes();
    modes.push(mode);
    await setModes(modes);
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
