const CACHE = "bus-buddy-v4";
const ASSETS = ["/", "/app.js", "/manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("push", (e) => {
  let payload = {};
  try {
    payload = e.data ? e.data.json() : {};
  } catch {
    payload = { title: "Bus Buddy", body: e.data ? e.data.text() : "" };
  }
  const title = payload.title || "Bus Buddy";
  const opts = {
    body: payload.body || "",
    icon:
      "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='80' font-size='80'>🚌</text></svg>",
    badge:
      "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='80' font-size='80'>🚌</text></svg>",
    requireInteraction: true,
    vibrate: [200, 100, 200, 100, 400],
    tag: payload.tag || "bus-buddy-alert",
    renotify: true,
    data: { url: payload.url || "/" },
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      if (list.length > 0) return list[0].focus();
      return clients.openWindow("/");
    })
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
