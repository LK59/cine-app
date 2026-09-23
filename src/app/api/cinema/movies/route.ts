import { NextResponse } from "next/server";
import { upstreamFailure } from "@/lib/upstreamResponse";
import { cachedJson } from "@/lib/cachedJson";
import { cachedMovies, cachedJellyfinMoviesAdmin, findJellyfinMovieByTmdb } from "@/lib/server-cache";
import { posterUrl, backdropUrl, tmdbResize, libraryPoster } from "@/lib/images";
import { localeOf, type Locale } from "@/lib/i18n";
import { getTitleArt } from "@/lib/title-art";
import { getTitleNames, localizedTitle } from "@/lib/titleNames";
import { recentlyAddedRail, dailyTop10, type Top10Theme } from "@/lib/cinemaRails";
import { dailyTop10Db } from "@/lib/db";
import type { HydratedPayload } from "@/lib/cinemaPayload";
import { toDynamicRange, type VideoQuality } from "@/lib/videoQuality";
import type { RadarrMovie } from "@/lib/clients/radarr";

export interface CinemaMovie {
  radarrId: number;
  jellyfinItemId: string;
  tmdbId: number;
  title: string;
  /**
   * Le titre de Radarr, quand on en affiche un autre — celui de la langue de qui regarde (voir
   * `titleNames`). Gardé pour la recherche : on cherche souvent un film sous son nom anglais.
   */
  aka?: string;
  /**
   * Le titre d'origine, seulement quand il diffère de celui qu'on affiche.
   *
   * Cent neuf films sur sept cent dix, sur cette bibliothèque. Sans lui, « Die Hard » ne trouvait
   * pas *Piège de cristal* et « The Hunt » pas *La Chasse* — alors que le serveur, lui, sait déjà
   * faire ce pont avec TMDB. Il n'est écrit que lorsqu'il apporte quelque chose, ce qui laisse la
   * charge utile à cinq kilo-octets près : un champ absent est un champ qui ne coûte rien.
   *
   * Les *titres alternatifs* de Radarr ont été écartés après mesure : sept mille neuf cent
   * soixante et onze entrées, cent quatre-vingts kilo-octets, et ce Radarr n'indique pas leur
   * langue — impossible de garder « FNaF 2 » sans embarquer aussi le hongrois et le turc.
   */
  originalTitle?: string;
  year: number;
  posterUrl: string | null;
  backdropUrl: string | null;
  logoUrl: string | null;
  /**
   * L'affiche sans le titre imprimé dessus, quand TMDB en a une.
   *
   * Elle ne remplace l'affiche ordinaire que là où l'on pose déjà notre propre logo par-dessus —
   * la bannière du téléphone. Ailleurs (les rangées), le titre écrit sur l'affiche est justement
   * ce qui permet de la reconnaître, et on garde l'affiche ordinaire.
   */
  posterTextlessUrl: string | null;
  overview: string | null;
  imdbRating: string | null;
  /**
   * La durée, en minutes.
   *
   * Elle n'existait que dans la fiche d'un titre, alors qu'elle est ce qu'on veut savoir *avant*
   * d'ouvrir quoi que ce soit — c'est elle qui décide si on lance le film ce soir. Radarr la donne
   * déjà pour chacun des titres de cette bibliothèque ; la porter ici coûte un nombre par film.
   */
  runtimeMinutes: number | null;
  /**
   * La qualité de l'image, que Radarr connaît déjà pour 690 fichiers sur 690.
   *
   * Gratuite : elle vient de `movieFile`, déjà présent dans la réponse que cette route demandait
   * de toute façon. Les champs sont omis quand ils sont inconnus, donc un film sans information
   * ne coûte rien à la charge utile — voir `videoQuality` pour ce qu'on accepte d'en dire.
   */
  quality?: VideoQuality;
  genres: string[];
  // Drives the "Nouveau" badge and the "Récemment ajoutés" rail. Null when Radarr has no real
  // date for it (its "never" sentinel included — see lib/cinemaRails).
  addedAt: string | null;
}

export interface CinemaMoviesWire {
  genres: string[];
  /**
   * Les titres une fois chacun. Tout le reste ne porte que des identifiants — voir
   * `cinemaPayload` : un titre était sérialisé une fois par genre, soit deux fois et demie
   * la charge nécessaire sur cette bibliothèque.
   */
  items: CinemaMovie[];
  rows: Record<string, number[]>;
  spotlight: number[];
  // Curated rails, computed here so the movie and series screens can't drift apart on what they
  // mean (see lib/cinemaRails for each one's definition).
  recentlyAdded: number[];
  top10: number[];
  /**
   * Ce que le palmarès du jour classe — un genre, une décennie, ou rien.
   *
   * Renvoyé plutôt que déduit côté écran : c'est le serveur qui tire le thème de la date, et deux
   * écrans qui le calculeraient chacun de leur côté pourraient tomber sur des jours différents —
   * celui de l'appareil, pas celui du serveur.
   */
  top10Theme: Top10Theme | null;
}

