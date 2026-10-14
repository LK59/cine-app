import { catalogueMembers } from "@/lib/catalogueMembers";
import type { RadarrMovie } from "@/lib/clients/radarr";
import type { SonarrSeries } from "@/lib/clients/sonarr";
import type { JellyfinItem } from "@/lib/clients/jellyfin";

/**
 * Un titre ouvrable : son identifiant de fiche, et les visuels de Radarr/Sonarr quand il en a. Un
 * titre que Jellyfin a seul (DECISIONS.md §89) n'a que le premier — son affiche vient de Jellyfin
 * (`seriesJellyfin`, `moviesJellyfin`).
 */
export interface PlayableEntry {
  id: number;
  images?: RadarrMovie["images"] | SonarrSeries["images"];
  source?: "jellyfin";
}

export interface PlayableLibrary {
  movies: Map<number, PlayableEntry>;
  series: Map<number, PlayableEntry>;
  /** L'élément Jellyfin de chaque série, par identifiant TMDB — voir `CatalogueMembers.seriesJellyfin`. */
  seriesJellyfin: Map<number, JellyfinItem>;
  /** L'élément Jellyfin des films que Jellyfin a seul, par identifiant TMDB — leur seule affiche. */
  moviesJellyfin?: Map<number, JellyfinItem>;
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
 *
 * Les titres que Jellyfin a seul y entrent aussi (§89), par le TMDB que Jellyfin leur donne : la
 * fiche TMDB et la recherche les ouvrent dans la bibliothèque au lieu de proposer de les demander.
 * Un titre de Radarr/Sonarr passe toujours devant, au même TMDB.
 */
export async function playableLibrary(): Promise<PlayableLibrary> {
  const { movies, series, seriesJellyfin, jellyfinOnly } = await catalogueMembers();
  const jellyfinBySonarr = seriesJellyfin ?? new Map<number, JellyfinItem>();
  const playableSeries = series.filter((s) => s.tmdbId != null);
  const movieMap = new Map<number, PlayableEntry>(movies.filter((m) => m.tmdbId).map((m) => [m.tmdbId, m]));
  const seriesMap = new Map<number, PlayableEntry>(playableSeries.map((s) => [s.tmdbId!, s]));
  const seriesItems = new Map<number, JellyfinItem>(
    playableSeries.flatMap((s) => {
      const item = jellyfinBySonarr.get(s.id);
      return item ? [[s.tmdbId!, item] as const] : [];
    })
  );
  const movieItems = new Map<number, JellyfinItem>();
  for (const t of jellyfinOnly?.movies ?? []) {
    if (t.tmdbId === null || movieMap.has(t.tmdbId)) continue;
    movieMap.set(t.tmdbId, { id: t.id, source: "jellyfin" });
    movieItems.set(t.tmdbId, t.item);
  }
  for (const t of jellyfinOnly?.series ?? []) {
    if (t.tmdbId === null || seriesMap.has(t.tmdbId)) continue;
    seriesMap.set(t.tmdbId, { id: t.id, source: "jellyfin" });
    seriesItems.set(t.tmdbId, t.item);
  }
  return { movies: movieMap, series: seriesMap, seriesJellyfin: seriesItems, moviesJellyfin: movieItems };
}

/** L'identifiant de fiche d'un titre, ou `null` s'il n'est pas ouvrable. */
export function playableId(lib: PlayableLibrary, type: "movie" | "series", tmdbId: number | null): number | null {
  if (tmdbId == null) return null;
  return (type === "series" ? lib.series.get(tmdbId)?.id : lib.movies.get(tmdbId)?.id) ?? null;
}
