"use client";

import useSWR from "swr";
import { fetcher, NEXT_UP_KEY, RESUME_KEY } from "@/lib/swr";
import type { CinemaNextUpItem, CinemaNextUpPayload } from "@/app/api/cinema/next-up/route";

/**
 * Ce qu'une fiche affiche avant que le réseau ait répondu — une seule décision, pour les quatre
 * fiches d'un titre de la bibliothèque (film et série, bureau et téléphone).
 *
 * 25/09/2026, Louis : à l'ouverture d'une fiche, les informations arrivaient les unes après les
 * autres, sans animation — le bouton Lire un instant plus tard, puis la durée, puis « Reprendre ·
 * 1 h 10 restantes » à la place de « Lire ». Or presque tout était déjà sur l'appareil :
 *
 *  - **la durée, l'année, les genres, le synopsis** viennent du catalogue, gardé sur l'appareil
 *    (`persistentCache.ts`). La fiche attendait la durée et le synopsis de TMDB, via la
 *    description Radarr/Sonarr, et le synopsis changeait même de texte sous les yeux à son
 *    arrivée. Le catalogue d'abord, TMDB seulement quand le catalogue n'a rien ;
 *  - **« Reprendre » et sa durée restante** sont dans les flux « Reprendre » et « À suivre »,
 *    gardés eux aussi. La fiche attendait la position lue chez Jellyfin.
 *
 * Et un bouton affiché d'emblée ne ment jamais sur la position : tant que Jellyfin n'a pas répondu,
 * `resumeKnown` reste faux, et « Lire » laisse alors le serveur fournir la position au lieu
 * d'affirmer un départ (CLAUDE.md : `resumeAt` absent = « demande au serveur »). Les ticks locaux ne
 * servent qu'au libellé et à la barre. Quand Jellyfin répond, sa réponse l'emporte — le libellé se
 * corrige, sans changer la taille de la ligne.
 *
 * Seulement pour un titre de la bibliothèque : les fiches TMDB (découverte, personnes) et les films
 * demandés mais pas encore là n'ont pas de bouton Lire, et ne passent pas ici.
 */

/** Ce que la reprise locale dit d'un titre, ou `null`. */
export interface LocalPlayTarget {
  /** L'élément que Lire lancerait : le film, ou l'épisode à reprendre. */
  itemId: string;
  resumeTicks: number | null;
  runtimeTicks: number | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
}

/** Ce que porte une ligne du flux « Reprendre » — seuls les champs lus ici. */
export interface ResumeFeedItem {
  id: string;
  positionTicks: number;
  runtimeTicks: number;
  /** `/radarr/12` ou `/sonarr/34`. */
  cinemaHref: string | null;
}

export type SheetTitle =
  | { kind: "movie"; jellyfinItemId: string }
  | { kind: "series"; jellyfinItemId: string; sonarrId: number | null | undefined };

/**
 * Ce que les flux gardés sur l'appareil savent de ce titre.
 *
 * Un film : sa ligne dans « Reprendre ». Une série : son épisode dans « À suivre » (celui que
 * Jellyfin propose), sinon un épisode de la série en cours dans « Reprendre ».
 */
export function localPlayTarget(
  title: SheetTitle,
  resume: readonly ResumeFeedItem[] | undefined,
  nextUp: readonly CinemaNextUpItem[] | undefined
): LocalPlayTarget | null {
  if (title.kind === "movie") {
    const entry = resume?.find((r) => r.id === title.jellyfinItemId);
    return entry
      ? { itemId: entry.id, resumeTicks: entry.positionTicks || null, runtimeTicks: entry.runtimeTicks || null, seasonNumber: null, episodeNumber: null }
      : null;
  }
  if (title.sonarrId == null) return null;
  const next = nextUp?.find((n) => n.sonarrId === title.sonarrId);
  if (next) {
    return {
      itemId: next.jellyfinItemId,
      resumeTicks: next.resumeTicks,
      runtimeTicks: next.runtimeTicks,
      seasonNumber: next.seasonNumber,
      episodeNumber: next.episodeNumber,
    };
  }
  const entry = resume?.find((r) => r.cinemaHref === `/sonarr/${title.sonarrId}`);
  return entry
    ? { itemId: entry.id, resumeTicks: entry.positionTicks || null, runtimeTicks: entry.runtimeTicks || null, seasonNumber: null, episodeNumber: null }
    : null;
}

/** Ce que le serveur a dit de la reprise : la position d'un film chez Jellyfin, ou l'épisode d'une série. */
export type ServerPlayFacts =
  | { kind: "movie"; known: boolean; resumeTicks: number | null | undefined; runtimeTicks: number | null | undefined }
  | {
      kind: "series";
      /** La liste des épisodes est arrivée — `episode` peut alors être nul : rien à lire. */
      known: boolean;
      episode: {
        itemId: string;
        title: string;
        resumeTicks?: number | null;
        runtimeTicks?: number | null;
        seasonNumber: number;
        episodeNumber: number;
        rewatch?: boolean;
      } | null;
    };

