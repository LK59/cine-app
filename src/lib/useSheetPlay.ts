"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { useSheetPlayFacts, type SheetPlayFacts } from "@/lib/sheetFacts";
import { useFileMissing } from "@/lib/missingFiles";
import { usePlaybackPrefetch } from "@/lib/usePlaybackPrefetch";
import { useNextEpisodeFromCache } from "@/lib/useNextEpisodeFromCache";
import { formatContinueLabel } from "@/lib/cinemaContinueLabel";
import { offlinePlayLabels, sharedResumeSeconds, useOfflinePlayable } from "@/components/offline/OfflineDownloadControl";
import { useT } from "@/components/TranslationProvider";
import type { OfflineDownload } from "@/lib/offline/downloads";
import type { CinemaProgressPayload } from "@/app/api/cinema/progress/[itemId]/route";
import type { CinemaEpisodesPayload } from "@/app/api/cinema/series/[jellyfinId]/episodes/route";
import type { CinemaSeries } from "@/app/api/cinema/series/route";

/**
 * Ce qu'une fiche de titre demande pour son bouton Lire (DECISIONS.md §114.7, sur §1, §2, §12, §29).
 *
 * La fiche film et la fiche série du bureau, celle du téléphone et celle d'un lien de partage
 * recopiaient les mêmes expressions — la réponse de Jellyfin traduite en faits serveur (« connu »
 * veut dire que Jellyfin a répondu, pas que la requête est revenue), la place tenue d'une série jamais
 * commencée, l'attente d'un S1·É1 supposé, le fichier introuvable, la copie hors ligne, le code de
 * l'épisode, le libellé « Lire en ligne », le préchargement, l'épisode suivant (audit du 23/10/2026).
 * Une seule écriture ici ; chaque fiche garde son dessin.
 *
 * Un film : la position vient de la réponse de `useJellyfinItemState`, que la fiche tient déjà pour
 * « Vu » — même clé, même réponse. Une série : la liste de ses épisodes, lue ici.
 */
export type SheetPlayTitle =
  | { kind: "movie"; jellyfinItemId: string; title: string; progress: CinemaProgressPayload | undefined }
  | {
      kind: "series";
      jellyfinItemId: string;
      title: string;
      sonarrId: number | null | undefined;
      firstEpisode?: CinemaSeries["firstEpisode"];
    };

export interface SheetPlay {
  facts: SheetPlayFacts;
  /** La liste des épisodes d'une série (`undefined` pour un film, et tant qu'elle n'est pas là). */
  episodesData: CinemaEpisodesPayload | undefined;
  episodesError: unknown;
  /** Une série jamais commencée dont la liste n'est pas encore là : la ligne de Lire garde sa place. */
  playPending: boolean;
  /** « Lire S1·É1 » supposé d'après le catalogue : un appui attend la réponse du serveur. */
  waitForServer: boolean;
  /** Jellyfin a répondu que le fichier de ce que Lire lancerait n'existe plus. */
  fileMissing: boolean;
  /** Le téléchargement lisible de ce que Lire lancerait, s'il y en a un. */
  offlinePlayable: OfflineDownload | null;
  /** « S1:É5 » quand Lire lance un épisode connu. */
  episodeCode: string | null;
  /** Le libellé de Lire : « Lire en ligne » quand un téléchargement passe en tête, sinon celui de la reprise. */
  label: string;
  getNextEpisode: ((currentItemId: string) => { itemId: string; title: string } | null) | undefined;
}

export function useSheetPlay(
  title: SheetPlayTitle,
  {
    /** Préparer ce que Lire va demander (`usePlaybackPrefetch`) — non quand le lien d'un invité est plein. */
    prefetch = true,
    /** La copie hors ligne compte-t-elle ? Non chez l'invité, qui n'a ni téléchargement ni lecteur hors ligne. */
    offline = true,
  }: { prefetch?: boolean; offline?: boolean } = {}
): SheetPlay {
  const t = useT();
  const isSeries = title.kind === "series";
  const episodesKey = `/api/cinema/series/${title.jellyfinItemId}/episodes`;
  const { data: episodesData, error: episodesError } = useSWR<CinemaEpisodesPayload>(isSeries ? episodesKey : null, fetcher);
  const progress = title.kind === "movie" ? title.progress : undefined;
  // L'épisode que Lire lancerait : celui du serveur quand la liste est là, sinon celui que « À
  // suivre » ou « Reprendre », gardés sur l'appareil, connaissent déjà — voir `sheetFacts.ts`. Pour un
  // film, `known` est la réponse de Jellyfin, pas l'arrivée de la requête : la route revient avec
  // `known: false` quand Jellyfin n'a pas répondu, et ce silence se lisait « aucune reprise ».
  const facts = useSheetPlayFacts(
    title.kind === "series"
      ? { kind: "series", jellyfinItemId: title.jellyfinItemId, sonarrId: title.sonarrId, firstEpisode: title.firstEpisode }
      : { kind: "movie", jellyfinItemId: title.jellyfinItemId },
    title.title,
    isSeries
      ? episodesData
        ? { kind: "series", known: true, episode: episodesData.nextEpisode }
        : undefined
      : progress
        ? { kind: "movie", known: progress.known === true, resumeTicks: progress.resumeTicks, runtimeTicks: progress.runtimeTicks }
        : undefined
  );
  // Une série jamais commencée : rien d'autre que la liste des épisodes ne dit quel épisode lire.
  const playPending = isSeries && !facts.targetId && episodesData === undefined && episodesError === undefined;
  // Grisé seulement si Jellyfin a répondu que le fichier n'existe plus — voir `missingFiles.ts`.
  const fileMissing = useFileMissing(facts.targetId);
  // Le film, ou l'épisode que Lire lancerait : téléchargé, il passe en tête (Louis, 19/10/2026).
  const offlinePlayable = useOfflinePlayable(offline ? facts.targetId : null, offline);
  // Ce que Lire va demander, demandé dès l'ouverture de la fiche — le titre du bouton principal
  // seulement, pas chaque ligne d'épisode. Voir `usePlaybackPrefetch`.
  usePlaybackPrefetch(prefetch ? facts.targetId : null);
  // Relu à l'appel, pas figé au rendu : voir `useNextEpisodeFromCache`.
  const nextFromCache = useNextEpisodeFromCache(episodesKey);
  const episodeCode =
    facts.seasonNumber != null && facts.episodeNumber != null ? t("cinema.episodeShort", { episode: facts.episodeNumber, season: facts.seasonNumber }) : null;
  // Le libellé de « Continuer à regarder » (« Reprendre S2:É3 · 30 min »), le même que la rangée d'où
  // l'on vient peut-être ; « Lire en ligne » quand le téléchargement passe en tête (19/10/2026).
  const label = offlinePlayable
    ? offlinePlayLabels(t, sharedResumeSeconds(offlinePlayable, facts.resumeTicks, facts.resumeKnown), offlinePlayable.runtimeSeconds, offlinePlayable.state === "done", episodeCode).online
    : formatContinueLabel(t, facts.resumeTicks, facts.runtimeTicks, facts.seasonNumber, facts.episodeNumber, facts.rewatch);
  return {
    facts,
    episodesData,
    episodesError,
    playPending,
    waitForServer: facts.guessed && episodesError === undefined,
    fileMissing,
    offlinePlayable,
    episodeCode,
    label,
    getNextEpisode: isSeries ? nextFromCache : undefined,
  };
}
