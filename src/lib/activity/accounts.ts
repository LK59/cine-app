// Ce que l'administrateur voit de chaque compte : tout ce que l'application et le serveur média
// savent de lui, réuni en un endroit.
//
// Né le 24/09/2026 d'un compte dont le jeton avait été révoqué six jours plus tôt : il a fallu
// croiser à la main le journal du lecteur, la base des sessions, les appareils et l'activité
// côté Jellyfin, et le journal de Jellyfin lui-même, pour voir ce qu'une ligne aurait dit —
// « activité dans l'application ce matin, côté Jellyfin il y a six jours ». Lecture seule ; les
// actions sont des routes à part, explicites.
//
// Deux clés désignent une personne dans la base, héritées de l'histoire des tables : son
// identifiant Jellyfin (sessions, liste « À voir », langue) et son nom (notifications,
// abonnements, demandes suivies, accueil). Les deux sont résolues ici, et nulle part ailleurs.

import { jellyfin, type JellyfinUser, type JellyfinDevice, type JellyfinSession } from "@/lib/clients/jellyfin";
import { jellyseerr } from "@/lib/clients/jellyseerr";
import { enrichRequests } from "@/lib/jellyseerr-enrich";
import { sessionDb, watchlistDb, pushDb, notificationPrefsDb, userPrefsDb, onboardingDb, pendingRequestDb } from "@/lib/db";
import { presenceOf, type Presence } from "@/lib/activity/presence";
import { readRecords, type LogRecord } from "@/lib/activity/logReader";
import { buildSeances, type Seance } from "@/lib/activity/seances";

const DAY = 24 * 60 * 60 * 1000;
/** Un compte actif dans l'application dont Jellyfin ne voit rien depuis plus d'un jour : son jeton. */
const TOKEN_GAP_MS = DAY;

export interface NowPlaying {
  itemId: string | null;
  title: string;
  positionSeconds: number | null;
  runtimeSeconds: number | null;
  paused: boolean;
  device: string | null;
  client: string | null;
  method: string | null;
}

export interface AccountSummary {
  id: string;
  name: string;
  admin: boolean;
  disabled: boolean;
  presence: Presence;
  nowPlaying: NowPlaying | null;
  app: { sessions: number; lastSeen: number | null };
  jellyfin: { lastActivity: number | null; lastLogin: number | null };
  /** Ce qui mérite un regard : un jeton refusé, ou un compte que Jellyfin ne voit plus. */
  alerts: { kind: "tokenRefused" | "tokenStale" | "clientErrors"; at: number | null; count?: number }[];
  week: { seances: number; watchedSeconds: number; problems: number };
}

const time = (iso: string | undefined | null): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

function nowPlayingFrom(session: JellyfinSession | undefined): NowPlaying | null {
  const item = session?.NowPlayingItem;
  if (!session || !item) return null;
  const episode =
    item.SeriesName && item.IndexNumber != null
      ? `${item.SeriesName} — S${String(item.ParentIndexNumber ?? 0).padStart(2, "0")}E${String(item.IndexNumber).padStart(2, "0")} · `
      : "";
  return {
    itemId: item.Id ?? null,
    title: `${episode}${item.Name ?? "?"}`,
    positionSeconds: session.PlayState?.PositionTicks != null ? session.PlayState.PositionTicks / 1e7 : null,
    runtimeSeconds: item.RunTimeTicks ? item.RunTimeTicks / 1e7 : null,
    paused: session.PlayState?.IsPaused === true,
    device: session.DeviceName ?? null,
    client: session.Client ?? null,
    method: session.PlayState?.PlayMethod ?? null,
  };
}

/** Les incidents d'une séance, comptés ensemble. */
export function problemsOf(s: Seance): number {
  return s.stalls + s.rebuilds + s.fallbacks + s.errors + s.slowSeeks;
}

function serverRecordsSince(since: number): LogRecord[] {
  return readRecords("server").filter((r) => r._t >= since);
}

