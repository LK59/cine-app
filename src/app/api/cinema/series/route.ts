import { NextResponse } from "next/server";
import { hiddenForRequest, withoutHidden } from "@/lib/blockedTags";
import { tvEpisodeRuntime } from "@/lib/tvRuntime";
import { canonicalGenres } from "@/lib/genres";
import { upstreamFailure } from "@/lib/upstreamResponse";
import { cachedJson } from "@/lib/cachedJson";
import { cachedSeries, cachedJellyfinSeriesAdmin, cachedJellyfinFirstEpisodes, cachedJellyfinSeasons, cachedJellyfinRecentEpisodes, cachedJellyfinPlayedAmong } from "@/lib/server-cache";
import { latestArrivals, seriesFreshness } from "@/lib/seriesArrival";
import { matchSeries } from "@/lib/catalogueMembers";
import { cataloguePoster, seriesBackdrop } from "@/lib/images";
import { localeOf, type Locale } from "@/lib/i18n";
import { getTitleArt, logoForLocale } from "@/lib/title-art";
import { catalogueExtras, getTitleExtras, type TitleExtras, getTitleNames, getTitleOverviews, localizedOverview, localizedTitle } from "@/lib/titleNames";
import { getImdbRating } from "@/lib/imdb-rating";
import { recentlyAddedRail, dailyTop10, type Top10Theme } from "@/lib/cinemaRails";
import { dailyTop10Db } from "@/lib/db";
import type { HydratedPayload } from "@/lib/cinemaPayload";
import type { SonarrSeries } from "@/lib/clients/sonarr";

export interface CinemaSeries {
  sonarrId: number;
  jellyfinItemId: string;
  tvdbId: number;
  tmdbId: number | null;
  title: string;
  /** Le titre de Sonarr, quand on en affiche un autre. Voir la note jumelle des films. */
  aka?: string;
  year: number;
  posterUrl: string | null;
  backdropUrl: string | null;
  logoUrl: string | null;
  /** Voir la note jumelle dans la route des films. */
  posterTextlessUrl: string | null;
  overview: string | null;
  /**
   * L'accroche et la bande-annonce, pour que la fiche les montre dès l'ouverture (08/10/2026) :
   * absentes tant que le serveur ne les sait pas — la fiche attend alors sa description —, chaîne
   * vide ou `null` quand le titre n'en a pas. Voir `TitleExtras`.
   */
  tagline?: string;
  trailerKey?: string | null;
  /** Les premiers noms de la distribution, pour la bannière du bureau — absents tant qu'ils ne sont pas sus. */
  castNames?: string[];
  /** La durée d'un épisode, en minutes — absente tant qu'elle n'est pas sue, comme les deux autres. */
  episodeRuntime?: number | null;
  /**
   * Le premier épisode (S1·É1), pour que « Lire » paraisse dès l'ouverture d'une série jamais
   * commencée — la seule que ni « Reprendre » ni « À suivre » ne connaissent (08/10/2026). Une
   * supposition, la même pour tous : la fiche la remplace par ce que le serveur dit de ce compte, et
   * un appui qui la précède attend cette réponse (`waitForServer` sur `PlayButton`).
   */
  firstEpisode?: { itemId: string; runtimeTicks: number | null };
  /** Le nombre de saisons qui ont des épisodes, spéciaux compris — comme la liste de la fiche. */
  seasonCount?: number;
  imdbRating: string | null;
  genres: string[];
  /**
   * Same role as the movie payload's own field — the badge, the recently-added rail, the new-arrivals
   * banner, the grid's "recent" sort. For a series it is the date of the latest thing this account can
   * watch there and hasn't: max(the series' own arrival, its latest episode's) — DECISIONS.md §74.
   */
  addedAt: string | null;
  /**
   * What `addedAt` names when it is recent — the badge's words (« Nouvelle série / saison / Nouvel
   * épisode »). Absent when there is nothing new to say, and in a catalogue kept from before it.
   */
  arrival?: "series" | "season" | "episode";
}

