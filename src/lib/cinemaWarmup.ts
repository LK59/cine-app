"use client";

/**
 * Préchauffer ce que l'écran va demander — un seul endroit pour le cinéma.
 *
 * Le bureau préchauffait déjà ses bannières ; le 21/09/2026, l'écran d'accueil s'en sert aussi,
 * et y ajoute les affiches et les décodeurs du lecteur. Tout se fait au fil de l'eau, quelques
 * requêtes à la fois, jamais en rafale : voir le budget ci-dessous.
 */

// Backdrop/logo warm-up budget. This used to queue EVERY title in the library at once — on a
// ~800-title library that's ~1600 image requests fired in one burst, which saturates the
// browser's own per-host connection pool and makes the visible poster images (the ones actually
// on screen) queue behind them. Only what's reachable within a few keypresses is worth
// pre-warming; anything further out is a cold fetch that the backdrop's own 150ms debounce and
// the browser cache already cover well enough.
const PREFETCH_PER_ROW = 8;
// En titres depuis le 21/09/2026 (c'était en images) : soixante titres à deux images — bannière
// et logo — font les mêmes 120 requêtes qu'avant sur le bureau.
const PREFETCH_LIMIT = 60;
const PREFETCH_CHUNK = 6;
const PREFETCH_CHUNK_DELAY_MS = 300;

// Fires the prefetches a few at a time instead of all at once, and hands back a cancel function
// so a data refresh (or unmount) doesn't leave a queue running for a list that no longer applies.
export function prefetchImages(urls: string[]): () => void {
  let cancelled = false;
  let index = 0;
  let timer: ReturnType<typeof setTimeout>;

  function pump() {
    if (cancelled) return;
    for (let n = 0; n < PREFETCH_CHUNK && index < urls.length; n++, index++) {
      Object.assign(new Image(), { src: urls[index] });
    }
    if (index < urls.length) timer = setTimeout(pump, PREFETCH_CHUNK_DELAY_MS);
  }

  // Deferred by a beat so it doesn't compete with the initial screen's own critical images.
  timer = setTimeout(pump, 400);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}

// Spotlight first (that's what the hero opens on), then the head of each row — the cards you can
// actually reach before scrolling. Deduped, capped, backdrop+logo per title.
export function warmUpUrls<T>(
  spotlight: T[],
  rows: Record<string, T[]>,
  id: (item: T) => number,
  urlsOf: (item: T) => (string | null)[],
  /** En titres, pas en images. Le bureau garde son plafond ; l'accueil en prend un plus serré. */
  limit: number = PREFETCH_LIMIT
): string[] {
  const seen = new Set<number>();
  const urls: string[] = [];
  const push = (item: T) => {
    if (seen.size >= limit || seen.has(id(item))) return;
    seen.add(id(item));
    for (const url of urlsOf(item)) if (url) urls.push(url);
  };
  for (const item of spotlight) push(item);
  for (const list of Object.values(rows)) for (const item of list.slice(0, PREFETCH_PER_ROW)) push(item);
  return urls;
}


/**
 * Les décodeurs du lecteur, avant le premier film : mediabunny et ses extensions AC-3 et DTS,
 * ~850 Ko compressés, que le premier « Lire » d'un fichier au son exotique téléchargeait sinon.
 *
 * Pendant l'écran d'accueil seulement — le premier lancement de l'application installée, qui part
 * d'un stockage vide. Leur nom ne change pas tant que leur contenu ne change pas, et le service
 * worker les reporte d'un build au suivant (voir `STATIC_PREFIX` dans sw.js) : une fois suffit.
 * Un échec ne coûte rien — le lecteur les chargera lui-même, comme avant.
 */
export function warmPlayerDecoders(): void {
  void import("mediabunny").catch(() => {});
  void import("@mediabunny/ac3").catch(() => {});
  void import("@mediabunny/dts").catch(() => {});
}
