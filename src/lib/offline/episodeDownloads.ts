"use client";

import { useSyncExternalStore } from "react";
import type { CinemaEpisode, CinemaEpisodesPayload, CinemaSeason } from "@/app/api/cinema/series/[jellyfinId]/episodes/route";
import type { DirectPlayAudioTrack, DirectPlayInfo } from "@/app/api/jellyfin/direct/[itemId]/route";
import { fetchDirectInfo } from "@/lib/directInfo";
import { displayTitle } from "@/lib/displayTitle";
import { nextEpisodeIn } from "@/lib/nextEpisode";
import { labelAudioTracks } from "@/lib/trackLabel";
import { trackLanguage } from "@/lib/trackPreferences";
import { offlineDownloadById, offlineEpisodesOf, startOfflineDownload, type OfflineDownload } from "./downloads";
import { expectedBytes, type OfflineCodec, type OfflineQuality } from "./quality";
import { applyResumeRules } from "./resumeRules";

/**
 * Les épisodes hors ligne (bêta, 19/10/2026) — ce que les lignes d'épisode, « Télécharger la saison »
 * et le lecteur hors ligne décident, écrit une fois (DECISIONS.md §109).
 *
 * Louis a voulu un bouton par épisode, à la Netflix, plutôt qu'un sélecteur global ; une saison entière
 * d'un geste, avec une seule question — la **langue**, puisque les pistes diffèrent d'un épisode à
 * l'autre — ; et le téléchargement automatique de l'épisode suivant (carte blanche) : à la moitié d'un
 * épisode lu depuis l'appareil, le suivant se demande aux mêmes choix, et un épisode vu jusqu'au bout
 * s'efface une fois la suite arrivée (`downloads.ts`, `markOfflineWatched`).
 */

/** Ce qu'il faut savoir de la série pour demander un de ses épisodes. */
export interface OfflineSeriesRef {
  /** L'identifiant Jellyfin de la série : sa liste d'épisodes (`/api/cinema/series/<id>/episodes`). */
  seriesItemId: string;
  sonarrId: number | null;
  seriesTitle: string;
}

/** Les traductions dont l'étiquette d'une piste a besoin (`labelAudioTracks`). */
export interface TrackLabeller {
  locale: string;
  canaux: (n: number) => string;
  piste: (n: number) => string;
}

export interface OfflineTrack {
  index: number;
  label: string;
  track: DirectPlayAudioTrack;
}

/** Les pistes son d'un fichier, nommées comme les lecteurs les nomment (`trackLabel.ts`). */
export function offlineTracks(info: DirectPlayInfo, labeller: TrackLabeller): OfflineTrack[] {
  const labels = labelAudioTracks(
    info.audio.map((a) => ({ number: a.index, language: a.language, name: a.displayTitle, isDefault: a.isDefault, isForced: false, codecId: a.codec, channels: a.channels, profile: a.profile })),
    { ...labeller, originalLanguage: info.originalLanguage }
  );
  return info.audio.map((a, i) => ({ index: a.index, label: labels[i]?.label ?? String(a.index), track: a }));
}

/** La langue d'une piste — déclarée, sinon lue dans son titre (`trackLanguage`). */
export function audioTrackLanguage(track: Pick<DirectPlayAudioTrack, "language" | "displayTitle" | "isDefault">): string | null {
  return trackLanguage({ language: track.language, name: track.displayTitle, isDefault: track.isDefault, isForced: false });
}

/**
 * La piste gardée pour une langue : la première dans cette langue, sinon celle que le fichier marque
 * par défaut, sinon la première. La même règle pour la piste préchoisie d'un film (la langue du compte)
 * et pour chaque épisode d'une saison (la langue choisie une fois pour toutes).
 */
export function trackForLanguage<T extends { track: Pick<DirectPlayAudioTrack, "language" | "displayTitle" | "isDefault"> }>(
  tracks: T[],
  language: string | null
): T | null {
  const inLanguage = language ? tracks.find((x) => audioTrackLanguage(x.track) === language) : undefined;
  return inLanguage ?? tracks.find((x) => x.track.isDefault) ?? tracks[0] ?? null;
}

/**
 * Le titre d'un épisode téléchargé, écrit comme le lecteur écrit le sien (`displayTitle`) :
 * « Série — S01E02 · Titre ». Le gestionnaire et le lecteur hors ligne le montrent tel quel.
 */
