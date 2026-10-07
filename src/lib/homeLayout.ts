// La disposition de l'accueil, réglée par l'exploitant (DECISIONS.md §52).
//
// Deux variantes d'une installation à l'autre, décidées ici une fois pour le bureau et le
// téléphone — deux écrans qui décident la même chose finissent par diverger :
//  - `HOME_BROWSE_BUTTON` : « Tous les films » / « Toutes les séries » en tête de l'accueil ;
//  - `HOME_CONTINUE_HERO` : la bannière montre ce qu'on regarde — Reprendre, À suivre — et
//    « À la une » descend à la place de la rangée Reprendre.
// Coupées, l'accueil est celui d'origine. Une fourche du code aurait fait deux applications à
// maintenir pour deux rangées échangées.

import type { ContinueEntry, ContinueEpisode, ContinueMovie } from "@/lib/continueOrder";

/** Une carte « Reprendre » : l'adresse de sa fiche (`/radarr/42`) — voir `openResumeTarget`. */
export interface HeroResumeMovie extends ContinueMovie {
  cinemaHref: string | null;
}
/** Une carte « À suivre » : la série de l'épisode. */
export interface HeroNextEpisode extends ContinueEpisode {
  sonarrId: number | null;
}

/** Une bannière tient huit titres, comme celle d'origine — au bureau, où sa rangée les montre tous. */
const HERO_LIMIT = 8;
/**
 * Sur téléphone, cinq reprises au plus dans la bannière (08/10/2026) : ses vignettes restent un
 * sommaire court, et quelqu'un qui a beaucoup en cours y voit encore « À la une ». Le reste est
 * dans la rangée Reprendre, juste dessous, entière. Au bureau la rangée sous la bannière montre tout
 * d'un coup et « À la une » suit avec dix titres : la limite n'y servirait à rien.
 */
export const HERO_LIMIT_PHONE = 5;

/**
 * Les titres de la bannière quand elle montre Reprendre / À suivre, dans l'ordre de la rangée (le
 * dernier lu d'abord, DECISIONS.md §33) — les films pour l'onglet Films, les séries pour l'onglet
 * Séries, chacun retrouvé dans le catalogue : la bannière a besoin de son image, de son logo, de
 * son synopsis, que les flux de reprise ne portent pas. Une série dont deux épisodes attendent
 * n'y figure qu'une fois ; un titre absent du catalogue (pas de fiche) n'y figure pas.
 */
export function continueHeroTitles<M, S, RM extends HeroResumeMovie, NE extends HeroNextEpisode>(
  entries: ContinueEntry<RM, NE>[],
  movieById: (radarrId: number) => M | undefined,
  seriesById: (sonarrId: number) => S | undefined,
  limit: number = HERO_LIMIT,
): { movies: M[]; series: S[]; placed: Set<string> } {
  const movies: M[] = [];
  const series: S[] = [];
  // Les entrées que la bannière montre — les autres (sans fiche, ou au-delà de huit) gardent une
  // rangée Reprendre à elles : sans quoi une reprise hors de Radarr/Sonarr disparaissait de l'accueil.
  const placed = new Set<string>();
  const seenMovies = new Set<number>();
  const seenSeries = new Set<number>();
  for (const entry of entries) {
    if (entry.kind === "movie") {
      const id = Number(entry.item.cinemaHref?.match(/^\/radarr\/(\d+)$/)?.[1] ?? NaN);
      const movie = Number.isFinite(id) && !seenMovies.has(id) ? movieById(id) : undefined;
      if (movie && movies.length < limit) {
        seenMovies.add(id);
        movies.push(movie);
      }
      if (Number.isFinite(id) && seenMovies.has(id)) placed.add(entry.key);
    } else {
      const id = entry.item.sonarrId;
      const show = id !== null && !seenSeries.has(id) ? seriesById(id) : undefined;
      if (show && id !== null && series.length < limit) {
        seenSeries.add(id);
        series.push(show);
      }
      if (id !== null && seenSeries.has(id)) placed.add(entry.key);
    }
  }
  return { movies, series, placed };
}

