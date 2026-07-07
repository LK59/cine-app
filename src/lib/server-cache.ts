import { radarr } from "@/lib/clients/radarr";
import { sonarr } from "@/lib/clients/sonarr";
import { jellyseerr } from "@/lib/clients/jellyseerr";
import { jellyfin, JellyfinItem } from "@/lib/clients/jellyfin";

// ─── TTL constants ───────────────────────────────────────────────────────────

export const TTL = {
  VERY_SHORT:      5_000,     // torrents, sessions actives
  SHORT:          15_000,     // statut services
  MEDIUM:         30_000,     // bibliothèque Radarr/Sonarr, activité
  LONG:          120_000,     // bibliothèque Jellyfin
  VERY_LONG:     600_000,     // stats disque
  RECOMMENDATIONS: 300_000,   // recommandations TMDb
  MEDIA_INFO:     60_000,     // infos media Jellyseerr
} as const;

// ─── Internal store ───────────────────────────────────────────────────────────

interface Entry<T> {
  v: T;
  exp: number;
}

interface StaleEntry<T> {
  v: T;
  fetchedAt: number;
}

const store      = new Map<string, Entry<unknown>>();
const staleStore = new Map<string, StaleEntry<unknown>>();
const inFlight   = new Map<string, Promise<unknown>>();

// ─── Cache result type (for aggregated/dashboard endpoints) ──────────────────

export interface CacheResult<T> {
  data: T | null;
  available: boolean;
  error: string | null;
  updatedAt: number | null;
  stale: boolean;
}

// ─── Core helpers ─────────────────────────────────────────────────────────────

/**
 * withCache — fetch + cache with:
 *   - Anti-stampede: concurrent callers for the same key share one in-flight request
 *   - Stale fallback: if fetch fails and we have a previous value, serve it with a short TTL
 *   - forceRefresh: bypass the cache and re-fetch immediately
 */
export async function withCache<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  options: { forceRefresh?: boolean } = {}
): Promise<T> {
  if (!options.forceRefresh) {
    const hit = store.get(key) as Entry<T> | undefined;
    if (hit && Date.now() < hit.exp) return hit.v;
  }

  // Anti-stampede
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const p: Promise<T> = fn()
    .then((v) => {
      store.set(key, { v, exp: Date.now() + ttlMs });
      staleStore.set(key, { v, fetchedAt: Date.now() });
      return v;
    })
    .catch((err) => {
      // Try stale fallback — serve last known value with a reduced TTL so we retry soon
      const stale = staleStore.get(key) as StaleEntry<T> | undefined;
      if (stale) {
        store.set(key, { v: stale.v, exp: Date.now() + Math.min(ttlMs * 0.5, 30_000) });
        return stale.v;
      }
      throw err;
    })
    .finally(() => { inFlight.delete(key); });

  inFlight.set(key, p as Promise<unknown>);
  return p;
}

/**
 * withCacheSafe — same as withCache but never throws.
 * Returns a CacheResult with available/error/updatedAt metadata.
 * Use this for dashboard / aggregated endpoints that must return partial data.
 */
export async function withCacheSafe<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  options: { forceRefresh?: boolean } = {}
): Promise<CacheResult<T>> {
  try {
    const data = await withCache<T>(key, ttlMs, fn, options);
    const stale = staleStore.get(key) as StaleEntry<T> | undefined;
    const isStale = !!stale && (store.get(key)?.exp ?? 0) < Date.now() + ttlMs * 0.1;
    return { data, available: true, error: null, updatedAt: stale?.fetchedAt ?? null, stale: isStale };
  } catch (err) {
    const stale = staleStore.get(key) as StaleEntry<T> | undefined;
    if (stale) {
      return { data: stale.v, available: true, error: null, updatedAt: stale.fetchedAt, stale: true };
    }
    return {
      data: null,
      available: false,
      error: err instanceof Error ? err.message : "Erreur inconnue",
      updatedAt: null,
      stale: false,
    };
  }
}

// ─── Invalidation ─────────────────────────────────────────────────────────────

export function invalidateKey(key: string) {
  store.delete(key);
}

export function invalidateByPrefix(prefix: string) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

export function invalidateLibrary() {
  store.delete("radarr:movies");
  store.delete("sonarr:series");
}

export function invalidateJellyfinLibrary() {
  invalidateByPrefix("jf:");
}

// ─── Named cache entries ───────────────────────────────────────────────────────

export const cachedMovies = (opts?: { forceRefresh?: boolean }) =>
  withCache("radarr:movies", TTL.MEDIUM, () => radarr.getMovies(), opts);

export const cachedSeries = (opts?: { forceRefresh?: boolean }) =>
  withCache("sonarr:series", TTL.MEDIUM, () => sonarr.getSeries(), opts);

export const cachedJellyfinMovies = (userId: string, opts?: { forceRefresh?: boolean }) =>
  withCache(`jf:movies:${userId}`, TTL.LONG, () => jellyfin.getAllMovies(userId), opts);

export const cachedJellyfinMoviesAdmin = (opts?: { forceRefresh?: boolean }) =>
  withCache("jf:movies:admin", TTL.LONG, () => jellyfin.getAllMoviesAdmin(), opts);

