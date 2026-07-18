/**
 * PWA installs keep running old JS/HTML from memory until something forces a
 * full reload — closing the app doesn't guarantee a fresh network fetch, and
 * there's no address bar to pull-to-refresh from. This clears the Cache
 * Storage the service worker fell back to, nudges it to check for a new
 * version, then hard-reloads so the page re-fetches everything from network.
 */
export async function hardRefreshApp() {
  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) await reg.update();
    }
  } finally {
    window.location.reload();
  }
}
