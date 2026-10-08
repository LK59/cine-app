// Les tags bloqués d'un compte, appliqués au catalogue (08/10/2026, DECISIONS.md §54).
//
// Le catalogue est construit une fois pour tout le monde, à partir de la vue serveur de Jellyfin
// (voir la note de `/api/cinema/movies`) : un titre caché à un compte par ses tags bloqués y
// figurait donc quand même — seule sa lecture était refusée (`assertVisible`). Pour qu'un titre
// réservé à certains comptes n'existe pas pour les autres, chaque réponse du catalogue retire ce que
// les tags bloqués du compte lui cachent. La règle reste celle de Jellyfin, et elle seule : les
// `BlockedTags` de sa politique, comparés aux tags de l'élément sans tenir compte de la casse et sans
// rien retoucher d'autre — une copie plus généreuse ou plus stricte montrerait un titre qui ne
// s'ouvre pas, ou cacherait un titre ouvrable.

import { config } from "@/lib/config";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { jellyfinIdSegment } from "@/lib/jellyfinPath";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";

/** Relue toutes les deux minutes : un tag ajouté ou retiré par l'administrateur s'applique vite. */
const TTL_MS = 2 * 60 * 1000;
const TIMEOUT_MS = 5000;

const cache = new Map<string, { tags: string[]; at: number }>();

/** Pour les tests. */
export function forgetBlockedTags(): void {
  cache.clear();
}

/**
 * Les tags bloqués du compte Jellyfin, en minuscules. Si Jellyfin ne répond pas : la dernière
 * réponse connue, sinon aucun — la lecture reste de toute façon refusée par `assertVisible`.
 */
export async function blockedTagsOf(jfId: string, now = Date.now()): Promise<string[]> {
  const known = cache.get(jfId);
  if (known && now - known.at < TTL_MS) return known.tags;
  try {
    const res = await fetch(`${config.jellyfin.url}/Users/${jellyfinIdSegment(jfId)}`, {
      headers: jellyfinAuthHeaders(config.jellyfin.apiKey),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return known?.tags ?? [];
    const user = (await res.json()) as { Policy?: { BlockedTags?: string[] | null } };
    const tags = (user.Policy?.BlockedTags ?? []).filter((t): t is string => typeof t === "string" && t.length > 0).map((t) => t.toLowerCase());
    cache.set(jfId, { tags, at: now });
    return tags;
  } catch {
    return known?.tags ?? [];
  }
}

/** L'élément porte-t-il un des tags bloqués ? Même comparaison que Jellyfin : la casse seule est ignorée. */
export function carriesBlockedTag(itemTags: readonly string[] | null | undefined, blocked: readonly string[]): boolean {
  if (!itemTags?.length || blocked.length === 0) return false;
  return itemTags.some((tag) => blocked.includes(tag.toLowerCase()));
}

/** Ce que le catalogue voyage : des titres, et des listes d'identifiants qui y renvoient. */
interface CatalogueWire<T> {
  items: T[];
  rows: Record<string, number[]>;
  genres: string[];
  spotlight: number[];
  recentlyAdded: number[];
  top10: number[];
}

/**
 * Le catalogue sans les titres cachés, partout où ils figurent — titres, rangées, sélection,
 * derniers ajouts, classement — et sans les genres qui n'ont plus rien. Le reste de la charge utile
 * est gardé tel quel.
 */
export function withoutHidden<W extends CatalogueWire<unknown>>(wire: W, hidden: ReadonlySet<number>, idOf: (item: W["items"][number]) => number): W {
  if (hidden.size === 0) return wire;
  const keep = (ids: number[]) => ids.filter((id) => !hidden.has(id));
  const rows: Record<string, number[]> = {};
  for (const [genre, ids] of Object.entries(wire.rows)) {
    const kept = keep(ids);
    if (kept.length > 0) rows[genre] = kept;
  }
  return {
    ...wire,
    items: wire.items.filter((item) => !hidden.has(idOf(item))),
    rows,
    genres: wire.genres.filter((g) => rows[g]),
    spotlight: keep(wire.spotlight),
    recentlyAdded: keep(wire.recentlyAdded),
    top10: keep(wire.top10),
  };
}

/** Le jeton de session lu dans l'en-tête `Cookie` d'une requête — les routes du catalogue reçoivent un `Request`. */
function sessionTokenOf(req: Request): string | undefined {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === SESSION_COOKIE) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return undefined;
}

/**
 * Ce que le compte de la requête ne doit pas voir dans le catalogue : les identifiants des titres
 * dont l'élément Jellyfin porte un de ses tags bloqués, et une signature de ces tags — pour que
 * deux comptes aux mêmes blocages partagent la même réponse préparée (`cachedJson`).
 */
export async function hiddenForRequest<M>(
  req: Request,
  matched: readonly M[],
  tagsOf: (entry: M) => readonly string[] | undefined,
  idOf: (entry: M) => number,
): Promise<{ hidden: Set<number>; signature: string }> {
  const session = await verifySessionFull(sessionTokenOf(req));
  const blocked = session?.jfId ? await blockedTagsOf(session.jfId) : [];
  if (blocked.length === 0) return { hidden: new Set(), signature: "" };
  const hidden = new Set(matched.filter((entry) => carriesBlockedTag(tagsOf(entry), blocked)).map(idOf));
  return { hidden, signature: [...blocked].sort().join(",") };
}