/** Ce que le bouton de lecture de la fiche montre, et ce qu'il demande. */
export interface SheetPlayFacts {
  /** Ce que Lire lance ; `null` tant qu'on ne le sait pas (une série encore jamais commencée). */
  targetId: string | null;
  /** Le titre donné au lecteur : celui de l'épisode quand le serveur l'a dit, sinon celui de la fiche. */
  title: string;
  /** Pour le libellé et la barre ; jamais pour la position, tant que `resumeKnown` est faux. */
  resumeTicks: number | null;
  runtimeTicks: number | null;
  /** Vrai seulement quand le serveur a répondu : sinon, Lire laisse le serveur fournir la position. */
  resumeKnown: boolean;
  /** Une reprise à montrer — ce qui fait aussi paraître « Recommencer ». */
  hasResume: boolean;
  seasonNumber: number | null;
  episodeNumber: number | null;
  rewatch: boolean;
}

export function sheetPlayFacts(fallbackTitle: string, server: ServerPlayFacts | undefined, local: LocalPlayTarget | null): SheetPlayFacts {
  const make = (
    targetId: string | null,
    title: string,
    resumeTicks: number | null | undefined,
    runtimeTicks: number | null | undefined,
    resumeKnown: boolean,
    seasonNumber: number | null = null,
    episodeNumber: number | null = null,
    rewatch = false
  ): SheetPlayFacts => ({
    targetId,
    title,
    resumeTicks: resumeTicks ?? null,
    runtimeTicks: runtimeTicks ?? null,
    resumeKnown,
    hasResume: !!resumeTicks && resumeTicks > 0,
    seasonNumber,
    episodeNumber,
    rewatch,
  });

  if (server?.kind === "movie") {
    if (server.known) return make(null, fallbackTitle, server.resumeTicks, server.runtimeTicks, true);
  } else if (server?.kind === "series" && server.known) {
    const ep = server.episode;
    if (!ep) return make(null, fallbackTitle, null, null, true);
    return make(ep.itemId, ep.title, ep.resumeTicks, ep.runtimeTicks, true, ep.seasonNumber, ep.episodeNumber, ep.rewatch ?? false);
  }
  // Le serveur n'a pas encore répondu : ce que l'appareil sait, affiché sans être affirmé.
  if (local) return make(local.itemId, fallbackTitle, local.resumeTicks, local.runtimeTicks, false, local.seasonNumber, local.episodeNumber);
  return make(null, fallbackTitle, null, null, false);
}

/**
 * Les faits du bouton de lecture pour une fiche : ce que le serveur a dit s'il a répondu, sinon ce
 * que les flux gardés sur l'appareil savent.
 *
 * Les flux sont lus sans être redemandés (`revalidateOnMount: false`) : l'accueil les tient déjà à
 * jour, et une fiche n'a pas à relancer « Reprendre » à chaque ouverture.
 *
 * `targetId` d'un film est toujours le film lui-même — la fiche le complète.
 */
export function useSheetPlayFacts(title: SheetTitle, fallbackTitle: string, server: ServerPlayFacts | undefined): SheetPlayFacts {
  const readOnly = { revalidateOnMount: false, revalidateIfStale: false, revalidateOnFocus: false } as const;
  const { data: resume } = useSWR<{ items: ResumeFeedItem[] }>(RESUME_KEY, fetcher, readOnly);
  const { data: nextUp } = useSWR<CinemaNextUpPayload>(title.kind === "series" ? NEXT_UP_KEY : null, fetcher, readOnly);
  const facts = sheetPlayFacts(fallbackTitle, server, localPlayTarget(title, resume?.items, nextUp?.items));
  return title.kind === "movie" ? { ...facts, targetId: title.jellyfinItemId } : facts;
}

/** La durée : celle du catalogue d'abord, celle de TMDB seulement quand le catalogue n'en a pas. */
export function sheetRuntimeMinutes(catalogue: number | null | undefined, tmdb: number | null | undefined): number | null {
  return catalogue && catalogue > 0 ? catalogue : tmdb && tmdb > 0 ? tmdb : null;
}

/**
 * Le synopsis : celui du catalogue, qui est là dès l'ouverture ; celui de TMDB seulement quand le
 * catalogue n'en a pas. L'inverse faisait changer le texte sous les yeux à l'arrivée de TMDB.
 */
export function sheetOverview(catalogue: string | null | undefined, tmdb: string | null | undefined): string {
  return catalogue?.trim() ? catalogue : tmdb?.trim() ? tmdb : "";
}
