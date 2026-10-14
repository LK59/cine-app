import {
  cachedJellyfinEpisodeCount,
  cachedJellyfinMoviesAdmin,
  cachedJellyfinSeriesAdmin,
  cachedMovies,
  cachedSeries,
  findJellyfinMovieByTmdb,
  findJellyfinSeriesByTvdb,
  getProviderIdCI,
} from "@/lib/server-cache";
import type { RadarrMovie } from "@/lib/clients/radarr";
import type { SonarrSeries } from "@/lib/clients/sonarr";
import type { JellyfinItem } from "@/lib/clients/jellyfin";
import { assignJellyfinOnlyIds } from "@/lib/jellyfinOnlyId";
import { logError } from "@/lib/logger";
import { mapInBatches } from "@/lib/inBatches";

/**
 * Ce que le cinéma montre — une seule définition (DECISIONS.md §47).
 *
 * Un film avec son fichier, une série avec au moins un épisode, **et** son élément Jellyfin
 * retrouvé (dossier d'abord, puis identifiants, puis titre). C'était écrit dans les deux routes du
 * catalogue, et approché ailleurs — la recherche, les rangées TMDB, les personnes — par la seule
 * première moitié : un titre que Radarr ou Sonarr avait mais que Jellyfin ne rapprochait pas y
 * était « dans la bibliothèque », et l'ouvrir ne faisait rien, puisque le catalogue ne l'avait pas
 * (*The Arena*, 05/10/2026).
 *
 * Depuis le 14/10/2026 (§89), aussi ce que **Jellyfin a seul** : un élément qu'aucun titre de
 * Radarr/Sonarr ne revendique — *La casa de papel*, rangée à la main —, voir `jellyfinOnlyMovies`.
 */
export function matchMovies(movies: RadarrMovie[], jellyfin: JellyfinItem[]) {
  return movies
    .filter((m) => m.hasFile)
    .map((m) => ({ m, jfItem: findJellyfinMovieByTmdb(jellyfin, m.tmdbId, m.title, m.year, m.imdbId ?? null, m.path ?? null) }))
    .filter((x): x is { m: RadarrMovie; jfItem: JellyfinItem } => x.jfItem !== null);
}

export function matchSeries(series: SonarrSeries[], jellyfin: JellyfinItem[]) {
  return series
    .filter((s) => (s.statistics?.episodeFileCount ?? 0) > 0)
    .map((s) => ({ s, jfItem: findJellyfinSeriesByTvdb(jellyfin, s.tvdbId, s.title, s.year, s.path ?? null) }))
    .filter((x): x is { s: SonarrSeries; jfItem: JellyfinItem } => x.jfItem !== null);
}

// ─── Ce que Jellyfin a seul (§89) ────────────────────────────────────────────

/**
 * Un titre que Jellyfin a seul : son élément, l'identifiant de catalogue qu'il reçoit (plage
 * réservée, `jellyfinOnlyId.ts`) et ses identifiants externes — ceux de Jellyfin, faute d'autres.
 */
export interface JellyfinOnlyTitle {
  id: number;
  item: JellyfinItem;
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
}

const positiveId = (raw: string | undefined): number | null => {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};
const idsOf = (item: JellyfinItem) => {
  const ids = item.ProviderIds as Record<string, string> | undefined;
  return {
    tmdbId: positiveId(getProviderIdCI(ids, "tmdb")),
    tvdbId: positiveId(getProviderIdCI(ids, "tvdb")),
    imdbId: getProviderIdCI(ids, "imdb")?.trim() || null,
  };
};

/** Une collision ne se rapporte qu'une fois par élément et par processus : le catalogue se recalcule souvent. */
const reportedCollisions = new Set<string>();
function reportCollision(kind: "movie" | "series", jellyfinId: string, wanted: number, given: number) {
  if (reportedCollisions.has(jellyfinId)) return;
  reportedCollisions.add(jellyfinId);
  logError("catalogue-reserved-id", new Error(`Identifiant réservé déjà pris (${kind})`), { jellyfinId, wanted, given });
}

function withReservedIds(kind: "movie" | "series", candidates: JellyfinItem[], taken: ReadonlySet<number>): JellyfinOnlyTitle[] {
  const ids = assignJellyfinOnlyIds(
    candidates.map((item) => item.Id),
    taken,
    (jellyfinId, wanted, given) => reportCollision(kind, jellyfinId, wanted, given)
  );
  return candidates.map((item) => ({ id: ids.get(item.Id)!, item, ...idsOf(item) }));
}

/**
 * Les films que Jellyfin a seul : un élément avec un fichier (`Path`), qu'aucun film de Radarr ne
 * revendique (le rapprochement de `matchMovies`), et dont aucun identifiant (TMDB, IMDb) n'est celui
 * d'un film du catalogue — un second élément du même film ne fait pas une seconde carte. **Jamais de
 * rapprochement par le titre** : deux films du même nom sont deux films, et le titre que Jellyfin a
 * compris peut être faux.
 */
