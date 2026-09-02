// The curated rails Cinema Mode leads with, before the per-genre rows.
//
// A library grouped by genre alphabetically is a catalogue; what makes a Netflix home feel like a
// home is a handful of rails with an *intention* — what just arrived, what's best, what you said
// you'd watch. All three come from data this app already has (Radarr/Sonarr's `added`, the IMDb
// rating it already caches, the watchlist in SQLite), so none of this costs a new integration.
//
// Shared by both cinema routes and both clients so a movie rail and a series rail can never
// disagree on what "recently added" means.

export interface RailItem {
  imdbRating: string | null;
  addedAt: string | null;
}

// How recent counts as "new" on a card badge. A month is long enough that a title you added and
// forgot about still announces itself, short enough that the badge stays meaningful.
export const NEW_BADGE_DAYS = 30;

const DAY_MS = 86_400_000;

// Radarr/Sonarr use this sentinel for "never" — parsing it yields a date in year 1, which would
// sort and compare as an extremely old (but valid) timestamp rather than as missing.
function addedTime(addedAt: string | null): number | null {
  if (!addedAt || addedAt.startsWith("0001-01-01")) return null;
  const t = new Date(addedAt).getTime();
  return Number.isFinite(t) ? t : null;
}

export function isRecentlyAdded(addedAt: string | null, now: number = Date.now()): boolean {
  const t = addedTime(addedAt);
  return t !== null && now - t <= NEW_BADGE_DAYS * DAY_MS;
}

export function recentlyAddedRail<T extends RailItem>(items: T[], limit = 20): T[] {
  return items
    .filter((i) => addedTime(i.addedAt) !== null)
    .sort((a, b) => addedTime(b.addedAt)! - addedTime(a.addedAt)!)
    .slice(0, limit);
}

function rating(item: RailItem): number {
  const n = item.imdbRating ? Number.parseFloat(item.imdbRating) : NaN;
  return Number.isFinite(n) ? n : 0;
}

// The numbered rail. Netflix ranks by popularity, which nothing here measures; the honest local
// equivalent is "the best-rated things you actually own", with recency breaking ties so the rail
// still moves as the library grows. Titles with no rating are left out rather than ranked at 0 —
// a rail of ten unrated items would be a worse answer than a shorter one.
export function top10Rail<T extends RailItem>(items: T[]): T[] {
  return items
    .filter((i) => rating(i) > 0)
    .sort((a, b) => {
      const diff = rating(b) - rating(a);
      if (diff !== 0) return diff;
      return (addedTime(b.addedAt) ?? 0) - (addedTime(a.addedAt) ?? 0);
    })
    .slice(0, 10);
}

// The rows map repeats a title once per genre and omits any title with no genre at all, so
// "everything in the payload" means the union of every list it carries, de-duplicated.
export function uniqueById<T>(items: T[], id: (item: T) => number): T[] {
  const byId = new Map<number, T>();
  for (const item of items) byId.set(id(item), item);
  return [...byId.values()];
}
