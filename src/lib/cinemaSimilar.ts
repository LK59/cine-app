// "Titres similaires" for a detail sheet — Netflix's "Plus comme ça", except every suggestion is
// something you own and can start right now.
//
// Deliberately not TMDB's similar/recommendations endpoint: that returns titles from the whole
// world, and a rail of things you can't play is worse than no rail. Genre overlap over the
// catalog the client already holds is instant, needs no network call, and can only ever propose
// playable titles.

export interface SimilarCandidate {
  genres: string[];
  year: number;
  imdbRating: string | null;
}

function rating(item: SimilarCandidate): number {
  const n = item.imdbRating ? Number.parseFloat(item.imdbRating) : NaN;
  return Number.isFinite(n) ? n : 0;
}

export function similarInLibrary<T extends SimilarCandidate>(
  subject: SimilarCandidate,
  candidates: T[],
  isSelf: (candidate: T) => boolean,
  limit = 12
): T[] {
  const subjectGenres = new Set(subject.genres);
  if (subjectGenres.size === 0) return [];

  return candidates
    .filter((c) => !isSelf(c))
    .map((c) => ({ c, shared: c.genres.filter((g) => subjectGenres.has(g)).length }))
    .filter((x) => x.shared > 0)
    .sort((a, b) => {
      // Most genres in common first — that's the actual "like this" signal. Rating then decides
      // between equally-related titles, and the year keeps the order stable when both tie.
      if (b.shared !== a.shared) return b.shared - a.shared;
      const diff = rating(b.c) - rating(a.c);
      if (diff !== 0) return diff;
      return b.c.year - a.c.year;
    })
    .slice(0, limit)
    .map((x) => x.c);
}
