import { catalogueMembers } from "@/lib/catalogueMembers";
import {
  cachedJellyfinFirstEpisodes,
  cachedJellyfinRecentEpisodes,
  cachedJellyfinSeasons,
  startKeptCacheRefresh,
} from "@/lib/server-cache";

/**
 * Les listes de la bibliothèque en mémoire dès le démarrage, puis gardées chaudes (15/10/2026) —
 * voir `withKeptCache`.
 *
 * Chaque déploiement recrée le conteneur, plusieurs fois par jour : sans cette première lecture, la
 * première ouverture qui suivait attendait Jellyfin et Radarr (~1,1 s de route). Ce qu'elle lit est
 * ce que lisent les quatre routes de l'ouverture : les quatre listes du catalogue et leurs
 * rapprochements (`catalogueMembers`, épisodes comptés des séries « Jellyfin seul » compris), et ce
 * que la route des séries y ajoute. Rien de propre à un compte.
 */
const FIRST_READ_DELAY_MS = 2_000;

let started = false;

export function startCatalogueWarm(): void {
  if (started) return;
  started = true;
  startKeptCacheRefresh();
  const first = setTimeout(() => {
    // Chacune pour soi : une source absente au démarrage ne retient pas les autres, et elle sera lue
    // à la première ouverture comme avant.
    void Promise.allSettled([
      catalogueMembers(),
      cachedJellyfinFirstEpisodes(),
      cachedJellyfinSeasons(),
      cachedJellyfinRecentEpisodes(),
    ]);
  }, FIRST_READ_DELAY_MS);
  (first as { unref?: () => void }).unref?.();
}