export function offlineEpisodeTitle(seriesTitle: string, episode: Pick<CinemaEpisode, "seasonNumber" | "episodeNumber" | "title">): string {
  return displayTitle(
    { Type: "Episode", SeriesName: seriesTitle, ParentIndexNumber: episode.seasonNumber, IndexNumber: episode.episodeNumber, Name: episode.title },
    episode.title
  );
}

/** Sur l'appareil ou en route : tout sauf un échec — un échec se redemande. */
function held(itemId: string, downloads: OfflineDownload[]): boolean {
  return downloads.some((d) => d.itemId === itemId && d.state !== "failed");
}

/** Les épisodes d'une saison qui ne sont pas encore sur l'appareil, dans l'ordre de la saison. */
export function episodesToDownload(episodes: CinemaEpisode[], downloads: OfflineDownload[]): CinemaEpisode[] {
  return episodes.filter((e) => !held(e.jellyfinItemId, downloads));
}

/** Ce qu'une liste d'épisodes pèsera, à cette qualité — la durée au débit demandé (`expectedBytes`). */
export function estimatedEpisodesBytes(episodes: CinemaEpisode[], quality: OfflineQuality): number {
  return episodes.reduce((sum, e) => sum + (e.runtimeTicks ? expectedBytes(e.runtimeTicks / 1e7, quality) : 0), 0);
}

/** Ce que la fenêtre de choix a tranché pour un ou plusieurs épisodes. */
export interface EpisodeChoice {
  /** La langue voulue ; `null` : la piste par défaut de chaque épisode. */
  language: string | null;
  /** Une piste précise — un seul épisode, choisi dans sa propre liste de pistes. */
  audioIndex?: number;
  quality: OfflineQuality;
  codec: OfflineCodec;
  autoNext: boolean;
}

/** Demande un épisode : ses pistes lues, la bonne gardée, le téléchargement lancé. */
export async function requestEpisodeDownload(
  series: OfflineSeriesRef,
  episode: CinemaEpisode,
  seasons: CinemaSeason[],
  choice: EpisodeChoice,
  labeller: TrackLabeller
): Promise<void> {
  const info = await fetchDirectInfo(episode.jellyfinItemId);
  const tracks = offlineTracks(info, labeller);
  const track = (choice.audioIndex !== undefined ? tracks.find((x) => x.index === choice.audioIndex) : null) ?? trackForLanguage(tracks, choice.language);
  if (!track) throw new Error("aucune piste son");
  await startOfflineDownload({
    itemId: episode.jellyfinItemId,
    episode: {
      sonarrId: series.sonarrId,
      seriesTitle: series.seriesTitle,
      seasonNumber: episode.seasonNumber,
      episodeNumber: episode.episodeNumber,
      episodeTitle: episode.title,
      autoNext: choice.autoNext,
      seriesItemId: series.seriesItemId,
      // La langue de la piste gardée quand on a choisi une piste précise : c'est elle que l'épisode
      // suivant cherchera.
      audioLanguage: choice.audioIndex !== undefined ? audioTrackLanguage(track.track) : choice.language,
      next: nextEpisodeIn(seasons)(episode.jellyfinItemId),
    },
    radarrId: null,
    title: offlineEpisodeTitle(series.seriesTitle, episode),
    year: null,
    runtimeSeconds: info.runtimeSeconds ?? (episode.runtimeTicks ? episode.runtimeTicks / 1e7 : 0),
    audioIndex: track.index,
    audioLabel: track.label,
    audioTracks: tracks.map(({ index, label }) => ({ index, label })),
    quality: choice.quality,
    codec: choice.codec,
  });
}

/**
 * Une saison d'un geste : chaque épisode qui n'est pas sur l'appareil, l'un après l'autre — dans
 * l'ordre de la saison, que la boucle de l'appareil suit (le plus ancien d'abord). Un épisode refusé
 * n'arrête pas les autres ; les refus sont rendus pour être dits.
 */
export async function requestSeasonDownloads(
  series: OfflineSeriesRef,
  episodes: CinemaEpisode[],
  seasons: CinemaSeason[],
  choice: Omit<EpisodeChoice, "audioIndex">,
  labeller: TrackLabeller,
  downloads: () => OfflineDownload[]
): Promise<{ started: number; failed: { episode: CinemaEpisode; error: string; cause: unknown }[] }> {
  let started = 0;
  // `cause` : l'erreur elle-même, avec son code — l'écran la traduit (`apiErrorText`) ; le message seul
  // est celui du serveur, en français.
  const failed: { episode: CinemaEpisode; error: string; cause: unknown }[] = [];
  for (const episode of episodes) {
    // Relu à chaque tour : un épisode demandé entre-temps (sa ligne, l'automatique) n'est pas redemandé.
    if (held(episode.jellyfinItemId, downloads())) continue;
    try {
      await requestEpisodeDownload(series, episode, seasons, choice, labeller);
      started += 1;
    } catch (error) {
      failed.push({ episode, error: error instanceof Error ? error.message : String(error), cause: error });
    }
  }
  return { started, failed };
}

