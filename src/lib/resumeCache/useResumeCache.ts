"use client";

import { useEffect, useMemo, useRef } from "react";
import useSWR from "swr";
import type { DirectPlayInfo } from "@/app/api/jellyfin/direct/[itemId]/route";
import type { CinemaNextUpPayload } from "@/app/api/cinema/next-up/route";
import { usePlayback } from "@/components/PlaybackProvider";
import { isWatchingFullScreen } from "@/lib/playbackBusy";
import { persistedCacheAccount } from "@/lib/persistentCache";
import { directInfoKey } from "@/lib/playbackPrefetch";
import { preloadQuietly } from "@/lib/prefetch";
import { openingPosition } from "@/lib/resumeRewind";
import { fetcher, followOnlyOptions, NEXT_UP_KEY, RESUME_KEY } from "@/lib/swr";
import { CHUNK_SIZE, HttpByteSource } from "@/lib/webcodecs/byteSource";
import { planResumeCache, remainingChunks, resumeTargets, type ResumeTarget } from "./plan";
import { recordOpening } from "./record";
import { readResumeIndex, removeResumeEntry, saveResumeEntry, type ResumeManifest } from "./store";

/**
 * « Reprendre » et « À suivre » qui démarrent instantanément — l'orchestration, en arrière-plan.
 *
 * Mesuré avant (player.log, du 20 au 25/09/2026) : un film s'ouvrait sur iPhone en 556 ms médians
 * depuis le début, 616 ms en reprise, jusqu'à 2,1 s pour les 10 % les plus lents en reprise ; 1,45 s
 * médians en reprise sur Windows. Le banc `cout.spec.ts` a établi que ce temps est celui des octets
 * (l'en-tête, l'index, le premier groupe d'images), pas du calcul. Ces octets-là sont donc gardés sur
 * l'appareil, pour les quelques titres qu'on relance d'un geste (`plan.ts`), et servis de là à
 * l'ouverture (`diskChunks.ts`).
 *
 * Tout ici est au second plan, et cède la place :
 * - jamais pendant qu'un film est ouvert — plein écran ou réduit : le réseau et le décodage sont à lui ;
 * - jamais avant que le cinéma soit affiché et au repos (`requestIdleCallback`, sinon un délai) ;
 * - jamais quand la page est en arrière-plan ;
 * - un titre à la fois, arrêté net si un film démarre ou si la liste change.
 */

/** Le délai avant le premier passage, pour laisser le catalogue s'afficher et ses images arriver. */
const START_DELAY_MS = 4000;
/** Le souffle entre deux titres. */
const BETWEEN_TITLES_MS = 800;

interface ResumeFeedItem {
  id: string;
  type: string;
  positionTicks: number;
  runtimeTicks: number;
}

/**
 * Les titres visés, chacun à la position où le lecteur s'ouvrira — `openingPosition`, la fonction
 * même qu'appelle `ExperimentalPlayerHost` : les octets gardés sont ceux qu'il lira. Depuis les deux
 * listes telles que le cinéma les a.
 */
export function targetsFrom(resume: ResumeFeedItem[] | undefined, nextUp: CinemaNextUpPayload["items"] | undefined): ResumeTarget[] {
  const fromResume = (resume ?? [])
    .filter((item) => item.type === "Movie" || item.type === "Episode")
    .map((item) => ({
      itemId: item.id,
      startSeconds: openingPosition(item.id, item.positionTicks / 1e7, item.runtimeTicks > 0 ? item.runtimeTicks / 1e7 : null),
    }));
  const fromNextUp = (nextUp ?? []).map((item) => ({
    itemId: item.jellyfinItemId,
    startSeconds: openingPosition(item.jellyfinItemId, (item.resumeTicks ?? 0) / 1e7, item.runtimeTicks ? item.runtimeTicks / 1e7 : null),
  }));
  return resumeTargets(fromResume, fromNextUp);
}

/** Ce qui arrête un passage en cours. */
function mustStop(signal: AbortSignal): boolean {
  return signal.aborted || isWatchingFullScreen() || (typeof document !== "undefined" && document.visibilityState === "hidden");
}

/**
 * Enregistre un titre : ce que son ouverture lit, rangé sur l'appareil. Rend le nombre de morceaux
 * gardés (0 si rien). Ne lève jamais : un échec laisse simplement ce titre au réseau.
 */
