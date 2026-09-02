"use client";

import type { CinemaEpisodesPayload } from "@/app/api/cinema/series/[jellyfinId]/episodes/route";

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
  const res = await fetch(`/api/cinema/series/${series.jellyfinItemId}/episodes`);
  if (!res.ok) return false;
  const data: CinemaEpisodesPayload = await res.json();
  const next = data.nextEpisode;
  if (!next) return false;

  // Same flat (season, episode) order the detail sheet hands the player, so the credits-time
  // auto-advance works identically whether playback started from here or from the sheet.
  const flat = data.seasons.flatMap((s) => s.episodes);
  playback.play({
    itemId: next.itemId,
    title: next.title,
    resumeAt: next.resumeTicks ? next.resumeTicks / 10_000_000 : undefined,
    getNextEpisode: (currentItemId: string) => {
      const idx = flat.findIndex((e) => e.jellyfinItemId === currentItemId);
      if (idx === -1 || idx === flat.length - 1) return null;
      return { itemId: flat[idx + 1].jellyfinItemId, title: flat[idx + 1].title };
    },
  });
  return true;
}
