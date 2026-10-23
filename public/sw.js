// v9: flushes the HTML documents earlier versions stored. They are no longer cached at all — see
// the fetch handler — and the ones already saved have to go with them, or a client would keep
// being handed a page built by a previous deploy.
// v10 : le lecteur a changé d'adresse (/cinema → /player) et la coquille de gestion a
// gagné la sienne (/gestion). Un cache d'une version précédente peut contenir des pages qui
// pointent encore vers les anciennes ; le bump les évince toutes d'un coup.
// v11 : le lecteur *est* la racine. `/player` et `/cinema` y redirigent désormais, et tout ce
// qu'une version précédente aurait pu garder — une réponse RSC, une ressource d'un ancien build —
// désigne une arborescence qui n'existe plus. On repart de zéro : `activate` supprime tout cache
// dont le nom n'est pas celui-ci.
// v12 (21/09/2026) : le cache grossissait sans fin. Chaque déploiement — plusieurs par jour —
// renomme ses fichiers JS/CSS, et les anciens restaient là pour toujours, puisque `activate` ne
// vise que les caches d'une autre *version*. Les images, elles, y étaient rangées en double : le
// navigateur les garde déjà un an. Safari finit par vider d'un coup tout le stockage d'une
// application qui en prend trop — on perdait alors ce qui compte avec ce qui ne sert plus. Le
// changement de nom évince une dernière fois tout l'ancien cache ; la suite ne grossit plus
// (voir STATIC_PREFIX et le traitement des images plus bas).
// (25/09/2026, sans changer de nom : ce fichier a changé pour rattraper les onglets ouverts sur un
// code plus ancien — voir `reloadHiddenTabsOnce`. Un changement de contenu suffit à faire installer
// le worker ; le nom, lui, évincerait tout le cache pour rien.)
// (19/10/2026, sans changer de nom : l'entrée hors ligne des téléchargements, DECISIONS.md §109.
// Le worker garde `/hors-ligne` — demandée sans cookie — et tout le code qu'elle atteint dans le
// cache du build, à la demande du cinéma et seulement sur un appareil qui a des téléchargements ;
// une navigation qui échoue y donne accès depuis la page « Pas de connexion », et une navigation
// qui tarde plus de six secondes sur un tel appareil affiche cette page en mode « attente », qui
// reprend la réponse dès qu'elle arrive. Le cache de l'application, lui, ne change pas.)
// (23/10/2026, sans changer de nom : le logo Laterna. Les icônes gardent leurs adresses, et ce worker
// les demande au réseau d'abord — le cache ne sert qu'hors ligne —, Next les sert sans durée de vie
// (`max-age=0`) : un appareil connecté reçoit les nouvelles dès sa prochaine requête. `install`
// recharge PRECACHE de toute façon. Le badge des notifications devient `/badge-96.png`, silhouette
// blanche. Ce qu'aucun nom de cache ne change : l'icône déjà posée sur un écran d'accueil iOS,
// qu'iOS ne relit jamais — il faut la reposer.)
const CACHE_NAME = "cine-app-v12";
const PRECACHE = ["/manifest.json", "/icon-192.png", "/icon-512.png", "/offline.html"];

/**
 * Le code de l'application, par génération : celle du déploiement en cours, et la précédente.
 *
 * L'adresse d'enregistrement porte le numéro du build (`/sw.js?v=…`, voir
 * ServiceWorkerRegistration) : un déploiement installe donc un nouveau worker, qui range son code
 * dans un cache à son nom. Un fichier resté identique d'un build à l'autre garde le même nom —
 * mediabunny et ses décodeurs (~850 Ko compressés) ne changent presque jamais — : il est alors
 * repris du cache précédent sans être retéléchargé. Tout ce que le build courant n'a pas
 * redemandé disparaît au déploiement suivant. Deux générations au plus, jamais davantage.
 */
