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

/** Ce qu'il faut d'un titre pour lui trouver un thème : son année et ses genres. */
export interface ThemedItem extends RailItem {
  year?: number | null;
  genres?: string[];
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

// ─── Le top 10 du jour ────────────────────────────────────────────────────────

/**
 * Ce que le palmarès du jour classe.
 *
 * Un genre tel que la bibliothèque le nomme — les rangées l'affichent déjà ainsi, sans le
 * traduire —, ou une décennie, qui elle se dit dans la langue de qui lit.
 */
export type Top10Theme = { kind: "genre"; genre: string } | { kind: "decade"; decade: number };

export interface DailyTop10<T> {
  /** Null quand rien n'est assez fourni : on retombe alors sur le palmarès de toute la collection. */
  theme: Top10Theme | null;
  items: T[];
}

/** En dessous, « top 10 » serait un mensonge : mieux vaut ne pas proposer ce thème du tout. */
const THEME_MIN = 10;

/**
 * Une graine stable tirée d'une chaîne — ici la date du jour.
 *
 * Il ne s'agit pas de brouiller quoi que ce soit, seulement d'obtenir *le même* nombre pour tout
 * le monde et toute la journée. Un tirage au hasard changerait à chaque revalidation : la charge
 * utile est en cache deux minutes, et la rangée clignoterait sans raison visible.
 */
function seedFrom(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** La date d'un instant, en jour civil — c'est l'unité à laquelle le thème change. */
export function dayKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function decadeOf(year: number | null | undefined): number | null {
  return typeof year === "number" && year > 1800 ? Math.floor(year / 10) * 10 : null;
}

/** Les thèmes que cette collection peut réellement porter, dans un ordre qui ne dépend pas du hasard. */
function eligibleThemes<T extends ThemedItem>(items: T[]): Top10Theme[] {
  const rated = items.filter((i) => rating(i) > 0);
  const byGenre = new Map<string, number>();
  const byDecade = new Map<number, number>();
  for (const item of rated) {
    for (const genre of item.genres ?? []) byGenre.set(genre, (byGenre.get(genre) ?? 0) + 1);
    const decade = decadeOf(item.year);
    if (decade !== null) byDecade.set(decade, (byDecade.get(decade) ?? 0) + 1);
  }
  // Triés par nom et par année : l'ordre doit être le même d'un serveur à l'autre et d'un jour à
  // l'autre, sans quoi la graine ne désignerait pas le même thème.
  const genres: Top10Theme[] = [...byGenre.entries()]
    .filter(([, n]) => n >= THEME_MIN)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([genre]) => ({ kind: "genre", genre }));
  const decades: Top10Theme[] = [...byDecade.entries()]
    .filter(([, n]) => n >= THEME_MIN)
    .sort(([a], [b]) => a - b)
    .map(([decade]) => ({ kind: "decade", decade }));
  return [...genres, ...decades];
}

function matches(item: ThemedItem, theme: Top10Theme): boolean {
  return theme.kind === "genre"
    ? (item.genres ?? []).includes(theme.genre)
    : decadeOf(item.year) === theme.decade;
}

/**
 * Le palmarès du jour : dix titres, classés par note, dans une tranche qui change chaque jour.
 *
 * Le classement ne bouge pas — c'est ce qu'on classe qui change. Un « top 10 » qui se remélange
 * tous les matins n'est plus un palmarès mais une sélection qui se fait passer pour tel, et ça se
 * voit : le premier d'hier a disparu sans que rien ne l'explique. Une tranche, elle, se comprend
 * d'un coup d'œil au titre de la rangée.
 *
 * Le thème se déduit de la date : tout le monde voit le même, toute la journée, sans que rien ne
 * soit stocké nulle part. Et il retombe sur toute la collection si rien n'est assez fourni — une
 * bibliothèque qui débute vaut mieux avec un palmarès général qu'avec un thème de quatre titres.
 */
export function dailyTop10<T extends ThemedItem>(items: T[], day: string = dayKey()): DailyTop10<T> {
  const themes = eligibleThemes(items);
  if (themes.length === 0) return { theme: null, items: top10Rail(items) };
  const theme = themes[seedFrom(day) % themes.length];
  return { theme, items: top10Rail(items.filter((i) => matches(i, theme))) };
}
