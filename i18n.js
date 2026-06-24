// ── Lightweight i18n for Bus Buddy ──
// Covers the static UI chrome (nav, headers, settings, modals, buttons).
// Strings are keyed; elements opt in via data-i18n / data-i18n-ph attributes.
// Singapore's four official languages: English, 中文, Bahasa Melayu, Tamil.

const I18N = {
  en: {
    "app.subtitle": "Singapore bus arrivals",
    "nav.home": "Home",
    "nav.search": "Search",
    "nav.map": "Map",
    "nav.favourites": "Favourites",
    "nav.reminders": "Reminders",
    "dash.yourStops": "Your Stops",
    "dash.refreshAll": "Refresh All",
    "dash.departureReminders": "Departure Reminders",
    "dash.dropoffAlerts": "Drop-off Alerts",
    "common.manage": "Manage",
    "search.placeholder": "Search stop name, road or code",
    "search.nearby": "Nearby",
    "settings.title": "Settings",
    "settings.language": "Language",
    "settings.apiKey": "LTA DataMall API Key",
    "settings.refresh": "Auto-refresh interval (seconds)",
    "settings.lead": "Departure reminder lead time (minutes)",
    "settings.cancel": "Cancel",
    "settings.save": "Save",
    "reminders.journeyModes": "Journey Modes",
    "reminders.addMode": "+ Add Journey Mode",
    "reminders.testAlert": "🔔 Test Alert",
    "reminders.addDeparture": "+ Add Departure Reminder",
    "reminders.addDropoff": "+ Add Drop-off Alert",
  },
  zh: {
    "app.subtitle": "新加坡巴士到站时间",
    "nav.home": "主页",
    "nav.search": "搜索",
    "nav.map": "地图",
    "nav.favourites": "收藏",
    "nav.reminders": "提醒",
    "dash.yourStops": "你的车站",
    "dash.refreshAll": "全部刷新",
    "dash.departureReminders": "出发提醒",
    "dash.dropoffAlerts": "下车提醒",
    "common.manage": "管理",
    "search.placeholder": "搜索车站名称、道路或编号",
    "search.nearby": "附近",
    "settings.title": "设置",
    "settings.language": "语言",
    "settings.apiKey": "LTA DataMall API 密钥",
    "settings.refresh": "自动刷新间隔（秒）",
    "settings.lead": "出发提醒提前时间（分钟）",
    "settings.cancel": "取消",
    "settings.save": "保存",
    "reminders.journeyModes": "行程模式",
    "reminders.addMode": "+ 添加行程模式",
    "reminders.testAlert": "🔔 测试提醒",
    "reminders.addDeparture": "+ 添加出发提醒",
    "reminders.addDropoff": "+ 添加下车提醒",
  },
  ms: {
    "app.subtitle": "Ketibaan bas Singapura",
    "nav.home": "Utama",
    "nav.search": "Cari",
    "nav.map": "Peta",
    "nav.favourites": "Kegemaran",
    "nav.reminders": "Peringatan",
    "dash.yourStops": "Hentian Anda",
    "dash.refreshAll": "Muat Semula Semua",
    "dash.departureReminders": "Peringatan Berlepas",
    "dash.dropoffAlerts": "Amaran Turun",
    "common.manage": "Urus",
    "search.placeholder": "Cari nama hentian, jalan atau kod",
    "search.nearby": "Berdekatan",
    "settings.title": "Tetapan",
    "settings.language": "Bahasa",
    "settings.apiKey": "Kunci API LTA DataMall",
    "settings.refresh": "Selang muat semula automatik (saat)",
    "settings.lead": "Masa awalan peringatan berlepas (minit)",
    "settings.cancel": "Batal",
    "settings.save": "Simpan",
    "reminders.journeyModes": "Mod Perjalanan",
    "reminders.addMode": "+ Tambah Mod Perjalanan",
    "reminders.testAlert": "🔔 Uji Amaran",
    "reminders.addDeparture": "+ Tambah Peringatan Berlepas",
    "reminders.addDropoff": "+ Tambah Amaran Turun",
  },
  ta: {
    "app.subtitle": "சிங்கப்பூர் பேருந்து வருகை",
    "nav.home": "முகப்பு",
    "nav.search": "தேடல்",
    "nav.map": "வரைபடம்",
    "nav.favourites": "பிடித்தவை",
    "nav.reminders": "நினைவூட்டல்கள்",
    "dash.yourStops": "உங்கள் நிறுத்தங்கள்",
    "dash.refreshAll": "அனைத்தையும் புதுப்பி",
    "dash.departureReminders": "புறப்பாடு நினைவூட்டல்கள்",
    "dash.dropoffAlerts": "இறங்கும் எச்சரிக்கைகள்",
    "common.manage": "நிர்வகி",
    "search.placeholder": "நிறுத்தப் பெயர், சாலை அல்லது குறியீட்டைத் தேடு",
    "search.nearby": "அருகில்",
    "settings.title": "அமைப்புகள்",
    "settings.language": "மொழி",
    "settings.apiKey": "LTA DataMall API சாவி",
    "settings.refresh": "தானியங்கி புதுப்பிப்பு இடைவெளி (வினாடிகள்)",
    "settings.lead": "புறப்பாடு நினைவூட்டல் முன்னறிவிப்பு (நிமிடங்கள்)",
    "settings.cancel": "ரத்து",
    "settings.save": "சேமி",
    "reminders.journeyModes": "பயண முறைகள்",
    "reminders.addMode": "+ பயண முறையைச் சேர்",
    "reminders.testAlert": "🔔 எச்சரிக்கையைச் சோதி",
    "reminders.addDeparture": "+ புறப்பாடு நினைவூட்டலைச் சேர்",
    "reminders.addDropoff": "+ இறங்கும் எச்சரிக்கையைச் சேர்",
  },
};

const LANG_NAMES = { en: "English", zh: "中文", ms: "Bahasa Melayu", ta: "தமிழ்" };
const LANG_KEY = "bb_lang";

let currentLang =
  localStorage.getItem(LANG_KEY) ||
  (navigator.language || "en").slice(0, 2).toLowerCase();
if (!I18N[currentLang]) currentLang = "en";

function t(key) {
  return (I18N[currentLang] && I18N[currentLang][key]) || I18N.en[key] || key;
}

function applyTranslations() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
    el.setAttribute("placeholder", t(el.getAttribute("data-i18n-ph")));
  });
  document.documentElement.setAttribute("lang", currentLang);
}

function setLanguage(lang) {
  if (!I18N[lang]) lang = "en";
  currentLang = lang;
  localStorage.setItem(LANG_KEY, lang);
  applyTranslations();
}

document.addEventListener("DOMContentLoaded", applyTranslations);
