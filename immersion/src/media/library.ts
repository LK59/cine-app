import { apiJson } from "../lib/session";

/**
 * La bibliothèque, telle que le panneau du chalet la montre : les deux catalogues de l'application
 * (`/api/cinema/movies`, `/api/cinema/series` — déjà filtrés pour ce compte), « Reprendre » et
 * « À suivre ». Lus une fois par visite, gardés en mémoire.
 */
export interface Title {
  kind: "movie" | "series";
  /** Identifiant propre au panneau : `m<radarrId>` ou `s<sonarrId>`. */
  key: string;
  /** L'élément Jellyfin : le film lui-même, ou la série. */
  itemId: string;
  title: string;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
  overview: string | null;
  tagline: string | null;
  /** Durée d'un film, ou d'un épisode, en minutes. */
  minutes: number | null;
  rating: number | null;
  cast: string[];
  seasons: number | null;
  addedAt: string | null;
}

interface WireMovie {
  radarrId: number;
  jellyfinItemId: string;
  title: string;
  year?: number;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  overview?: string | null;
  tagline?: string | null;
  runtimeMinutes?: number | null;
  /** Un nombre ou son écriture (« 7.4 ») selon la source : lu par `ratingOf`. */
  imdbRating?: number | string | null;
  castNames?: string[];
  addedAt?: string | null;
}
interface WireSeries extends Omit<WireMovie, "radarrId" | "runtimeMinutes"> {
  sonarrId: number;
  episodeRuntime?: number | null;
  seasonCount?: number | null;
}
interface WireCatalogue<T> {
  items?: T[];
  recentlyAdded: number[] | T[];
}

/** Une ligne de « Reprendre » ou d'« À suivre » : un film ou un épisode, prêt à lancer. */
export interface Continue {
  itemId: string;
  title: string;
  subtitle: string | null;
  image: string | null;
  /** 0 à 100. */
  progress: number;
  kind: "movie" | "episode";
  /** Le titre du catalogue correspondant (son affiche), quand il s'y trouve. */
  owner: Title | null;
}

export interface Episode {
  itemId: string;
  season: number;
  episode: number;
  title: string;
  overview: string | null;
  thumbnail: string | null;
  minutes: number | null;
  watched: boolean;
  /** Position de reprise, en secondes (0 : pas commencé). */
  resume: number;
}

export interface Library {
  movies: Title[];
  series: Title[];
  recent: Title[];
  continues: Continue[];
}

/** La note, en nombre — ou rien si elle manque ou ne se lit pas. */
function ratingOf(value: number | string | null | undefined): number | null {
  const rating = typeof value === "string" ? Number.parseFloat(value) : value;
  return typeof rating === "number" && Number.isFinite(rating) && rating > 0 ? rating : null;
}

const movieOf = (m: WireMovie): Title => ({
  kind: "movie",
  key: `m${m.radarrId}`,
  itemId: m.jellyfinItemId,
  title: m.title,
  year: m.year || null,
  poster: m.posterUrl ?? null,
  backdrop: m.backdropUrl ?? null,
  overview: m.overview ?? null,
  tagline: m.tagline || null,
  minutes: m.runtimeMinutes ?? null,
  rating: ratingOf(m.imdbRating),
  cast: m.castNames ?? [],
  seasons: null,
  addedAt: m.addedAt ?? null,
});

const seriesOf = (s: WireSeries): Title => ({
  kind: "series",
  key: `s${s.sonarrId}`,
  itemId: s.jellyfinItemId,
  title: s.title,
  year: s.year || null,
  poster: s.posterUrl ?? null,
  backdrop: s.backdropUrl ?? null,
  overview: s.overview ?? null,
  tagline: s.tagline || null,
  minutes: s.episodeRuntime ?? null,
  rating: ratingOf(s.imdbRating),
  cast: s.castNames ?? [],
  seasons: s.seasonCount ?? null,
  addedAt: s.addedAt ?? null,
});

/** Les catalogues voyagent dédupliqués : les titres une fois dans `items`, des identifiants ailleurs. */
function recentOf<T>(payload: WireCatalogue<T>, idOf: (item: T) => number): T[] {
  const list = payload.recentlyAdded ?? [];
  if (list.length === 0 || typeof list[0] !== "number") return list as T[];
  const byId = new Map((payload.items ?? []).map((item) => [idOf(item), item]));
  return (list as number[]).map((id) => byId.get(id)).filter((item): item is T => item !== undefined);
}

let cached: Promise<Library> | null = null;

