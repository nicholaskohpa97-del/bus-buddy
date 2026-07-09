const CACHE = "fasttrack-v1";
const ASSETS = [
  "/", "/index.html", "/manifest.json",
  "/main.js", "/state.js", "/supabase.js", "/ui.js", "/env.js",
  "/fasting.js", "/diary.js", "/weight.js", "/settings.js",
  "/charts.js", "/pushclient.js",
  "/icon-192.svg", "/icon-512.svg",
];
const ICON = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='80' font-size='80'>⏳</text></svg>";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("push", (e) => {
  let payload = {};
  try { payload = e.data ? e.data.json() : {}; }
  catch { payload = { title: "FastTrack", body: e.data ? e.data.text() : "" }; }
  const opts = {
    body: payload.body || "",
    icon: ICON, badge: ICON,
    requireInteraction: false,
    vibrate: [200, 100, 200],
    tag: payload.tag || "fasttrack",
    renotify: true,
    data: { url: payload.url || "/" },
  };
  e.waitUntil(self.registration.showNotification(payload.title || "FastTrack", opts));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    if (list.length) return list[0].focus();
    return clients.openWindow(e.notification.data?.url || "/");
  }));
});

// Network-first for app files (so updates land), cache fallback offline. Skip API.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api/") || e.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then((m) => m || caches.match("/")))
  );
});
