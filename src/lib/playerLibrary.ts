import { catalogueMembers } from "@/lib/catalogueMembers";
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
 * les avoir**, et des titres qu'ils ont mais que Jellyfin ne rapproche pas. Les indexer comme « on
 * l'a » donnait un identifiant de bibliothèque à un titre qu'aucun écran ne sait afficher : une
 * carte sans la pastille « Pas encore là », qui n'ouvrait rien du tout quand on cliquait dessus.
 *
 * La règle est donc **celle du catalogue**, et non plus une approximation : `catalogueMembers`
 * (fichier ou épisode, *et* élément Jellyfin retrouvé). Un titre qui n'y est pas s'ouvre sur sa
 * fiche TMDB (*The Arena*, 05/10/2026 — Jellyfin l'avait pris pour une autre série).
 */
export async function playableLibrary(): Promise<PlayableLibrary> {
  const { movies, series } = await catalogueMembers();
  return {
    movies: new Map(movies.filter((m) => m.tmdbId).map((m) => [m.tmdbId, m])),
    series: new Map(series.filter((s) => s.tmdbId != null).map((s) => [s.tmdbId!, s])),
  };
}

/** L'identifiant de fiche d'un titre, ou `null` s'il n'est pas ouvrable. */
export function playableId(lib: PlayableLibrary, type: "movie" | "series", tmdbId: number | null): number | null {
  if (tmdbId == null) return null;
  return (type === "series" ? lib.series.get(tmdbId)?.id : lib.movies.get(tmdbId)?.id) ?? null;
}
