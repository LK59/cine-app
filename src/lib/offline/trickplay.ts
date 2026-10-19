"use client";

import { deviceStore } from "./deviceStore";
import { trickplayTileOrder, type TrickplayInfo } from "@/lib/trickplayTile";

/**
 * Les aperçus de la barre (trickplay) d'un téléchargement hors ligne (Louis, 19/10/2026 : « aperçu
 * de la barre, faut que tu t'en occupes ») : la description de Jellyfin et chacune de ses planches,
 * gardées à côté du film (`trickplay-<rang>.jpg`) — quelques Mo pour un film, une fraction de la
 * vidéo. Sans elles, le lecteur hors ligne les demandait au serveur : rien sans réseau.
 */
export interface OfflineTrickplay extends TrickplayInfo {
  /** Le nombre de planches gardées, toutes : une planche manquante, et rien n'est gardé. */
  tiles: number;
}

const tileName = (index: number) => `trickplay-${index}.jpg`;

/**
 * Télécharge et range les planches ; rend leur description, `null` si le titre n'en a pas, ou
 * `undefined` si le réseau ou l'appareil a manqué en route (à réessayer). Ne lève jamais.
 */
export async function storeOfflineTrickplay(account: string, id: string, itemId: string): Promise<OfflineTrickplay | null | undefined> {
  try {
    const res = await fetch(`/api/jellyfin/trickplay/info?itemId=${encodeURIComponent(itemId)}`);
    if (res.status === 404) return null;
    if (!res.ok) return undefined;
    const info = (await res.json()) as TrickplayInfo;
    const tiles = Math.ceil(info.thumbnailCount / (info.tileWidth * info.tileHeight));
    if (!(tiles > 0)) return null;
    for (const index of trickplayTileOrder(0, tiles)) {
      const tile = await fetch(`/api/jellyfin/trickplay/tile?itemId=${encodeURIComponent(itemId)}&width=${info.width}&index=${index}`);
      if (!tile.ok) return undefined;
      await deviceStore.writeFile(account, id, tileName(index), new Uint8Array(await tile.arrayBuffer()));
    }
    return { ...info, tiles };
  } catch {
    return undefined;
  }
}

/**
 * Les planches gardées, en adresses `blob:` dans l'ordre de leur rang — à libérer par
 * `URL.revokeObjectURL` quand le lecteur se ferme. `null` si l'une manque.
 */
export async function readOfflineTrickplayUrls(account: string, id: string, tiles: number): Promise<string[] | null> {
  const urls: string[] = [];
  for (let index = 0; index < tiles; index++) {
    const blob = await deviceStore.readFile(account, id, tileName(index)).catch(() => null);
    if (!blob) {
      for (const url of urls) URL.revokeObjectURL(url);
      return null;
    }
    urls.push(URL.createObjectURL(blob));
  }
  return urls;
}