// Repris tel quel par `SW_STATIC_CACHE_PREFIX` (src/lib/pwaRefresh.ts) : « Actualiser l'application »
// n'évince que ces caches-là.
const STATIC_PREFIX = "cine-static-";
const BUILD = (() => {
  try {
    return new URL(self.location.href).searchParams.get("v") || "dev";
  } catch {
    return "dev";
  }
})();
const STATIC_CACHE = STATIC_PREFIX + BUILD;

/** La génération précédente : le dernier cache de code créé avant celui-ci. */
function previousStaticCache() {
  return caches.keys().then((keys) => {
    const older = keys.filter((k) => k.startsWith(STATIC_PREFIX) && k !== STATIC_CACHE);
    return older.length > 0 ? older[older.length - 1] : null;
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  // Garde : le cache de l'application, le code de ce build, et la génération d'avant — dont le
  // code resté identique sera repris à la demande. Tout le reste part.
  event.waitUntil(
    previousStaticCache()
      .then((previous) =>
        caches
          .keys()
          .then((keys) =>
            Promise.all(
              keys
                .filter((k) => k !== CACHE_NAME && k !== STATIC_CACHE && k !== previous)
                .map((k) => caches.delete(k))
            )
          )
      )
      .then(() => self.clients.claim())
      .then(() => reloadHiddenTabsOnce())
  );
});

/**
 * Les onglets ouverts sur un code d'avant le 25/09/2026, rattrapés une fois.
 *
 * Un onglet ne se recharge seul quand un déploiement sort (`BuildRefresh`) que s'il porte déjà ce
 * code-là — un onglet plus ancien ne le sait pas, et un iPad a regardé toute une soirée sur le code
 * du matin. Ces onglets-là ont encore l'ancienne bannière « Nouvelle version disponible », qui
 * redemande ce fichier à chaque retour au premier plan : il suffit qu'il change pour que le
 * navigateur installe ce worker, et que la bannière s'affiche d'elle-même dans l'onglet visible.
 *
 * Ceux qui sont en arrière-plan, personne ne les regarde : ils sont rechargés ici, une seule fois
 * par navigateur (la marque est gardée dans le cache de l'application, que `activate` conserve).
 * Un onglet visible ne l'est jamais : un film peut y jouer, et le worker ne peut pas le savoir.
 */
const HIDDEN_TABS_SWEEP = "/__sweep/onglets-2026-09-25";

function reloadHiddenTabsOnce() {
  const mark = new Request(new URL(HIDDEN_TABS_SWEEP, self.location.href).href);
  return caches
    .open(CACHE_NAME)
    .then((cache) =>
      cache.match(mark).then((done) => {
        if (done) return;
        return cache.put(mark, new Response("1")).then(() =>
          self.clients.matchAll({ type: "window" }).then((tabs) =>
            Promise.all(
              tabs
                .filter((tab) => tab.visibilityState === "hidden" && typeof tab.navigate === "function")
                .map((tab) => tab.navigate(tab.url).catch(() => {}))
            )
          )
        );
      })
    )
    .catch(() => {});
}

/**
 * Un fichier du code (`/_next/static/`) : du cache de ce build, sinon repris du précédent, sinon du
 * réseau — et rangé dans le cache de ce build. Le gestionnaire `fetch` et la mise en réserve de
 * l'entrée hors ligne passent par ici, pour que les deux rangent le code au même endroit.
 */
function staticResponse(request) {
  return caches.open(STATIC_CACHE).then((current) =>
    current.match(request).then((cached) => {
      if (cached) return cached;
      // Pas dans ce build : peut-être le même fichier, gardé par le précédent.
      return previousStaticCache()
        .then((previous) => (previous ? caches.open(previous).then((c) => c.match(request)) : undefined))
        .then((carried) => {
          if (carried) {
            current.put(request, carried.clone()).catch(() => {});
            return carried;
          }
          return fetch(request).then((response) => {
            if (!response.ok) return response;
            current.put(request, response.clone()).catch(() => {});
            return response;
          });
        });
    })
  );
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  // La page d'attente demande ici si la navigation qu'elle remplace a abouti — voir `navigate`.
  if (url.pathname === WAIT_PATH) {
    event.respondWith(waitingState(url.searchParams.get("url") || ""));
    return;
  }
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
    event.respondWith(staticResponse(event.request));
    return;
  }
  /**
   * Les images passent sans s'arrêter : le navigateur les garde déjà un an (l'optimiseur répond
   * `max-age` d'un an, les affiches du cinéma sont des adresses stables), et le worker en rangeait
   * une seconde copie — chaque grande image de bannière vue, pour toujours. C'est le cache HTTP
   * qui fait ce travail, sans rien compter en double.
   */
  if (url.pathname.startsWith("/_next/image") || event.request.destination === "image") return;

  /**
   * Les documents HTML ne sont pas mis en cache — ils sont seulement servis depuis le réseau.
   *
   * Ils l'étaient, et deux choses en découlaient. La première : une page mise en cache par un
   * déploiement se retrouvait servie à un client qui exécute le suivant, dont les fragments
   * JavaScript ne correspondent plus — c'est la famille d'erreurs d'hydratation de React, dont
   * le #419 relevé au retour depuis un titre similaire. La seconde : Next diffuse son HTML en
   * flux, et une navigation abandonnée en cours de route laisse une réponse tronquée, qu'on
   * s'empressait d'enregistrer telle quelle. Une frontière Suspense jamais refermée, relue plus
   * tard, donne exactement la même erreur.
   *
   * Hors ligne, ces pages retombent sur `offline.html`, ce qu'elles faisaient déjà lorsque rien
   * n'avait encore été mis en cache.
   */
  const isDocument = event.request.mode === "navigate";
  if (isDocument) {
    // Jamais mis en cache non plus — mais plus seulement « réseau, sinon offline.html » : voir
    // `navigate` et l'entrée hors ligne des téléchargements, plus bas.
    event.respondWith(navigate(event));
    return;
  }

  // Network-first for everything else: this is a live dashboard, data must stay fresh. We only
  // fall back to cache when the network is unreachable (offline). Navigations are handled above.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Une réponse d'erreur n'a rien à faire en cache : la garder revient à servir l'erreur
        // encore et encore une fois le réseau revenu.
        if (!response.ok) return response;
        const copy = response.clone();
        // `.catch` : un corps interrompu fait échouer l'écriture, et une promesse rejetée sans
        // personne pour l'attraper remonte comme une erreur du service worker.
        caches
          .open(CACHE_NAME)
          .then((cache) => cache.put(event.request, copy))
          .catch(() => {});
        return response;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => {
          if (cached) return cached;
          // event.respondWith() throws "Failed to convert value to 'Response'" if this ever
          // resolves to undefined (a real failure mode hit live: a non-navigate request whose
          // network fetch failed with nothing cached) — a synthetic error response is always
          // valid where undefined isn't.
          return new Response("", { status: 504, statusText: "Network error, nothing cached" });
        })
      )
  );
});