export function jellyfinOnlyMovies(jellyfin: JellyfinItem[], matched: { m: RadarrMovie; jfItem: JellyfinItem }[]): JellyfinOnlyTitle[] {
  const claimed = new Set(matched.map((x) => x.jfItem.Id));
  const tmdb = new Set(matched.map((x) => x.m.tmdbId).filter((n) => n > 0));
  const imdb = new Set(matched.map((x) => x.m.imdbId).filter((s): s is string => !!s));
  const candidates = jellyfin.filter((item) => {
    if (claimed.has(item.Id) || !item.Path) return false;
    const ids = idsOf(item);
    return !(ids.tmdbId !== null && tmdb.has(ids.tmdbId)) && !(ids.imdbId !== null && imdb.has(ids.imdbId));
  });
  return withReservedIds("movie", candidates, new Set(matched.map((x) => x.m.id)));
}

/**
 * Les séries que Jellyfin a seul : la même règle que les films (non revendiquée, aucun identifiant
 * TVDB/TMDB/IMDb d'une série du catalogue), et **au moins un épisode réel** — *La casa de las
 * flores*, dossier vide que Sonarr suit sans fichier, reste invisible. Les doubles rangements voulus
 * (*Le Flambeau*, qui est aussi la saison 2 de *Burning Love* ; *Berlin et La Dame à l'hermine*,
 * aussi la saison 2 de *Berlin*) sont deux dossiers, deux identités : chacun garde sa fiche.
 */
export async function jellyfinOnlySeries(
  jellyfin: JellyfinItem[],
  matched: { s: SonarrSeries; jfItem: JellyfinItem }[],
  episodeCount: (seriesId: string) => Promise<number> = (id) => cachedJellyfinEpisodeCount(id)
): Promise<JellyfinOnlyTitle[]> {
  const claimed = new Set(matched.map((x) => x.jfItem.Id));
  const tvdb = new Set(matched.map((x) => x.s.tvdbId).filter((n) => n > 0));
  const tmdb = new Set(matched.map((x) => x.s.tmdbId).filter((n): n is number => !!n && n > 0));
  const imdb = new Set(matched.map((x) => x.s.imdbId).filter((s): s is string => !!s));
  const unclaimed = jellyfin.filter((item) => {
    if (claimed.has(item.Id)) return false;
    const ids = idsOf(item);
    return (
      !(ids.tvdbId !== null && tvdb.has(ids.tvdbId)) &&
      !(ids.tmdbId !== null && tmdb.has(ids.tmdbId)) &&
      !(ids.imdbId !== null && imdb.has(ids.imdbId))
    );
  });
  // Une requête par série candidate, et une série dont le compte échoue reste dehors : mieux vaut une
  // carte de moins qu'une fiche vide. Elles se comptent sur les doigts tant que Sonarr revendique
  // presque tout — mais une installation sans Sonarr les a **toutes** pour candidates (14/10/2026) :
  // par lots de huit, pour ne jamais envoyer deux cents requêtes ensemble à Jellyfin.
  const counts = await mapInBatches(unclaimed, 8, (item) => episodeCount(item.Id).catch(() => 0));
  const withEpisodes = unclaimed.filter((_, i) => counts[i] > 0);
  return withReservedIds("series", withEpisodes, new Set(matched.map((x) => x.s.id)));
}

// ─── Le lien d'un élément Jellyfin vers son titre ────────────────────────────

/**
 * Le titre du catalogue qu'un élément Jellyfin **est** — décidé par le dossier (le rapprochement de
 * `matchMovies`/`matchSeries`), jamais par les identifiants que Jellyfin a posés dessus (§89). C'est
 * ce qui relie « Reprendre », « À suivre » et « Vu » à la bonne fiche : *Aliens*, que Jellyfin
 * prenait pour *Alien³*, rangeait son vu sous Alien³ ; les cartes de reprise d'une série mal
 * identifiée n'ouvraient rien.
 */
export interface CatalogueLink {
  type: "movie" | "series";
  /** L'identifiant de fiche : Radarr, Sonarr, ou la plage réservée pour un titre que Jellyfin a seul. */
  catalogueId: number;
  /** Le TMDB du catalogue (Radarr/Sonarr), celui de Jellyfin pour un titre qu'il a seul. */
  tmdbId: number | null;
  source: "radarr" | "sonarr" | "jellyfin";
}

export interface CatalogueMembers {
  movies: RadarrMovie[];
  series: SonarrSeries[];
  /**
   * L'élément Jellyfin rapproché de chaque série (par identifiant Sonarr) — vide si Jellyfin ne
   * répond pas. Il donne l'affiche de repli d'une série (`cataloguePoster`), la même que le catalogue.
   */
  seriesJellyfin: Map<number, JellyfinItem>;
  /** Ce que Jellyfin a seul (§89) — vide si Jellyfin, ou Radarr/Sonarr, ne répond pas. */
  jellyfinOnly: { movies: JellyfinOnlyTitle[]; series: JellyfinOnlyTitle[] };
  /** Élément Jellyfin → titre du catalogue, par le dossier. Vide si Jellyfin ne répond pas. */
  byJellyfinId: Map<string, CatalogueLink>;
}

