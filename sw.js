const CACHE = "bus-buddy-v12";
const ASSETS = ["/", "/app.js", "/auth.js", "/i18n.js", "/manifest.json"];

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
    actions: Array.isArray(payload.actions) ? payload.actions : [],
    // Carried through to notificationclick — a one-shot's Dismiss button needs
    // the reminder id and its token, and the SW has no other way to get them.
    data: {
      url: payload.url || "/",
      reminderId: payload.reminderId || null,
      dismissToken: payload.dismissToken || null,
    },
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener("notificationclick", (e) => {
  const data = e.notification.data || {};
  e.notification.close();

  // "Stop telling me about this bus." Authorised by the token that came with
  // the notification, since there's no session available out here.
  if (e.action === "dismiss") {
    if (!data.reminderId || !data.dismissToken) return;
    e.waitUntil(
      fetch("/api/dismiss-reminder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reminderId: data.reminderId,
          dismissToken: data.dismissToken,
        }),
      }).catch(() => {})
    );
    return;
  }

  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      if (list.length > 0) return list[0].focus();
      return clients.openWindow(data.url || "/");
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
