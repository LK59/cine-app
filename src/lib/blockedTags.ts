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
 * une panne de Jellyfin, recevait le catalogue entier, titres réservés compris (§92). La première
 * réponse cachait alors *tout titre étiqueté* — mais Jellyfin range les mots-clés de TMDB dans les
 * tags (562 films sur 650 en portent), et le catalogue devenait presque vide. Décidé par Louis le
 * même jour, priorité au catalogue : faute de savoir, on applique les tags que l'installation pose
 * d'office aux nouveaux comptes (`NEW_ACCOUNT_BLOCKED_TAGS`, « prive » ici) ; sans réglage, aucun.
 * La copie gardée par compte (mémoire, puis disque) passe toujours avant.
 */
export function unknownBlockedTags(): readonly string[] {
  return config.accounts.newBlockedTags
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

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
 * réponse connue (mémoire, puis disque), sinon `unknownBlockedTags()`. Un 4xx (compte inconnu de Jellyfin) reste « aucun » : c'est une réponse.
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
      if (res.status >= 500) return lastKnownTags(jfId) ?? unknownBlockedTags();
      return known?.tags ?? [];
    }
    const user = (await res.json()) as { Policy?: { BlockedTags?: string[] | null } };
    const tags = (user.Policy?.BlockedTags ?? []).filter((t): t is string => typeof t === "string" && t.length > 0).map((t) => t.toLowerCase());
    rememberTags(jfId, tags, now);
    return tags;
  } catch {
    return lastKnownTags(jfId) ?? unknownBlockedTags();
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
 * Combien de temps `hiddenTmdbKeysFor` attend Jellyfin — ses tags bloqués et ses listes — avant de se
 * rabattre sur ce qu'il a gardé (§92) : la recherche et les fiches attendaient sinon les cinq à treize
 * secondes d'un hôte figé. La même grâce que la recherche (`SEARCH_JELLYFIN_WAIT_MS`). L'appel
 * continue derrière et remplit les caches pour le suivant.
 */
export const HIDDEN_JELLYFIN_WAIT_MS = 1500;

/** `load` dans la limite de `ms` ; `null` passé ce délai ou en échec. L'appel n'est pas abandonné. */
function within<T>(ms: number, load: () => Promise<T>): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    (timer as { unref?: () => void }).unref?.();
    void Promise.resolve()
      .then(load)
      .then(
        (value) => resolve(value),
        () => resolve(null),
      )
      .finally(() => clearTimeout(timer));
  });
}

/**
 * L'index des titres étiquetés, par TMDB : pour chaque tag *surveillé*, les clés (`movie:603`,
 * `series:1399`) des titres qui le portent (14/10/2026, §54/§92).
 *
 * Pourquoi : `hiddenTmdbKeysFor` lit les tags des titres dans les listes Jellyfin de l'administrateur.
 * Jellyfin injoignable après un redémarrage de cine-app (ou au-delà de la copie périmée en mémoire),
 * ces listes manquaient, l'ensemble rendu était vide — et un titre « prive » réapparaissait dans la
 * recherche, la découverte et sa fiche pour un compte qui ne doit pas le voir. L'index est gardé sur
 * disque (`kv_cache`) à chaque calcul réussi, et relu quand les listes manquent.
 *
 * Petit exprès : seuls les tags bloqués de quelqu'un — ceux des comptes déjà lus (mémoire) et ceux
 * posés d'office (`unknownBlockedTags`) — et pas les mots-clés de TMDB que Jellyfin range aussi dans
 * les tags (562 films sur 650). Un tag présent dans `tags`, même sans clé, est un tag *connu* : sa
 * liste vide veut dire « aucun titre », pas « on ne sait pas ».
 */
interface TaggedIndex {
  tags: Record<string, string[]>;
}

const INDEX_KEY = "blocked-tags:tmdb-index";
let memoryIndex: TaggedIndex | null = null;
let savedIndexJson: string | null = null;

/** Pour les tests : la mémoire d'un processus neuf (le disque, lui, reste). */
export function forgetTaggedIndex(): void {
  memoryIndex = null;
  savedIndexJson = null;
}

/** Les tags dont l'index tient la liste : ceux que quelqu'un bloque, à notre connaissance. */
function watchedTags(extra: readonly string[]): Set<string> {
  const out = new Set<string>(unknownBlockedTags());
  for (const { tags } of cache.values()) for (const t of tags) out.add(t);
  for (const t of extra) out.add(t);
  return out;
}

