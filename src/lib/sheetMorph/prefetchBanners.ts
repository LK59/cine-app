/**
 * Les visuels des fiches, décodés d'avance (DECISIONS.md §61).
 *
 * Ouverte depuis la bannière, une fiche dont le visuel n'est pas encore là garde l'affiche qui a
 * volé comme bannière de remplacement, et le vrai visuel arrive ensuite — en fondu désormais, mais le
 * mieux est que le relais n'ait pas lieu. Deux façons de le demander avant qu'on en ait besoin :
 *
 * - `keepSheetBanners` : tous les titres de la bannière d'accueil du téléphone (une dizaine au plus),
 *   demandés dès que sa liste est connue — au lancement, depuis le catalogue gardé sur l'appareil —,
 *   et *gardés* décodés : les objets `Image` restent référencés ici, le navigateur ne jette pas leur
 *   décodage. Une liste qui change rend ceux qui en sortent et demande aussitôt les nouveaux. Les
 *   octets eux-mêmes persistent d'un lancement à l'autre par le cache HTTP (les visuels TMDB, et
 *   `/api/jellyfin/image` avec un `tag`, servi `immutable`). Avant (77463aa), seuls le titre affiché
 *   et ses deux voisins étaient demandés, et seulement au repos : le premier lancement ouvrait encore
 *   souvent une fiche sur l'affiche en remplacement (Louis, 10/10/2026).
 * - `prefetchSheetBannerNow` : la carte qu'un doigt vient de toucher, à l'appui même.
 *
 * Jamais pendant un film : l'appelant suspend la garde (`suspendSheetBanners`), ce qui abandonne ce
 * qui se télécharge encore. Jamais sur une connexion qui demande l'économie de données.
 */

/** Déjà demandés par l'appui, dans cette page : une adresse n'est jamais redemandée. Bornée. */
const asked = new Set<string>();
const MAX_REMEMBERED = 60;

/** Les visuels gardés décodés, et qui les veut (une bannière par onglet). */
const kept = new Map<string, HTMLImageElement>();
const owners = new Map<string, Set<string>>();

function saveData(): boolean {
  if (typeof navigator === "undefined") return false;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}

function decodeOne(url: string): HTMLImageElement {
  const img = new Image();
  img.decoding = "async";
  // `fetchPriority` n'existe pas partout : posé comme attribut, ignoré là où il est inconnu.
  img.setAttribute("fetchpriority", "low");
  img.src = url;
  img.decode?.().catch(() => {});
  return img;
}

/** Rend ce que plus personne ne veut. */
function prune(): void {
  const wanted = new Set<string>();
  for (const urls of owners.values()) for (const u of urls) wanted.add(u);
  for (const url of Array.from(kept.keys())) if (!wanted.has(url)) kept.delete(url);
}

/**
 * Garde décodés les visuels de ces fiches pour `owner` (une bannière) : demande ceux qui manquent
 * tout de suite, rend ceux qu'elle ne montre plus.
 */
export function keepSheetBanners(owner: string, urls: readonly (string | null | undefined)[]): void {
  if (saveData()) return;
  const want = new Set(urls.filter((u): u is string => typeof u === "string" && u.length > 0));
  const before = owners.get(owner);
  owners.set(owner, want);
  // Ceux que cette bannière ne montre plus, et que personne d'autre ne veut, sont rendus — pas ceux
  // qu'une bannière suspendue (l'autre onglet) a laissés décodés.
  if (before) {
    const wanted = new Set<string>();
    for (const urls of owners.values()) for (const u of urls) wanted.add(u);
    for (const url of before) if (!wanted.has(url)) kept.delete(url);
  }
  for (const url of want) if (!kept.has(url)) kept.set(url, decodeOne(url));
}

/**
 * La bannière `owner` quitte l'écran (un film démarre, l'autre onglet, un panneau) : ce qu'elle seule
 * faisait télécharger est abandonné — retirer `src` l'annule —, ce qui est déjà décodé reste gardé.
 * `keepSheetBanners` redemandera le reste à son retour. Les visuels qu'une autre bannière veut encore
 * ne sont pas touchés.
 */
export function suspendSheetBanners(owner: string): void {
  owners.delete(owner);
  const wanted = new Set<string>();
  for (const urls of owners.values()) for (const u of urls) wanted.add(u);
  for (const [url, img] of Array.from(kept)) {
    if (wanted.has(url) || (img.complete && img.naturalWidth > 0)) continue;
    img.removeAttribute("src");
    kept.delete(url);
  }
}

/** La bannière n'existe plus : ses visuels sont rendus. */
export function releaseSheetBanners(owner: string): void {
  owners.delete(owner);
  prune();
}

/**
 * Le visuel de la fiche qu'un doigt vient de toucher, demandé à l'appui même (`pointerdown`, lu par
 * `source.ts` sur `data-sheet-backdrop`) : l'adresse est connue 80 à 150 ms avant le relâchement, de
 * quoi qu'il soit souvent décodé quand le trajet part — et sinon qu'il arrive en plein vol, en fondu
 * (`useSheetMorph`). Pas d'attente du repos ici : c'est le geste qui le demande.
 */
export function prefetchSheetBannerNow(url: string | null | undefined): void {
  if (!url || kept.has(url) || asked.has(url) || saveData()) return;
  asked.add(url);
  if (asked.size > MAX_REMEMBERED) asked.delete(asked.values().next().value as string);
  decodeOne(url);
}

/** Pour les tests. */
export const prefetchBannersForTests = {
  reset(): void {
    asked.clear();
    kept.clear();
    owners.clear();
  },
  kept: () => Array.from(kept.keys()),
};
