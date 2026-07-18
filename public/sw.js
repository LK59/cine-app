const CACHE_NAME = "cine-app-v3";
const PRECACHE = ["/manifest.json", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first: this is a live dashboard, data must stay fresh. We only fall
// back to cache (static assets) when the network is unreachable (offline).
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// ─── Push notifications ───────────────────────────────────────────────────────

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch {}

  const title = data.title ?? "Cine App";
  const options = {
    body: data.body ?? "",
    icon: data.icon ?? "/icon-192.png",
    badge: "/icon-192.png",
    tag: data.tag ?? "cine-app",
    data: { url: data.url ?? "/" },
    vibrate: [200, 100, 200],
    requireInteraction: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      const existing = windowClients.find((c) => c.url.includes(self.location.origin));
      if (existing) return existing.focus().then((c) => c.navigate(url));
      return clients.openWindow(url);
    })
  );
});
