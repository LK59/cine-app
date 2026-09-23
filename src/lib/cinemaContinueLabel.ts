import { formatDurationShort } from "@/lib/format";

type TFn = (key: string, vars?: Record<string, string | number>) => string;

// Netflix-style resume label — "À suivre S1 · É3" (a series with an unwatched next episode ready,
// no progress yet), "Reprendre S1 · É3 · 30min restantes" (an episode partway through), or
// "Reprendre · 1h10 restantes" (a movie partway through). Shared between CinemaClient's Continue Watching
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
  episodeNumber?: number | null,
  /** Une série vue en entier, relancée depuis le premier épisode : « Lire », pas « À suivre ». */
  rewatch?: boolean
): string {
  const hasResume = !!resumeTicks && resumeTicks > 0;
  const remaining = hasResume && runtimeTicks ? Math.max(runtimeTicks - resumeTicks!, 0) : null;
  const timeLabel = remaining !== null ? t("cinema.timeRemaining", { time: formatDurationShort(remaining) }) : null;
  const episodeCode =
    seasonNumber != null && episodeNumber != null
      ? t("cinema.episodeShort", { episode: episodeNumber, season: seasonNumber })
      : null;

  if (episodeCode && rewatch) return `${t("common.play")} ${episodeCode}`;
  if (episodeCode) {
    // Un épisode jamais commencé n'est pas une lecture à reprendre : c'est la suite qui attend.
    // « À suivre » le dit, là où « Lire » ne disait rien de plus qu'un bouton.
    return hasResume && timeLabel
      ? `${t("common.resume")} ${episodeCode} · ${timeLabel}`
      : `${t("cinema.upNext")} ${episodeCode}`;
  }
  return hasResume && timeLabel ? `${t("common.resume")} · ${timeLabel}` : t("common.play");
}

/** « 1h10 », « 25 min » : l'espace avant « min » que la forme courte des boutons n'a pas la place de mettre. */
function remainingText(remainingTicks: number): string {
  const minutes = Math.max(1, Math.round(remainingTicks / 10_000_000 / 60));
  const h = Math.floor(minutes / 60);
  return h > 0 ? `${h}h${String(minutes % 60).padStart(2, "0")}` : `${minutes} min`;
}

/**
 * La ligne sous une carte de « Reprendre » — sans verbe, puisque la rangée s'appelle déjà ainsi.
 *
 * Elle réutilisait l'étiquette du bouton : « Reprendre Ep3 S1 - 25min re… », coupée, qui répétait
 * le nom de la rangée juste au-dessus et nommait l'épisode avant la saison (23/09/2026). Elle dit
 * maintenant « S1 · É3 · 25 min restantes » ; « À suivre » reste là où rien n'est commencé, parce
 * que c'est la seule chose qui distingue la suite d'une reprise.
 */
export function formatContinueCaption(
  t: TFn,
  resumeTicks: number | null | undefined,
  runtimeTicks: number | null | undefined,
  seasonNumber?: number | null,
  episodeNumber?: number | null
): string {
  const hasResume = !!resumeTicks && resumeTicks > 0;
  const time =
    hasResume && runtimeTicks ? t("cinema.timeRemaining", { time: remainingText(Math.max(runtimeTicks - resumeTicks!, 0)) }) : null;
  const episodeCode =
    seasonNumber != null && episodeNumber != null
      ? t("cinema.episodeShort", { episode: episodeNumber, season: seasonNumber })
      : null;
  if (episodeCode) return time ? `${episodeCode} · ${time}` : `${t("cinema.upNext")} · ${episodeCode}`;
  return time ?? t("common.resume");
}
