// La collecte du tri (DECISIONS.md §198) : chaque film et chaque série de Radarr et Sonarr, croisés avec
// qui les a demandés (Jellyseerr), qui les a vus ou entamés (Jellyfin, compte par compte), et ce que les
// journaux disent des appareils — puis les scores (score.ts).
//
// Une collecte prend quelques secondes (quinze comptes Jellyfin, des milliers de lignes de journal) : le
// résultat est gardé dix minutes sur `globalThis` (les routes et l'instrumentation sont empaquetées à
// part, voir CLAUDE.md), et une seule collecte tourne à la fois.
import { cachedMovies, cachedSeries } from "@/lib/server-cache";
import { posterUrl } from "@/lib/images";
import { jellyfin, type JellyfinItem } from "@/lib/clients/jellyfin";
import { jellyseerr, type JellyseerrRequest } from "@/lib/clients/jellyseerr";
import { readLogFacts, deviceAround } from "./logs";
import { accountScore, burstShare, flagsOf, genreDistance, titleScore } from "./score";
import { listRemovals, freedTotal } from "./removals";
import { diskIndex } from "./plan";
import type { TriAccount, TriPayload, TriProfile, TriTitle, TriKind, TriRequest, TriSession, TriViewer } from "./types";

const TTL_MS = 10 * 60_000;
const STALE_MS = 180 * 86_400_000;
const DAY_MS = 86_400_000;

interface State {
  payload: TriPayload | null;
  running: Promise<TriPayload> | null;
}
const state = ((globalThis as Record<symbol, unknown>)[Symbol.for("cine-app.tri")] ??= { payload: null, running: null }) as State;

export function triPayload(force = false): Promise<TriPayload> {
  if (!force && state.payload && Date.now() - state.payload.computedAt < TTL_MS) return Promise.resolve(state.payload);
  if (state.running) return state.running;
  state.running = collect()
    .then((p) => {
      state.payload = p;
      // L'index du disque se prépare une fois la collecte finie (pas pendant : voir `fsSlot`, plan.ts),
      // pour que le premier aperçu de suppression n'ait que les services à interroger.
      void diskIndex().catch(() => {});
      return p;
    })
    .finally(() => {
      state.running = null;
    });
  return state.running;
}

/** Après une suppression : la collecte suivante repart de zéro. */
export function forgetTriPayload(): void {
  state.payload = null;
}

const lower = (s: string | undefined | null) => (s ?? "").trim().toLowerCase();

/** Les comptes de test et de secours : leurs lectures ne disent rien des goûts de la maison. */
const NOT_A_VIEWER = /^(claude-test|cine-test|test|rescue-admin)$/;

function requesterName(r: JellyseerrRequest): string {
  const by = r.requestedBy as { jellyfinUsername?: string; displayName?: string; username?: string };
  return lower(by.jellyfinUsername || by.displayName || by.username) || "?";
}

/**
 * Un appel lourd (la liste complète de Jellyfin, 1 100 titres vus d'un compte) peut dépasser les 5 s de
 * `fetchJson` quand le serveur est occupé — mesuré au premier chargement après un démarrage. Une
 * seconde chance, pas davantage : la page dit l'échec plutôt que de tourner sans fin.
 */
async function patient<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof Error) || !/délai|timeout|abort/i.test(`${e.name} ${e.message}`)) throw e;
    await new Promise((r) => setTimeout(r, 1000));
    return fn();
  }
}

async function inTurn<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

