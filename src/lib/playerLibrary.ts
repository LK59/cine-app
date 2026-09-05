import { cachedMovies, cachedSeries } from "@/lib/server-cache";
import type { RadarrMovie } from "@/lib/clients/radarr";
import type { SonarrSeries } from "@/lib/clients/sonarr";

export interface PlayableLibrary {
  movies: Map<number, RadarrMovie>;
  series: Map<number, SonarrSeries>;
}

/**
 * Ce que la bibliothèque peut réellement ouvrir, indexé par identifiant TMDB.
 *
 * La nuance qui compte : Radarr et Sonarr connaissent aussi des titres qu'ils **surveillent sans
 * les avoir**. Les indexer comme « on l'a » donnait un identifiant de bibliothèque à un film
 * qu'aucun écran ne sait afficher — les écrans cinéma ne montrent que ce qui a un fichier et une
 * correspondance Jellyfin. Résultat à l'usage : une carte sans la pastille « Pas encore là », qui
 * n'ouvrait rien du tout quand on cliquait dessus.
 *
 * Le filtre est donc le même que celui des routes du catalogue : un film avec son fichier, une
 * série avec au moins un épisode. C'est une approximation de la correspondance Jellyfin — elle
 * peut encore laisser passer un titre présent chez Radarr mais absent de Jellyfin — mais elle
 * supprime le cas courant, et de loin.
 */
export async function playableLibrary(): Promise<PlayableLibrary> {
  const [movies, series] = await Promise.all([
    cachedMovies().catch(() => [] as RadarrMovie[]),
    cachedSeries().catch(() => [] as SonarrSeries[]),
  ]);

  return {
    movies: new Map(movies.filter((m) => m.hasFile && m.tmdbId).map((m) => [m.tmdbId, m])),
    series: new Map(
      series
        .filter((s) => s.tmdbId != null && (s.statistics?.episodeFileCount ?? 0) > 0)
        .map((s) => [s.tmdbId!, s])
    ),
  };
}

/** L'identifiant de fiche d'un titre, ou `null` s'il n'est pas ouvrable. */
export function playableId(lib: PlayableLibrary, type: "movie" | "series", tmdbId: number | null): number | null {
  if (tmdbId == null) return null;
  return (type === "series" ? lib.series.get(tmdbId)?.id : lib.movies.get(tmdbId)?.id) ?? null;
}
