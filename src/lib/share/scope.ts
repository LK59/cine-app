import { jellyfin } from "@/lib/clients/jellyfin";
import { isJellyfinId } from "@/lib/jellyfinPath";
import type { Share } from "@/lib/share/store";

/**
 * Ce qu'un lien de partage couvre (DECISIONS.md §112) : un film — lui seul —, ou une série — elle,
 * ses saisons et ses épisodes, ceux qui arriveront compris.
 *
 * Un film se décide sans rien demander. Pour une série, c'est Jellyfin qui dit à quelle série
 * appartient un élément (`SeriesId`, le même champ que lisent `playback-state` et la langue par
 * série) ; la réponse est gardée par lien et par élément, comme `assertVisible` garde les siennes :
 * les segments d'une ouverture arrivent ensemble, une seule question pour tous.
 *
 * Une question sans réponse (Jellyfin injoignable) vaut un refus : on ne laisse pas passer ce qu'on
 * n'a pas pu vérifier.
 */

const TTL_MS = 30 * 60_000;
const MAX = 4_000;
const verdicts = new Map<string, { inScope: boolean; at: number }>();
const inflight = new Map<string, Promise<boolean>>();

async function askJellyfin(share: Share, itemId: string): Promise<boolean> {
  if (!share.jfUserId) return false;
  try {
    const item = await jellyfin.getItemBasic(share.jfUserId, itemId);
    if (!item) return false;
    const type = (item as { Type?: string }).Type;
    const seriesId = (item as { SeriesId?: string | null }).SeriesId;
    return (type === "Episode" || type === "Season") && seriesId === share.itemId;
  } catch {
    return false;
  }
}

export async function itemInShare(share: Share, itemId: string | null | undefined, now = Date.now()): Promise<boolean> {
  if (!isJellyfinId(itemId)) return false;
  if (itemId === share.itemId) return true;
  if (share.kind !== "series") return false;
  const key = `${share.id}:${itemId}`;
  const known = verdicts.get(key);
  if (known && now - known.at < TTL_MS) return known.inScope;
  let pending = inflight.get(key);
  if (!pending) {
    pending = askJellyfin(share, itemId).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  const inScope = await pending;
  verdicts.delete(key);
  verdicts.set(key, { inScope, at: now });
  while (verdicts.size > MAX) verdicts.delete(verdicts.keys().next().value as string);
  return inScope;
}

export const __testing = { reset: () => { verdicts.clear(); inflight.clear(); } };