// ─── L'entrée hors ligne des téléchargements (19/10/2026, DECISIONS.md §109) ───────────────────
//
// Le cinéma est rendu par le serveur, derrière une session : sans réseau, il n'y a rien à ouvrir, et
// on ne garde jamais une page d'un compte (voir plus haut). Les téléchargements, eux, sont sur
// l'appareil. `/hors-ligne` est une page publique qui les montre et les lit sans rien demander au
// serveur ; le worker la garde ici, avec tout son code, pour qu'elle s'ouvre sans réseau.
//
// - **Quand** : à la demande du cinéma (`cine:warm-offline-entry`), qu'il n'envoie que s'il y a des
//   téléchargements sur l'appareil — ce code (2,7 Mo compressés) n'a pas à être gardé partout. Une fois
//   par build : elle vit dans le cache du build (`STATIC_CACHE`), avec le code qu'elle charge, si
//   bien que la page et ses fichiers sont toujours de la même génération.
// - **Comment** : la page est demandée **sans cookie** (`credentials: "omit"`) — rendue comme pour un
//   inconnu, elle ne porte ni compte ni réglage de personne. Puis chaque fichier qu'elle nomme, et
//   ceux que nomment ces fichiers (les morceaux chargés à la demande, le lecteur, les dictionnaires),
//   jusqu'au dernier : Turbopack écrit leurs chemins en clair (`static/chunks/…`). La page n'est
//   rangée qu'à la fin — tant qu'elle n'y est pas, rien ne la sert, et la demande suivante reprend.
// - **Servie** : `/hors-ligne` part au réseau et prend la copie gardée au bout de 2,5 s ou à l'échec ;
//   toute autre navigation qui échoue reçoit `offline.html`, dont le bouton y mène.
//
// **Une navigation lente** : sur un appareil qui garde l'entrée (donc qui a des téléchargements),
// une page qui n'a pas répondu au bout de six secondes est remplacée par `offline.html` en mode
// « attente » — le serveur tarde, et le bouton des téléchargements est là. La requête continue :
// gardée ici une minute, la page d'attente la guette (`/__sw/attente`) et se recharge dès qu'elle a
// répondu, recevant alors **cette** réponse sans la redemander. Six secondes, et pas moins : un
// lancement en 4G en itinérance dépasse souvent trois secondes jusqu'au premier octet, et c'est un
// lancement normal. Un appareil sans téléchargement n'attend jamais autrement qu'avant.