export interface CinemaSeriesWire {
  genres: string[];
  /**
   * Les titres une fois chacun. Tout le reste ne porte que des identifiants — voir
   * `cinemaPayload` : un titre était sérialisé une fois par genre, soit deux fois et demie
   * la charge nécessaire sur cette bibliothèque.
   */
  items: CinemaSeries[];
  rows: Record<string, number[]>;
  spotlight: number[];
  recentlyAdded: number[];
  top10: number[];
  /** Le thème du palmarès du jour — voir la route des films, même mécanisme. */
  top10Theme: Top10Theme | null;
}

// Mirrors /api/cinema/movies/route.ts exactly (see its own comments for the reasoning behind
// each choice — bulk-included logo/rating, jellyfin-match-required filtering, genre rows +
// spotlight) — the one real difference is IMDb rating: Radarr resolves that for movies itself
// (Skyhook, free), but Sonarr doesn't for series, hence the extra getImdbRating() call here
// (OMDb-backed, 24h persistently cached — same helper the dashboard route already uses for its
// own "recently added series" rail).
/**
 * L'accroche, la bande-annonce et la durée d'un épisode (« 43min/ép. ») : la même règle que la
 * fiche (`tvEpisodeRuntime`), la durée de Sonarr comprise. Absentes ensemble tant que TMDB n'a pas
 * répondu pour ce titre.
 */
function seriesExtras(extras: TitleExtras | null, locale: Locale, sonarrRuntime: number | null | undefined) {
  if (!extras) return {};
  return { ...catalogueExtras(extras, locale), episodeRuntime: tvEpisodeRuntime(extras.tvRuntime ?? null, sonarrRuntime) };
}

async function toCinemaSeries(
  s: SonarrSeries,
  jellyfinItem: { Id: string; BackdropImageTags?: string[]; ImageTags?: { Primary?: string } },
  locale: Locale,
  firstEpisode: CinemaSeries["firstEpisode"],
  seasonCount: number | undefined,
  freshness: Pick<CinemaSeries, "addedAt" | "arrival">
): Promise<CinemaSeries> {
  // Independent lookups (different upstreams, different cache keys) — run concurrently rather
  // than one after the other, halving the cold-cache latency per series that hasn't been seen
  // by either cache before (steady state is unaffected either way, both are cache reads then).
  const [art, imdbRating] = await Promise.all([
    getTitleArt(s.tmdbId ?? 0, "series"),
    s.tmdbId ? getImdbRating(s.tmdbId, "series") : Promise.resolve(null),
  ]);
  const names = getTitleNames(s.tmdbId, "series");
  const { title, aka } = localizedTitle(names, locale, s.title);
  return {
    sonarrId: s.id,
    jellyfinItemId: jellyfinItem.Id,
    tvdbId: s.tvdbId,
    tmdbId: s.tmdbId ?? null,
    title,
    ...(aka ? { aka } : {}),
    year: s.year,
    // La langue de qui regarde, celle de Jellyfin sinon, celle de Sonarr en dernier — voir `jellyfinPoster`.
    posterUrl: cataloguePoster("series", art.posterByLang, s.images, locale, jellyfinItem),
    // Redimensionné par Jellyfin plutôt que l'original de TheTVDB — voir `seriesBackdrop`.
    backdropUrl: seriesBackdrop(jellyfinItem, s.images),
    // Le logo de la langue du titre affiché — voir `logoForLocale` (DECISIONS.md §58).
    logoUrl: logoForLocale(art, names, locale),
    posterTextlessUrl: art.posterTextlessUrl,
    // Dans la langue de qui regarde quand TMDB la connaît — voir `TitleOverviews`.
    overview: localizedOverview(getTitleOverviews(s.tmdbId, "series"), locale, s.overview ?? null),
    // L'accroche et la bande-annonce, là dès l'ouverture de la fiche — voir `TitleExtras`.
    ...seriesExtras(getTitleExtras(s.tmdbId, "series"), locale, s.runtime),
    imdbRating,
    // Sous leur nom commun : « Horreur » et « Horror » ne font qu'un genre — voir `genres.ts`.
    genres: canonicalGenres(s.genres),
    addedAt: freshness.addedAt,
    ...(freshness.arrival ? { arrival: freshness.arrival } : {}),
    ...(firstEpisode ? { firstEpisode } : {}),
    ...(seasonCount ? { seasonCount } : {}),
  };
}

