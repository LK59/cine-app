"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import useSWR, { useSWRConfig } from "swr";
import type { CinemaNextUpItem, CinemaNextUpPayload } from "@/app/api/cinema/next-up/route";
import { continueOrder, type ContinueEntry } from "@/lib/continueOrder";
import { isAwaitingFresh, noteContinueReconciled, onFeedSettled, type ContinueChanges } from "@/lib/persistentCache";
import { prefersReducedMotion } from "@/lib/reducedMotion";
import { bannerResumeAt, feedResumeAt } from "@/lib/sheetFacts";
import { fetcher, liveFeedOptions, NEXT_UP_KEY, RESUME_KEY } from "@/lib/swr";
import { CATALOGUE_FLIP, useFlipGrid } from "@/lib/useFlipGrid";
import { interleaveLeaving } from "@/lib/useCatalogueRow";

/**
 * La rangée « Reprendre » des deux accueils — bureau et téléphone —, décidée une fois (DECISIONS.md
 * §86, 13/10/2026).
 *
 * Au lancement, la rangée est dessinée depuis le cache de l'appareil (`persistentCache.ts`) : chez
 * nous, une à deux machines par compte, il est presque toujours juste. Puis la réponse du serveur la
 * corrige sous les yeux, sans saut :
 *  - une carte qui change de place glisse (`useFlipGrid`, transform seulement) ;
 *  - une carte qui part s'efface sur place (`continue-leaving`, opacité + échelle), puis ses voisines
 *    glissent dans le trou ;
 *  - une carte qui arrive se pose (le même `useFlipGrid`) ;
 *  - une barre de progression glisse vers sa nouvelle valeur (`ProgressFill`) — ce qui suppose des
 *    clés stables par titre : la carte reste le même élément, seule sa valeur change.
 * « Réduire les animations » : rien ne bouge, la rangée est simplement remplacée.
 *
 * Et le garde-fou qui va avec : une carte, la bannière ou son bouton Lire dessinés depuis le cache ne
 * lancent **jamais** la position du cache. Un appui qui précède la réponse fraîche est retenu, puis
 * part avec ce qu'elle dit (`playWhenFresh`). Les deux écrans avaient chacun leurs `useSWR` sur ces
 * deux flux, leur tri, leur place tenue : trois décisions recopiées, que ce module rassemble.
 */

// Le flux « Reprendre » léger — /api/dashboard le porte aussi, mais seulement au milieu d'un tour de
// tous les services, du client torrent et des disques : beaucoup d'attente pour une rangée.
export interface CinemaResumeItem {
  id: string;
  name: string;
  type: string;
  progress: number;
  positionTicks: number;
  runtimeTicks: number;
  imageTag: string | null;
  /** `/radarr/12` ou `/sonarr/34` — ce qui relie une reprise à sa fiche. */
  cinemaHref: string | null;
  /** Quand il a été lu pour la dernière fois — l'ordre de la rangée (`continueOrder`). */
  lastPlayedAt?: string | null;
}

export type ContinueRowEntry = ContinueEntry<CinemaResumeItem, CinemaNextUpItem>;
/** Une carte de la rangée telle qu'elle est dessinée : `leaving`, elle est en train de partir. */
export type ShownContinueEntry = ContinueRowEntry & { leaving?: true };

export interface ContinueFeeds {
  resume: { items: CinemaResumeItem[] } | undefined;
  nextUp: CinemaNextUpPayload | undefined;
}

/** La durée de l'effacement d'une carte qui part — celle de `continue-leave`, globals.css. */
export const LEAVE_MS = 220;

/**
 * Combien de temps un « Lire » retenu attend la réponse fraîche. Au-delà, il part sans elle — et
 * toujours sans la position du cache : `resumeAt` absent, le serveur décide (CLAUDE.md, `resumeAt`).
 * Un appui qui ne fait rien pendant plus longtemps se lirait comme une panne.
 */
export const FRESH_WAIT_MAX_MS = 4000;