/** Qui est dans l'application, qui regarde quoi, et les comptes d'un coup d'œil. */
export async function listAccounts(now = Date.now()): Promise<AccountSummary[]> {
  const [users, sessions] = await Promise.all([
    jellyfin.getUsers().catch(() => [] as JellyfinUser[]),
    jellyfin.getSessions().catch(() => [] as JellyfinSession[]),
  ]);
  const appSessions = sessionDb.summaryByUser();
  const weekStart = now - 7 * DAY;
  const seances = buildSeances(readRecords("player")).filter((s) => s.start >= weekStart);
  const server = serverRecordsSince(weekStart);

  return users
    .map((user): AccountSummary => {
      const name = user.Name;
      const lower = name.toLowerCase();
      const app = appSessions.get(user.Id);
      const lastActivity = time(user.LastActivityDate);
      const mine = seances.filter((s) => s.user.toLowerCase() === lower);
      const refused = server.filter((r) => r.scope === "jellyfin-token" && String(r.user ?? "").toLowerCase() === lower);
      const clientErrors = server.filter((r) => r.scope === "client" && String(r.user ?? "").toLowerCase() === lower);
      const alerts: AccountSummary["alerts"] = [];
      if (refused.length) alerts.push({ kind: "tokenRefused", at: refused[refused.length - 1]._t });
      else if (app && app.lastSeenAt > weekStart && (lastActivity === null || app.lastSeenAt - lastActivity > TOKEN_GAP_MS)) {
        alerts.push({ kind: "tokenStale", at: lastActivity });
      }
      if (clientErrors.length) alerts.push({ kind: "clientErrors", at: clientErrors[clientErrors.length - 1]._t, count: clientErrors.length });
      const playing = sessions.find((s) => s.UserId === user.Id && s.NowPlayingItem);
      return {
        id: user.Id,
        name,
        admin: user.Policy?.IsAdministrator === true,
        disabled: user.Policy?.IsDisabled === true,
        presence: presenceOf(name, now),
        nowPlaying: nowPlayingFrom(playing),
        app: { sessions: app?.count ?? 0, lastSeen: app?.lastSeenAt ?? null },
        jellyfin: { lastActivity, lastLogin: time(user.LastLoginDate) },
        alerts,
        week: {
          seances: mine.length,
          watchedSeconds: mine.reduce((n, s) => n + (s.stop?.watched ?? 0), 0),
          problems: mine.reduce((n, s) => n + problemsOf(s), 0),
        },
      };
    })
    .sort((a, b) => rank(b) - rank(a) || (b.app.lastSeen ?? 0) - (a.app.lastSeen ?? 0));
}

/** Les présents d'abord — en lecture, puis dans l'application —, puis les plus récemment vus. */
function rank(a: AccountSummary): number {
  if (a.presence.state === "playing" || a.nowPlaying) return 2;
  if (a.presence.state === "app") return 1;
  return 0;
}

export interface WeekSignals {
  since: number;
  seances: number;
  viewers: number;
  watchedSeconds: number;
  waits: number;
  waitedMs: number;
  slowSeeks: number;
  seeks: number;
  stalls: number;
  rebuilds: number;
  fallbacks: number;
  errors: number;
  lost: number;
  audioSwitches: number;
  clientErrors: number;
  tokenRefusals: number;
  serverErrors: { scope: string; count: number }[];
  rebuildReasons: { reason: string; count: number }[];
  /** Les titres qui ont posé le plus de problèmes cette semaine. */
  troubledTitles: { title: string; itemId: string | null; problems: number; seances: number }[];
  /** Les séances par jour, pour la courbe. */
  perDay: { day: string; seances: number; problems: number }[];
}