// Bulk-included here (like poster/backdrop already were) rather than fetched per-item on focus
// — Cinema Mode's whole hero/detail idea is an instant title treatment, not a spinner-then-swap.
// getTitleLogo() is persistently cached 7 days per title (same cache the per-item
// /api/radarr/movies/[id]/info route already populates), so only the very first request after a
// cold cache pays the full TMDB round-trip for the whole library at once — every request after
// that, including this one, is cache reads only.
async function toCinemaMovie(m: RadarrMovie, jellyfinItemId: string, locale: Locale): Promise<CinemaMovie> {
  // Le logo et l'affiche sans texte viennent de la même réponse TMDB et de la même entrée de
  // cache : la seconde ne coûte donc pas un appel de plus.
  const art = await getTitleArt(m.tmdbId, "movie");
  const { title, aka } = localizedTitle(getTitleNames(m.tmdbId, "movie"), locale, m.title);
  return {
    radarrId: m.id,
    runtimeMinutes: m.runtime && m.runtime > 0 ? m.runtime : null,
    jellyfinItemId,
    tmdbId: m.tmdbId,
    title,
    ...(aka ? { aka } : {}),
    ...(m.originalTitle && m.originalTitle !== title && m.originalTitle !== aka ? { originalTitle: m.originalTitle } : {}),
    year: m.year,
    // L'affiche dans la langue de qui regarde, celle de Radarr sinon. Voir `libraryPoster`.
    posterUrl: libraryPoster(art.posterByLang, m.images, locale),
    backdropUrl: tmdbResize(backdropUrl(m.images, "full"), "w1280"),
    logoUrl: art.logoUrl,
    posterTextlessUrl: art.posterTextlessUrl,
    overview: m.overview ?? null,
    // Radarr already resolves this itself at add/refresh time (Skyhook) — free, no
    // OMDb/TMDB round trip needed, same field fetchHero() in the dashboard route uses.
    imdbRating: m.ratings?.imdb?.value != null ? m.ratings.imdb.value.toFixed(1) : null,
    quality: videoQualityOf(m),
    genres: m.genres ?? [],
    addedAt: m.added ?? null,
  };
}

/**
 * Ce que Radarr sait du fichier, réduit à ce qui s'affiche.
 *
 * `undefined` plutôt qu'un objet vide quand il n'y a rien à dire : c'est ce qui fait qu'un film
 * sans information ne pèse pas une clé de plus dans la charge utile.
 */
function videoQualityOf(m: RadarrMovie): VideoQuality | undefined {
  const resolution = m.movieFile?.quality?.quality?.resolution;
  const dynamicRange = toDynamicRange(m.movieFile?.mediaInfo?.videoDynamicRangeType);
  if (!resolution && !dynamicRange) return undefined;
  return {
    ...(resolution ? { resolution } : {}),
    ...(dynamicRange ? { dynamicRange } : {}),
  };
}

// Cinema Mode is library-only and movies-only for now (series + their own season/episode
// screen are a follow-up) — every item returned here must already be playable, so items
// without a resolved Jellyfin match are skipped entirely rather than shown inert.