/** Le moins de titres que montre la bannière Reprendre / À suivre : en dessous, « À la une » complète. */
export const HERO_MIN = 5;

/**
 * Ce que la bannière montre (DECISIONS.md §52).
 *
 * Sans l'option, ou sans rien en cours : « À la une », comme toujours. Avec : ce qu'on regarde
 * d'abord, le dernier lu en tête — et s'il y en a moins de cinq, « À la une » complète la suite.
 * Une seule reprise laissait une bannière figée, qui ne tournait plus et faisait paraître l'accueil
 * mort (07/10/2026) ; les compléments disent eux-mêmes ce qu'ils sont, par leur bouton (« Lire »
 * et non « Reprendre ») et l'absence de barre de progression.
 *
 * `mixed` : la bannière mêle les deux — la rangée du bureau qui la suit s'appelle alors « Pour
 * vous » plutôt que « Reprendre ». `shown` : les clés montrées, que la rangée « À la une »
 * descendue n'affiche pas une seconde fois.
 */
export function heroSource<T>(
  continueHero: boolean,
  official: T[],
  continuing: T[],
  keyOf: (item: T) => string,
): { items: T[]; continuing: boolean; mixed: boolean; shown: Set<string> } {
  if (!continueHero || continuing.length === 0) {
    return { items: official, continuing: false, mixed: false, shown: new Set(official.map(keyOf)) };
  }
  const items = [...continuing];
  const shown = new Set(items.map(keyOf));
  for (const item of official) {
    if (items.length >= HERO_MIN) break;
    if (shown.has(keyOf(item))) continue;
    items.push(item);
    shown.add(keyOf(item));
  }
  return { items, continuing: true, mixed: items.length > continuing.length, shown };
}

/**
 * Ce que la bannière Reprendre / À suivre propose de lancer, titre par titre : la reprise du film,
 * ou l'épisode qui attend la série — la plus récente quand une série en a deux. Le bouton dit
 * alors « Reprendre · 40 min restantes » ou « À suivre S1 · É3 » (`formatContinueLabel`), comme
 * les cartes de la rangée qu'elle remplace (demandé le 07/10/2026).
 */
export function continueTargets<RM extends HeroResumeMovie, NE extends HeroNextEpisode>(
  entries: ContinueEntry<RM, NE>[],
): { movies: Map<number, RM>; series: Map<number, NE> } {
  const movies = new Map<number, RM>();
  const series = new Map<number, NE>();
  for (const entry of entries) {
    if (entry.kind === "movie") {
      const id = Number(entry.item.cinemaHref?.match(/^\/radarr\/(\d+)$/)?.[1] ?? NaN);
      if (Number.isFinite(id) && !movies.has(id)) movies.set(id, entry.item);
    } else if (entry.item.sonarrId !== null && !series.has(entry.item.sonarrId)) {
      series.set(entry.item.sonarrId, entry.item);
    }
  }
  return { movies, series };
}

/** Ce que tient la rangée « À la une » sous la bannière des reprises, au plus. */
const SPOTLIGHT_ROW_MAX = 10;

/**
 * La rangée « À la une » sous la bannière des reprises (DECISIONS.md §52) : la sélection « À la
 * une », puis les derniers ajouts pour la compléter, sans ce que la bannière montre déjà. Puisée
 * dans la seule sélection, elle tombait à deux ou trois titres dès que la bannière en avait pris
 * quatre pour se compléter (08/10/2026) ; avec les ajouts derrière, elle en garde au moins cinq.
 */
export function spotlightRowItems<T>(pools: readonly (readonly T[])[], shown: ReadonlySet<string>, keyOf: (item: T) => string): T[] {
  const out: T[] = [];
  const seen = new Set(shown);
  for (const pool of pools) {
    for (const item of pool) {
      if (out.length >= SPOTLIGHT_ROW_MAX) return out;
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}
