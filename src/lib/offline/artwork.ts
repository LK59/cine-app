"use client";

import { deviceStore } from "./deviceStore";
import type { OfflineDetails } from "@/app/api/offline/details/[itemId]/route";

/**
 * La fiche d'un téléchargement, gardée sur l'appareil (Louis, 19/10/2026) : le résumé, l'année, les
 * genres, le logo et le grand visuel — ce que la fiche hors ligne de la page des téléchargements et
 * l'ouverture de la lecture montrent sans réseau. Le logo et le visuel d'un épisode sont ceux de sa
 * série, rangés avec chaque épisode (quelques centaines de Ko, contre des centaines de Mo de vidéo).
 */
export interface OfflineArtwork extends Omit<OfflineDetails, "logoItemId" | "backdropItemId" | "posterItemId" | "markers"> {
  /** Absent : une fiche gardée avant les repères (rattrapée au chargement). */
  markers?: OfflineDetails["markers"];
  hasLogo: boolean;
  hasBackdrop: boolean;
  /** L'affiche de la série, pour un épisode (`SERIES_POSTER_FILE`). */
  hasSeriesPoster?: boolean;
}

/** L'affiche (ou la vignette d'un épisode), rangée par `downloads.ts` à la demande. */
export const POSTER_FILE = "poster";
export const LOGO_FILE = "logo";
export const BACKDROP_FILE = "backdrop";
export const SERIES_POSTER_FILE = "series-poster";

async function keepImage(account: string, id: string, itemId: string | null, kind: "logo" | "backdrop" | "poster", name: string): Promise<boolean> {
  if (!itemId) return false;
  const res = await fetch(`/api/jellyfin/image?itemId=${encodeURIComponent(itemId)}&kind=${kind}`);
  if (!res.ok) return false;
  await deviceStore.writeFile(account, id, name, new Uint8Array(await res.arrayBuffer()));
  return true;
}

/**
 * Télécharge et range la fiche ; rend ce qui a été gardé, `null` si le titre n'est plus connu, ou
 * `undefined` si le réseau a manqué (à réessayer au prochain chargement). Ne lève jamais.
 */
export async function storeOfflineArtwork(account: string, id: string, itemId: string): Promise<OfflineArtwork | null | undefined> {
  try {
    const res = await fetch(`/api/offline/details/${encodeURIComponent(itemId)}`, { cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) return undefined;
    const { logoItemId, backdropItemId, posterItemId, ...details } = (await res.json()) as OfflineDetails;
    const [hasLogo, hasBackdrop, hasSeriesPoster] = await Promise.all([
      keepImage(account, id, logoItemId, "logo", LOGO_FILE).catch(() => false),
      keepImage(account, id, backdropItemId, "backdrop", BACKDROP_FILE).catch(() => false),
      keepImage(account, id, posterItemId, "poster", SERIES_POSTER_FILE).catch(() => false),
    ]);
    return { ...details, hasLogo, hasBackdrop, hasSeriesPoster };
  } catch {
    return undefined;
  }
}

/**
 * Les images gardées, en adresses `blob:` — faites une fois par fichier et gardées pour la séance :
 * l'ouverture de la lecture fige ce qu'elle montre à son montage, l'adresse doit donc souvent être
 * déjà prête (`peekOfflineImage`). Libérées quand le téléchargement quitte l'appareil.
 */
const urls = new Map<string, Promise<string | null>>();
const ready = new Map<string, string | null>();

export function offlineImage(account: string, id: string, name: string): Promise<string | null> {
  const key = `${account}/${id}/${name}`;
  let pending = urls.get(key);
  if (!pending) {
    pending = Promise.resolve()
      .then(() => deviceStore.readFile(account, id, name))
      .then((blob) => (blob && blob.size > 0 ? URL.createObjectURL(blob) : null))
      .catch(() => null)
      .then((url) => {
        ready.set(key, url);
        return url;
      });
    urls.set(key, pending);
  }
  return pending;
}

/** L'adresse déjà faite, sans attendre ; `undefined` si elle n'a pas encore été lue. */
export function peekOfflineImage(account: string, id: string, name: string): string | null | undefined {
  return ready.get(`${account}/${id}/${name}`);
}

export function forgetOfflineImages(account: string, id: string): void {
  for (const key of [...ready.keys()]) {
    if (!key.startsWith(`${account}/${id}/`)) continue;
    const url = ready.get(key);
    if (url) URL.revokeObjectURL(url);
    ready.delete(key);
    urls.delete(key);
  }
}
