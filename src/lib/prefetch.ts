import { preload } from "swr";
import { fetcher, progressKey } from "@/lib/swr";

/**
 * Un préchargement SWR dont l'échec ne va nulle part — le seul `preload` du dépôt.
 *
 * `preload` rend la promesse de la requête, et personne ne l'attend : sans `.catch`, un réseau
 * absent devient un rejet non rattrapé. C'est ce que journalisait l'iPhone de Louis le 21/09/2026,
 * « Load failed » sur `/`, à chaque réouverture de l'application juste après un déploiement :
 * « Ma liste » était préchargée au démarrage alors que le réseau n'était pas encore revenu. Ce
 * n'est qu'une avance prise ; l'écran qui a vraiment besoin des données refera la demande.
 */
export function preloadQuietly<T>(key: string, fetch: (key: string) => Promise<T> = fetcher as (key: string) => Promise<T>): Promise<T | undefined> {
  try {
    return Promise.resolve(preload(key, fetch)).catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}

/**
 * Le même préchargement, mais qui dit ce qui s'est passé : la donnée, ou l'erreur.
 *
 * `preloadQuietly` rend `undefined` sur un échec, sans en dire la nature — or « le fichier
 * n'existe plus » et « le réseau a coupé » n'appellent pas la même conduite (voir
 * `missingFiles.ts`). Jamais de rejet non plus.
 */
export function preloadOutcome<T>(
  key: string,
  fetch: (key: string) => Promise<T> = fetcher as (key: string) => Promise<T>
): Promise<{ data?: T; error?: unknown }> {
  try {
    return Promise.resolve(preload(key, fetch)).then(
      (data) => ({ data }),
      (error: unknown) => ({ error })
    );
  } catch (error) {
    return Promise.resolve({ error });
  }
}

/**
 * Ce qu'une fiche va demander, demandé dès que le doigt se pose sur son affiche.
 *
 * Entre l'appui et l'ouverture de la fiche, il s'écoule le temps du geste lui-même — cent à deux
 * cents millisecondes que la fiche passait ensuite à attendre sa description Radarr/Sonarr et
 * l'état Jellyfin du titre (25/09/2026). Partis à l'appui, ils arrivent avec la fiche. SWR
 * dédoublonne : la fiche qui s'ouvre reprend la demande en vol au lieu d'en lancer une autre, et un
 * second appui dans la foulée n'en lance pas de troisième.
 *
 * Seulement pour un titre de la bibliothèque — `jellyfinItemId` présent : une affiche TMDB n'a ni
 * fiche Radarr ni état Jellyfin.
 *
 * Et une seule fois par titre et par demi-minute : `preload` ne regarde pas la réserve de SWR, il
 * ne partage que la demande encore en vol. Un doigt qui revient sur la même affiche — ou qui la
 * frôle en faisant défiler la rangée — relancerait sinon les deux requêtes à chaque fois.
 */
export function prefetchTitleSheet(title: { kind: "movie"; radarrId: number; jellyfinItemId: string | null | undefined } | { kind: "series"; sonarrId: number; jellyfinItemId: string | null | undefined }): void {
  if (!title.jellyfinItemId) return;
  // La description seulement, la même pour tout le monde. Pas l'état Jellyfin ni la liste des
  // épisodes : un préchargement jamais consommé reste dans la réserve de SWR et est rendu, des
  // heures plus tard, comme s'il venait d'arriver — un doigt qui frôlait *Dune* en défilant, le film
  // regardé ensuite sur la télé, et la fiche affirmait « depuis le début » (chasse aux défauts du
  // 25/09/2026). La fiche affiche déjà son bouton depuis ce que l'appareil sait (`sheetFacts`).
  const keys = title.kind === "movie" ? [`/api/radarr/movies/${title.radarrId}/info`] : [`/api/sonarr/series/${title.sonarrId}/info`];
  const now = Date.now();
  for (const key of keys) {
    const at = recentlyPrefetched.get(key);
    if (at !== undefined && now - at < PREFETCH_AGAIN_MS) continue;
    recentlyPrefetched.set(key, now);
    void preloadQuietly(key);
  }
}

const PREFETCH_AGAIN_MS = 30_000;
const recentlyPrefetched = new Map<string, number>();

/** Pour les tests : oublier ce qui a déjà été demandé. */
export function resetTitleSheetPrefetch(): void {
  recentlyPrefetched.clear();
}

/**
 * La même chose pour une affiche dont on ne sait que la forme — les rangées du téléphone sont
 * écrites une fois pour les films et les séries.
 */
export function prefetchLibraryItem(item: object): void {
  const title = item as { radarrId?: unknown; sonarrId?: unknown; jellyfinItemId?: unknown };
  const jellyfinItemId = typeof title.jellyfinItemId === "string" ? title.jellyfinItemId : null;
  if (typeof title.radarrId === "number") prefetchTitleSheet({ kind: "movie", radarrId: title.radarrId, jellyfinItemId });
  else if (typeof title.sonarrId === "number") prefetchTitleSheet({ kind: "series", sonarrId: title.sonarrId, jellyfinItemId });
}

// Warms the SWR cache for a route's main data before navigation actually
// happens (hover/focus on its nav link), so the page renders with data
// already in cache instead of waiting for a fresh round-trip on mount.
const PREFETCH_MAP: Record<string, string[]> = {
  // The dashboard fetches a single consolidated payload (see DashboardClient.tsx) — this used
  // to point at /api/status + /api/activity from before that consolidation, which the dashboard
  // hasn't called since. Hovering "Accueil" was warming a cache entry the page never reads.
  "/": ["/api/dashboard"],
  // La même charge utile : `/gestion` est l'adresse définitive du tableau de bord, et c'est par
  // elle qu'on y arrive depuis le rail du lecteur.
  "/gestion": ["/api/dashboard"],
  "/radarr": ["/api/radarr/movies"],
  "/sonarr": ["/api/sonarr/series"],
  "/qbittorrent": ["/api/qbittorrent/torrents", "/api/qbittorrent/transfer"],
  "/bazarr": ["/api/bazarr/wanted"],
  "/jackett": ["/api/jackett/indexers"],
  "/jellyfin": ["/api/jellyfin/sessions", "/api/jellyfin/library"],
  "/jellyseerr": ["/api/jellyseerr/requests?filter=pending"],
};

export function prefetchRoute(href: string) {
  const keys = PREFETCH_MAP[href];
  if (!keys) return;
  for (const key of keys) void preloadQuietly(key);
}

export function prefetchMovieDetail(id: number) {
  void preloadQuietly(`/api/radarr/movies/${id}`);
  void preloadQuietly(`/api/radarr/movies/${id}/info`);
  void preloadQuietly("/api/radarr/meta");
}

export function prefetchSeriesDetail(id: number) {
  void preloadQuietly(`/api/sonarr/series/${id}`);
  void preloadQuietly(`/api/sonarr/series/${id}/info`);
  void preloadQuietly("/api/sonarr/meta");
}
