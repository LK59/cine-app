const CACHE_NAME = "cine-app-v5";
const PRECACHE = ["/manifest.json", "/icon-192.png", "/icon-512.png", "/offline.html"];

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

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/")) return;

  // Cache-first: Next.js fingerprints these filenames by content hash (the
  // hash changes if the content does), so a cached copy is never stale —
  // serving it straight away avoids a redundant network round-trip on every
  // navigation for JS/CSS chunks that never change between deploys.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        });
      })
    );
    return;
  }

  // Network-first for everything else: this is a live dashboard, HTML/data
  // must stay fresh. We only fall back to cache when the network is
  // unreachable (offline) — and for a navigation that was never cached
  // either, fall back further to a static offline page instead of failing.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => {
          if (cached) return cached;
          if (event.request.mode === "navigate") return caches.match("/offline.html");
          return undefined;
        })
      )
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

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      // Badging API: not supported on iOS Safari today, but feature-detected
      // so this stays inert there and picks up support automatically if/when
      // Apple ships it, plus it already works on Android/desktop Chrome.
      self.navigator.setAppBadge
        ? self.registration.getNotifications().then((n) => self.navigator.setAppBadge(n.length))
        : Promise.resolve(),
    ])
  );
});

self.addEventListener("notificationclose", () => {
  if (!self.navigator.setAppBadge) return;
  self.registration.getNotifications().then((n) => {
    if (n.length > 0) self.navigator.setAppBadge(n.length);
    else if (self.navigator.clearAppBadge) self.navigator.clearAppBadge();
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? "/";
  event.waitUntil(
    Promise.all([
      clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
        const existing = windowClients.find((c) => c.url.includes(self.location.origin));
        if (existing) return existing.focus().then((c) => c.navigate(url));
        return clients.openWindow(url);
      }),
      self.registration.getNotifications().then((n) => {
        if (!self.navigator.setAppBadge) return;
        if (n.length > 0) return self.navigator.setAppBadge(n.length);
        if (self.navigator.clearAppBadge) return self.navigator.clearAppBadge();
      }),
    ])
  );
});