/**
 * Les titres du catalogue, tels que ses routes les servent. Si Jellyfin ne répond pas, la première
 * moitié de la règle seule (fichier, épisode) : mieux vaut un titre qui ne s'ouvre pas qu'une
 * bibliothèque qui disparaît des recherches le temps d'une panne.
 *
 * Et si Radarr (ou Sonarr) ne répond pas, **aucun** titre « Jellyfin seul » de ce côté : sans la
 * liste de Radarr, tout Jellyfin paraîtrait non revendiqué, et huit cents films changeraient
 * d'identifiant le temps d'une panne. Un Radarr (ou Sonarr) **non configuré** n'est pas une panne :
 * `cachedMovies` (`cachedSeries`) rend alors une liste vide sans rien demander, et tout ce que Jellyfin
 * a de ce côté est « Jellyfin seul » — une installation sans eux a un cinéma (14/10/2026, §89).
 */
export async function catalogueMembers(opts: { jellyfinWaitMs?: number } = {}): Promise<CatalogueMembers> {
  // Rattrapé quelle que soit la façon d'échouer — une promesse rejetée comme une erreur levée tout de
  // suite : Jellyfin absent ne doit jamais vider la bibliothèque des recherches.
  const attempt = <T,>(load: () => Promise<T>) => Promise.resolve().then(load).catch(() => null);
  /**
   * Et sans attendre un Jellyfin figé, quand l'appelant le demande (§92) : la recherche attendait
   * ses huit secondes de délai avant de rendre des résultats Radarr/Sonarr/TMDB qu'elle avait déjà.
   * Passé `jellyfinWaitMs`, la moitié Jellyfin compte comme absente — la règle de panne ci-dessus ;
   * l'appel continue et, s'il aboutit, remplit le cache pour la suivante.
   */
  const bounded = <T,>(load: () => Promise<T>): Promise<T | null> => {
    const wait = opts.jellyfinWaitMs;
    if (wait === undefined) return attempt(load);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), wait);
      (timer as { unref?: () => void }).unref?.();
      void attempt(load).then((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  };
  const [movies, series, jfMovies, jfSeries] = await Promise.all([
    attempt(() => cachedMovies()),
    attempt(() => cachedSeries()),
    bounded(() => cachedJellyfinMoviesAdmin()),
    bounded(() => cachedJellyfinSeriesAdmin()),
  ]);
  const matchedMovies = jfMovies ? matchMovies(movies ?? [], jfMovies) : null;
  const matchedSeries = jfSeries ? matchSeries(series ?? [], jfSeries) : null;
  const onlyMovies = jfMovies && movies && matchedMovies ? jellyfinOnlyMovies(jfMovies, matchedMovies) : [];
  const onlySeries = jfSeries && series && matchedSeries ? await jellyfinOnlySeries(jfSeries, matchedSeries) : [];

  const byJellyfinId = new Map<string, CatalogueLink>();
  for (const { m, jfItem } of matchedMovies ?? []) {
    byJellyfinId.set(jfItem.Id, { type: "movie", catalogueId: m.id, tmdbId: m.tmdbId > 0 ? m.tmdbId : null, source: "radarr" });
  }
  for (const { s, jfItem } of matchedSeries ?? []) {
    byJellyfinId.set(jfItem.Id, { type: "series", catalogueId: s.id, tmdbId: s.tmdbId && s.tmdbId > 0 ? s.tmdbId : null, source: "sonarr" });
  }
  for (const t of onlyMovies) byJellyfinId.set(t.item.Id, { type: "movie", catalogueId: t.id, tmdbId: t.tmdbId, source: "jellyfin" });
  for (const t of onlySeries) byJellyfinId.set(t.item.Id, { type: "series", catalogueId: t.id, tmdbId: t.tmdbId, source: "jellyfin" });

  return {
    movies: matchedMovies ? matchedMovies.map((x) => x.m) : (movies ?? []).filter((m) => m.hasFile),
    series: matchedSeries ? matchedSeries.map((x) => x.s) : (series ?? []).filter((s) => (s.statistics?.episodeFileCount ?? 0) > 0),
    seriesJellyfin: new Map((matchedSeries ?? []).map((x) => [x.s.id, x.jfItem])),
    jellyfinOnly: { movies: onlyMovies, series: onlySeries },
    byJellyfinId,
  };
}

/** Le titre que Jellyfin a seul derrière cet identifiant de catalogue, s'il en est un. */
export async function jellyfinOnlyTitle(type: "movie" | "series", id: number): Promise<JellyfinOnlyTitle | null> {
  const { jellyfinOnly } = await catalogueMembers();
  return (type === "movie" ? jellyfinOnly.movies : jellyfinOnly.series).find((t) => t.id === id) ?? null;
}
