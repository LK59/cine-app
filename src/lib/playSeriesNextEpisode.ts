"use client";

import type { CinemaEpisodesPayload } from "@/app/api/cinema/series/[jellyfinId]/episodes/route";
import { useCallback } from "react";
import { nextEpisodeIn } from "@/lib/nextEpisode";
import { useToast } from "@/components/Toast";
import { useT } from "@/components/TranslationProvider";

interface PlaybackLike {
  play: (session: {
    itemId: string;
    title: string;
    resumeAt?: number;
    getNextEpisode?: (currentItemId: string) => { itemId: string; title: string } | null;
  }) => void;
}

// A series' own Jellyfin id is not playable — only an episode is. Anywhere a "Lire" button sits
// on a series (a hero, a card), what it has to start is Jellyfin's next-up episode for that
// series: where you stopped, or S1E1 if you never started.
//
// Resolved on click rather than fetched up front: a rotating hero would otherwise pull the
// episode list for every title it cycles past, and this endpoint hits Jellyfin twice per call.
// The one request this makes is on the path of a press the user is already waiting on.
export async function playSeriesNextEpisode(
  playback: PlaybackLike,
  series: { jellyfinItemId: string; title: string }
): Promise<boolean> {
  // `false` plutôt qu'une exception, dans tous les cas où rien ne démarre : l'appel part d'un
  // bouton, sans personne pour rattraper. Hors ligne, `fetch` levait « Load failed », qui finissait
  // en rejet non géré dans server.log, et l'appui sur « Lire » ne faisait rien à l'écran. C'est à
  // l'appelant de dire que rien n'a démarré — voir `usePlaySeriesNextEpisode`.
  let data: CinemaEpisodesPayload;
  try {
    const res = await fetch(`/api/cinema/series/${series.jellyfinItemId}/episodes`);
    if (!res.ok) return false;
    data = await res.json();
  } catch {
    return false;
  }
  const next = data?.nextEpisode;
  if (!next) return false;

  // Same flat (season, episode) order the detail sheet hands the player, so the credits-time
  // auto-advance works identically whether playback started from here or from the sheet.
  playback.play({
    itemId: next.itemId,
    title: next.title,
    resumeAt: next.resumeTicks ? next.resumeTicks / 10_000_000 : 0,
    getNextEpisode: nextEpisodeIn(data.seasons),
  });
  return true;
}

/**
 * Le même geste, avec ce qu'on dit quand rien ne démarre.
 *
 * Un `false` que personne ne lisait : la bannière du téléphone jetait la promesse, et un appui sur
 * « Lire » hors ligne — ou sur une série dont Jellyfin ne connaît aucun épisode — ne faisait
 * strictement rien. Un message, et un seul endroit pour l'écrire, pour que le prochain bouton
 * « Lire » posé sur une série n'ait pas à y penser.
 */
export function usePlaySeriesNextEpisode(playback: PlaybackLike): (series: { jellyfinItemId: string; title: string }) => Promise<boolean> {
  const toast = useToast();
  const t = useT();
  return useCallback(
    async (series) => {
      const started = await playSeriesNextEpisode(playback, series);
      if (!started) toast.error(t("cinema.playSeriesFailed", { title: series.title }));
      return started;
    },
    [playback, toast, t]
  );
}
