/**
 * Préfixe des caches de code du service worker — le même littéral que `STATIC_PREFIX` dans
 * public/sw.js, qui ne peut rien importer d'ici ; pwaRefresh-caches.test.ts compare les deux.
 */
export const SW_STATIC_CACHE_PREFIX = "cine-static-";

/**
 * PWA installs keep running old JS/HTML from memory until something forces a
 * full reload — closing the app doesn't guarantee a fresh network fetch, and
 * there's no address bar to pull-to-refresh from. This clears the service
 * worker's code caches, nudges it to check for a new version, then
 * hard-reloads so the page re-fetches everything from network.
 *
 * Seuls les caches de code partent. Le cache de l'application (`CACHE_NAME` dans sw.js) contient
 * le précache — offline.html compris — et la marque de `reloadHiddenTabsOnce` ; il n'est rempli
 * qu'à `install`, et l'adresse `/sw.js?v=` n'ayant pas changé, rien ne le reposait : une
 * navigation hors ligne recevait « Offline 503 », et le déploiement suivant rechargeait de
 * nouveau les onglets cachés, film ouvert ou non.
 */
export async function hardRefreshApp() {
  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith(SW_STATIC_CACHE_PREFIX)).map((k) => caches.delete(k))
      );
    }
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) await reg.update();
    }
  } finally {
    window.location.reload();
  }
}
