// Pure, testable extraction of the "who sees which search button" rule established after two
// rounds of the same bug (a guest-visible button that shouldn't have been): a regular user sees
// no search action once a file/episode already exists — a downloaded file is a fact, not
// something to search for — and exactly one action, auto-search (never interactive search),
// when it doesn't. Admins always see both auto-search and interactive search, unconditionally.

export function canAutoSearchMovie(isGuest: boolean, hasFile: boolean): boolean {
  return !isGuest || !hasFile;
}

export function canAutoSearchSeason(isGuest: boolean, fileCount: number, episodeCount: number): boolean {
  return !isGuest || fileCount < episodeCount;
}
