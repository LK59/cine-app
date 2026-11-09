import { createTmdbClient } from "@/lib/clients/tmdb";
import { getTmdbLocale, type Locale } from "@/lib/i18n";
import { selectBio } from "@/lib/format";
import { logError } from "@/lib/logger";
import { enrichedPerson, personCreditsCached, personDetailsCached, personFilmography, personWithBiography } from "@/lib/tmdbPerson";
import { analysisTarget, castOf, type XrayPerson } from "./cast";

/**
 * Le panneau d'une personne d'« À l'écran » (DECISIONS.md §138, 10.27) — ce qui ne dépend pas du modèle :
 * l'âge et le lieu de naissance, une courte biographie, et deux ou trois de ses autres titres **ouvrables
 * dans la bibliothèque**. Tout vient du chemin des fiches personne du cinéma (`src/lib/tmdbPerson.ts` :
 * mêmes appels à TMDB et à Wikipédia, mêmes clés de cache, `selectBio` pour choisir la biographie), rien
 * n'est recopié.
 *
 * Lu par `/api/player/xray/[itemId]?person=<id>` — sous l'élément regardé, pour qu'un lien de partage y
 * passe par la règle de la route existante (portée `path`), et que la personne soit cherchée **dans la
 * distribution de cet élément** : on ne lit pas n'importe quelle personne de TMDB par cette porte.
 * Une absence attendue répond `status: "none"`, jamais une erreur (route appelée par personne).
 */

export interface XrayPersonFacts {
  status: "ok" | "none";
  personId?: number;
  birthday?: string | null;
  deathday?: string | null;
  placeOfBirth?: string | null;
  /** La biographie choisie (TMDB, sinon Wikipédia) — entière : l'écran la coupe à trois lignes. */
  bio?: string | null;
  /** Ses autres titres dans la bibliothèque (pas celui qu'on regarde), trois au plus. */
  library?: { tmdbId: number; mediaType: "movie" | "tv"; title: string; year: number | null; poster: string | null }[];
}

export const XRAY_LIBRARY_MAX = 3;
const POSTER = "https://image.tmdb.org/t/p/w185";

/** Une personne de la distribution de cet élément, ou `null`. */
export async function castPerson(itemId: string, personId: number): Promise<{ person: XrayPerson; tmdb: NonNullable<Awaited<ReturnType<typeof analysisTarget>>>["tmdb"] } | null> {
  const target = await analysisTarget(itemId.toLowerCase());
  if (!target?.tmdb) return null;
  const cast = await castOf(target.tmdb);
  const person = cast.find((p) => p.personId === personId);
  return person ? { person, tmdb: target.tmdb } : null;
}

export async function personFactsForPlayer(itemId: string, personId: number, lang: Locale, jfId: string | null | undefined): Promise<XrayPersonFacts> {
  try {
    const found = await castPerson(itemId, personId);
    if (!found) return { status: "none" };
    const locale = getTmdbLocale(lang);
    const tmdb = createTmdbClient(locale);
    if (!tmdb.isEnabled()) return { status: "none" };
    const [localized, enriched, credits] = await Promise.all([
      personDetailsCached(tmdb, locale, personId),
      enrichedPerson(tmdb, lang, personId),
      personCreditsCached(tmdb, locale, personId).catch(() => ({ cast: [] as never[] })),
    ]);
    const details = await personWithBiography(localized, locale, personId);
    const filmography = await personFilmography(credits.cast ?? [], jfId);
    const current = found.tmdb;
    const isCurrent = (c: { mediaType: string; tmdbId: number }) =>
      current?.kind === "movie" ? c.mediaType === "movie" && c.tmdbId === current.id : current?.kind === "episode" && c.mediaType === "tv" && c.tmdbId === current.tvId;
    const library = filmography
      .filter((c) => c.inLibrary && !isCurrent(c) && c.title)
      .slice(0, XRAY_LIBRARY_MAX)
      .map((c) => ({ tmdbId: c.tmdbId, mediaType: c.mediaType, title: c.title, year: c.year, poster: c.posterPath ? `${POSTER}${c.posterPath}` : null }));
    return {
      status: "ok",
      personId,
      birthday: details?.birthday ?? null,
      deathday: details?.deathday ?? null,
      placeOfBirth: details?.place_of_birth ?? null,
      bio: selectBio(details?.biography, enriched.wikiBio)?.text ?? null,
      library,
    };
  } catch (error) {
    logError("xray/person", error, { itemId, personId });
    return { status: "none" };
  }
}
