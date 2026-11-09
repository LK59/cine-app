import { createTmdbClient, TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { hiddenTmdbKeysFor } from "@/lib/blockedTags";
import { playableLibrary } from "@/lib/playerLibrary";
import { withPersistentCache } from "@/lib/server-cache";
import { sortFilmography } from "@/lib/filmographyOrder";

/**
 * Une personne chez TMDB, telle que les fiches personne du cinéma la lisent — sortie des routes
 * `/api/tmdb/person/[id]` et `/enriched` (10.27, 09/11/2026) pour qu'un second écran, le panneau d'une
 * personne d'« À l'écran » (DECISIONS.md §138), lise **la même chose par le même chemin** : mêmes appels,
 * mêmes clés de cache sur disque, même repli de la biographie, mêmes titres cachés par les tags bloqués.
 * Rien ici n'a changé de comportement en sortant des routes.
 */

/**
 * Une semaine, sur disque (23/09/2026) : une fiche personne coûtait deux appels à TMDB à chaque
 * ouverture, et une filmographie ne change pas d'un jour à l'autre. Seules les réponses de TMDB
 * sont gardées — ce qui est dans la bibliothèque est recalculé à chaque fois, pour qu'un film
 * arrivé hier y apparaisse aujourd'hui. Un échec n'est pas gardé (voir `withPersistentCache`).
 */
export const PERSON_WEEK_MS = 7 * 24 * 3600_000;

type TmdbClient = ReturnType<typeof createTmdbClient>;
export type TmdbPersonDetails = Awaited<ReturnType<TmdbClient["getPersonDetails"]>>;
type TmdbPersonCast = Awaited<ReturnType<TmdbClient["getPersonCredits"]>>["cast"];

/** Les détails dans la langue de qui regarde (`null` si TMDB ne répond pas). */
export function personDetailsCached(tmdb: TmdbClient, locale: string, personId: number): Promise<TmdbPersonDetails | null> {
  return withPersistentCache(`tmdb:person:details:${locale}:${personId}`, PERSON_WEEK_MS, () => tmdb.getPersonDetails(personId)).catch(() => null);
}

/**
 * Sans biographie dans la langue de qui regarde, celle en anglais. Le repli redemandait la même
 * langue au même client — donc la même réponse vide, et un appel de plus à chaque ouverture
 * (relevé le 23/09/2026).
 */
export async function personWithBiography(localized: TmdbPersonDetails | null, locale: string, personId: number): Promise<TmdbPersonDetails | null> {
  if (localized?.biography || locale === "en-US") return localized;
  return withPersistentCache(`tmdb:person:details:en-US:${personId}`, PERSON_WEEK_MS, () => createTmdbClient("en-US").getPersonDetails(personId)).catch(
    () => localized
  );
}

export function personCreditsCached(tmdb: TmdbClient, locale: string, personId: number) {
  return withPersistentCache(`tmdb:person:credits:${locale}:${personId}`, PERSON_WEEK_MS, () => tmdb.getPersonCredits(personId));
}

export interface FilmographyCredit {
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  mediaType: "movie" | "tv";
  character?: string;
  voteAverage: number;
  inLibrary: boolean;
  libraryHref: string | null;
  libraryId: number | null;
  voteCount: number | null;
}

/**
 * La filmographie d'une personne, reliée à la bibliothèque (seulement ce qui est **ouvrable**, voir
 * `playableLibrary`), triée (DECISIONS.md §98), sans ce que les tags bloqués du compte lui cachent (§54).
 */
export async function personFilmography(cast: TmdbPersonCast, jfId: string | null | undefined): Promise<FilmographyCredit[]> {
  const lib = await playableLibrary();
  const movieByTmdb = new Map([...lib.movies].map(([tmdbId, m]) => [tmdbId, m.id]));
  const seriesByTmdb = new Map([...lib.series].map(([tmdbId, s]) => [tmdbId, s.id]));

  // Deduplicate (same title can appear as multiple roles), keep highest popularity
  const seen = new Map<string, (typeof cast)[0]>();
  for (const c of cast) {
    const key = `${c.media_type}:${c.id}`;
    const existing = seen.get(key);
    if (!existing || c.popularity > existing.popularity) seen.set(key, c);
  }

  // L'ordre : bibliothèque, vrais rôles, puis note pondérée par les votes (DECISIONS.md §98).
  const credits = sortFilmography(
    [...seen.values()].map((c) => {
      const isMovie = c.media_type === "movie";
      const libraryId = isMovie ? movieByTmdb.get(c.id) : seriesByTmdb.get(c.id);
      return {
        tmdbId: c.id,
        title: (isMovie ? c.title : c.name) ?? "",
        year: new Date((isMovie ? c.release_date : c.first_air_date) ?? "").getFullYear() || null,
        posterPath: c.poster_path,
        mediaType: c.media_type,
        character: c.character,
        voteAverage: c.vote_average,
        inLibrary: Boolean(libraryId),
        libraryHref: libraryId ? (isMovie ? `/radarr/${libraryId}` : `/sonarr/${libraryId}`) : null,
        // Le même identifiant, nu : le lecteur ouvre une fiche par son id, pas par une adresse
        // de la partie gestion — et il ne doit surtout pas avoir à découper une URL pour ça.
        libraryId: libraryId ?? null,
        voteCount: c.vote_count ?? null,
        genreIds: c.genre_ids ?? null,
      };
    })
  ).map(({ genreIds: _genreIds, ...c }) => c); // le genre ne sert qu'au tri

  // Ce que les tags bloqués du compte lui cachent n'apparaît pas dans une filmographie (DECISIONS.md §54).
  const hidden = await hiddenTmdbKeysFor(jfId);
  return (credits as FilmographyCredit[]).filter((c) => !hidden.has(`${c.mediaType === "tv" ? "series" : "movie"}:${c.tmdbId}`));
}

// ── Wikipédia et les liens (la route `/enriched`) ─────────────────────────────────────────────────

export interface EnrichedPersonData {
  photos: string[]; // TMDb profile image URLs (w342)
  instagram: string | null; // full URL or null
  imdb: string | null; // full URL or null
  wikipedia: string | null; // full URL or null
  wikiBio: string | null; // Wikipedia extract in FR (or EN fallback)
}

export const EMPTY_ENRICHED: EnrichedPersonData = { photos: [], instagram: null, imdb: null, wikipedia: null, wikiBio: null };

function wikiLangOrder(locale: string): string[] {
  if (locale.startsWith("es")) return ["es", "en", "fr"];
  if (locale.startsWith("en")) return ["en", "fr"];
  if (locale.startsWith("de")) return ["de", "en", "fr"];
  return ["fr", "en"];
}

async function fetchWikipediaBio(
  name: string,
  wikidataId: string | null,
  locale: string,
  outcome: { failed: boolean } = { failed: false }
): Promise<{ bio: string | null; url: string | null }> {
  const langOrder = wikiLangOrder(locale);

  const tryLang = async (lang: string, title: string) => {
    try {
      const res = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, { signal: AbortSignal.timeout(4000) });
      // Une page absente (404) est une réponse ; une erreur de serveur ou une coupure n'en est pas
      // une, et ne doit pas finir gardée une semaine comme « pas de biographie ».
      if (!res.ok) {
        if (res.status >= 500 || res.status === 429) outcome.failed = true;
        return null;
      }
      const data = (await res.json()) as { extract?: string; content_urls?: { desktop?: { page?: string } }; type?: string };
      if (data.type === "disambiguation" || !data.extract) return null;
      return { bio: data.extract, url: data.content_urls?.desktop?.page ?? null };
    } catch {
      outcome.failed = true;
      return null;
    }
  };

  // If we have a Wikidata ID, resolve titles for all target languages at once
  if (wikidataId) {
    try {
      const wdRes = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${wikidataId}&format=json&props=sitelinks&origin=*`, {
        signal: AbortSignal.timeout(3000),
      });
      if (wdRes.ok) {
        const wdData = (await wdRes.json()) as { entities?: Record<string, { sitelinks?: Record<string, { title: string }> }> };
        const sitelinks = wdData.entities?.[wikidataId]?.sitelinks ?? {};
        for (const lang of langOrder) {
          const title = sitelinks[`${lang}wiki`]?.title;
          if (title) {
            const result = await tryLang(lang, title);
            if (result) return result;
          }
        }
      }
    } catch {
      /* fall through */
    }
  }

  // Fallback: search by name in locale order
  for (const lang of langOrder) {
    const result = await tryLang(lang, name);
    if (result) return result;
  }
  return { bio: null, url: null };
}

/**
 * Photos, liens et biographie de Wikipédia, une semaine sur disque (dix minutes en mémoire avant le
 * 23/09/2026 : perdues à chaque déploiement). Le moindre échec — une des trois réponses de TMDB, ou
 * Wikipédia injoignable — n'est pas gardé : une réponse partielle l'aurait été une semaine, une fiche
 * sans photos ou sans biographie parce qu'un appel avait échoué ce jour-là. `rawLang` : une langue
 * connue (la valeur entre dans la clé de cache).
 */
export function enrichedPerson(tmdb: TmdbClient, rawLang: string, personId: number): Promise<EnrichedPersonData> {
  return withPersistentCache<EnrichedPersonData>(`enriched:person:${personId}:${rawLang}`, PERSON_WEEK_MS, async () => {
    const [imagesData, externalIds, personDetails] = await Promise.all([
      tmdb.getPersonImages(personId),
      tmdb.getPersonExternalIds(personId),
      tmdb.getPersonDetails(personId),
    ]);

    const photos = (imagesData?.profiles ?? [])
      .sort((a, b) => b.vote_average - a.vote_average)
      .slice(0, 12)
      .map((p) => `${TMDB_IMAGE_BASE}/w342${p.file_path}`);

    const instagram = externalIds?.instagram_id ? `https://www.instagram.com/${externalIds.instagram_id}/` : null;
    const imdb = externalIds?.imdb_id ? `https://www.imdb.com/name/${externalIds.imdb_id}` : null;

    const wiki = { failed: false };
    const { bio: wikiBio, url: wikipedia } = await fetchWikipediaBio(personDetails?.name ?? "", externalIds?.wikidata_id ?? null, rawLang, wiki);
    if (!wikiBio && wiki.failed) throw new Error("Wikipédia injoignable");

    return { photos, instagram, imdb, wikipedia, wikiBio };
  }).catch((): EnrichedPersonData => ({ ...EMPTY_ENRICHED }));
}
