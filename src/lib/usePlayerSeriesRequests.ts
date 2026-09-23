"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import type { MissingPayload, MissingSeason } from "@/app/api/player/series/[sonarrId]/missing/route";
import { DOWNLOAD_REFRESH_MS } from "@/components/cinema/CinemaDetailExtras";

/**
 * Ce qui manque à une série — à lire, plus à demander.
 *
 * Une seule requête pour toute la série, partagée par l'écran des épisodes et la fiche : le cache
 * de SWR fait que les deux lisent la même réponse. Les gestes « demander cet épisode » et
 * « demander cette saison » ont été retirés le 23/09/2026 : une série se demande en entier, et
 * Sonarr cherche déjà lui-même ce qui lui manque (voir `CinemaMissingEpisodes`).
 */
export function usePlayerSeriesRequests(sonarrId: number | null | undefined) {
  const { data } = useSWR<MissingPayload>(
    sonarrId ? `/api/player/series/${sonarrId}/missing` : null,
    fetcher,
    {
      revalidateOnFocus: false,
      // Relue tant qu'un épisode arrive, pour que son pourcentage avance ; jamais sinon.
      refreshInterval: (latest) =>
        latest?.seasons.some((season) => season.episodes.some((ep) => ep.downloading != null)) ? DOWNLOAD_REFRESH_MS : 0,
    }
  );

  const seasons = useMemo(() => data?.seasons ?? [], [data]);
  const bySeason = useMemo(() => new Map(seasons.map((s) => [s.seasonNumber, s])), [seasons]);

  return {
    /** Toutes les saisons qui ont au moins un épisode absent. */
    seasons,
    seasonOf: (n: number): MissingSeason | undefined => bySeason.get(n),
  };
}