/** Le bilan de la semaine : ce que le journal du lecteur et celui du serveur en disent. */
export function weekSignals(now = Date.now()): WeekSignals {
  const since = now - 7 * DAY;
  const seances = buildSeances(readRecords("player")).filter((s) => s.start >= since);
  const server = serverRecordsSince(since);
  const sum = (f: (s: Seance) => number) => seances.reduce((n, s) => n + f(s), 0);

  const reasons = new Map<string, number>();
  for (const s of seances) {
    for (const i of s.incidents) {
      if (i.kind !== "rebuild") continue;
      // Le motif sans son état détaillé : « InvalidStateError … (MediaSource closed, …) » et
      // « source fermée en arrière-plan » sont les familles qui se comptent.
      const family = i.reason.replace(/\s*\(.*$/, "").slice(0, 80) || "?";
      reasons.set(family, (reasons.get(family) ?? 0) + 1);
    }
  }
  const titles = new Map<string, { title: string; itemId: string | null; problems: number; seances: number }>();
  for (const s of seances) {
    const key = s.itemId ?? s.title;
    const t = titles.get(key) ?? { title: s.title, itemId: s.itemId, problems: 0, seances: 0 };
    t.problems += problemsOf(s);
    t.seances += 1;
    titles.set(key, t);
  }
  const scopes = new Map<string, number>();
  for (const r of server) {
    const scope = String(r.scope ?? "?");
    if (scope === "client" || scope === "jellyfin-token") continue;
    scopes.set(scope, (scopes.get(scope) ?? 0) + 1);
  }
  const perDay: WeekSignals["perDay"] = [];
  for (let d = 6; d >= 0; d--) {
    const start = new Date(now - d * DAY);
    start.setHours(0, 0, 0, 0);
    const end = start.getTime() + DAY;
    const day = seances.filter((s) => s.start >= start.getTime() && s.start < end);
    perDay.push({ day: start.toISOString().slice(0, 10), seances: day.length, problems: day.reduce((n, s) => n + problemsOf(s), 0) });
  }

  return {
    since,
    seances: seances.length,
    viewers: new Set(seances.map((s) => s.user.toLowerCase())).size,
    watchedSeconds: sum((s) => s.stop?.watched ?? 0),
    waits: sum((s) => s.stop?.waits ?? 0),
    waitedMs: sum((s) => s.stop?.waitedMs ?? 0),
    slowSeeks: sum((s) => s.slowSeeks),
    seeks: sum((s) => s.seeks),
    stalls: sum((s) => s.stalls),
    rebuilds: sum((s) => s.rebuilds),
    fallbacks: sum((s) => s.fallbacks),
    errors: sum((s) => s.errors),
    lost: seances.filter((s) => s.stop?.why === "lost").length,
    audioSwitches: sum((s) => s.audioSwitches),
    clientErrors: server.filter((r) => r.scope === "client").length,
    tokenRefusals: server.filter((r) => r.scope === "jellyfin-token").length,
    serverErrors: [...scopes].map(([scope, count]) => ({ scope, count })).sort((a, b) => b.count - a.count).slice(0, 8),
    rebuildReasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 6),
    troubledTitles: [...titles.values()].filter((t) => t.problems > 0).sort((a, b) => b.problems - a.problems).slice(0, 8),
    perDay,
  };
}

// ─── Un compte ──────────────────────────────────────────────────────────────────────────────

export interface MediaEntry {
  itemId: string;
  title: string;
  kind: "movie" | "episode" | "series" | "other";
  year: number | null;
  imageTag: string | null;
  positionSeconds: number | null;
  runtimeSeconds: number | null;
  lastPlayed: number | null;
  played: boolean;
}

interface JellyfinItemLike {
  Id: string;
  Name?: string;
  Type?: string;
  SeriesName?: string;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  ProductionYear?: number;
  RunTimeTicks?: number;
  ImageTags?: { Primary?: string };
  UserData?: { PlaybackPositionTicks?: number; LastPlayedDate?: string; Played?: boolean };
}

function mediaEntry(item: JellyfinItemLike): MediaEntry {
  const episode = item.Type === "Episode";
  return {
    itemId: item.Id,
    title: episode
      ? `${item.SeriesName ?? "?"} — S${String(item.ParentIndexNumber ?? 0).padStart(2, "0")}E${String(item.IndexNumber ?? 0).padStart(2, "0")} · ${item.Name ?? ""}`
      : (item.Name ?? "?"),
    kind: episode ? "episode" : item.Type === "Movie" ? "movie" : item.Type === "Series" ? "series" : "other",
    year: item.ProductionYear ?? null,
    imageTag: item.ImageTags?.Primary ?? null,
    positionSeconds: item.UserData?.PlaybackPositionTicks ? item.UserData.PlaybackPositionTicks / 1e7 : null,
    runtimeSeconds: item.RunTimeTicks ? item.RunTimeTicks / 1e7 : null,
    lastPlayed: time(item.UserData?.LastPlayedDate),
    played: item.UserData?.Played === true,
  };
}

/** Ce qui n'a pas pu être lu : la page le dit à sa place au lieu d'afficher une liste vide. */
type Part<T> = { ok: true; value: T } | { ok: false };
const part = async <T>(p: Promise<T>): Promise<Part<T>> => p.then((value) => ({ ok: true as const, value }), () => ({ ok: false as const }));

