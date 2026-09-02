import {
  normalize,
  bestTitleMatchScore,
  GENRE_ALIASES,
  parseNaturalQuery,
  parseNaturalQueryEN,
  parseNaturalQueryES,
  parseNaturalQueryDE,
} from "./search-natural-query";
import type { Locale } from "./i18n";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import type { CinemaSeries } from "@/app/api/cinema/series/route";

export type CinemaSearchResult =
  | { kind: "movie"; item: CinemaMovie; score: number }
  | { kind: "series"; item: CinemaSeries; score: number };

// Same natural-language engine as the global search bar (genre words, "films"/"séries" hints,
// typo-tolerant title matching), but run entirely against the catalog the Cinema client already
// holds in memory: no network round-trip, no TMDB, so results appear as fast as you type — and
// they can only ever be titles you actually own. Deliberately no cast/director matching: the
// library payload carries no credits, and the user asked for titles only here.

// The parser returns a canonical genre key ("sciencefiction"); library genres come from
// Radarr/Sonarr as English display names ("Science Fiction", "Sci-Fi & Fantasy"). Matching on a
// letters-only substring bridges the two, and the extra aliases cover Sonarr's compound genres.
const GENRE_KEY_ALIASES: Record<string, string[]> = {
  sciencefiction: ["sciencefiction", "scifi"],
  tvmovie: ["tvmovie"],
};

function flattenGenre(g: string): string {
  return normalize(g).replace(/[^a-z0-9]/g, "");
}

function matchesGenre(genres: string[], canonical: string): boolean {
  const keys = GENRE_KEY_ALIASES[canonical] ?? [canonical];
  return genres.some((g) => {
    const flat = flattenGenre(g);
    return keys.some((k) => flat.includes(k));
  });
}

const MEDIA_WORDS =
  /\b(film|films|movie|movies|serie|series|series|tv|show|shows|pelicula|peliculas|filme|serien)\b/g;

// Strips the parts of the query the parser consumed (media type, genre, a year), leaving whatever
// the user meant as an actual title. "films d'action de 2019" leaves nothing — which is the
// signal to list the whole genre instead of scoring titles against noise.
function residualTitle(raw: string, genreName: string | null, year: number | null): string {
  let q = normalize(raw).replace(MEDIA_WORDS, " ");
  if (year) q = q.replace(new RegExp(`\\b${year}\\b`, "g"), " ");
  if (genreName) {
    for (const alias of GENRE_ALIASES[genreName] ?? []) {
      q = q.replace(new RegExp(`\\b${normalize(alias).replace(/\s+/g, "\\s+")}\\b`, "g"), " ");
    }
  }
  return q.replace(/\b(de|du|des|d|le|la|les|un|une|of|the|a|el|los|las|der|die|das)\b/g, " ").replace(/\s+/g, " ").trim();
}

function ratingOf(imdbRating: string | null): number {
  const n = imdbRating ? Number.parseFloat(imdbRating) : NaN;
  return Number.isFinite(n) ? n : 0;
}

export function searchCinemaLibrary(
  raw: string,
  movies: CinemaMovie[],
  series: CinemaSeries[],
  locale: Locale
): CinemaSearchResult[] {
  const query = raw.trim();
  if (query.length < 2) return [];

  const parse =
    locale === "en" ? parseNaturalQueryEN
    : locale === "es" ? parseNaturalQueryES
    : locale === "de" ? parseNaturalQueryDE
    : parseNaturalQuery;
  const natural = parse(query, "all");

  const yearMatch = query.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? Number.parseInt(yearMatch[0], 10) : null;
  const title = residualTitle(query, natural.genreName, year);
  // Nothing left to match on and nothing to filter by: an unusable query (e.g. just "de").
  if (!title && !natural.genreName && !year) return [];

  const results: CinemaSearchResult[] = [];

  function consider(kind: "movie" | "series", item: CinemaMovie | CinemaSeries) {
    if (natural.mediaType === "movie" && kind !== "movie") return;
    if (natural.mediaType === "series" && kind !== "series") return;
    if (natural.genreName && !matchesGenre(item.genres, natural.genreName)) return;
    if (year && item.year !== year) return;

    // With no title left, the genre/year filters *are* the query — everything surviving them is a
    // hit, ranked by rating below. Otherwise the title has to actually match.
    const score = title ? bestTitleMatchScore([item.title], title) : 50;
    if (score <= 0) return;
    results.push({ kind, item, score } as CinemaSearchResult);
  }

  for (const m of movies) consider("movie", m);
  for (const s of series) consider("series", s);

  return results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ra = ratingOf(a.item.imdbRating);
    const rb = ratingOf(b.item.imdbRating);
    if (rb !== ra) return rb - ra;
    return (b.item.year ?? 0) - (a.item.year ?? 0);
  });
}