/**
 * Les cartes à dessiner : la nouvelle liste, plus celles qui viennent d'en sortir, laissées à leur
 * place le temps de s'effacer. Une carte partante reste après la dernière voisine qui, avant le
 * changement, la précédait et est toujours là — ou en tête, s'il n'y en a pas.
 */
export function withLeaving<E extends { key: string }>(before: readonly (E & { leaving?: true })[], next: readonly E[]): (E & { leaving?: true })[] {
  // Le placement est celui des rangées du catalogue (§94) : une seule écriture.
  return interleaveLeaving<E & { leaving?: true }>(before, next as readonly (E & { leaving?: true })[], (entry) => entry.key, (entry) => ({ ...entry, leaving: true }));
}

interface RowSnapshot {
  keys: string[];
  progress: Map<string, number | null>;
}

function progressOf(entry: ContinueRowEntry): number | null {
  return entry.kind === "movie" ? entry.item.positionTicks ?? null : entry.item.resumeTicks ?? null;
}

function snapshotOf(entries: readonly ContinueRowEntry[]): RowSnapshot {
  return { keys: entries.map((entry) => entry.key), progress: new Map(entries.map((entry) => [entry.key, progressOf(entry)])) };
}

/**
 * Ce que la réponse fraîche a changé à la rangée du cache : cartes ajoutées, retirées, déplacées
 * (parmi celles restées, celles dont le rang relatif n'est plus le même), barres qui ont bougé.
 */
export function continueChanges(before: RowSnapshot, after: RowSnapshot): ContinueChanges {
  const was = new Set(before.keys);
  const now = new Set(after.keys);
  const added = after.keys.filter((key) => !was.has(key)).length;
  const removed = before.keys.filter((key) => !now.has(key)).length;
  const keptBefore = before.keys.filter((key) => now.has(key));
  const keptAfter = after.keys.filter((key) => was.has(key));
  const moved = keptAfter.filter((key, i) => keptBefore[i] !== key).length;
  const progressed = keptAfter.filter((key) => (before.progress.get(key) ?? null) !== (after.progress.get(key) ?? null)).length;
  return { added, removed, moved, progressed };
}

/** Ce que demande un « Lire » : l'élément, son titre, et la position — absente quand on ne sait pas. */
export interface FeedStart {
  itemId: string;
  title: string;
  resumeAt: number | undefined;
}

/**
 * Un film, d'après « Reprendre » tel qu'il est au moment de partir. Absent de la liste fraîche — fini
 * sur la télé, retiré —, la position reste absente et le serveur décide : la règle de la bannière
 * (`bannerResumeAt`, DECISIONS.md §1), qui ne prétend jamais rien pour un titre que la liste ne
 * contient pas.
 */
export function movieStartFrom(feeds: ContinueFeeds, itemId: string, title: string): FeedStart {
  const entry = feeds.resume?.items.find((item) => item.id === itemId);
  return { itemId, title, resumeAt: bannerResumeAt(feeds.resume !== undefined, entry?.positionTicks, entry !== undefined, RESUME_KEY) };
}

/**
 * Un épisode, d'après « À suivre » au moment de partir. La liste fraîche peut nommer un autre épisode
 * de la même série — celui d'après, quand le précédent a été fini ailleurs : c'est lui qui part.
 * Ni l'un ni l'autre : l'épisode montré, position absente — le serveur décide, comme pour un film.
 */
export function episodeStartFrom(feeds: ContinueFeeds, episode: Pick<CinemaNextUpItem, "jellyfinItemId" | "title" | "sonarrId">): FeedStart {
  const items = feeds.nextUp?.items ?? [];
  const same = items.find((item) => item.jellyfinItemId === episode.jellyfinItemId);
  const next = same ?? (episode.sonarrId !== null ? items.find((item) => item.sonarrId === episode.sonarrId) : undefined);
  if (!next) return { itemId: episode.jellyfinItemId, title: episode.title, resumeAt: undefined };
  return { itemId: next.jellyfinItemId, title: next.title, resumeAt: feedResumeAt(next.resumeTicks, NEXT_UP_KEY) };
}

