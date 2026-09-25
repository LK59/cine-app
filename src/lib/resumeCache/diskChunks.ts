import { openingBytes, type DiskChunks } from "@/lib/webcodecs/byteSource";
import { trace } from "@/lib/webcodecs/trace";
import { persistedCacheAccount } from "@/lib/persistentCache";
import { readResumeChunk, readResumeManifest, removeResumeEntry, type ResumeManifest } from "./store";

/** Au-delà, un titre gardé n'est plus servi : il est effacé. */
export const RESUME_CACHE_MAX_AGE_MS = 14 * 24 * 3600_000;

/** Ce que la description du fichier (`DirectPlayInfo`) dit de lui avant qu'un octet soit lu. */
export interface FileIdentity {
  itemId: string;
  streamUrl: string;
  size: number | null;
  fileVersion: string | null;
}

/**
 * Le manifeste décrit-il ce fichier-là ?
 *
 * Tout doit concorder, et une donnée absente ne concorde pas : sans version (Jellyfin ne la donne
 * pas) ou sans taille, on ne sait pas, et dans le doute on lit le réseau. L'adresse porte l'identifiant
 * de la source média — un titre dont la source a changé n'a plus la même.
 */
export function sameFile(manifest: ResumeManifest, identity: FileIdentity): boolean {
  return (
    identity.fileVersion !== null &&
    identity.size !== null &&
    manifest.fileVersion === identity.fileVersion &&
    manifest.size === identity.size &&
    manifest.streamUrl === identity.streamUrl
  );
}

/**
 * Les morceaux gardés pour ce titre, prêts à servir la source d'octets du lecteur — ou null quand il
 * n'y a rien, ou rien de sûr.
 *
 * Un manifeste d'un autre fichier (remplacé, réencodé) ou trop ancien est effacé ici, en arrière-plan,
 * et le titre s'ouvre par le réseau comme avant : rien ne lève. La première réponse du réseau refait
 * la vérification avec ce que le serveur dit vraiment (`verify`) — la description de Jellyfin peut
 * avoir un temps de retard sur un fichier tout juste remplacé.
 */
export async function openDiskChunks(identity: FileIdentity, now = Date.now()): Promise<DiskChunks | null> {
  const account = persistedCacheAccount();
  if (!account) return null;
  try {
    const manifest = await readResumeManifest(account, identity.itemId);
    if (!manifest) return null;
    if (!sameFile(manifest, identity)) {
      trace(`reprise sur l'appareil : le fichier a changé depuis l'enregistrement — morceaux gardés jetés`);
      void removeResumeEntry(account, identity.itemId);
      return null;
    }
    if (now - manifest.savedAt > RESUME_CACHE_MAX_AGE_MS) {
      void removeResumeEntry(account, identity.itemId);
      return null;
    }
    return diskChunksFor(account, manifest);
  } catch {
    return null;
  }
}

/** Efface un titre fini — appelé à la fin d'un film, en arrière-plan. Ne lève jamais. */
export function forgetResumeCache(itemId: string): void {
  const account = persistedCacheAccount();
  if (account) void removeResumeEntry(account, itemId);
}

/**
 * Pour la ligne `start` : d'où l'ouverture a été servie, et combien d'octets venaient de l'appareil.
 * « appareil » : rien du réseau jusque-là ; « mixte » : les deux ; « réseau » : rien de l'appareil.
 * De quoi comparer `openedInMs` avant et après ce chantier, et voir une reprise qui aurait dû être
 * servie de l'appareil et ne l'a pas été.
 */
export function openingFacts(streamUrl: string): Record<string, string | number> {
  const bytes = openingBytes(streamUrl);
  if (!bytes) return {};
  const openedFrom = bytes.device === 0 ? "réseau" : bytes.network === 0 ? "appareil" : "mixte";
  return { openedFrom, deviceBytes: bytes.device };
}

/** La couche elle-même, séparée pour être éprouvée sans magasin. */
export function diskChunksFor(
  account: string,
  manifest: ResumeManifest,
  read: (index: number) => Promise<Uint8Array | null> = (index) => readResumeChunk(account, manifest.itemId, index),
  remove: () => Promise<void> = () => removeResumeEntry(account, manifest.itemId)
): DiskChunks {
  const kept = new Set(manifest.chunks);
  let disabled = false;
  trace(`reprise sur l'appareil : ${manifest.chunks.length} Mo gardés (${manifest.partial ? "en-tête et index" : `jusqu'à ${manifest.coveredTo.toFixed(0)} s`})`);
  return {
    has: (index) => !disabled && kept.has(index),
    read: (index) => (disabled ? Promise.resolve(null) : read(index)),
    verify(total, lastModified) {
      if (disabled) return;
      const sizeDiffers = total !== manifest.size;
      const dateDiffers = lastModified !== null && manifest.lastModified !== null && lastModified !== manifest.lastModified;
      if (!sizeDiffers && !dateDiffers) return;
      disabled = true;
      trace(
        `reprise sur l'appareil : le serveur annonce un autre fichier (` +
          (sizeDiffers ? `${total} octets au lieu de ${manifest.size}` : `daté ${lastModified} au lieu de ${manifest.lastModified}`) +
          `) — morceaux gardés jetés`
      );
      void remove();
    },
  };
}