export async function accountDetail(id: string, now = Date.now()) {
  const users = await jellyfin.getUsers().catch(() => [] as JellyfinUser[]);
  const user = users.find((u) => u.Id === id);
  if (!user) return null;
  const name = user.Name;
  const lower = name.toLowerCase();

  const [sessions, devices, resume, recentMovies, recentEpisodes, favorites, playedMovies, playedEpisodes, requests] = await Promise.all([
    part(jellyfin.getSessions()),
    part(jellyfin.getDevices()),
    part(jellyfin.getResumeItems(id).then((r) => (r.Items as JellyfinItemLike[]).map(mediaEntry))),
    part(jellyfin.getRecentlyPlayed(id, "Movie", 25).then((r) => (r.Items as JellyfinItemLike[]).map(mediaEntry))),
    part(jellyfin.getRecentlyPlayed(id, "Episode", 25).then((r) => (r.Items as JellyfinItemLike[]).map(mediaEntry))),
    part(jellyfin.getFavorites(id).then((items) => (items as JellyfinItemLike[]).map(mediaEntry))),
    part(jellyfin.getPlayedCount(id, "Movie").then((r) => r.TotalRecordCount)),
    part(jellyfin.getPlayedCount(id, "Episode").then((r) => r.TotalRecordCount)),
    part(requestsOf(id)),
  ]);

  const seances = buildSeances(readRecords("player")).filter((s) => s.user.toLowerCase() === lower);
  const errors = readRecords("server")
    .filter((r) => String(r.user ?? "").toLowerCase() === lower)
    .slice(-100)
    .reverse();
  const recent = recentMovies.ok && recentEpisodes.ok
    ? [...recentMovies.value, ...recentEpisodes.value].sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0)).slice(0, 30)
    : null;
  const week = seances.filter((s) => s.start >= now - 7 * DAY);

  return {
    id,
    name,
    profile: {
      admin: user.Policy?.IsAdministrator === true,
      disabled: user.Policy?.IsDisabled === true,
      remoteAccess: user.Policy?.EnableRemoteAccess !== false,
      playback: user.Policy?.EnableMediaPlayback !== false,
      invalidLogins: user.Policy?.InvalidLoginAttemptCount ?? 0,
      hasPassword: user.HasPassword !== false,
      lastLogin: time(user.LastLoginDate),
      lastActivity: time(user.LastActivityDate),
      lang: userPrefsDb.getLang(id, ""),
      onboardingPending: onboardingDb.isPending(name),
      notifications: notificationPrefsDb.getForUser(name),
      pushDevices: pushDb.countForUser(name),
      followedRequests: pendingRequestDb.getAll().filter((r) => r.userId === name).length,
    },
    presence: presenceOf(name, now),
    nowPlaying: sessions.ok ? nowPlayingFrom(sessions.value.find((s) => s.UserId === id && s.NowPlayingItem)) : null,
    appSessions: sessionDb.listForUser(id).map((s) => ({ ...s, jti: s.jti })),
    devices: devices.ok
      ? devices.value
          .filter((d: JellyfinDevice) => d.LastUserId === id || d.LastUserName?.toLowerCase() === lower)
          .map((d) => ({ id: d.Id, app: d.AppName ?? "?", version: d.AppVersion ?? null, name: d.Name ?? null, lastActivity: time(d.DateLastActivity) }))
          .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))
      : null,
    library: {
      resume: resume.ok ? resume.value : null,
      recent,
      favorites: favorites.ok ? favorites.value : null,
      playedMovies: playedMovies.ok ? playedMovies.value : null,
      playedEpisodes: playedEpisodes.ok ? playedEpisodes.value : null,
    },
    watchlist: watchlistDb.getAll(id),
    requests: requests.ok ? requests.value : null,
    seances: seances.slice(0, 300),
    stats: {
      seances: seances.length,
      watchedSeconds: seances.reduce((n, s) => n + (s.stop?.watched ?? 0), 0),
      weekSeances: week.length,
      weekWatchedSeconds: week.reduce((n, s) => n + (s.stop?.watched ?? 0), 0),
      problems: seances.reduce((n, s) => n + problemsOf(s), 0),
      devices: [...new Set(seances.map((s) => s.device).filter(Boolean))] as string[],
      firstSeen: seances.length ? seances[seances.length - 1].start : null,
    },
    errors,
  };
}

export type AccountDetail = NonNullable<Awaited<ReturnType<typeof accountDetail>>>;

/** Les demandes de ce compte, par son compte lié côté Seerr. */
async function requestsOf(jellyfinId: string) {
  const { results: users } = await jellyseerr.getUsers();
  const linked = users.find((u) => u.jellyfinUserId?.replace(/-/g, "") === jellyfinId.replace(/-/g, ""));
  if (!linked) return [];
  const { results } = await jellyseerr.getRequestsByUser(linked.id);
  const enriched = await enrichRequests(results);
  return enriched.map((r) => ({
    id: r.id,
    title: r.media.title ?? "?",
    mediaType: r.media.mediaType,
    status: r.status,
    mediaStatus: r.media.status ?? null,
    createdAt: time(r.createdAt),
    updatedAt: time(r.updatedAt),
    posterPath: r.media.posterPath ?? null,
  }));
}

/** Les dernières séances, tous comptes confondus — le fil de ce qui s'est regardé. */
export function recentSeances(limit = 20): Seance[] {
  return buildSeances(readRecords("player")).slice(0, limit);
}
