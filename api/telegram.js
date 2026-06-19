const { kv } = require("@vercel/kv");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_API = `https://api.telegram.org/bot${TOKEN}`;

async function sendMessage(chatId, text) {
  await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
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
  const stateKey = `tg_state_${chatId}`;

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
    const modes = (await kv.get("modes")) || [];
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
    const modes = (await kv.get("modes")) || [];
    if (idx < 0 || idx >= modes.length) {
      await sendMessage(chatId, `Invalid number. You have ${modes.length} mode(s). Use /modes to see the list.`);
    } else {
      const deleted = modes.splice(idx, 1)[0];
      await kv.set("modes", modes);
      await sendMessage(chatId, `✅ Deleted mode "<b>${deleted.name}</b>".`);
    }
    await kv.del(stateKey);
    return res.status(200).end();
  }

  if (text === "/newmode") {
    await kv.set(stateKey, { step: 0, data: {} }, { ex: 600 });
    await sendMessage(chatId, `Let's create a new journey mode! 🚌\n\n${STEPS[0].prompt}`);
    return res.status(200).end();
  }

  if (text === "/cancel") {
    await kv.del(stateKey);
    await sendMessage(chatId, "Cancelled.");
    return res.status(200).end();
  }

  // Conversation flow
  const conv = await kv.get(stateKey);
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
      await sendMessage(chatId, "Please enter a radius between 100 and 1000 metres, or <code>skip</code> for the default (300m).");
      return res.status(200).end();
    }
  }

  conv.data[step.key] = value;
  conv.step += 1;

  if (conv.step < STEPS.length) {
    await kv.set(stateKey, conv, { ex: 600 });
    await sendMessage(chatId, STEPS[conv.step].prompt);
  } else {
    await kv.del(stateKey);
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
    const modes = (await kv.get("modes")) || [];
    modes.push(mode);
    await kv.set("modes", modes);
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