const OFFLINE_ENTRY = "/hors-ligne";
const WAIT_PATH = "/__sw/attente";
const SLOW_NAVIGATION_MS = 6000;
const OFFLINE_ENTRY_FAST_MS = 2500;
const HELD_NAVIGATION_MS = 60000;
/**
 * Un plafond, au cas où un fichier nommerait des chemins sans fin. Mesuré sur 8.71.4 : la racine en
 * atteint une cinquantaine sur les 177 du build — 8,7 Mo, 2,7 Mo compressés —, et rien de plus.
 */
const OFFLINE_ENTRY_MAX_FILES = 800;

const SCOPE_BASE = (() => {
  try {
    return new URL("/", self.location.href).href;
  } catch {
    return "https://localhost/";
  }
})();
const offlineEntryKey = () => new Request(new URL(OFFLINE_ENTRY, SCOPE_BASE).href);

/** L'entrée gardée, de ce build ou du précédent — chacune avec le code de sa génération. */
function cachedOfflineEntry() {
  return caches
    .open(STATIC_CACHE)
    .then((c) => c.match(offlineEntryKey()))
    .then(
      (hit) =>
        hit ||
        previousStaticCache().then((previous) => (previous ? caches.open(previous).then((c) => c.match(offlineEntryKey())) : undefined))
    )
    .catch(() => undefined);
}

function offlinePage() {
  return caches.match("/offline.html").then((offline) => offline ?? new Response("Offline", { status: 503 }));
}

/** `offline.html`, marquée « attente » : la même page, qui guette la navigation au lieu de dire l'échec. */
function waitingPage() {
  return caches.match("/offline.html").then((offline) =>
    offline
      ? offline.text().then(
          (html) => new Response(html.replace("<html", '<html data-attente="1"'), { headers: { "Content-Type": "text/html; charset=utf-8" } })
        )
      : null
  );
}

/** Les navigations qui ont tardé, par adresse (sans fragment), le temps que leur page d'attente les reprenne. */
const heldNavigations = new Map();
const navigationKey = (href) => String(href).split("#")[0];

function navigate(event) {
  const request = event.request;
  const key = navigationKey(request.url);
  if (new URL(request.url).pathname === OFFLINE_ENTRY) return navigateOfflineEntry(event);
  // La page d'attente se recharge : la réponse qu'elle guettait est là, on la lui rend.
  const held = heldNavigations.get(key);
  if (held) {
    heldNavigations.delete(key);
    return held.response.catch(() => offlinePage());
  }
  const network = fetch(request);
  // Une rejection que personne n'attend encore ne doit pas remonter comme une erreur du worker.
  network.catch(() => {});
  if (event.waitUntil) event.waitUntil(network.catch(() => {}));
  return cachedOfflineEntry().then((entry) => {
    if (!entry) return network.catch(() => offlinePage());
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const at = Date.now();
        heldNavigations.set(key, { response: network, at });
        setTimeout(() => {
          if (heldNavigations.get(key)?.at === at) heldNavigations.delete(key);
        }, HELD_NAVIGATION_MS);
        resolve(waitingPage().then((page) => page || network.catch(() => offlinePage())));
      }, SLOW_NAVIGATION_MS);
      network.then(
        (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(response);
        },
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(offlinePage());
        }
      );
    });
  });
}

