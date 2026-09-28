import { CHUNK_SIZE, type HeldBytes } from "@/lib/webcodecs/byteSource";
import { persistedCacheAccount } from "@/lib/persistentCache";
import { sameFile, type FileIdentity } from "./diskChunks";
import { commitResumeEntry, readResumeManifest, removeResumeEntry, writeResumeChunk, type ResumeManifest } from "./store";

/**
 * Ce que le lecteur tenait en mémoire à l'arrêt, gardé sur l'appareil (28/09/2026).
 *
 * Avant, l'arrêt oubliait tout : les octets autour de la position — ceux-là mêmes qu'une reprise
 * relira — n'étaient gardés que par le passage d'arrière-plan (`useResumeCache`), qui les
 * retéléchargeait plus tard, au repos, et seulement si l'application restait ouverte. Un iPhone
 * qui ferme l'application aussitôt le film arrêté n'avait donc rien pour la reprise du soir.
 *
 * Écrits tels quels, sans rien mesurer : la couverture est inconnue (`coveredTo` négatif), et le
 * prochain passage d'arrière-plan la mesure en relisant ces morceaux depuis l'appareil — seul ce qui
 * manque (l'en-tête, l'index, s'ils ont quitté la mémoire) part au réseau, et ce qui dépasse le
 * budget est effacé. En attendant, le lecteur s'en sert déjà : un morceau gardé est un morceau gardé
 * (`HttpByteSource.fromDiskOrNetwork`).
 *
 * Jamais pour un film fini (`forgetResumeCache`), ni pendant un banc. Ne lève jamais.
 */
export async function keepOnStop(identity: FileIdentity, held: HeldBytes | null): Promise<number> {
  try {
    const account = persistedCacheAccount();
    if (!account || !held || held.chunks.size === 0 || !identity.fileVersion || identity.size !== held.size) return 0;
    const previous = await readResumeManifest(account, identity.itemId);
    const reusable = previous && sameFile(previous, identity) ? previous : null;
    if (previous && !reusable) await removeResumeEntry(account, identity.itemId);
    const expected = (index: number) => Math.max(0, Math.min(CHUNK_SIZE, held.size - index * CHUNK_SIZE));
    const kept = new Set(reusable?.chunks ?? []);
    let written = 0;
    for (const [index, bytes] of held.chunks) {
      if (kept.has(index) || bytes.byteLength !== expected(index)) continue;
      if (!(await writeResumeChunk(account, identity.itemId, index, bytes))) break;
      kept.add(index);
      written += 1;
    }
    if (written === 0) return 0;
    const chunks = [...kept].sort((a, b) => a - b);
    const manifest: ResumeManifest = {
      v: 1,
      itemId: identity.itemId,
      streamUrl: identity.streamUrl,
      size: held.size,
      fileVersion: identity.fileVersion,
      lastModified: held.lastModified ?? reusable?.lastModified ?? null,
      savedAt: Date.now(),
      startSeconds: -1,
      coveredFrom: -1,
      coveredTo: -1,
      chunks,
      bytes: chunks.reduce((sum, index) => sum + expected(index), 0),
      partial: false,
    };
    return (await commitResumeEntry(account, manifest, [])) ? written : 0;
  } catch {
    return 0;
  }
}
