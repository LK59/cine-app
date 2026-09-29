/**
 * L'épisode suivant, préparé pendant le générique : qu'il démarre sans attente.
 *
 * Ouvrir un épisode, c'est d'abord trois questions posées au serveur l'une après l'autre : la
 * description du fichier, la position et les préférences du compte, puis l'en-tête et l'index du
 * fichier lui-même — deux plages aux deux bouts de plusieurs gigaoctets. Depuis un serveur
 * lointain, c'est l'essentiel de l'attente entre deux épisodes. Les trois sont posées ici, à une
 * minute de la fin, et gardées où l'ouverture les cherche déjà : SWR pour la description,
 * `prefetchPlaybackState` pour la position, le cache d'en-têtes de `parseMatroska` pour le fichier.
 *
 * Depuis le 28/09/2026, son ouverture est aussi gardée sur l'appareil — l'en-tête, l'index et
 * `OPENING_TITLE_CHUNKS` depuis le début, comme un titre d'« À suivre » (`recordTitle`) : l'épisode
 * démarre depuis le disque même si le réseau tombe au générique. Rien de plus : l'avance, elle, ne se
 * construit qu'en le regardant (`budget.ts`). Un échec ne coûte rien : l'ouverture repose ses
 * questions, comme avant.
 */

import type { DirectPlayInfo } from "@/app/api/jellyfin/direct/[itemId]/route";
import { directInfoKey, prefetchPlaybackState } from "@/lib/playbackPrefetch";
import { preloadQuietly } from "@/lib/prefetch";
import { HttpByteSource } from "@/lib/webcodecs/byteSource";
import { mediaHeaderKey, openMediaFile } from "@/lib/webcodecs/mediaFile";
import { trace } from "@/lib/webcodecs/trace";
import { persistedCacheAccount } from "@/lib/persistentCache";
import { OPENING_TITLE_CHUNKS } from "@/lib/resumeCache/budget";
import { openDiskChunks } from "@/lib/resumeCache/diskChunks";
import { recordTitle } from "@/lib/resumeCache/recordTitle";

/** Les fichiers déjà préparés dans cette page : un seul essai chacun. */
const prepared = new Set<string>();

export async function warmNextEpisode(itemId: string): Promise<void> {
  if (prepared.has(itemId)) return;
  prepared.add(itemId);
  try {
    prefetchPlaybackState(itemId);
    const info = await preloadQuietly<DirectPlayInfo>(directInfoKey(itemId));
    if (!info?.streamUrl) return;
    const startedAt = Date.now();
    // L'appareil d'abord, puis l'en-tête lu *depuis* l'appareil : dans l'ordre inverse, l'en-tête et
    // l'index étaient téléchargés deux fois — une pour le cache d'en-têtes, une pour l'appareil —,
    // plusieurs mégaoctets de trop au générique (chasse aux défauts du 28/09).
    const account = persistedCacheAccount();
    if (account) {
      const kept = await recordTitle(account, { itemId, startSeconds: 0, started: false }, OPENING_TITLE_CHUNKS, new AbortController().signal, true);
      if (kept > 0) trace(`épisode suivant : ${kept} Mo gardés sur l'appareil`);
    }
    const disk =
      account && info.sizeBytes && info.fileVersion
        ? await openDiskChunks({ itemId, streamUrl: info.streamUrl, size: info.sizeBytes, fileVersion: info.fileVersion }).catch(() => null)
        : null;
    // Sans lecture en avance : elle téléchargeait six mégaoctets après l'en-tête, que personne ne gardait.
    const source = (await HttpByteSource.open(info.streamUrl, info.sizeBytes, disk)).withoutReadahead();
    try {
      // Nommé comme à l'ouverture — adresse et version du fichier : c'est ce qui la rendra instantanée.
      await openMediaFile(source, mediaHeaderKey(info.streamUrl, info.fileVersion));
      trace(`épisode suivant préparé en ${Date.now() - startedAt} ms`);
    } finally {
      source.close(false);
    }
  } catch {
    // Préparer n'est pas lire : un échec ici laisse simplement l'ouverture faire son travail.
  }
}