/**
 * `/hors-ligne` : le réseau s'il répond vite et bien (la page rendue avec la session), sinon la copie
 * gardée. Une page qu'on ouvre faute de réseau ne doit pas attendre le réseau.
 */
function navigateOfflineEntry(event) {
  const network = fetch(event.request);
  network.catch(() => {});
  return cachedOfflineEntry().then((entry) => {
    if (!entry) return network.catch(() => offlinePage());
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(entry);
      }, OFFLINE_ENTRY_FAST_MS);
      network.then(
        (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(response.ok ? response : entry);
        },
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(entry);
        }
      );
    });
  });
}

/** Ce que la page d'attente apprend : `ready` (rechargez), `failed` (pas de réseau), `none` (rien de gardé). */
function waitingState(href) {
  const json = (state) =>
    new Response(JSON.stringify({ state }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  const key = navigationKey(href);
  const held = heldNavigations.get(key);
  if (!held) return Promise.resolve(json("none"));
  return held.response.then(
    () => json("ready"),
    () => {
      heldNavigations.delete(key);
      return json("failed");
    }
  );
}

/** Les chemins de fichiers du code qu'un texte nomme — HTML, JS (chemins en clair) ou CSS (`url(...)`). */
const ASSET_IN_TEXT = /(?:\/_next\/)?static\/(?:chunks|media|css)\/[A-Za-z0-9_.~%\-/]+?\.(?:m?js|css|woff2?|ttf|otf|wasm|svg|png|jpe?g|webp|avif)(?![A-Za-z0-9_])/g;
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

function assetsIn(text, base, isCss) {
  const found = [];
  for (const m of text.matchAll(ASSET_IN_TEXT)) found.push("/_next/" + m[0].replace(/^\/?(?:_next\/)?/, ""));
  if (isCss) {
    for (const m of text.matchAll(CSS_URL)) {
      try {
        const u = new URL(m[2], base);
        if (u.origin === new URL(base).origin && u.pathname.startsWith("/_next/static/")) found.push(u.pathname);
      } catch {
        /* une adresse illisible n'est pas un fichier à garder */
      }
    }
  }
  return found;
}

let warming = null;

/** Garde `/hors-ligne` et tout le code qu'elle atteint dans le cache de ce build — voir plus haut. */
function warmOfflineEntry() {
  if (warming) return warming;
  warming = caches
    .open(STATIC_CACHE)
    .then((cache) =>
      cache.match(offlineEntryKey()).then(async (already) => {
        if (already) return;
        const page = await fetch(new URL(OFFLINE_ENTRY, SCOPE_BASE).href, { credentials: "omit", cache: "no-store", redirect: "manual" });
        if (!page.ok || !/text\/html/.test(page.headers.get("Content-Type") || "")) return;
        const html = await page.text();
        const queue = assetsIn(html, SCOPE_BASE, false);
        const seen = new Set();
        while (queue.length > 0 && seen.size < OFFLINE_ENTRY_MAX_FILES) {
          const path = queue.shift();
          if (seen.has(path)) continue;
          seen.add(path);
          const href = new URL(path, SCOPE_BASE).href;
          // Un échec du réseau arrête tout (rien n'est rangé, la prochaine demande reprend) ; un 404
          // n'est qu'un chemin cité qui n'est pas un fichier, passé.
          const response = await staticResponse(new Request(href));
          if (!response.ok) continue;
          if (/\.(?:m?js|css)$/.test(path)) queue.push(...assetsIn(await response.text(), href, path.endsWith(".css")));
        }
        await cache.put(offlineEntryKey(), new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
      })
    )
    .catch(() => {})
    .then(() => {
      warming = null;
    });
  return warming;
}

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "cine:warm-offline-entry") {
    const work = warmOfflineEntry();
    if (event.waitUntil) event.waitUntil(work);
  }
});

