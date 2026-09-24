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
 * Rien n'est lu des images : c'est la seule partie qui dépend de l'endroit où l'on reprend, et
 * garder des mégaoctets pour un épisode que personne ne lancera peut-être serait du gaspillage.
 * Un échec ne coûte rien : l'ouverture repose ses questions, comme avant.
 */

import type { DirectPlayInfo } from "@/app/api/jellyfin/direct/[itemId]/route";
import { directInfoKey, prefetchPlaybackState } from "@/lib/playbackPrefetch";
import { preloadQuietly } from "@/lib/prefetch";
import { HttpByteSource } from "@/lib/webcodecs/byteSource";
import { openMediaFile } from "@/lib/webcodecs/mediaFile";
import { trace } from "@/lib/webcodecs/trace";

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
    const source = await HttpByteSource.open(info.streamUrl, info.sizeBytes);
    try {
      // Nommé par son adresse, comme à l'ouverture : c'est ce qui la rendra instantanée.
      await openMediaFile(source, info.streamUrl);
      trace(`épisode suivant préparé en ${Date.now() - startedAt} ms`);
    } finally {
      source.close(false);
    }
  } catch {
    // Préparer n'est pas lire : un échec ici laisse simplement l'ouverture faire son travail.
  }
}