export async function recordTitle(account: string, target: ResumeTarget, budgetChunks: number, signal: AbortSignal): Promise<number> {
  try {
    const info = await preloadQuietly<DirectPlayInfo>(directInfoKey(target.itemId));
    if (!info?.streamUrl || !info.sizeBytes || !info.fileVersion || mustStop(signal)) return 0;
    const source = await HttpByteSource.open(info.streamUrl, info.sizeBytes);
    try {
      const recorded = await recordOpening(source, target.startSeconds, () => mustStop(signal));
      if (!recorded || recorded.chunks.length === 0 || recorded.chunks.length > budgetChunks || mustStop(signal)) return 0;
      const chunks = new Map<number, Uint8Array>();
      let bytes = 0;
      for (const index of recorded.chunks) {
        if (mustStop(signal)) return 0;
        const length = Math.min(CHUNK_SIZE, source.size - index * CHUNK_SIZE);
        // Un morceau entier, aligné comme la source du lecteur les demandera : copié, pour ne pas
        // garder une vue sur la mémoire de la source qu'on va fermer.
        const data = new Uint8Array(await source.read(index * CHUNK_SIZE, length));
        if (data.byteLength !== length) return 0;
        chunks.set(index, data);
        bytes += data.byteLength;
      }
      // La description et le serveur doivent dire la même taille : sinon l'un des deux a un temps de
      // retard sur un fichier remplacé, et rien n'est gardé.
      if (source.size !== info.sizeBytes) return 0;
      const manifest: ResumeManifest = {
        v: 1,
        itemId: target.itemId,
        streamUrl: info.streamUrl,
        size: source.size,
        fileVersion: info.fileVersion,
        lastModified: source.lastModified,
        savedAt: Date.now(),
        startSeconds: target.startSeconds,
        coveredFrom: recorded.coveredFrom,
        coveredTo: recorded.coveredTo,
        chunks: recorded.chunks,
        bytes,
        partial: recorded.partial,
      };
      return (await saveResumeEntry(account, manifest, chunks)) ? recorded.chunks.length : 0;
    } finally {
      // Sans laisser ses morceaux au relais : il revient au film qu'on regarde, pas à une préparation.
      source.close(false);
    }
  } catch {
    return 0;
  }
}

/**
 * Un passage à la fois, enchaînés : un passage demandé pendant qu'un autre s'achève (la liste a
 * changé, retour au premier plan) attend la fin du précédent — qui, annulé, s'arrête au prochain
 * échantillon — au lieu de courir à côté ou d'être perdu.
 */
let chain: Promise<void> = Promise.resolve();

/** Un passage : effacer ce qui n'est plus visé, puis enregistrer ce qui manque, dans l'ordre. */
export function runResumeCache(targets: ResumeTarget[], signal: AbortSignal, now = Date.now()): Promise<void> {
  const next = chain.then(() => onePass(targets, signal, now));
  chain = next.catch(() => undefined);
  return next;
}

async function onePass(targets: ResumeTarget[], signal: AbortSignal, now: number): Promise<void> {
  const account = persistedCacheAccount();
  if (!account || mustStop(signal)) return;
  const index = await readResumeIndex(account);
  const plan = planResumeCache(targets, index, now);
  for (const itemId of plan.remove) {
    if (signal.aborted) return;
    await removeResumeEntry(account, itemId);
  }
  let remaining = remainingChunks(index, plan);
  for (const target of plan.record) {
    if (mustStop(signal)) return;
    remaining -= await recordTitle(account, target, remaining, signal);
    await new Promise((resolve) => setTimeout(resolve, BETWEEN_TITLES_MS));
  }
}

function whenIdle(work: () => void): () => void {
  const ric = typeof window !== "undefined" ? (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void }) : null;
  let idle: number | null = null;
  const timer = setTimeout(() => {
    if (ric?.requestIdleCallback) idle = ric.requestIdleCallback(work, { timeout: 3000 });
    else work();
  }, START_DELAY_MS);
  return () => {
    clearTimeout(timer);
    if (idle !== null) ric?.cancelIdleCallback?.(idle);
  };
}

/**
 * Le passage, lancé quand la page est au repos et relancé quand les listes changent. Monté une fois,
 * par la page du cinéma (bureau et téléphone confondus).
 */
export function useResumeCache(): void {
  const { session } = usePlayback();
  // Lues, jamais demandées d'elles-mêmes : monté avant le cinéma (la page attend encore le catalogue
  // gardé sur l'appareil), un `useSWR` qui demandait ces listes au serveur prenait leur place dans
  // le cache — et l'hydratation, qui ne touche jamais une clé déjà demandée, laissait « Reprendre »
  // sans son affichage instantané. Mais avec le récupérateur : voir `followOnlyOptions`.
  const { data: resume } = useSWR<{ items: ResumeFeedItem[] }>(RESUME_KEY, fetcher, followOnlyOptions);
  const { data: nextUp } = useSWR<CinemaNextUpPayload>(NEXT_UP_KEY, fetcher, followOnlyOptions);
  const filmOpen = session !== null;
  const targets = useMemo(() => targetsFrom(resume?.items, nextUp?.items), [resume, nextUp]);
  const signature = targets.map((target) => `${target.itemId}@${Math.round(target.startSeconds)}`).join(",");
  const latest = useRef(targets);
  useEffect(() => {
    latest.current = targets;
  });

  useEffect(() => {
    if (filmOpen || !signature) return;
    const control = new AbortController();
    const cancel = whenIdle(() => void runResumeCache(latest.current, control.signal));
    // Relancé au retour au premier plan : un passage interrompu par l'arrière-plan reprend.
    const onVisible = () => {
      if (document.visibilityState === "visible" && !control.signal.aborted) void runResumeCache(latest.current, control.signal);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      control.abort();
      cancel();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [signature, filmOpen]);
}
