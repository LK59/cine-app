import { CHUNK_SIZE, type HeldBytes } from "@/lib/webcodecs/byteSource";
import { clusterOffsetForTime, type MatroskaFile } from "@/lib/webcodecs/matroska";
import { RESUME_MINIMAL_MAX_CHUNKS } from "./budget";
import { resumeEnd } from "./coverage";
import { MIN_COVERED_AHEAD_SECONDS } from "./plan";
import { persistedCacheAccount } from "@/lib/persistentCache";
import { sameFile, type FileIdentity } from "./diskChunks";
import { mergeResumeEntry, readResumeManifest, removeResumeEntry, writeResumeChunk } from "./store";

/**
 * À l'arrêt, ce qu'il faut pour reprendre, pris dans ce que le lecteur tenait en mémoire (28/09/2026).
 *
 * Avant, l'arrêt oubliait tout : les octets autour de la position — ceux-là mêmes qu'une reprise
 * relira — n'étaient gardés que par le passage d'arrière-plan (`useResumeCache`), qui les
 * retéléchargeait plus tard, au repos, et seulement si l'application restait ouverte. Un iPhone
 * qui ferme l'application aussitôt le film arrêté n'avait donc rien pour la reprise du soir.
 *
 * **Seulement de quoi démarrer** (`budget.ts`) : l'en-tête, l'index, et le passage de l'image clé qui
 * précède la position (recul de reprise compris) jusqu'à un groupe après elle — pas toute la mémoire
 * du lecteur, qui ferait écrire des dizaines de mégaoctets à chaque arrêt. La couverture est mesurée
 * au prochain passage d'arrière-plan, qui télécharge ce qui manque (l'en-tête, s'il a quitté la
 * mémoire). En attendant, le lecteur s'en sert déjà (`HttpByteSource.fromDiskOrNetwork`).
 *
 * Jamais pour un film fini (`forgetResumeCache`), ni pendant un banc. Ne lève jamais.
 */
export async function keepOnStop(identity: FileIdentity, held: HeldBytes | null, around: { file: MatroskaFile; seconds: number } | null): Promise<number> {
  try {
    const account = persistedCacheAccount();
    if (!account || !held || !around || !identity.fileVersion || identity.size !== held.size) return 0;
    const wanted = resumeChunks(around.file, around.seconds, held.size);
    const previous = await readResumeManifest(account, identity.itemId);
    const reusable = previous && sameFile(previous, identity) ? previous : null;
    if (previous && !reusable) await removeResumeEntry(account, identity.itemId);
    const expected = (index: number) => Math.max(0, Math.min(CHUNK_SIZE, held.size - index * CHUNK_SIZE));
    const onDisk = new Set(reusable?.chunks ?? []);
    const added: number[] = [];
    for (const [index, bytes] of held.chunks) {
      if (!wanted.has(index) || onDisk.has(index) || bytes.byteLength !== expected(index)) continue;
      if (!(await writeResumeChunk(account, identity.itemId, index, bytes))) break;
      added.push(index);
    }
    // Rien de neuf et rien de gardé : rien à décrire. Sinon, par différence (`mergeResumeEntry`) ; la
    // couverture sera mesurée au prochain passage.
    if (added.length === 0 && !reusable) return 0;
    const file = { itemId: identity.itemId, streamUrl: identity.streamUrl, size: held.size, fileVersion: identity.fileVersion, lastModified: held.lastModified };
    const ok = await mergeResumeEntry(account, file, added, [], { startSeconds: -1, coveredFrom: -1, coveredTo: -1, partial: false, playedAt: Date.now() });
    return ok ? added.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Les morceaux d'une reprise à `seconds` : le début du fichier (l'en-tête), ses deux derniers (l'index
 * y est le plus souvent), et le passage de l'image clé qui précède la position — dix secondes plus tôt,
 * pour le recul de reprise — jusqu'à un groupe après elle, `RESUME_MINIMAL_MAX_CHUNKS` au plus.
 */
export function resumeChunks(file: MatroskaFile, seconds: number, size: number): Set<number> {
  const out = new Set<number>();
  const last = Math.floor((size - 1) / CHUNK_SIZE);
  const headerEnd = Math.floor((file.firstClusterOffset ?? file.segmentDataStart) / CHUNK_SIZE);
  for (let index = 0; index <= headerEnd; index++) out.add(index);
  out.add(last);
  if (last > 0) out.add(last - 1);
  const video = file.tracks.find((track) => track.type === "video");
  const at = (t: number) => Math.floor((clusterOffsetForTime(file, t * 1e6, video?.number) ?? file.firstClusterOffset ?? 0) / CHUNK_SIZE);
  const from = at(Math.max(0, seconds - 10));
  const to = Math.min(last, at(resumeEnd(file, seconds, MIN_COVERED_AHEAD_SECONDS)) + 1, from + RESUME_MINIMAL_MAX_CHUNKS - 1);
  for (let index = from; index <= to; index++) out.add(index);
  return out;
}