/** La moitié d'un épisode lu depuis l'appareil : le moment de demander le suivant. */
export const AUTO_NEXT_AT = 0.5;

export function autoNextDue(position: number, runtimeSeconds: number): boolean {
  return runtimeSeconds > 0 && position >= runtimeSeconds * AUTO_NEXT_AT;
}

/**
 * Vu jusqu'au bout : le seuil de Jellyfin (`resumeRules.ts`, 90 % par défaut, celui du serveur sinon),
 * le même que la position gardée. Un seuil à part (95 %) faisait d'un arrêt entre les deux un épisode
 * « vu » pour l'appareil mais pas pour le ménage automatique — ou l'inverse, selon le serveur
 * (relecture du 19/10/2026).
 */
export function watchedThrough(position: number, runtimeSeconds: number): boolean {
  return applyResumeRules(position, runtimeSeconds).watched;
}

export type AutoNextOutcome = "started" | "present" | "none" | "offline" | "skipped";

/**
 * Le téléchargement automatique : l'épisode qui suit `d` dans sa série (les spéciaux à part,
 * `nextEpisodeIn`), aux mêmes langue, qualité et codec — s'il n'est pas déjà sur l'appareil. Il faut
 * du réseau ; sans, on n'essaie pas (rien à dire : l'épisode se lit, la suite viendra la prochaine fois).
 */
export async function downloadNextEpisode(
  d: OfflineDownload,
  labeller: TrackLabeller,
  online: () => boolean = () => typeof navigator === "undefined" || navigator.onLine !== false
): Promise<AutoNextOutcome> {
  const facts = d.episode;
  if (!facts?.autoNext || !facts.seriesItemId) return "skipped";
  if (!online()) return "offline";
  const res = await fetch(`/api/cinema/series/${encodeURIComponent(facts.seriesItemId)}/episodes`, { cache: "no-store" });
  if (!res.ok) throw new Error(`épisodes ${res.status}`);
  const payload = (await res.json()) as CinemaEpisodesPayload;
  const seasons = payload.seasons ?? [];
  const next = nextEpisodeIn(seasons)(d.itemId);
  if (!next) return "none";
  const episode = seasons.flatMap((s) => s.episodes).find((e) => e.jellyfinItemId === next.itemId);
  if (!episode) return "none";
  if (held(episode.jellyfinItemId, offlineEpisodesOf(facts.sonarrId, facts.seriesTitle))) return "present";
  // Supprimé pendant qu'on lisait la liste : la suite n'a plus de raison d'être demandée.
  if (!offlineDownloadById(d.id)) return "skipped";
  await requestEpisodeDownload(
    { seriesItemId: facts.seriesItemId, sonarrId: facts.sonarrId, seriesTitle: facts.seriesTitle },
    episode,
    seasons,
    { language: facts.audioLanguage ?? null, quality: d.quality, codec: d.codec, autoNext: true },
    labeller
  );
  return "started";
}

/**
 * Où mène « Épisode suivant » depuis un épisode lu hors ligne : le fichier téléchargé s'il est
 * lisible (une séance hors ligne), sinon la lecture en ligne s'il y a du réseau, sinon rien — le
 * bouton disparaît plutôt que de promettre ce qu'il ne peut pas tenir.
 */
export function offlineNextTarget(
  current: OfflineDownload | null,
  downloads: OfflineDownload[],
  online: boolean,
  playable: (d: OfflineDownload) => boolean
): { itemId: string; title: string; offlineId: string | null } | null {
  const next = current?.episode?.next;
  if (!next) return null;
  const onDevice = downloads.find((d) => d.itemId === next.itemId && playable(d));
  if (onDevice) return { itemId: onDevice.itemId, title: onDevice.title, offlineId: onDevice.id };
  return online ? { itemId: next.itemId, title: next.title, offlineId: null } : null;
}

function subscribeOnline(listener: () => void): () => void {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

/** En ligne selon le navigateur — suivi, pour qu'un bouton qui en dépend apparaisse et disparaisse. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine !== false,
    () => true
  );
}
