"use client";

import { deviceStore } from "./deviceStore";

/**
 * Les sous-titres d'un téléchargement hors ligne (Louis, 19/10/2026) : chaque piste texte du titre,
 * convertie en WebVTT par Jellyfin, gardée sur l'appareil à côté du film (`sub-<index>.vtt`), et
 * décrite dans ses métadonnées pour le menu du lecteur — nommée à l'affichage par `trackLabel.ts`,
 * comme partout ailleurs.
 */
export interface OfflineSubtitle {
  index: number;
  language: string | null;
  title: string | null;
  isForced: boolean;
  isHearingImpaired: boolean;
  isExternal: boolean;
}

const fileName = (index: number) => `sub-${index}.vtt`;

/**
 * Télécharge et range les sous-titres d'un titre ; rend ceux qui ont été gardés. Ne lève jamais : un
 * sous-titre qui ne vient pas n'empêche pas le film — il manquera au menu, voilà tout.
 */
export async function storeOfflineSubtitles(account: string, id: string, itemId: string): Promise<OfflineSubtitle[]> {
  try {
    const res = await fetch(`/api/offline/subtitles/${encodeURIComponent(itemId)}`, { cache: "no-store" });
    if (!res.ok) return [];
    const { subtitles } = (await res.json()) as { subtitles: (OfflineSubtitle & { url: string })[] };
    const kept: OfflineSubtitle[] = [];
    for (const s of subtitles) {
      try {
        const vtt = await fetch(s.url, { cache: "no-store" });
        if (!vtt.ok) continue;
        await deviceStore.writeFile(account, id, fileName(s.index), new TextEncoder().encode(await vtt.text()));
        const { url: _url, ...facts } = s;
        void _url;
        kept.push(facts);
      } catch {
        /* celui-là manquera */
      }
    }
    return kept;
  } catch {
    return [];
  }
}

/** Le texte d'un sous-titre gardé, ou `null`. */
export async function readOfflineSubtitle(account: string, id: string, index: number): Promise<string | null> {
  const blob = await deviceStore.readFile(account, id, fileName(index)).catch(() => null);
  return blob ? blob.text() : null;
}
