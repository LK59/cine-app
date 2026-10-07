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

/** Une bannière tient huit titres, comme celle d'origine. */
const HERO_LIMIT = 8;

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
): { movies: M[]; series: S[] } {
  const movies: M[] = [];
  const series: S[] = [];
  const seenMovies = new Set<number>();
  const seenSeries = new Set<number>();
  for (const entry of entries) {
    if (entry.kind === "movie") {
      const id = Number(entry.item.cinemaHref?.match(/^\/radarr\/(\d+)$/)?.[1] ?? NaN);
      const movie = Number.isFinite(id) && !seenMovies.has(id) ? movieById(id) : undefined;
      if (movie && movies.length < HERO_LIMIT) {
        seenMovies.add(id);
        movies.push(movie);
      }
    } else {
      const id = entry.item.sonarrId;
      const show = id !== null && !seenSeries.has(id) ? seriesById(id) : undefined;
      if (show && id !== null && series.length < HERO_LIMIT) {
        seenSeries.add(id);
        series.push(show);
      }
    }
  }
  return { movies, series };
}

/**
 * Ce que la bannière montre : Reprendre / À suivre si l'installation le veut **et** s'il y a de
 * quoi — un compte neuf, ou un onglet où rien n'est en cours, garde « À la une » plutôt qu'une
 * bannière vide.
 */
export function heroSource<T>(continueHero: boolean, official: T[], continuing: T[]): { items: T[]; continuing: boolean } {
  return continueHero && continuing.length > 0 ? { items: continuing, continuing: true } : { items: official, continuing: false };
}