export const cachedJellyfinSeries = (userId: string, opts?: { forceRefresh?: boolean }) =>
  withCache(`jf:series:${userId}`, TTL.LONG, () => jellyfin.getAllSeries(userId), opts);

export const cachedJellyfinSeriesAdmin = (opts?: { forceRefresh?: boolean }) =>
  withCache("jf:series:admin", TTL.LONG, () => jellyfin.getAllSeriesAdmin(), opts);

export const cachedMovieInfo = (tmdbId: number, opts?: { forceRefresh?: boolean }) =>
  withCache(`js:movie:${tmdbId}`, TTL.MEDIA_INFO, () => jellyseerr.getMovieMedia(tmdbId), opts);

export const cachedTvInfo = (tmdbId: number, opts?: { forceRefresh?: boolean }) =>
  withCache(`js:tv:${tmdbId}`, TTL.MEDIA_INFO, () => jellyseerr.getTvMedia(tmdbId), opts);

// ─── Jellyfin lookup helpers ──────────────────────────────────────────────────

function getProviderIdCI(ids: Record<string, string> | undefined, key: string): string | undefined {
  if (!ids) return undefined;
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(ids)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

// Strip accents, punctuation, keep only alphanum+spaces, lowercase
function normRaw(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")  // strip diacritics
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Articles to strip from the START of a title in Fr/En/Es/De
const LEADING_ARTICLES = /^(the|a|an|le|la|les|l|un|une|des|el|los|las|der|die|das) /i;

// Canonical title: strip leading article, collapse spaces, alphanum only
function normTitle(s: string): string {
  const raw = normRaw(s).replace(LEADING_ARTICLES, "");
  return raw.replace(/\s+/g, "");
}

// Also try the "Article, The" → "The Article" transposition Jellyfin sometimes does
function titleVariants(s: string): string[] {
  const base = normTitle(s);
  const variants = new Set<string>([base]);

  // "Title, The" → "The Title"
  const commaArticle = normRaw(s).match(/^(.+),\s*(the|le|la|les|un|une|el|der|die|das)$/i);
  if (commaArticle) {
    variants.add(normTitle(`${commaArticle[2]} ${commaArticle[1]}`));
  }
  // "The Title" → "Title, The" (reverse)
  const withArticle = normRaw(s).match(LEADING_ARTICLES);
  if (withArticle) {
    const article = withArticle[0].trim();
    const rest = normRaw(s).slice(withArticle[0].length);
    variants.add(normTitle(`${rest} ${article}`));
  }
  return [...variants];
}

function yearMatches(jfYear: number | undefined, radarrYear: number | null | undefined): boolean {
  if (!jfYear || !radarrYear) return true; // can't compare — allow match
  return Math.abs(jfYear - radarrYear) <= 1;
}

export function findJellyfinMovieByTmdb(
  items: JellyfinItem[],
  tmdbId: number,
  fallbackTitle?: string,
  fallbackYear?: number | null,
  fallbackImdbId?: string | null,
) {
  // Pass 1 — TMDb ID (most reliable when present)
  if (tmdbId > 0) {
    const byTmdb = items.find((i) => getProviderIdCI(i.ProviderIds, "tmdb") === String(tmdbId));
    if (byTmdb) return byTmdb;
  }

  // Pass 2 — IMDb ID (also very reliable, often present when TMDb isn't)
  if (fallbackImdbId) {
    const byImdb = items.find((i) => getProviderIdCI(i.ProviderIds, "imdb") === fallbackImdbId);
    if (byImdb) return byImdb;
  }

  // Pass 3 — Normalized title + year ±1
  if (fallbackTitle) {
    const variants = titleVariants(fallbackTitle);
    const withYear = items.find((i) => {
      const jfVariants = titleVariants(i.Name);
      if (!variants.some((v) => jfVariants.includes(v))) return false;
      return yearMatches(i.ProductionYear, fallbackYear);
    });
    if (withYear) return withYear;

    // Pass 4 — Title only, no year (last resort for edge cases)
    const noYear = items.find((i) => {
      const jfVariants = titleVariants(i.Name);
      return variants.some((v) => jfVariants.includes(v));
    });
    if (noYear) return noYear;
  }

  return null;
}

export function findJellyfinSeriesByTvdb(
  items: JellyfinItem[],
  tvdbId: number,
  fallbackTitle?: string,
  fallbackYear?: number | null,
) {
  // Pass 1 — TVDb ID
  if (tvdbId > 0) {
    const byId = items.find((i) => getProviderIdCI(i.ProviderIds, "tvdb") === String(tvdbId));
    if (byId) return byId;
  }

  // Pass 2 — Normalized title + year ±1
  if (fallbackTitle) {
    const variants = titleVariants(fallbackTitle);
    const withYear = items.find((i) => {
      const jfVariants = titleVariants(i.Name);
      if (!variants.some((v) => jfVariants.includes(v))) return false;
      return yearMatches(i.ProductionYear, fallbackYear);
    });
    if (withYear) return withYear;

    // Pass 3 — Title only
    return items.find((i) => {
      const jfVariants = titleVariants(i.Name);
      return variants.some((v) => jfVariants.includes(v));
    }) ?? null;
  }
  return null;
}