// ─── Push notifications ───────────────────────────────────────────────────────

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch {}

  const title = data.title ?? "Laterna";
  const options = {
    body: data.body ?? "",
    icon: data.icon ?? "/icon-192.png",
    // Android ne garde du badge que son alpha et le teinte lui-même : une silhouette blanche sur
    // transparent. L'icône en couleur qu'il recevait jusqu'au 23/10/2026 s'y lisait en carré plein.
    badge: "/badge-96.png",
    tag: data.tag ?? "cine-app",
    data: { url: data.url ?? "/" },
    vibrate: [200, 100, 200],
    requireInteraction: false,
  };

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      // Badging API — feature-detected. iOS applies it to home-screen apps since 16.4, Android and
      // desktop Chrome too. The page clears it on open (clearDeliveredNotifications): nothing here
      // did, and the "1" stayed on the icon for good.
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
  // Une adresse de ce site seulement (revue de sécurité du 20/10/2026) : la notification dit où
  // aller, et un lien vers ailleurs — envoyé par erreur ou par un serveur compromis — s'ouvrait
  // dans l'application installée comme si c'était elle. Ce qui n'est pas d'ici mène à l'accueil.
  let url = event.notification.data?.url ?? "/";
  try {
    if (new URL(url, self.location.origin).origin !== self.location.origin) url = "/";
  } catch {
    url = "/";
  }
  event.waitUntil(
    Promise.all([
      clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
        const existing = windowClients.find((c) => c.url.includes(self.location.origin));
        // `navigate` échoue sur un onglet que ce worker ne contrôle pas encore (un rechargement en
        // cours) : l'onglet venait au premier plan sans ouvrir la page de la notification. Une
        // fenêtre neuve plutôt que rien (audit du 26/09/2026).
        if (existing) {
          return existing
            .focus()
            .then((c) => c.navigate(url))
            .catch(() => clients.openWindow(url));
        }
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

// ─── L'abonnement push change sous nos pieds ──────────────────────────────────
//
// Les navigateurs font tourner l'abonnement : Chrome le renouvelle périodiquement, iOS le lâche
// quand la PWA reste longtemps inutilisée. Sans ce gestionnaire, l'ancien point de terminaison
// meurt, le serveur le supprime au premier 410 — et plus aucune notification n'arrive, pendant que
// l'interrupteur des options continue d'afficher « activé ». Une panne qui ne se voit jamais.
//
// Tout est au mieux : il n'y a pas d'écran ici pour signaler un échec, et rien à gagner à ce qu'un
// service worker s'interrompe.

function swUrlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function resubscribePush(oldSubscription) {
  // La clé de l'ancien abonnement quand le navigateur la donne — elle évite un aller-retour, et
  // surtout elle est forcément la bonne. Firefox ne la fournit pas : on la redemande alors.
  let key = oldSubscription?.options?.applicationServerKey ?? null;
  if (!key) {
    const res = await fetch("/api/push/vapid-key");
    if (!res.ok) return;
    const { publicKey } = await res.json();
    if (!publicKey) return;
    key = swUrlBase64ToUint8Array(publicKey);
  }

  const fresh = await self.registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });
  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fresh.toJSON()),
  });

  // L'ancien n'enverra plus rien ; le laisser en base, c'est garder une ligne qui n'attend que son
  // premier 410 pour disparaître. Autant le dire tout de suite.
  if (oldSubscription?.endpoint && oldSubscription.endpoint !== fresh.endpoint) {
    await fetch("/api/push/subscribe", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: oldSubscription.endpoint }),
    }).catch(() => {});
  }
}

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(resubscribePush(event.oldSubscription).catch(() => {}));
});
