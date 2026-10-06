"use client";

import { useState } from "react";
import { mutate as globalMutate } from "swr";
import { apiAction } from "@/lib/apiAction";
import { revalidateWatchState } from "@/lib/swr";
import { useT } from "@/components/TranslationProvider";
import { useToast } from "@/components/Toast";

/**
 * Le bouton « Vu » d'un titre désigné par TMDB — la fiche de découverte, pour un titre que la
 * bibliothèque n'a pas forcément (DECISIONS.md §51). Les fiches de la bibliothèque gardent le leur
 * (`useJellyfinItemState`), qui connaît l'élément Jellyfin.
 *
 * Optimiste sur la clé de la fiche ; « Ma liste » et les rangées de reprise sont relues ensuite,
 * comme après tout geste qui change le vu.
 */
export function useTitleWatched(
  title: { type: "movie" | "series"; tmdbId: number; title: string; year: number | null; posterPath: string | null; watched: boolean } | null,
  key: string
) {
  const t = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (!title || busy) return;
    const next = !title.watched;
    setBusy(true);
    void globalMutate(key, (d: Record<string, unknown> | undefined) => (d ? { ...d, watched: next } : d), { revalidate: false });
    try {
      const answer = (await apiAction("/api/player/watched", {
        method: "POST",
        body: JSON.stringify({ type: title.type, tmdbId: title.tmdbId, watched: next, title: title.title, year: title.year, posterPath: title.posterPath }),
      })) as { stillWatched?: boolean } | null;
      toast.success(
        answer?.stillWatched
          ? t("cinema.seriesStillWatched")
          : t(next ? (title.type === "series" ? "cinema.seriesMarkedWatched" : "cinema.markedWatched") : title.type === "series" ? "cinema.seriesMarkedUnwatched" : "cinema.markedUnwatched")
      );
      void globalMutate(key);
      void globalMutate("/api/player/lists");
      void revalidateWatchState(null);
    } catch (error) {
      void globalMutate(key);
      toast.error(error instanceof Error && error.message ? error.message : t("common.unknown"));
    } finally {
      setBusy(false);
    }
  }

  return { watched: title?.watched ?? false, busy, toggle };
}
