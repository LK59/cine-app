import { formatDurationShort } from "@/lib/format";

type TFn = (key: string, vars?: Record<string, string | number>) => string;

// Netflix-style resume label — "Lire EpX SX" (a series with an unwatched next episode ready, no
// progress yet), "Reprendre EpX SX - 30min restants" (an episode partway through), or "Reprendre
// - 1h10 restants" (a movie partway through). Shared between CinemaClient's Continue Watching
// cards and CinemaSeriesDetail's own "Lire"/"Reprendre" row, so both read the same wherever they
// show up (they used to disagree: PlayButton's own default label showed ELAPSED time and no
// episode code, since it's a generic label meant for every Lire button in the app, not just
// Cinema Mode's — this fixes that mismatch by passing an explicit override from here instead of
// changing PlayButton's default, which is still what every other page's own Lire button uses).
export function formatContinueLabel(
  t: TFn,
  resumeTicks: number | null | undefined,
  runtimeTicks: number | null | undefined,
  seasonNumber?: number | null,
  episodeNumber?: number | null
): string {
  const hasResume = !!resumeTicks && resumeTicks > 0;
  const remaining = hasResume && runtimeTicks ? Math.max(runtimeTicks - resumeTicks!, 0) : null;
  const timeLabel = remaining !== null ? t("cinema.timeRemaining", { time: formatDurationShort(remaining) }) : null;
  const episodeCode =
    seasonNumber != null && episodeNumber != null
      ? t("cinema.episodeShort", { episode: episodeNumber, season: seasonNumber })
      : null;

  if (episodeCode) {
    // Un épisode jamais commencé n'est pas une lecture à reprendre : c'est la suite qui attend.
    // « À suivre » le dit, là où « Lire » ne disait rien de plus qu'un bouton.
    return hasResume && timeLabel
      ? `${t("common.resume")} ${episodeCode} - ${timeLabel}`
      : `${t("cinema.upNext")} ${episodeCode}`;
  }
  return hasResume && timeLabel ? `${t("common.resume")} - ${timeLabel}` : t("common.play");
}
