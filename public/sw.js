// v8: flushes any RSC payloads cached by earlier versions (see the fetch handler — they are no
// longer intercepted at all, but ones already stored would otherwise linger).
const CACHE_NAME = "cine-app-v8";
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

  // Next's client-side navigations don't fetch the page — they fetch the target route's RSC
  // payload, marked by an "RSC" request header and a ?_rsc= cache-buster. Left to the branch
  // below, those were both cached (keyed by URL, so a payload from a previous build could be
  // handed to a client running the new one) and, worse, wrapped on failure: a rejected fetch
  // came back as this worker's synthetic 504, which the router can only read as "the server
  // answered with an error" rather than "the network failed", so it had nothing to fall back on.
  // Not intercepting them at all means they are never stale and a real failure stays a real
  // failure, which the router already knows how to handle.
  if (url.searchParams.has("_rsc") || event.request.headers.get("RSC")) return;

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
          if (event.request.mode === "navigate") {
            return caches
              .match("/offline.html")
              .then((offline) => offline ?? new Response("Offline", { status: 503 }));
          }
          // event.respondWith() throws "Failed to convert value to 'Response'" if this ever
          // resolves to undefined (a real failure mode hit live: a non-navigate request whose
          // network fetch failed with nothing cached) — a synthetic error response is always
          // valid where undefined isn't.
          return new Response("", { status: 504, statusText: "Network error, nothing cached" });
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
