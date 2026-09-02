export interface TmdbVideoLite {
  type: string;
  site: string;
  official: boolean;
  key: string;
}

// Prefer an official YouTube trailer, then any YouTube trailer, else none — extracted from
// what used to be identical inline logic in both the movie and series /info routes, so a third
// caller (the bulk trailer-download job) doesn't have to duplicate it a third time.
export function resolveTrailerKey(videos: { results: TmdbVideoLite[] }): string | null {
  const trailer =
    videos.results.find((v) => v.type === "Trailer" && v.site === "YouTube" && v.official) ??
    videos.results.find((v) => v.type === "Trailer" && v.site === "YouTube") ??
    null;
  return trailer?.key ?? null;
}
