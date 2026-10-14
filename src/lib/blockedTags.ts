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
import { jellyfinFetch } from "@/lib/jellyfinBreaker";
import { jellyfinIdSegment } from "@/lib/jellyfinPath";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { cachedJellyfinMoviesAdmin, cachedJellyfinSeriesAdmin } from "@/lib/server-cache";
import { catalogueLinks } from "@/lib/sonarrLink";
import { kvCacheDb } from "@/lib/db";

/** Relue toutes les deux minutes : un tag ajouté ou retiré par l'administrateur s'applique vite. */
const TTL_MS = 2 * 60 * 1000;
const TIMEOUT_MS = 5000;

const cache = new Map<string, { tags: string[]; at: number }>();

/** Pour les tests. */
export function forgetBlockedTags(): void {
  cache.clear();
}

/**
 * Les tags bloqués d'un compte qu'on ne connaît pas — Jellyfin injoignable, et rien de gardé.
 *
 * Avant le 14/10/2026, ce cas rendait « aucun » : un compte jamais vu depuis le démarrage, pendant
 * une panne de Jellyfin, recevait le catalogue entier, titres réservés compris (le catalogue sait
 * se servir de listes gardées, §92). On ne montre pas sur une supposition : faute de savoir, **tout
 * titre portant un tag** est tenu pour bloqué (`carriesBlockedTag`). Un titre sans tag ne peut être
 * bloqué par aucun, il reste.
 */
export const UNKNOWN_BLOCKED_TAGS: readonly string[] = Object.freeze(["*inconnus*"]);

/** La copie sur disque, pour qu'un redémarrage pendant une panne ne fasse pas tout oublier. */
const diskKey = (jfId: string) => `blocked-tags:${jfId}`;

function rememberTags(jfId: string, tags: string[], now: number): void {
  const before = cache.get(jfId);
  cache.set(jfId, { tags, at: now });
  // Écrite quand elle change (ou au premier passage depuis le démarrage) : une ligne minuscule,
  // pas une écriture toutes les deux minutes par compte.
  if (before && before.tags.join(",") === tags.join(",")) return;
  try {
    kvCacheDb.set(diskKey(jfId), tags, now);
  } catch {
    // Un ornement : la mémoire suffit tant que le processus vit.
  }
}

function lastKnownTags(jfId: string): string[] | null {
  const known = cache.get(jfId);
  if (known) return known.tags;
  try {
    const disk = kvCacheDb.get(diskKey(jfId));
    if (disk && Array.isArray(disk.value) && disk.value.every((t) => typeof t === "string")) {
      const tags = disk.value as string[];
      // En mémoire, mais datée de son écriture : la prochaine occasion relira Jellyfin.
      cache.set(jfId, { tags, at: disk.fetchedAt });
      return tags;
    }
  } catch {
    // Base illisible : on ne sait pas.
  }
  return null;
}

/**
 * Les tags bloqués du compte Jellyfin, en minuscules. Si Jellyfin ne répond pas : la dernière
 * réponse connue (mémoire, puis disque), sinon `UNKNOWN_BLOCKED_TAGS` — jamais « aucun » sur une
 * supposition. Un 4xx (compte inconnu de Jellyfin) reste « aucun » : c'est une réponse.
 */
export async function blockedTagsOf(jfId: string, now = Date.now()): Promise<readonly string[]> {
  const known = cache.get(jfId);
  if (known && now - known.at < TTL_MS) return known.tags;
  try {
    const res = await jellyfinFetch(`${config.jellyfin.url}/Users/${jellyfinIdSegment(jfId)}`, {
      headers: jellyfinAuthHeaders(config.jellyfin.apiKey),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      if (res.status >= 500) return lastKnownTags(jfId) ?? UNKNOWN_BLOCKED_TAGS;
      return known?.tags ?? [];
    }
    const user = (await res.json()) as { Policy?: { BlockedTags?: string[] | null } };
    const tags = (user.Policy?.BlockedTags ?? []).filter((t): t is string => typeof t === "string" && t.length > 0).map((t) => t.toLowerCase());
    rememberTags(jfId, tags, now);
    return tags;
  } catch {
    return lastKnownTags(jfId) ?? UNKNOWN_BLOCKED_TAGS;
  }
}

/** L'élément porte-t-il un des tags bloqués ? Même comparaison que Jellyfin : la casse seule est ignorée. */
export function carriesBlockedTag(itemTags: readonly string[] | null | undefined, blocked: readonly string[]): boolean {
  if (!itemTags?.length || blocked.length === 0) return false;
  // Blocages inconnus (panne, rien de gardé) : tout titre étiqueté est tenu pour caché.
  if (blocked === UNKNOWN_BLOCKED_TAGS) return true;
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

/** L'identité Jellyfin du compte de la requête — la session seule, sans Jellyfin (§92 : utile pendant une panne). */
export async function requestJfId(req: Request): Promise<string | null> {
  const session = await verifySessionFull(sessionTokenOf(req));
  return session?.jfId ?? null;
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
): Promise<{ hidden: Set<number>; signature: string; jfId: string | null }> {
  const session = await verifySessionFull(sessionTokenOf(req));
  // Le compte aussi : le catalogue des séries en tire ce que ce compte a déjà vu (§75), sans relire la session.
  const jfId = session?.jfId ?? null;
  const blocked: readonly string[] = jfId ? await blockedTagsOf(jfId) : [];
  if (blocked.length === 0) return { hidden: new Set(), signature: "", jfId };
  const hidden = new Set(matched.filter((entry) => carriesBlockedTag(tagsOf(entry), blocked)).map(idOf));
  return { hidden, signature: [...blocked].sort().join(","), jfId };
}

/**
 * Les mêmes titres, désignés par TMDB (`movie:603`, `series:1399`) : la recherche et les rangées de
 * découverte parlent en identifiants TMDB et marquaient ce titre « dans la bibliothèque ». Un compte
 * qui ne le voit pas dans le catalogue ne le voit nulle part (08/10/2026).
 */
export async function hiddenTmdbKeysFor(jfId: string | null | undefined): Promise<Set<string>> {
  const blocked: readonly string[] = jfId ? await blockedTagsOf(jfId) : [];
  if (blocked.length === 0) return new Set();
  const [movies, series, links] = await Promise.all([
    cachedJellyfinMoviesAdmin().catch(() => []),
    cachedJellyfinSeriesAdmin().catch(() => []),
    catalogueLinks(),
  ]);
  const keys = new Set<string>();
  for (const [type, items] of [["movie", movies], ["series", series]] as const) {
    for (const item of items) {
      if (!carriesBlockedTag(item.Tags, blocked)) continue;
      const tmdb = item.ProviderIds?.Tmdb;
      if (tmdb) keys.add(`${type}:${tmdb}`);
      // Et le TMDB du titre que le catalogue range dans ce dossier (DECISIONS.md §89) : c'est sous
      // lui que la recherche et les rangées parlent de ce titre, quoi que Jellyfin en ait compris.
      const link = links.get(item.Id);
      if (link?.tmdbId) keys.add(`${link.type}:${link.tmdbId}`);
    }
  }
  return keys;
}
