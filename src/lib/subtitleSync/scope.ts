import { isJellyfinId } from "@/lib/jellyfinPath";
import type { SyncAction, SyncDecideScope, SyncScanScope } from "./types";

/**
 * La portée d'un geste de la page Synchro des sous-titres (§141), lue dans le corps d'une requête — un élément,
 * une saison, une série, une liste de films (500 au plus), et pour une décision une piste seule. `null` : refusé
 * (400), avant tout appel à Jellyfin ou au service.
 */
export function parseScope(body: unknown, allowTrack: boolean): SyncDecideScope | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  switch (b.scope) {
    case "item":
      return isJellyfinId(b.itemId) ? { scope: "item", itemId: b.itemId } : null;
    case "series":
      return isJellyfinId(b.seriesId) ? { scope: "series", seriesId: b.seriesId } : null;
    case "season":
      return isJellyfinId(b.seriesId) && Number.isInteger(b.season) && (b.season as number) >= 0
        ? { scope: "season", seriesId: b.seriesId, season: b.season as number }
        : null;
    case "movies": {
      const ids = Array.isArray(b.itemIds) ? b.itemIds : null;
      if (!ids || ids.length === 0 || ids.length > 500 || !ids.every(isJellyfinId)) return null;
      return { scope: "movies", itemIds: ids as string[] };
    }
    case "track":
      if (!allowTrack || !isJellyfinId(b.itemId) || typeof b.trackKey !== "string" || !/^(emb:\d+|ext:\/[^\n\r\0]{1,4096})$/.test(b.trackKey)) return null;
      return { scope: "track", itemId: b.itemId, trackKey: b.trackKey };
    default:
      return null;
  }
}

export function parseScanScope(body: unknown): SyncScanScope | null {
  const scope = parseScope(body, false);
  return scope && scope.scope !== "track" ? scope : null;
}

export function parseAction(value: unknown): SyncAction | null {
  return value === "apply" || value === "reject" || value === "reset" ? value : null;
}
