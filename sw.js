// sw.js — Fleet Manager Service Worker
const CACHE_VERSION = "fleet-v2";

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Network-first strategija
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// ── PUSH NOTIFIKACIJE ─────────────────────────────────────────
self.addEventListener("push", (e) => {
  if (!e.data) return;
  try {
    const data = e.data.json();
    e.waitUntil(
      self.registration.showNotification(data.title || "Fleet Manager", {
        body: data.body || "",
        icon: data.icon || "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        tag: data.tag || "fleet-notification",
        requireInteraction: false,
      })
    );
  } catch {}
});

// Poruke od glavnog threada (Web Push bez servera)
self.addEventListener("message", (e) => {
  if (e.data?.type === "SHOW_NOTIFICATION") {
    self.registration.showNotification(e.data.title || "Fleet Manager", {
      body: e.data.body || "",
      icon: e.data.icon || "/icons/icon-192.png",
      tag: "fleet-notification",
    });
  }
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: "window" }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && "focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow("/");
    })
  );
});