export interface ContinueRow {
  resume: ContinueFeeds["resume"];
  resumeError: unknown;
  nextUp: CinemaNextUpPayload | undefined;
  nextUpError: unknown;
  /** Les films de « Reprendre », dans l'ordre du flux. */
  resumeMovies: CinemaResumeItem[];
  /** Les épisodes d'« À suivre ». */
  continueSeries: CinemaNextUpItem[];
  /** La rangée vraie, le dernier lu d'abord (DECISIONS.md §33) — ce que lit la bannière. */
  entries: ContinueRowEntry[];
  /** La rangée dessinée : `entries` plus les cartes en train de partir. */
  shown: ShownContinueEntry[];
  /** La place tenue tant que rien n'est arrivé, ni du cache ni du réseau. */
  pending: boolean;
  /**
   * Lance `run` avec les flux tels qu'ils sont : tout de suite s'ils sont frais, sinon dès que la
   * réponse du serveur est là (ou qu'elle a échoué, ou après `FRESH_WAIT_MAX_MS`). Un seul appui
   * retenu à la fois : le dernier.
   */
  playWhenFresh: (run: (feeds: ContinueFeeds) => void) => void;
}

const FEEDS = [RESUME_KEY, NEXT_UP_KEY] as const;

/**
 * Un flux montré depuis le cache dont la réponse fraîche peut encore venir. Une requête qui a échoué
 * (hors ligne) laisse le flux « pas frais » pour de bon : l'attendre ferait patienter chaque appui
 * jusqu'à l'échéance. Il part alors sans position, et le serveur décide.
 */
function stillAwaiting(cache: { get(key: string): unknown }, key: string): boolean {
  return isAwaitingFresh(key) && (cache.get(key) as { error?: unknown } | undefined)?.error === undefined;
}

function awaitingAnyFeed(cache: { get(key: string): unknown }): boolean {
  return FEEDS.some((key) => stillAwaiting(cache, key));
}

