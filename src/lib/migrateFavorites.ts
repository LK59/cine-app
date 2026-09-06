import { watchlistDb, migrationDb } from "@/lib/db";
import { cachedJellyfinFavorites, getProviderIdCI } from "@/lib/server-cache";

/**
 * Les favoris Jellyfin rejoignent « À voir », une fois par compte.
 *
 * « Favoris » était une liste de plus qui disait la même chose qu'« À voir » avec un autre mot, et
 * qui tirait sa vérité d'ailleurs : le cœur vit chez Jellyfin. La liste disparaît de l'interface,
 * mais ce que les gens y avaient rangé ne doit pas disparaître avec elle — soixante-deux titres
 * répartis sur sept comptes, au moment où ceci a été écrit.
 *
 * À la lecture et non au démarrage : un favori est attaché à un compte Jellyfin, et un compte
 * n'existe de notre côté qu'une fois qu'il s'est connecté. Un marqueur par compte garantit que ça
 * ne se fait qu'une fois — sans lui, quelqu'un qui retire un titre de sa liste le verrait revenir
 * au chargement suivant.
 *
 * Le cœur de Jellyfin n'est pas touché : c'est sa donnée, elle a un sens dans ses applications.
 */
export async function migrateFavoritesToWatchlist(userId: string, jellyfinUserId: string): Promise<void> {
  const marker = `favorites-to-watchlist:${userId}`;
  if (migrationDb.isDone(marker)) return;

  const favorites = await cachedJellyfinFavorites(jellyfinUserId);
  for (const item of favorites) {
    const raw = getProviderIdCI(item.ProviderIds as Record<string, string> | undefined, "tmdb");
    const tmdbId = raw ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isFinite(tmdbId) || tmdbId <= 0) continue;
    const mediaType = item.Type === "Series" ? "series" : "movie";
    // Ne jamais écraser un choix existant : quelqu'un qui a déjà marqué ce titre « vu » ou l'a
    // rangé lui-même a dit quelque chose de plus récent que ce cœur.
    if (watchlistDb.get(userId, mediaType, tmdbId)) continue;
    watchlistDb.upsert({
      userId,
      mediaType,
      tmdbId,
      tvdbId: null,
      title: item.Name,
      year: item.ProductionYear ?? null,
      posterPath: null,
      voteAverage: null,
      status: "to_watch",
      note: null,
    });
  }
  migrationDb.markDone(marker);
}
