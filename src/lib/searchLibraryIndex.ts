import { TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import type { RadarrMovie } from "@/lib/clients/radarr";
import type { SonarrSeries } from "@/lib/clients/sonarr";
import type { CatalogueMembers } from "@/lib/catalogueMembers";
import type { UnifiedSearchResult } from "@/app/api/search/route";

/**
 * Ce qu'on possède, vu depuis un identifiant TMDB — et la carte de résultat qui en découle.
 *
 * Déplacé tel quel de `/api/search` (07/11/2026) : la recherche par description
 * (`describeSearch.ts`) trouve ses titres par TMDB et doit dire exactement comme la recherche
 * ordinaire si on les a, si on peut les lire, et sur quelle fiche ils s'ouvrent. Une seconde copie
 * de cette règle aurait divergé — c'est elle qui décide « Lire » ou « Demander ».
 */
export interface SearchLibraryIndex {
  radarrByTmdb: Map<number, number>;
  sonarrByTmdb: Map<number, number>;
  playable: Set<string>;
}

export function searchLibraryIndex(
  movies: Pick<RadarrMovie, "id" | "tmdbId">[],
  series: Pick<SonarrSeries, "id" | "tmdbId">[],
  members: Pick<CatalogueMembers, "movies" | "series" | "jellyfinOnly">,
): SearchLibraryIndex {
  const radarrByTmdb = new Map(movies.map((m) => [m.tmdbId, m.id]));
  const sonarrByTmdb = new Map(series.filter((s) => s.tmdbId).map((s) => [s.tmdbId!, s.id]));
  // Ouvrable = dans le catalogue du cinéma, la même règle que ses routes (`catalogueMembers`) :
  // un titre que Jellyfin ne rapproche pas s'ouvre sur sa fiche TMDB au lieu de ne rien faire.
  const playable = new Set<string>([
    ...members.movies.map((m) => `movie:${m.id}`),
    ...members.series.map((s) => `series:${s.id}`),
  ]);
  // Ce que Jellyfin a seul (DECISIONS.md §89), par le TMDB qu'il lui donne : « dans la
  // bibliothèque », ouvert sur sa fiche — jamais « Demander ». Un titre de Radarr/Sonarr *ouvrable*
  // au même TMDB passe devant ; un titre qu'ils suivent sans l'avoir s'efface devant celui qu'on a.
  for (const [titles, byTmdb, kind] of [
    [members.jellyfinOnly?.movies ?? [], radarrByTmdb, "movie"],
    [members.jellyfinOnly?.series ?? [], sonarrByTmdb, "series"],
  ] as const) {
    for (const t of titles) {
      if (t.tmdbId === null) continue;
      const known = byTmdb.get(t.tmdbId);
      if (known !== undefined && playable.has(`${kind}:${known}`)) continue;
      byTmdb.set(t.tmdbId, t.id);
      playable.add(`${kind}:${t.id}`);
    }
  }
  return { radarrByTmdb, sonarrByTmdb, playable };
}

export function makeEntry(
  item: { id: number; title?: string; name?: string; poster_path?: string | null; release_date?: string; first_air_date?: string; vote_average?: number; overview?: string },
  mediaType: "movie" | "series",
  radarrByTmdb: Map<number, number>,
  sonarrByTmdb: Map<number, number>,
  source: "tmdb" | "radarr" | "sonarr" = "tmdb",
  playable?: Set<string>,
): UnifiedSearchResult {
  const title = item.title ?? item.name ?? "";
  const dateStr = item.release_date ?? item.first_air_date ?? "";
  const radarrId = mediaType === "movie" ? radarrByTmdb.get(item.id) ?? null : null;
  const sonarrId = mediaType === "series" ? sonarrByTmdb.get(item.id) ?? null : null;
  const inLibrary = radarrId !== null || sonarrId !== null;
  return {
    tmdbId: item.id,
    title,
    year: dateStr ? Number(dateStr.split("-")[0]) : null,
    posterPath: item.poster_path ? `${TMDB_IMAGE_BASE}/w342${item.poster_path}` : null,
    type: mediaType,
    overview: item.overview ?? "",
    rating: item.vote_average ?? 0,
    radarrId,
    sonarrId,
    inLibrary,
    available:
      (radarrId !== null && (playable?.has(`movie:${radarrId}`) ?? false)) ||
      (sonarrId !== null && (playable?.has(`series:${sonarrId}`) ?? false)),
    sources: inLibrary ? [source === "tmdb" ? (mediaType === "movie" ? "radarr" : "sonarr") : source] : ["tmdb"],
  };
}