function saveIndex(index: TaggedIndex, now: number): void {
  memoryIndex = index;
  const json = JSON.stringify(index);
  // Écrit quand il change : une ligne de quelques kilo-octets, pas une écriture par recherche.
  if (json === savedIndexJson) return;
  try {
    kvCacheDb.set(INDEX_KEY, index, now);
    savedIndexJson = json;
  } catch {
    // La mémoire suffit tant que le processus vit.
  }
}

function lastKnownIndex(): TaggedIndex | null {
  if (memoryIndex) return memoryIndex;
  try {
    const disk = kvCacheDb.get(INDEX_KEY);
    const value = disk?.value as TaggedIndex | undefined;
    if (value && typeof value.tags === "object" && value.tags !== null) {
      memoryIndex = value;
      savedIndexJson = JSON.stringify(value);
      return value;
    }
  } catch {
    // Base illisible : pas d'index.
  }
  return null;
}

/**
 * Les mêmes titres, désignés par TMDB (`movie:603`, `series:1399`) : la recherche et les rangées de
 * découverte parlent en identifiants TMDB et marquaient ce titre « dans la bibliothèque ». Un compte
 * qui ne le voit pas dans le catalogue ne le voit nulle part (08/10/2026).
 *
 * Jellyfin en panne (§92) : au plus `HIDDEN_JELLYFIN_WAIT_MS` d'attente, puis les tags gardés du
 * compte et l'index gardé des titres étiquetés. Un tag que l'index ne connaît pas (jamais de calcul
 * réussi sur cette installation, ou un tag bloqué neuf pendant la panne) ne cache rien de plus : le
 * catalogue d'abord (Louis, 14/10/2026). « prive », posé d'office, est toujours dans l'index.
 */
export async function hiddenTmdbKeysFor(jfId: string | null | undefined, now = Date.now()): Promise<Set<string>> {
  if (!jfId) return new Set();
  // Les listes partent en même temps que les tags : deux attentes bornées à la suite faisaient trois
  // secondes sur un hôte figé. Elles sont en cache (celui du catalogue) en temps normal.
  const listsPromise = Promise.all([
    within(HIDDEN_JELLYFIN_WAIT_MS, () => cachedJellyfinMoviesAdmin()),
    within(HIDDEN_JELLYFIN_WAIT_MS, () => cachedJellyfinSeriesAdmin()),
  ]);
  const blocked: readonly string[] =
    (await within(HIDDEN_JELLYFIN_WAIT_MS, () => blockedTagsOf(jfId, now))) ?? lastKnownTags(jfId) ?? unknownBlockedTags();
  if (blocked.length === 0) return new Set();
  const [movies, series] = await listsPromise;

  let index: TaggedIndex | null;
  if (movies && series) {
    const links = await catalogueLinks();
    const watched = watchedTags(blocked);
    const tags: Record<string, Set<string>> = {};
    for (const tag of watched) tags[tag] = new Set();
    for (const [type, items] of [["movie", movies], ["series", series]] as const) {
      for (const item of items) {
        if (!item.Tags?.length) continue;
        const carried = item.Tags.map((t) => t.toLowerCase()).filter((t) => watched.has(t));
        if (carried.length === 0) continue;
        const keys: string[] = [];
        const tmdb = item.ProviderIds?.Tmdb;
        if (tmdb) keys.push(`${type}:${tmdb}`);
        // Et le TMDB du titre que le catalogue range dans ce dossier (DECISIONS.md §89) : c'est sous
        // lui que la recherche et les rangées parlent de ce titre, quoi que Jellyfin en ait compris.
        const link = links.get(item.Id);
        if (link?.tmdbId) keys.push(`${link.type}:${link.tmdbId}`);
        for (const tag of carried) for (const key of keys) tags[tag].add(key);
      }
    }
    index = { tags: Object.fromEntries(Object.entries(tags).map(([tag, keys]) => [tag, [...keys].sort()])) };
    saveIndex(index, now);
  } else {
    index = lastKnownIndex();
  }

  // Un tag absent de l'index ne cache rien : cacher toute la bibliothèque à un compte restreint
  // (la règle du premier jet, 14/10/2026) coûtait la recherche et la découverte entières pour un cas
  // qu'aucune installation ne rencontre en pratique. Choix de Louis : le fonctionnement d'abord.
  const keys = new Set<string>();
  for (const tag of blocked) for (const key of index?.tags[tag] ?? []) keys.add(key);
  return keys;
}