export function useContinueRow(trackRef: RefObject<HTMLElement | null>): ContinueRow {
  const { data: resume, error: resumeError } = useSWR<{ items: CinemaResumeItem[] }>(RESUME_KEY, fetcher, liveFeedOptions);
  const { data: nextUp, error: nextUpError } = useSWR<CinemaNextUpPayload>(NEXT_UP_KEY, fetcher, liveFeedOptions);
  // Mémoïsés sur les réponses : recalculés à chaque rendu, ils donnaient une liste neuve à la
  // rangée, qui se redessinait à chaque survol et à chaque tour de la bannière (08/10/2026).
  const resumeMovies = useMemo(() => (resume?.items ?? []).filter((r) => r.type === "Movie"), [resume]);
  const continueSeries = useMemo(() => nextUp?.items ?? [], [nextUp]);
  const entries = useMemo(() => continueOrder(resumeMovies, continueSeries), [resumeMovies, continueSeries]);
  const pending = entries.length === 0 && ((resume === undefined && resumeError === undefined) || (nextUp === undefined && nextUpError === undefined));

  // Les cartes qui partent restent dessinées le temps de s'effacer. L'état est ajusté pendant le
  // rendu, à l'arrivée d'une nouvelle liste (le motif « d'après le rendu précédent » de React) : un
  // effet dessinerait d'abord la rangée sans elles, puis avec — un clignotement.
  const [presence, setPresence] = useState<{ source: ContinueRowEntry[]; shown: ShownContinueEntry[] }>(() => ({ source: entries, shown: entries }));
  let shown = presence.shown;
  if (presence.source !== entries) {
    const removed = presence.shown.filter((entry) => !entries.some((next) => next.key === entry.key)).length;
    // Au-delà de ce que `CATALOGUE_FLIP` fait glisser, la rangée entière se remplace en fondu : des
    // cartes qui s'effaceraient une à une n'y auraient plus de sens.
    const animate = removed > 0 && removed <= (CATALOGUE_FLIP.maxChanged ?? 3) && !prefersReducedMotion();
    shown = animate ? withLeaving(presence.shown, entries) : entries;
    setPresence({ source: entries, shown });
  }
  useEffect(() => {
    if (!presence.shown.some((entry) => entry.leaving)) return;
    const timer = setTimeout(() => setPresence((current) => ({ source: current.source, shown: current.source })), LEAVE_MS);
    return () => clearTimeout(timer);
  }, [presence]);

  const shownKeys = useMemo(() => shown.map((entry) => entry.key), [shown]);
  useFlipGrid(trackRef, shownKeys, CATALOGUE_FLIP);

  // Les flux tels qu'ils sont maintenant, lus au moment de partir — pas ceux du rendu qui a reçu
  // l'appui. Lus dans le cache de SWR plutôt que dans le rendu : quand la réponse fraîche est
  // tranchée, SWR l'y a posée avant que l'écran ait eu le temps de se redessiner.
  const { cache } = useSWRConfig();
  const feedsNow = useCallback(
    (): ContinueFeeds => ({
      resume: (cache.get(RESUME_KEY) as { data?: ContinueFeeds["resume"] } | undefined)?.data,
      nextUp: (cache.get(NEXT_UP_KEY) as { data?: ContinueFeeds["nextUp"] } | undefined)?.data,
    }),
    [cache]
  );

  const queued = useRef<{ run: (feeds: ContinueFeeds) => void; timer: ReturnType<typeof setTimeout> } | null>(null);
  const fireQueued = useCallback(() => {
    const pendingPlay = queued.current;
    if (!pendingPlay) return;
    queued.current = null;
    clearTimeout(pendingPlay.timer);
    pendingPlay.run(feedsNow());
  }, [feedsNow]);

  // Le compte rendu de la correction, pour la ligne d'ouverture (`noteContinueReconciled`).
  const [fromCache] = useState(() => (FEEDS.some((key) => isAwaitingFresh(key)) ? snapshotOf(entries) : null));
  const latestEntries = useRef(entries);
  useLayoutEffect(() => {
    latestEntries.current = entries;
  });
  const reconciled = useRef(false);

  useEffect(() => {
    const unsubscribe = onFeedSettled((key) => {
      if (!(FEEDS as readonly string[]).includes(key)) return;
      // La réponse vient d'être tranchée et SWR ne l'a pas encore posée : la tâche suivante la lit.
      setTimeout(() => {
        // Encore un flux qui attend sa réponse (et n'a pas échoué) : on l'attend aussi.
        if (queued.current && !FEEDS.some((feed) => feed !== key && stillAwaiting(cache, feed))) fireQueued();
        if (fromCache && !reconciled.current && !FEEDS.some((feed) => isAwaitingFresh(feed))) {
          reconciled.current = true;
          noteContinueReconciled(continueChanges(fromCache, snapshotOf(latestEntries.current)));
        }
      }, 0);
    });
    return unsubscribe;
  }, [cache, fireQueued, fromCache]);

  // Un appui retenu ne survit pas à l'écran qui l'a reçu.
  useEffect(
    () => () => {
      if (queued.current) clearTimeout(queued.current.timer);
      queued.current = null;
    },
    []
  );

  const playWhenFresh = useCallback(
    (run: (feeds: ContinueFeeds) => void) => {
      if (queued.current) clearTimeout(queued.current.timer);
      queued.current = null;
      if (!awaitingAnyFeed(cache)) {
        run(feedsNow());
        return;
      }
      queued.current = { run, timer: setTimeout(fireQueued, FRESH_WAIT_MAX_MS) };
    },
    [cache, feedsNow, fireQueued]
  );

  return { resume, resumeError, nextUp, nextUpError, resumeMovies, continueSeries, entries, shown, pending, playWhenFresh };
}
