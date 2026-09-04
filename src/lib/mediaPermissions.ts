// Pure, testable extraction of the "who sees which search button" rule established after two
// rounds of the same bug (a guest-visible button that shouldn't have been): a regular user sees
// no search action once a file/episode already exists — a downloaded file is a fact, not
// something to search for — and exactly one action, auto-search (never interactive search),
// when it doesn't. Admins always see both auto-search and interactive search, unconditionally.

export function canAutoSearchMovie(isReadOnly: boolean, hasFile: boolean): boolean {
  return !isReadOnly || !hasFile;
}

export function canAutoSearchSeason(isReadOnly: boolean, fileCount: number, episodeCount: number): boolean {
  return !isReadOnly || fileCount < episodeCount;
}

// Même règle au niveau de la série entière : un compte ordinaire ne cherche pas ce qui est
// déjà complet. `episodeCount` à zéro (une série que Sonarr n'a pas encore inventoriée) compte
// comme incomplète — il n'y a rien sur le disque à opposer à la recherche.
export function canAutoSearchSeries(isReadOnly: boolean, fileCount: number, episodeCount: number): boolean {
  return !isReadOnly || fileCount < episodeCount || episodeCount === 0;
}
