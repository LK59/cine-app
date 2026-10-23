import type { PlaybackSession } from "@/components/PlaybackProvider";
import { formatDurationShort, formatMinutes } from "@/lib/format";
import { episodeResumeAt } from "@/lib/nextEpisode";

/**
 * Ce qu'une ligne d'épisode dit, et ce qu'elle lance — pour les trois listes d'épisodes des fiches :
 * l'écran des épisodes du bureau (`CinemaEpisodeBrowser`), la fiche du téléphone et la fiche d'un
 * lien de partage au téléphone (DECISIONS.md §114.6). Chacune garde son dessin.
 *
 * La règle du temps était écrite trois fois et le lancement quatre (audit du 23/10/2026) : identiques
 * ce jour-là, elles auraient dérivé à la première correction.
 */

interface EpisodeLike {
  jellyfinItemId: string;
  title: string;
  watched: boolean;
  resumeTicks: number | null;
  runtimeTicks: number | null;
  runtimeMinutes: number | null;
}

export interface EpisodeRowFacts {
  /**
   * Le temps qui reste, déjà mis en forme (« 23min »), pour un épisode commencé et pas fini — c'est le
   * nombre qu'on veut avant d'appuyer. `null` sinon : la durée le remplace.
   */
  remaining: string | null;
  /** La durée, déjà mise en forme, quand on la connaît et que le temps restant ne la remplace pas. */
  runtime: string | null;
  /** L'épisode que Lire lancerait (« À suivre »). */
  isNext: boolean;
}

export function episodeRowFacts(ep: EpisodeLike, nextEpisodeId: string | null | undefined): EpisodeRowFacts {
  const started = !!ep.resumeTicks && !!ep.runtimeTicks && !ep.watched;
  return {
    remaining: started ? formatDurationShort(ep.runtimeTicks! - ep.resumeTicks!) : null,
    runtime: !started && ep.runtimeMinutes ? formatMinutes(ep.runtimeMinutes) : null,
    isNext: ep.jellyfinItemId === nextEpisodeId,
  };
}

/** Lancer un épisode d'une liste : là où il en est (`episodeResumeAt`), avec la suite de la série. */
export function playEpisodeFrom(
  playback: { play: (session: PlaybackSession) => void },
  ep: EpisodeLike,
  getNextEpisode: PlaybackSession["getNextEpisode"]
): void {
  playback.play({ itemId: ep.jellyfinItemId, title: ep.title, resumeAt: episodeResumeAt(ep), getNextEpisode });
}