async function collect(): Promise<TriPayload> {
  const now = Date.now();
  const [movies, series, requests, jfUsers, jfMovies, jfSeries, logs] = await Promise.all([
    patient(() => cachedMovies()),
    patient(() => cachedSeries()),
    patient(() => jellyseerr.getAllRequests()),
    patient(() => jellyfin.getUsers()),
    patient(() => jellyfin.getAllMoviesAdmin()),
    patient(() => jellyfin.getAllSeriesAdmin()),
    readLogFacts(),
  ]);

  // Jellyfin ↔ Radarr/Sonarr : par TMDB pour un film, par TVDB pour une série.
  const jfMovieByTmdb = new Map<number, JellyfinItem>();
  for (const m of jfMovies) if (m.ProviderIds?.Tmdb) jfMovieByTmdb.set(Number(m.ProviderIds.Tmdb), m);
  const jfSeriesByTvdb = new Map<number, JellyfinItem>();
  for (const s of jfSeries) if (s.ProviderIds?.Tvdb) jfSeriesByTvdb.set(Number(s.ProviderIds.Tvdb), s);

  // Ce que chaque compte a vu ou entamé : élément Jellyfin (film ou série) → épisodes et dernière date.
  const watchedBy = new Map<string, Map<string, { played: number; last: string | null }>>();
  const episodeSeries = new Map<string, string>();
  await inTurn(jfUsers, 3, async (u) => {
    // Un compte illisible ne compte pour personne — ce qui ferait passer ses titres pour jamais ouverts :
    // l'échec remonte plutôt que de fausser la page.
    const items = await patient(() => jellyfin.getWatchedOrStarted(u.Id));
    const mine = new Map<string, { played: number; last: string | null }>();
    const counted = new Set<string>();
    for (const it of items) {
      if (!it.Id || counted.has(it.Id)) continue;
      counted.add(it.Id);
      const target = it.Type === "Episode" ? it.SeriesId : it.Id;
      if (!target) continue;
      if (it.Type === "Episode") episodeSeries.set(it.Id, target);
      const prev = mine.get(target) ?? { played: 0, last: null };
      const last = (it.UserData as { LastPlayedDate?: string } | undefined)?.LastPlayedDate ?? null;
      mine.set(target, { played: prev.played + 1, last: !prev.last || (last && last > prev.last) ? last : prev.last });
    }
    if (!NOT_A_VIEWER.test(lower(u.Name))) watchedBy.set(lower(u.Name), mine);
  });

  // Un épisode que personne n'a marqué vu ni entamé n'est pas dans `episodeSeries` : sa série se
  // retrouve alors par le nom que porte la ligne du journal.
  const jfSeriesByName = new Map<string, string>();
  for (const s of jfSeries) if (s.Id && s.Name) jfSeriesByName.set(lower(s.Name), s.Id);
  const targetOf = (itemId: string, seriesName: string | null) =>
    episodeSeries.get(itemId) ?? (seriesName ? jfSeriesByName.get(lower(seriesName)) : undefined) ?? itemId;

  // Les séances du journal, rangées par élément Jellyfin du titre (film, ou série pour un épisode).
  const sessionsOf = new Map<string, TriSession[]>();
  for (const s of logs.sessions) {
    if (NOT_A_VIEWER.test(s.user)) continue;
    const target = targetOf(s.itemId, s.seriesName);
    const list = sessionsOf.get(target) ?? [];
    list.push({ user: s.user, device: s.device, at: new Date(s.at).toISOString(), episode: s.episode, watchedMin: s.watchedS === null ? null : Math.round(s.watchedS / 60) });
    sessionsOf.set(target, list);
  }
  for (const list of sessionsOf.values()) list.sort((a, b) => b.at.localeCompare(a.at));

  // Les genres d'un élément Jellyfin, lus chez Radarr ou Sonarr (en anglais, comme les catégories).
  const genresOfJf = new Map<string, string[]>();
  for (const m of movies) {
    const jf = jfMovieByTmdb.get(m.tmdbId);
    if (jf?.Id) genresOfJf.set(jf.Id, m.genres ?? []);
  }
  for (const s of series) {
    const jf = jfSeriesByTvdb.get(s.tvdbId);
    if (jf?.Id) genresOfJf.set(jf.Id, s.genres ?? []);
  }

  // Les profils : compte × type d'appareil, et les genres de ce qu'ils ouvrent.
  const profileGenres = new Map<string, Map<string, number>>();
  const profileOpened = new Map<string, Set<string>>();
  for (const o of logs.opened) {
    if (NOT_A_VIEWER.test(o.user)) continue;
    const target = targetOf(o.itemId, o.seriesName);
    if (!genresOfJf.has(target)) continue;
    const key = `${o.user} · ${o.device}`;
    const set = profileOpened.get(key) ?? new Set<string>();
    if (set.has(target)) continue;
    set.add(target);
    profileOpened.set(key, set);
    const g = profileGenres.get(key) ?? new Map<string, number>();
    for (const genre of genresOfJf.get(target) ?? []) g.set(genre, (g.get(genre) ?? 0) + 1);
    profileGenres.set(key, g);
  }
  // Les goûts d'un compte entier, pour un profil qui a trop peu regardé seul.
  const accountGenres = new Map<string, Map<string, number>>();
  for (const [key, g] of profileGenres) {
    const user = key.split(" · ")[0];
    const acc = accountGenres.get(user) ?? new Map<string, number>();
    for (const [genre, n] of g) acc.set(genre, (acc.get(genre) ?? 0) + n);
    accountGenres.set(user, acc);
  }
  const profiles: TriProfile[] = [...profileGenres.entries()]
    .map(([key, g]) => ({
      key,
      user: key.split(" · ")[0],
      device: key.split(" · ")[1],
      opened: profileOpened.get(key)?.size ?? 0,
      topGenres: [...g.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([genre, count]) => ({ genre, count })),
    }))
    .sort((a, b) => b.opened - a.opened);

  // Les demandes, rattachées au titre de Radarr/Sonarr qu'elles ont produit.
  const requestsOf = new Map<string, { r: JellyseerrRequest; user: string; device: string | null }[]>();
  for (const r of requests) {
    const kind: TriKind | null = r.type === "movie" ? "movie" : r.type === "tv" ? "series" : null;
    const ext = r.media?.externalServiceId;
    if (!kind || !ext) continue;
    const user = requesterName(r);
    const device = deviceAround(logs.events, user, Date.parse(r.createdAt));
    const key = `${kind}:${ext}`;
    requestsOf.set(key, [...(requestsOf.get(key) ?? []), { r, user, device }]);
  }

  // Les titres, avant score : de quoi calculer d'abord les comptes.
  interface Draft {
    t: Omit<TriTitle, "score" | "reasons" | "genreDistance">;
    jfId: string | null;
  }
  const drafts: Draft[] = [];
  const viewersOf = (jfId: string | null): TriViewer[] => {
    if (!jfId) return [];
    const out: TriViewer[] = [];
    for (const [user, m] of watchedBy) {
      const w = m.get(jfId);
      if (w) out.push({ user, played: w.played, lastPlayed: w.last });
    }
    return out.sort((a, b) => (b.lastPlayed ?? "").localeCompare(a.lastPlayed ?? ""));
  };
  const poster = (images: { coverType: string; remoteUrl?: string }[] | undefined) => posterUrl(images, "thumb");
  const toRequests = (key: string): TriRequest[] =>
    (requestsOf.get(key) ?? []).map(({ r, user, device }) => ({ user, device, at: r.createdAt, jellyseerrRequestId: r.id }));
  const mediaIdOf = (key: string) => requestsOf.get(key)?.find((x) => x.r.media?.id)?.r.media?.id ?? null;

  for (const m of movies) {
    if (!m.hasFile && !(m.sizeOnDisk > 0)) continue;
    const jf = jfMovieByTmdb.get(m.tmdbId)?.Id ?? null;
    const rating = m.ratings?.imdb?.value ?? null;
    const key = `movie:${m.id}`;
    drafts.push({
      jfId: jf,
      t: {
        kind: "movie",
        id: m.id,
        title: m.title,
        year: m.year || null,
        genres: m.genres ?? [],
        rating: rating && rating > 0 ? rating : null,
        ratingSource: rating ? "imdb" : null,
        sizeBytes: m.sizeOnDisk ?? 0,
        added: m.added ?? null,
        episodes: null,
        poster: poster(m.images),
        requests: toRequests(key),
        viewers: viewersOf(jf),
        sessions: jf ? (sessionsOf.get(jf) ?? []).slice(0, 100) : [],
        flags: flagsOf("movie", m.genres ?? [], rating),
        jellyseerrMediaId: mediaIdOf(key),
      },
    });
  }
  for (const s of series) {
    const stats = s.statistics;
    if (!stats || stats.episodeFileCount === 0) continue;
    const jf = jfSeriesByTvdb.get(s.tvdbId)?.Id ?? null;
    const raw = (s as unknown as { ratings?: { value?: number } }).ratings?.value ?? null;
    const key = `series:${s.id}`;
    drafts.push({
      jfId: jf,
      t: {
        kind: "series",
        id: s.id,
        title: s.title,
        year: s.year || null,
        genres: s.genres ?? [],
        rating: raw && raw > 0 ? raw : null,
        ratingSource: raw ? "tvdb" : null,
        sizeBytes: stats.sizeOnDisk ?? 0,
        added: s.added ?? null,
        episodes: { files: stats.episodeFileCount, total: stats.episodeCount },
        poster: poster(s.images as { coverType: string; remoteUrl?: string }[] | undefined),
        requests: toRequests(key),
        viewers: viewersOf(jf),
        sessions: jf ? (sessionsOf.get(jf) ?? []).slice(0, 100) : [],
        flags: flagsOf("series", s.genres ?? [], raw),
        jellyseerrMediaId: mediaIdOf(key),
      },
    });
  }

  // Les comptes demandeurs.
  const byUser = new Map<string, { dates: string[]; titles: Draft[]; devices: Set<string> }>();
  for (const [key, list] of requestsOf) {
    for (const { r, user } of list) {
      const e = byUser.get(user) ?? { dates: [], titles: [], devices: new Set<string>() };
      e.dates.push(r.createdAt);
      const d = drafts.find((x) => `${x.t.kind}:${x.t.id}` === key);
      if (d && !e.titles.includes(d)) e.titles.push(d);
      byUser.set(user, e);
    }
  }
  for (const p of profiles) byUser.get(p.user)?.devices.add(p.device);
  const accounts: TriAccount[] = [...byUser.entries()].map(([user, e]) => {
    const openedByMe = (d: Draft) => d.t.viewers.some((v) => v.user === user) || d.t.sessions.some((x) => x.user === user);
    const available = e.titles.length;
    const opened = e.titles.filter(openedByMe).length;
    const rated = e.titles.map((d) => d.t.rating).filter((r): r is number => r !== null);
    const avgRating = rated.length ? Math.round((rated.reduce((a, b) => a + b, 0) / rated.length) * 10) / 10 : null;
    const neverOpenedBytes = e.titles.filter((d) => d.t.viewers.length === 0 && d.t.sessions.length === 0).reduce((a, d) => a + d.t.sizeBytes, 0);
    const last90Days = e.dates.filter((d) => now - Date.parse(d) < 90 * DAY_MS).length;
    const input = { requests: e.dates.length, available, opened, avgRating, neverOpenedBytes, burstShare: burstShare(e.dates), profiles: e.devices.size, last90Days };
    const { score, parts } = accountScore(input);
    return { user, ...input, profiles: [...e.devices].sort(), score, parts };
  });
  accounts.sort((a, b) => b.requests - a.requests);
  const accountScoreOf = new Map(accounts.map((a) => [a.user, a.score]));

  const titles: TriTitle[] = drafts.map(({ t }) => {
    // Ouvert : vu ou entamé pour Jellyfin (n'importe quel client), ou une séance au journal de Laterna.
    const neverOpened = t.viewers.length === 0 && t.sessions.length === 0;
    const lastSeen = Math.max(
      t.viewers.reduce<number>((a, v) => Math.max(a, v.lastPlayed ? Date.parse(v.lastPlayed) : 0), 0),
      t.sessions.length ? Date.parse(t.sessions[0].at) : 0
    );
    const firstRequest = t.requests.reduce<number | null>((a, r) => (a === null ? Date.parse(r.at) : Math.min(a, Date.parse(r.at))), null);
    const added = t.added ? Date.parse(t.added) : null;
    const since = firstRequest !== null && added !== null ? Math.min(firstRequest, added) : (firstRequest ?? added);
    // Loin des goûts du profil qui l'a demandé — à défaut, de ceux du compte entier.
    const req = t.requests[0];
    const watched = req ? (profileGenres.get(`${req.user} · ${req.device}`) ?? accountGenres.get(req.user)) : undefined;
    const distance = watched ? genreDistance(t.genres, watched) : null;
    const requesterScore = t.requests.length ? Math.min(...t.requests.map((r) => accountScoreOf.get(r.user) ?? 100)) : null;
    const { score, reasons } = titleScore({
      neverOpened,
      stale: !neverOpened && lastSeen > 0 && now - lastSeen > STALE_MS,
      since,
      flags: t.flags,
      rating: t.rating,
      distance,
      requesterScore,
      sizeBytes: t.sizeBytes,
      now,
    });
    return { ...t, score, reasons, genreDistance: distance };
  });
  titles.sort((a, b) => b.score - a.score);

  return { computedAt: now, titles, accounts, profiles, removed: listRemovals(), freedBytesTotal: freedTotal() };
}
