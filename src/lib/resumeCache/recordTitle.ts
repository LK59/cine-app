import type { DirectPlayInfo } from "@/app/api/jellyfin/direct/[itemId]/route";
import { isWatchingFullScreen } from "@/lib/playbackBusy";
import { directInfoKey } from "@/lib/playbackPrefetch";
import { preloadQuietly } from "@/lib/prefetch";
import { CHUNK_SIZE, HttpByteSource } from "@/lib/webcodecs/byteSource";
import type { MatroskaFile } from "@/lib/webcodecs/matroska";
import { resumeEnd } from "./coverage";
import { diskChunksFor, sameFile } from "./diskChunks";
import { MIN_COVERED_AHEAD_SECONDS, titleChunks, type ResumeTarget } from "./plan";
import { recordOpening } from "./record";
import { commitResumeEntry, readResumeManifest, removeResumeEntry, resumeStoreGeneration, writeResumeChunk, type ResumeManifest } from "./store";

/**
 * Refaire un titre sur l'appareil — le passage d'arrière-plan (`useResumeCache`) et l'épisode suivant
 * préparé pendant le générique (`nextEpisodeWarmup`). Sans React : importé depuis le lecteur.
 */

/** Ce qui arrête un passage en cours. */
export function mustStop(signal: AbortSignal): boolean {
  return signal.aborted || isWatchingFullScreen() || (typeof document !== "undefined" && document.visibilityState === "hidden");
}

/**
 * Refait un titre : ce qu'il faut pour le démarrer depuis l'appareil, et rien de plus. Rend le nombre
 * de morceaux gardés (0 si rien). Ne lève jamais : un échec laisse simplement ce titre au réseau.
 *
 * **Au repos, rien n'est téléchargé d'avance** (`budget.ts`). Seul le minimum de démarrage part au
 * réseau s'il manque : l'ouverture (« À suivre ») ou, pour une reprise, de l'image clé qui précède la
 * position jusqu'à un groupe après elle. Tout le reste de ce qui est gardé pour ce fichier — ce que
 * l'arrêt a gardé autour de la position, une ancienne réserve — est effacé. L'en-tête et l'index restent.
 *
 * **Ce qui est déjà là sert.** La source lit l'appareil d'abord, comme celle du lecteur : l'en-tête
 * et l'index ne sont jamais retéléchargés pour un même fichier, et un titre gardé à l'arrêt est mesuré
 * sans réseau.
 *
 * **Écrits au fil de l'eau** : chaque morceau que le réseau apporte est écrit aussitôt, depuis la
 * mémoire de la source — le relire à la fin redemandait au réseau ce que sa mémoire avait rendu.
 *
 * @param whilePlaying l'épisode suivant, préparé pendant le générique : un film à l'écran n'arrête
 *   pas cet enregistrement-là, seul `signal` le fait.
 */
export async function recordTitle(
  account: string,
  target: ResumeTarget,
  budgetChunks: number,
  signal: AbortSignal,
  whilePlaying = false
): Promise<number> {
  // « Vider le cache » ou une déconnexion en route : ce passage ne recrée rien de ce qu'ils ont effacé.
  const generation = resumeStoreGeneration();
  const stop = () => resumeStoreGeneration() !== generation || (whilePlaying ? signal.aborted : mustStop(signal));
  try {
    const info = await preloadQuietly<DirectPlayInfo>(directInfoKey(target.itemId));
    if (!info?.streamUrl || !info.sizeBytes || !info.fileVersion || stop()) return 0;
    const identity = { itemId: target.itemId, streamUrl: info.streamUrl, size: info.sizeBytes, fileVersion: info.fileVersion };
    const previous = await readResumeManifest(account, target.itemId);
    const reusable = previous && sameFile(previous, identity) ? previous : null;
    // Un autre fichier : rien de ce qui est gardé ne vaut plus.
    if (previous && !reusable) await removeResumeEntry(account, target.itemId);
    const onDisk = new Set(reusable?.chunks ?? []);
    const disk = reusable ? diskChunksFor(account, reusable) : null;
    // Sans lecture en avance : au repos, seul ce qui est lu est téléchargé (`budget.ts`).
    const source = (await HttpByteSource.open(info.streamUrl, info.sizeBytes, disk)).withoutReadahead();
    const written = new Set<number>();
    const writes: Promise<void>[] = [];
    let failed = false;
    try {
      const cap = Math.min(titleChunks(target), budgetChunks);
      // Jusqu'à un groupe après la position *exacte* : le lecteur peut aussi bien y ouvrir, sans recul
      // (`openingSpan`).
      const until = target.started
        ? (file: MatroskaFile) => resumeEnd(file, Math.max(target.startSeconds, target.positionSeconds ?? target.startSeconds), MIN_COVERED_AHEAD_SECONDS)
        : undefined;
      const recorded = await recordOpening(
        source,
        target.startSeconds,
        stop,
        cap,
        (index) => {
          // Sur l'appareil *et* relu de l'appareil : sinon le réseau l'a apporté, et on le réécrit.
          if (onDisk.has(index) && disk?.has(index) === true) return;
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
        },
        until
      );
      await Promise.all(writes);
      if (!recorded || recorded.chunks.length === 0 || failed || stop()) {
        if (written.size > 0) await dropChunks(account, target.itemId, reusable, written);
        return 0;
      }
      // Ce qui est sur l'appareil maintenant. Le serveur a pu annoncer en route un autre fichier
      // (`DiskChunks.verify`) : les morceaux réutilisés ont alors été effacés.
      const present = (index: number) => written.has(index) || (onDisk.has(index) && disk?.has(index) === true);
      if (source.size !== info.sizeBytes || !recorded.chunks.every(present)) {
        await removeResumeEntry(account, target.itemId);
        return 0;
      }
      const header = new Set(recorded.headerChunks);
      const minimal = recorded.chunks.filter((index) => !header.has(index));
      const keep = new Set(recorded.chunks);
      const drop = [...onDisk, ...written].filter((index) => !keep.has(index));
      const chunks = [...keep].sort((a, b) => a - b);
      const bytes = chunks.reduce((sum, index) => sum + Math.min(CHUNK_SIZE, source.size - index * CHUNK_SIZE), 0);
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
        chunks,
        bytes,
        partial: recorded.partial,
        headerChunks: recorded.headerChunks,
        minimalChunks: minimal.length,
        ...(reusable?.playedAt !== undefined ? { playedAt: reusable.playedAt } : {}),
      };
      // Sur le manifeste qu'on a lu en commençant, et aucun autre : un arrêt du lecteur (`keepOnStop`) a
      // pu en écrire un entre-temps, et le remplacer en entier perdait ses morceaux.
      return (await commitResumeEntry(account, manifest, drop, reusable?.savedAt ?? null)) ? chunks.length : 0;
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
  if (previous) await commitResumeEntry(account, previous, written, previous.savedAt);
  else await removeResumeEntry(account, itemId);
}