// Library-only, same as movies: every item returned here must already have at least one
// downloaded episode AND a resolved Jellyfin match — a series with neither isn't playable, so
// it's skipped entirely rather than shown inert. Season/episode-level Cinema Mode (browsing what
// episodes actually exist) is a separate route — this one is just the browse grid.

/**
 * La vue serveur, et non celle d'un compte — voir la note jumelle dans la route des films, où les
 * deux comptages sont écrits : le défaut de 10.11, sa correction en 12, et pourquoi on garde la
 * vue serveur malgré tout.
 */
export async function GET(req: Request) {
  try {
    const [series, jellyfinSeries, firstEpisodes, seasons, recentEpisodes] = await Promise.all([
      cachedSeries(),
      cachedJellyfinSeriesAdmin(),
      // Deux ornements : sans eux, la fiche attend sa liste d'épisodes comme avant.
      cachedJellyfinFirstEpisodes().catch(() => []),
      cachedJellyfinSeasons().catch(() => []),
      // Un troisième : sans lui, chaque série garde sa propre date, comme avant le 12/10/2026 (§74).
      cachedJellyfinRecentEpisodes().catch(() => []),
    ]);
    // Les saisons non vides de chaque série, par numéro : une saison sans épisode n'est pas une
    // saison qu'on peut regarder, et la liste de la fiche ne la montre pas.
    const seasonsBySeries = new Map<string, Set<number>>();
    for (const season of seasons) {
      if (!season.SeriesId || (season.ChildCount ?? 1) <= 0) continue;
      const numbers = seasonsBySeries.get(season.SeriesId) ?? new Set<number>();
      numbers.add(season.IndexNumber ?? -1);
      seasonsBySeries.set(season.SeriesId, numbers);
    }
    const firstBySeries = new Map<string, NonNullable<CinemaSeries["firstEpisode"]>>();
    for (const ep of firstEpisodes) {
      if (ep.SeriesId && !firstBySeries.has(ep.SeriesId)) firstBySeries.set(ep.SeriesId, { itemId: ep.Id, runtimeTicks: ep.RunTimeTicks ?? null });
    }

    // La règle du catalogue, commune à tout ce qui dit « dans la bibliothèque » (`catalogueMembers`).
    const matched = matchSeries(series, jellyfinSeries);

    // Le compte de la requête : ses tags bloqués (§54), et ce qu'il a déjà vu (§74).
    const { hidden, signature, jfId } = await hiddenForRequest(req, matched, (x) => x.jfItem.Tags, (x) => x.s.id);

    // La date de chaque série pour ce compte (DECISIONS.md §74). Le catalogue est commun, mais « déjà
    // vu » appartient au compte : décidé ici, où l'identité est connue, plutôt que sur l'appareil, qui
    // n'a aucun état « vu » par épisode en main. Une requête pour toute la liste, pas une par carte ;
    // un Jellyfin qui ne répond pas laisse remonter — on ne cache pas un épisode sur une supposition.
    const arrivals = latestArrivals(recentEpisodes);
    const latestIds = matched.map(({ jfItem }) => arrivals.get(jfItem.Id)?.episodeId).filter((id): id is string => !!id);
    const seen: Set<string> = jfId && latestIds.length > 0 ? await cachedJellyfinPlayedAmong(jfId, latestIds).catch(() => new Set<string>()) : new Set<string>();
    const now = Date.now();
    const freshnessOf = (s: SonarrSeries, jfItem: { Id: string; DateCreated?: string }) => {
      const latest = arrivals.get(jfItem.Id);
      return seriesFreshness({
        sonarrAddedAt: s.added ?? null,
        libraryAddedAt: jfItem.DateCreated,
        latest,
        seenLatest: latest ? seen.has(latest.episodeId) : false,
        now,
      });
    };

    const locale = localeOf(req);
    const cinemaSeries = await Promise.all(
      matched.map(({ s, jfItem }) => toCinemaSeries(s, jfItem, locale, firstBySeries.get(jfItem.Id), seasonsBySeries.get(jfItem.Id)?.size, freshnessOf(s, jfItem)))
    );

    // Des identifiants, pas des titres : un film à trois genres n'a pas à être écrit trois
    // fois. Voir `cinemaPayload` — le client reconstruit la forme complète à l'arrivée.
    const rows: Record<string, number[]> = {};
    const genreSet = new Set<string>();

    for (const cs of cinemaSeries) {
      for (const g of cs.genres) {
        genreSet.add(g);
        (rows[g] ??= []).push(cs.sonarrId);
      }
    }

    // Les nouveautés de la bannière : la même date que la rangée — celle du dernier épisode pour une
    // série qui en reçoit (§74). Elle lisait l'ajout dans Sonarr, et une saison qui arrivait n'y
    // apparaissait jamais.
    const spotlight = recentlyAddedRail(cinemaSeries, 10);

    // La graine est la date, mais les thèmes éligibles ne sont pas les mêmes que pour les films —
    // une collection de séries n'a ni les mêmes genres ni les mêmes décennies en quantité. Les deux
    // rangées peuvent donc porter des thèmes différents le même jour, et c'est très bien : chacune
    // parle de ce qu'elle contient.
    //
    // Classé sur la date de la série dans Sonarr, la même pour tous : le palmarès départage ses
    // ex-aequo par la date, et celle de §74 dépend du compte — deux comptes auraient lu deux top 10.
    const sonarrAdded = new Map(matched.map(({ s }) => [s.id, s.added ?? null]));
    const top10OfTheDay = dailyTop10(
      cinemaSeries.map((cs) => ({ ...cs, addedAt: sonarrAdded.get(cs.sonarrId) ?? null })),
      undefined,
      (item) => item.sonarrId,
      dailyTop10Db.forKind("series")
    );

    const payload: CinemaSeriesWire = {
      genres: [...genreSet].sort(),
      rows,
      items: cinemaSeries,
      spotlight: spotlight.map((i) => i.sonarrId),
      recentlyAdded: recentlyAddedRail(cinemaSeries).map((i) => i.sonarrId),
      top10: top10OfTheDay.items.map((i) => i.sonarrId),
      top10Theme: top10OfTheDay.theme,
    };
    // Étiquetée et compressée : un retour sur l'onglet ne retélécharge plus le catalogue
    // entier, il demande seulement s'il a changé. Voir `cachedJson`.
    // Une entrée par langue — voir la route des films.
    // Sans ce que les tags bloqués du compte lui cachent (DECISIONS.md §54) : construit une fois en
    // entier — le classement du jour est gardé par sorte, pas par compte —, puis retiré.
    // Une entrée par compte depuis §74 : les dates dépendent de ce qu'il a vu. Bornée par le nombre
    // de comptes — une clé par ensemble « vu » grandirait sans fin.
    return cachedJson(req, `cinema-series:${locale}:${signature}:${jfId ?? ""}`, withoutHidden(payload, hidden, (item) => item.sonarrId));
  } catch (err) {
    // Une panne amont se nomme, elle ne sort pas en 500 nu — voir `upstreamFailure`.
    return upstreamFailure(err, "cinema-series");
  }
}

/**
 * Ce que les écrans lisent : les mêmes listes, mais pleines de titres.
 *
 * `CinemaSeriesWire` est ce qui voyage — les titres une fois, des identifiants ailleurs. `cinemaFetcher`
 * rend cette forme-ci à l'arrivée, si bien qu'aucun écran n'a eu à changer. Voir `cinemaPayload`.
 */
export type CinemaSeriesPayload = HydratedPayload<CinemaSeries> & { top10Theme: Top10Theme | null };