/**
 * La bibliothèque, vue par le serveur et non par un compte.
 *
 * Cette route a lu un temps `/Users/{id}/Items` pour ne montrer à chacun que ce qu'il peut voir.
 * Mesuré sur Jellyfin 10.11 : cet endpoint renvoyait 546 films là où la vue serveur en comptait
 * 674 — et pour un compte **administrateur, avec accès à toutes les bibliothèques**. Ce n'était
 * donc pas une question de droits : le parcours à partir des vues d'un utilisateur ne descendait
 * pas dans tout l'arbre. Cent vingt-huit films disparaissaient du catalogue, dont un que Louis
 * était en train de regarder — sa reprise ouvrait une fiche introuvable, donc rien.
 *
 * **Jellyfin 12 a corrigé ce défaut.** Remesuré le 2026-09-08, le jour de la montée de version :
 * 554 films des deux côtés, à l'unité près. L'annonce le laissait entendre — `GetItems` devient
 * asynchrone et applique `recursive` quand des filtres sont demandés, « la même requête peut
 * renvoyer un jeu de résultats différent de 10.11 ».
 *
 * On garde pourtant la vue serveur, et c'est maintenant un choix et non une contrainte : cette
 * application est publiée pour d'autres installations, dont certaines resteront en 10.11 un
 * moment. Un catalogue amputé d'un cinquième y serait un défaut silencieux, alors que la vue
 * serveur est correcte sur les deux versions.
 *
 * Ce que ça implique, et qu'il faut savoir avant de le changer : le catalogue est **le même pour
 * tout le monde**, et les permissions ne s'appliquent qu'à la lecture, où Jellyfin refuse. Le jour
 * où un compte devra voir une bibliothèque restreinte, la vue serveur deviendra franchement
 * fausse — elle lui montrerait des titres qu'il ne peut pas ouvrir. `cachedJellyfinMovies(userId)`
 * existe déjà pour ce jour-là ; le prix à payer sera un cache par compte au lieu d'un seul, pour
 * une charge utile qui ne se partagera plus.
 */
export async function GET(req: Request) {
  try {
    const [movies, jellyfinMovies] = await Promise.all([cachedMovies(), cachedJellyfinMoviesAdmin()]);

    const downloaded = movies.filter((m) => m.hasFile);
    const matched = downloaded
      .map((m) => ({ m, jfItem: findJellyfinMovieByTmdb(jellyfinMovies, m.tmdbId, m.title, m.year, m.imdbId ?? null) }))
      .filter((x): x is { m: RadarrMovie; jfItem: NonNullable<typeof x.jfItem> } => x.jfItem !== null);

    const locale = localeOf(req);
    const cinemaMovies = await Promise.all(matched.map(({ m, jfItem }) => toCinemaMovie(m, jfItem.Id, locale)));

    const byRadarrId = new Map<number, CinemaMovie>();
    // Des identifiants, pas des titres : un film à trois genres n'a pas à être écrit trois
    // fois. Voir `cinemaPayload` — le client reconstruit la forme complète à l'arrivée.
    const rows: Record<string, number[]> = {};
    const genreSet = new Set<string>();

    for (const cinemaMovie of cinemaMovies) {
      byRadarrId.set(cinemaMovie.radarrId, cinemaMovie);
      for (const g of cinemaMovie.genres) {
        genreSet.add(g);
        (rows[g] ??= []).push(cinemaMovie.radarrId);
      }
    }

    const spotlight = downloaded
      .filter((m) => byRadarrId.has(m.id) && m.added && m.added !== "0001-01-01T00:00:00Z")
      .sort((a, b) => new Date(b.added!).getTime() - new Date(a.added!).getTime())
      .slice(0, 10)
      .map((m) => byRadarrId.get(m.id)!);

    // Le thème du jour est tiré de la date, donc le même pour tout le monde et stable tant que la
    // journée dure — voir `dailyTop10`.
    const top10OfTheDay = dailyTop10(cinemaMovies, undefined, (item) => item.radarrId, dailyTop10Db.forKind("movies"));

    const payload: CinemaMoviesWire = {
      genres: [...genreSet].sort(),
      rows,
      items: cinemaMovies,
      spotlight: spotlight.map((i) => i.radarrId),
      recentlyAdded: recentlyAddedRail(cinemaMovies).map((i) => i.radarrId),
      top10: top10OfTheDay.items.map((i) => i.radarrId),
      top10Theme: top10OfTheDay.theme,
    };
    // Étiquetée et compressée : un retour sur l'onglet ne retélécharge plus le catalogue
    // entier, il demande seulement s'il a changé. Voir `cachedJson`.
    // Une entrée par langue : les titres et les affiches en dépendent, et deux spectateurs de
    // langues différentes s'évinçaient l'un l'autre — une recompression complète à chaque fois.
    return cachedJson(req, `cinema-movies:${locale}`, payload);
  } catch (err) {
    // Une panne amont se nomme, elle ne sort pas en 500 nu — voir `upstreamFailure`.
    return upstreamFailure(err, "cinema-movies");
  }
}

/**
 * Ce que les écrans lisent : les mêmes listes, mais pleines de titres.
 *
 * `CinemaMoviesWire` est ce qui voyage — les titres une fois, des identifiants ailleurs. `cinemaFetcher`
 * rend cette forme-ci à l'arrivée, si bien qu'aucun écran n'a eu à changer. Voir `cinemaPayload`.
 */
export type CinemaMoviesPayload = HydratedPayload<CinemaMovie> & { top10Theme: Top10Theme | null };
