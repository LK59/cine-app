/**
 * L'en-tête et l'index du fichier que « Lire » ouvrirait, lus pendant que la fiche est à l'écran.
 *
 * Mesuré du 20 au 28/10/2026 (player.log, 298 ouvertures) : un titre dont le début est gardé sur
 * l'appareil bougeait 1,2 s après l'appui (médiane), un titre lu entièrement depuis le réseau 2,4 s —
 * et 10,8 s pour le dixième le plus lent. L'écart tient d'abord à l'en-tête et à l'index (deux plages
 * aux deux bouts du fichier, 1 à 3 Mo) : 0,4 s depuis l'appareil, 1,1 s médians depuis le réseau,
 * 6 s sur un lien lent. Entre l'ouverture d'une fiche et l'appui sur Lire, il y a ce temps-là.
 *
 * Le même geste que la préparation de l'épisode suivant (`nextEpisodeWarmup.ts`), en plus sobre :
 * l'en-tête lu est gardé là où l'ouverture le cherche déjà (le cache d'en-têtes de `parseMatroska`,
 * quatre fichiers, nommé par `mediaHeaderKey`), et rien n'est écrit sur l'appareil. Les octets lus
 * meurent avec la source (`close(false)`) : ne reste en mémoire que l'en-tête analysé — pistes et
 * points d'index, quelques centaines de Ko au plus.
 *
 * Retenu exprès :
 * - **une seconde de fiche d'abord** : une fiche traversée ne coûte rien ;
 * - **un fichier à la fois** : la fiche suivante coupe la lecture de la précédente ;
 * - **coupé à la fermeture de la fiche** — les requêtes en cours meurent avec la source ;
 * - **jamais pendant un film** (plein écran ou réduit), ni page cachée, ni « économiseur de données » —
 *   et un film qui s'ouvre l'arrête : l'ouverture lit l'en-tête elle-même ;
 * - **rouvrir la fiche ne relit rien** : un en-tête encore dans le cache est rendu sans un octet lu.
 * Un échec ne coûte rien : l'ouverture lit l'en-tête elle-même, comme avant.
 */

import { fetchDirectInfo } from "@/lib/directInfo";
import { persistedCacheAccount } from "@/lib/persistentCache";
import { openDiskChunks } from "@/lib/resumeCache/diskChunks";
import { holdsHandover, HttpByteSource } from "@/lib/webcodecs/byteSource";
import { mediaHeaderKey, openMediaFile } from "@/lib/webcodecs/mediaFile";
import { trace } from "@/lib/webcodecs/trace";

/** Le temps de fiche avant de lire quoi que ce soit. */
export const SHEET_WARMUP_DELAY_MS = 1000;
/** La préparation en cours — une seule : la suivante l'arrête. */
let current: AbortController | null = null;

/** L'appareil demande-t-il d'économiser ses données ? (Chromium seulement ; ailleurs, non.) */
function savesData(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}

/**
 * Prépare l'en-tête de `itemId` après une seconde, sauf si `cancel` est appelé avant.
 *
 * @returns de quoi tout arrêter — à appeler quand la fiche se ferme ou change de titre.
 */
export function scheduleSheetHeaderWarmup(itemId: string): () => void {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    if (controller.signal.aborted || document.hidden || savesData()) return;
    void warmSheetHeader(itemId, controller);
  }, SHEET_WARMUP_DELAY_MS);
  return () => {
    clearTimeout(timer);
    controller.abort();
  };
}

/** Exportée pour les tests ; ailleurs, passer par `scheduleSheetHeaderWarmup`. */
export async function warmSheetHeader(itemId: string, controller: AbortController): Promise<void> {
  current?.abort();
  current = controller;
  const { signal } = controller;
  try {
    // La description que la fiche a déjà demandée (`usePlaybackPrefetch`) : reprise en vol, pas reposée.
    const info = await fetchDirectInfo(itemId).catch(() => undefined);
    if (signal.aborted || !info?.streamUrl) return;
    // Le film vient de se fermer et la fiche réapparaît : ses octets attendent la réouverture dans le
    // relais, et ouvrir une source les lui prendrait (`HttpByteSource.open` → `takeHandover`) pour les
    // jeter aussitôt. Son en-tête est de toute façon dans le cache.
    if (holdsHandover(info.streamUrl)) return;
    const startedAt = Date.now();
    // Un titre gardé sur l'appareil (« Reprendre », « À suivre ») se lit depuis l'appareil : rien ne
    // part sur le réseau pour lui. Lu seulement — rien n'y est écrit d'ici.
    const disk =
      persistedCacheAccount() && info.sizeBytes && info.fileVersion
        ? await openDiskChunks({ itemId, streamUrl: info.streamUrl, size: info.sizeBytes, fileVersion: info.fileVersion }).catch(() => null)
        : null;
    if (signal.aborted) return;
    // Sans lecture en avance : elle téléchargerait plusieurs mégaoctets après l'en-tête, pour un film
    // qu'on ne lancera peut-être pas.
    const source = (await HttpByteSource.open(info.streamUrl, info.sizeBytes, disk)).withoutReadahead();
    // `close(false)` : ses morceaux ne prennent pas la place unique du relais (`handover`), et ses
    // requêtes en cours meurent avec elle.
    const stop = () => source.close(false);
    signal.addEventListener("abort", stop, { once: true });
    try {
      if (signal.aborted) return;
      await openMediaFile(source, mediaHeaderKey(info.streamUrl, info.fileVersion));
      if (signal.aborted) return;
      trace(`fiche : en-tête et index préparés en ${Date.now() - startedAt} ms`);
    } finally {
      signal.removeEventListener("abort", stop);
      stop();
    }
  } catch {
    // Préparer n'est pas lire : l'ouverture refera la lecture, comme avant.
  } finally {
    if (current === controller) current = null;
  }
}

/** Pour les tests : l'état d'une page neuve. */
export function forgetSheetHeaderWarmups(): void {
  current?.abort();
  current = null;
}
