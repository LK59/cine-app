"use client";

import { canJoinWatchlist, useAddToWatchlist } from "@/lib/useAddToWatchlist";
import { useWatchlistStatusMap } from "@/lib/useWatchlistStatusMap";
import type { WatchlistStatus } from "@/lib/db";

export interface WatchlistToggleRef {
  mediaType: "movie" | "series";
  tmdbId: number | null | undefined;
  title: string;
  year: number | null | undefined;
  posterPath: string | null | undefined;
  voteAverage?: number | null;
}

/**
 * « À voir » d'une fiche de titre — bibliothèque ou TMDB (DECISIONS.md §114.4).
 *
 * Deux crochets écrivaient la même ligne : `useAddToWatchlist` sur les fiches de la bibliothèque
 * (optimiste, « Ajouté à ma liste »), `usePlayerTitleActions.setStatus` sur la fiche TMDB (grisé
 * pendant l'écriture, « Ajouté à « Ma liste » »). Le même geste changeait de message selon la fiche
 * qu'un titre de saga ouvrait (audit du 23/10/2026). Un seul ici, avec la garde `canJoinWatchlist` :
 * sans identifiant TMDB, rien à proposer (`listable` faux) et rien à écrire.
 *
 * L'état de départ : celui que la fiche tient déjà (`known` — la fiche TMDB le reçoit avec le titre),
 * sinon celui que `bulk-status` répond pour ce titre.
 */
export function useWatchlistToggle(ref: WatchlistToggleRef, known?: { status: WatchlistStatus | null }) {
  const listable = canJoinWatchlist(ref.tmdbId);
  const statusMap = useWatchlistStatusMap(listable && !known ? [{ mediaType: ref.mediaType, tmdbId: ref.tmdbId as number }] : []);
  const initial = known ? known.status : listable ? (statusMap[`${ref.mediaType}:${ref.tmdbId}`] ?? null) : null;
  const { addedStatus, addToWatchlist, removeFromWatchlist } = useAddToWatchlist(initial);
  const inList = addedStatus === "to_watch";

  function toggle() {
    if (!canJoinWatchlist(ref.tmdbId)) return;
    const tmdbId = ref.tmdbId;
    if (inList) removeFromWatchlist({ tmdbId, mediaType: ref.mediaType });
    else
      addToWatchlist(
        { tmdbId, mediaType: ref.mediaType, title: ref.title, year: ref.year ?? null, posterPath: ref.posterPath ?? null, voteAverage: ref.voteAverage ?? null },
        "to_watch"
      );
  }

  return { listable, inList, toggle };
}