async function load(): Promise<Library> {
  const [movies, series, resume, nextUp] = await Promise.all([
    apiJson<WireCatalogue<WireMovie>>("/api/cinema/movies"),
    apiJson<WireCatalogue<WireSeries>>("/api/cinema/series"),
    apiJson<{ items: { id: string; name: string; subtitle: string | null; type: string; progress: number; imageTag?: string | null }[] }>("/api/jellyfin/resume").catch(() => ({ items: [] })),
    apiJson<{ items: { jellyfinItemId: string; title: string; thumbnailUrl: string | null; seasonNumber: number; episodeNumber: number; resumeTicks: number; runtimeTicks: number; sonarrId: number }[] }>(
      "/api/cinema/next-up"
    ).catch(() => ({ items: [] })),
  ]);
  const movieList = (movies.items ?? []).filter((m) => m.jellyfinItemId).map(movieOf);
  const seriesList = (series.items ?? []).filter((s) => s.jellyfinItemId).map(seriesOf);
  const byItem = new Map(movieList.map((m) => [m.itemId, m]));
  const seriesByKey = new Map(seriesList.map((s) => [s.key, s]));

  const recent = [...recentOf(movies, (m) => m.radarrId).map(movieOf), ...recentOf(series, (s) => s.sonarrId).map(seriesOf)]
    .filter((t) => t.itemId)
    .sort((a, b) => (b.addedAt ?? "").localeCompare(a.addedAt ?? ""))
    .slice(0, 18);

  const seen = new Set<string>();
  const continues: Continue[] = [];
  for (const r of resume.items ?? []) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const owner = byItem.get(r.id) ?? null;
    continues.push({
      itemId: r.id,
      title: r.name,
      subtitle: r.subtitle,
      image: owner?.poster ?? (r.imageTag ? `/api/jellyfin/image?itemId=${r.id}&tag=${r.imageTag}` : null),
      progress: Math.max(0, Math.min(100, r.progress ?? 0)),
      kind: r.type === "Movie" ? "movie" : "episode",
      owner,
    });
  }
  for (const n of nextUp.items ?? []) {
    if (seen.has(n.jellyfinItemId)) continue;
    seen.add(n.jellyfinItemId);
    const owner = seriesByKey.get(`s${n.sonarrId}`) ?? null;
    continues.push({
      itemId: n.jellyfinItemId,
      title: owner?.title ?? n.title,
      subtitle: `S${String(n.seasonNumber).padStart(2, "0")}E${String(n.episodeNumber).padStart(2, "0")}`,
      image: owner?.poster ?? n.thumbnailUrl,
      progress: n.runtimeTicks > 0 ? Math.round((n.resumeTicks / n.runtimeTicks) * 100) : 0,
      kind: "episode",
      owner,
    });
  }
  return { movies: movieList, series: seriesList, recent, continues };
}

/** La bibliothèque du compte. Un échec n'est pas gardé : la demande suivante réessaie. */
export function library(): Promise<Library> {
  if (!cached) {
    cached = load().catch((error) => {
      cached = null;
      throw error;
    });
  }
  return cached;
}

/** À relire après une lecture : « Reprendre » a changé. */
export function forgetLibrary(): void {
  cached = null;
}

export async function episodesOf(seriesItemId: string): Promise<{ episodes: Episode[]; next: string | null }> {
  const data = await apiJson<{
    seasons: { seasonNumber: number; episodes: { jellyfinItemId: string; seasonNumber: number; episodeNumber: number; title: string; overview: string | null; thumbnailUrl: string | null; runtimeMinutes: number | null; watched: boolean; resumeTicks: number }[] }[];
    nextEpisode: { itemId: string } | null;
  }>(`/api/cinema/series/${seriesItemId}/episodes`);
  const episodes = (data.seasons ?? []).flatMap((season) =>
    (season.episodes ?? [])
      .filter((e) => e.jellyfinItemId)
      .map((e) => ({
        itemId: e.jellyfinItemId,
        season: e.seasonNumber,
        episode: e.episodeNumber,
        title: e.title,
        overview: e.overview,
        thumbnail: e.thumbnailUrl,
        minutes: e.runtimeMinutes,
        watched: e.watched,
        resume: (e.resumeTicks ?? 0) / 10_000_000,
      }))
  );
  return { episodes, next: data.nextEpisode?.itemId ?? null };
}

const fold = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Une recherche simple, sur place : les titres qui commencent par ce qui est tapé, puis ceux dont un
 * mot commence ainsi, puis ceux qui le contiennent. Accents et casse ignorés.
 */
export function search(lib: Library, query: string, limit = 30): Title[] {
  const q = fold(query);
  if (!q) return [];
  const scored: { title: Title; score: number }[] = [];
  for (const title of [...lib.movies, ...lib.series]) {
    const name = fold(title.title);
    const score = name === q ? 0 : name.startsWith(q) ? 1 : name.split(" ").some((word) => word.startsWith(q)) || name.includes(" " + q) ? 2 : name.includes(q) ? 3 : -1;
    if (score >= 0) scored.push({ title, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || (b.title.year ?? 0) - (a.title.year ?? 0))
    .slice(0, limit)
    .map((s) => s.title);
}
