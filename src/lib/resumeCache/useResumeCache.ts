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
import { deviceBudget } from "./budget";
import { diskChunksFor, sameFile } from "./diskChunks";
import { planResumeCache, remainingChunks, resumeTargets, titleChunks, type ResumeTarget } from "./plan";
import { recordOpening } from "./record";
import { commitResumeEntry, readResumeIndex, readResumeManifest, removeResumeEntry, writeResumeChunk, type ResumeManifest } from "./store";

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
    // Un épisode d'« À suivre » déjà entamé est une reprise, pas une ouverture.
    started: (item.resumeTicks ?? 0) > 0,
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
 *
 * **Ce qui est déjà là sert** (28/09/2026). Refaire un titre — la position a bougé sur un autre
 * appareil, ou il vient d'être gardé à l'arrêt sans que sa couverture soit mesurée — relisait tout
 * au réseau, l'en-tête et l'index compris, qui ne changent jamais pour un même fichier. La source de
 * l'enregistrement lit désormais l'appareil d'abord (comme celle du lecteur), et seuls les morceaux
 * qui manquent partent au réseau. Ceux qui ne servent plus sont effacés à la fin.
 *
 * **Écrits au fil de l'eau** : chaque morceau touché est écrit aussitôt, depuis la mémoire de la
 * source. Relire à la fin ce que la lecture avait touché, comme avant, redemandait au réseau tout ce
 * que sa mémoire (48 Mio) avait déjà rendu — le double, pour 128 Mio.
 */
export async function recordTitle(account: string, target: ResumeTarget, budgetChunks: number, signal: AbortSignal): Promise<number> {
  try {
    const info = await preloadQuietly<DirectPlayInfo>(directInfoKey(target.itemId));
    if (!info?.streamUrl || !info.sizeBytes || !info.fileVersion || mustStop(signal)) return 0;
    const identity = { itemId: target.itemId, streamUrl: info.streamUrl, size: info.sizeBytes, fileVersion: info.fileVersion };
    const previous = await readResumeManifest(account, target.itemId);
    const reusable = previous && sameFile(previous, identity) ? previous : null;
    // Un autre fichier : rien de ce qui est gardé ne vaut plus.
    if (previous && !reusable) await removeResumeEntry(account, target.itemId);
    const onDisk = new Set(reusable?.chunks ?? []);
    const disk = reusable ? diskChunksFor(account, reusable) : null;
    const source = await HttpByteSource.open(info.streamUrl, info.sizeBytes, disk);
    const written = new Set<number>();
    const writes: Promise<void>[] = [];
    let failed = false;
    try {
      const passage = Math.min(titleChunks(target), budgetChunks);
      const recorded = await recordOpening(source, target.startSeconds, () => mustStop(signal), passage, (index) => {
        if (onDisk.has(index)) return;
        const length = Math.min(CHUNK_SIZE, source.size - index * CHUNK_SIZE);
        writes.push(
          source
            .read(index * CHUNK_SIZE, length)
            .then((data) => (data.byteLength === length ? writeResumeChunk(account, target.itemId, index, data) : false))
            .then((ok) => {
              if (ok) written.add(index);
              else failed = true;
            })
            .catch(() => {
              failed = true;
            })
        );
      });
      await Promise.all(writes);
      // Ce qui a été écrit sans servir (un enregistrement arrêté, un budget dépassé) ne reste pas.
      const drop = [...onDisk, ...written];
      if (!recorded || recorded.chunks.length === 0 || failed || mustStop(signal)) {
        if (written.size > 0) await dropChunks(account, target.itemId, reusable, written);
        return 0;
      }
      // La description et le serveur doivent dire la même taille : sinon l'un des deux a un temps de
      // retard sur un fichier remplacé, et rien n'est gardé.
      // Et ce qui était gardé l'est encore : le serveur a pu annoncer en route un autre fichier
      // (`DiskChunks.verify`), et les morceaux réutilisés ont alors été effacés.
      const stillThere = (index: number) => (onDisk.has(index) ? disk?.has(index) === true : written.has(index));
      if (source.size !== info.sizeBytes || !recorded.chunks.every(stillThere)) {
        await removeResumeEntry(account, target.itemId);
        return 0;
      }
      const bytes = recorded.chunks.reduce((sum, index) => sum + Math.min(CHUNK_SIZE, source.size - index * CHUNK_SIZE), 0);
      const manifest: ResumeManifest = {
        v: 1,
        itemId: target.itemId,
        streamUrl: info.streamUrl,
        size: source.size,
        fileVersion: info.fileVersion,
        lastModified: source.lastModified ?? reusable?.lastModified ?? null,
        savedAt: Date.now(),
        startSeconds: target.startSeconds,
        coveredFrom: recorded.coveredFrom,
        coveredTo: recorded.coveredTo,
        chunks: recorded.chunks,
        bytes,
        partial: recorded.partial,
      };
      return (await commitResumeEntry(account, manifest, drop)) ? recorded.chunks.length : 0;
    } finally {
      // Sans laisser ses morceaux au relais : il revient au film qu'on regarde, pas à une préparation.
      source.close(false);
    }
  } catch {
    return 0;
  }
}

/**
 * Efface des morceaux écrits pour rien. L'ancien manifeste, s'il y en a un, reste tel quel : il ne
 * décrit que des morceaux qui étaient déjà là.
 */
async function dropChunks(account: string, itemId: string, previous: ResumeManifest | null, written: Set<number>): Promise<void> {
  if (previous) await commitResumeEntry(account, previous, written);
  else await removeResumeEntry(account, itemId);
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
  let remaining = remainingChunks(index, plan, (await deviceBudget()).resumeChunks);
  for (const target of plan.record) {
    if (mustStop(signal) || remaining <= 0) return;
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
