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

import { summarize } from "@/lib/reports";
import { jellyfin, type JellyfinUser, type JellyfinDevice, type JellyfinSession } from "@/lib/clients/jellyfin";
import { jellyseerr } from "@/lib/clients/jellyseerr";
import { enrichRequests } from "@/lib/jellyseerr-enrich";
import { sessionDb, watchlistDb, pushDb, notificationPrefsDb, userPrefsDb, onboardingDb, pendingRequestDb, reportsDb } from "@/lib/db";
import { presenceOf, type Presence } from "@/lib/activity/presence";
import { diagnoseTitles } from "@/lib/activity/diagnosis";
import { readRecords, type LogRecord } from "@/lib/activity/logReader";
import { buildSeances, type Seance } from "@/lib/activity/seances";
import { isChunkLoadError } from "@/lib/chunkError";

/**
 * Une « erreur » de navigateur qui n'en est pas une : la page était ouverte pendant un
 * déploiement, et elle a demandé un morceau de code renommé depuis. L'écran d'erreur recharge
 * alors l'application d'office, une fois (`chunkError.ts`) — il n'y a rien à réparer. Comptée à
 * part pour ne pas lever d'alerte : Sarah et Lucas en avaient chacun une le 23/09/2026, un jour
 * de déploiements, et elles se lisaient comme des pannes.
 */
function isStaleClientChunk(r: LogRecord): boolean {
  return r.scope === "client" && isChunkLoadError({ message: String(r.message ?? ""), name: String(r.name ?? "") });
}

const DAY = 24 * 60 * 60 * 1000;
/**
 * Jusqu'où remonte la fiche d'un compte. Les journaux gardent des années depuis le 24/09/2026 ;
 * tout relire à chaque ouverture tiendrait le serveur plusieurs secondes. Les journaux eux-mêmes
 * remontent aussi loin qu'on le demande (page Journaux, « Plus ancien »).
 */
export const ACCOUNT_HISTORY_DAYS = 90;
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
  return readRecords("server", since).filter((r) => r._t >= since);
}

/** Qui est dans l'application, qui regarde quoi, et les comptes d'un coup d'œil. */
export async function listAccounts(now = Date.now()): Promise<AccountSummary[]> {
  const [users, sessions] = await Promise.all([
    jellyfin.getUsers().catch(() => [] as JellyfinUser[]),
    jellyfin.getSessions().catch(() => [] as JellyfinSession[]),
  ]);
  const appSessions = sessionDb.summaryByUser();
  const weekStart = now - 7 * DAY;
  const seances = buildSeances(readRecords("player", weekStart)).filter((s) => s.start >= weekStart);
  const server = serverRecordsSince(weekStart);

  return users
    .map((user): AccountSummary => {
      const name = user.Name;
      const lower = name.toLowerCase();
      const app = appSessions.get(user.Id);
      const lastActivity = time(user.LastActivityDate);
      const mine = seances.filter((s) => s.user.toLowerCase() === lower);
      const refused = server.filter((r) => r.scope === "jellyfin-token" && String(r.user ?? "").toLowerCase() === lower);
      const clientErrors = server.filter((r) => r.scope === "client" && !isStaleClientChunk(r) && String(r.user ?? "").toLowerCase() === lower);
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
  /** Des pages ouvertes pendant un déploiement, rechargées d'office — voir `isStaleClientChunk`. */
  staleReloads: number;
  tokenRefusals: number;
  serverErrors: { scope: string; count: number }[];
  rebuildReasons: { reason: string; count: number }[];
  /** Les titres qui ont posé le plus de problèmes cette semaine. */
  /** Les séances par jour, pour la courbe. */
  perDay: { day: string; seances: number; problems: number }[];
}

/** Le bilan de la semaine : ce que le journal du lecteur et celui du serveur en disent. */
export function weekSignals(now = Date.now()): WeekSignals {
  const since = now - 7 * DAY;
  const seances = buildSeances(readRecords("player", since)).filter((s) => s.start >= since);
  const server = serverRecordsSince(since);
  const sum = (f: (s: Seance) => number) => seances.reduce((n, s) => n + f(s), 0);

  const reasons = new Map<string, number>();
  for (const s of seances) {
    for (const i of s.incidents) {
      if (i.kind !== "rebuild") continue;
      // Le motif sans son état détaillé : « InvalidStateError … (MediaSource closed, …) » est la
      // famille qui se compte. Les retours d'arrière-plan n'en sont plus (`backgroundRebuilds`).
      const family = i.reason.replace(/\s*\(.*$/, "").slice(0, 80) || "?";
      reasons.set(family, (reasons.get(family) ?? 0) + 1);
    }
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
    clientErrors: server.filter((r) => r.scope === "client" && !isStaleClientChunk(r)).length,
    staleReloads: server.filter(isStaleClientChunk).length,
    tokenRefusals: server.filter((r) => r.scope === "jellyfin-token").length,
    serverErrors: [...scopes].map(([scope, count]) => ({ scope, count })).sort((a, b) => b.count - a.count).slice(0, 8),
    rebuildReasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 6),
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
  const nextUp = await part(jellyfin.getNextUpGlobal(id, 12).then((items) => (items as unknown as JellyfinItemLike[]).map(mediaEntry)));

  const historyStart = now - ACCOUNT_HISTORY_DAYS * DAY;
  const seances = buildSeances(readRecords("player", historyStart)).filter((s) => s.user.toLowerCase() === lower && s.start >= historyStart);
  const errors = readRecords("server", historyStart)
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
    historyDays: ACCOUNT_HISTORY_DAYS,
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
    quality: qualityByDevice(seances),
    habits: habitsOf(seances),
    seriesInProgress: nextUp.ok ? nextUp.value : null,
    auth: authEventsFor(name, historyStart),
    notificationsReceived: notificationsFor(name, historyStart),
    // Ses signalements envoyés — ses brouillons ne sont qu'à lui.
    reports: reportsDb
      .listForUser(id)
      .filter((r) => r.status !== "draft")
      .map((r) => summarize(r, { userId: "", userName: "", admin: true }, "admin")),
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
export function recentSeances(limit = 20, now = Date.now()): Seance[] {
  return buildSeances(readRecords("player", now - 30 * DAY)).slice(0, limit);
}


// ─── Qualité, habitudes, connexions, notifications ──────────────────────────────────

export interface DeviceQuality {
  device: string;
  seances: number;
  watchedSeconds: number;
  /** Temps d'ouverture médian, en ms. */
  openMs: number | null;
  waits: number;
  waitedMs: number;
  slowSeeks: number;
  rebuilds: number;
  stalls: number;
  fallbacks: number;
  errors: number;
  /** Part des séances qui ont connu au moins un incident. */
  troubledShare: number;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * La qualité de lecture par appareil — « iPhone · Safari », « Mac · Safari ». Un appareil qui souffre
 * se voit là avant qu'on le dise : ouvertures lentes, reconstructions, replis. Né d'un iPhone 12 qui
 * perdait son décodeur au bout de vingt minutes, et que rien ne distinguait des autres (23/09/2026).
 */
export function qualityByDevice(seances: Seance[]): DeviceQuality[] {
  const groups = new Map<string, Seance[]>();
  for (const s of seances) {
    const key = s.device ?? "?";
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups]
    .map(([device, list]) => ({
      device,
      seances: list.length,
      watchedSeconds: list.reduce((n, s) => n + (s.stop?.watched ?? 0), 0),
      openMs: median(list.map((s) => s.openedMs).filter((v): v is number => v !== null)),
      waits: list.reduce((n, s) => n + (s.stop?.waits ?? 0), 0),
      waitedMs: list.reduce((n, s) => n + (s.stop?.waitedMs ?? 0), 0),
      slowSeeks: list.reduce((n, s) => n + s.slowSeeks, 0),
      rebuilds: list.reduce((n, s) => n + s.rebuilds, 0),
      stalls: list.reduce((n, s) => n + s.stalls, 0),
      fallbacks: list.reduce((n, s) => n + s.fallbacks, 0),
      errors: list.reduce((n, s) => n + s.errors, 0),
      troubledShare: list.filter((s) => problemsOf(s) > 0).length / list.length,
    }))
    .sort((a, b) => b.seances - a.seances);
}

export interface Habits {
  /** [jour de la semaine, lundi = 0][heure] → secondes regardées (ou séances, faute de bilan). */
  heatmap: number[][];
  topTitles: { title: string; seances: number; watchedSeconds: number }[];
}

/** Le nom d'une série pour un épisode — « Ted Lasso — S04E01 · … » → « Ted Lasso ». */
function workTitle(title: string): string {
  const cut = title.indexOf(" — S");
  return cut > 0 ? title.slice(0, cut) : title;
}

/** Quand on regarde, et quoi : de quoi voir les habitudes d'une personne ou du foyer. */
export function habitsOf(seances: Seance[]): Habits {
  const heatmap = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  const titles = new Map<string, { title: string; seances: number; watchedSeconds: number }>();
  for (const s of seances) {
    const d = new Date(s.start);
    // L'heure du serveur, qui est celle du foyer (TZ du conteneur).
    const day = (d.getDay() + 6) % 7;
    heatmap[day][d.getHours()] += s.stop?.watched ?? 60;
    const key = workTitle(s.title);
    const t = titles.get(key) ?? { title: key, seances: 0, watchedSeconds: 0 };
    t.seances += 1;
    t.watchedSeconds += s.stop?.watched ?? 0;
    titles.set(key, t);
  }
  return {
    heatmap,
    topTitles: [...titles.values()].sort((a, b) => b.watchedSeconds - a.watchedSeconds || b.seances - a.seances).slice(0, 10),
  };
}

/** Les notifications reçues par ce compte : ce qui est parti, et ce qu'il en est advenu chez lui. */
function notificationsFor(userName: string, since: number) {
  const lower = userName.toLowerCase();
  return readRecords("notifications", since)
    .filter((r) => r._t >= since)
    .map((r) => {
      const mine = (Array.isArray(r.recipients) ? (r.recipients as Record<string, unknown>[]) : []).find(
        (x) => String(x.user ?? "").toLowerCase() === lower
      );
      return mine ? { at: r._t, category: r.category ?? null, title: String(r.title ?? ""), body: String(r.body ?? ""), outcome: mine } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .reverse()
    .slice(0, 100);
}

/** Les connexions de ce compte, les plus récentes d'abord. */
function authEventsFor(userName: string, since: number) {
  const lower = userName.toLowerCase();
  return readRecords("auth", since)
    .filter((r) => r._t >= since && String(r.user ?? "").toLowerCase() === lower)
    .reverse()
    .slice(0, 100)
    .map((r) => ({ at: r._t, kind: String(r.kind ?? "?"), device: r.device ?? null, ip: r.ip ?? null, reason: r.reason ?? null, count: r.count ?? null, by: r.by ?? null }));
}

/** Le foyer sur trente jours : appareils, habitudes, connexions et notifications. */
export function household(now = Date.now()) {
  const since = now - 30 * DAY;
  const seances = buildSeances(readRecords("player", since)).filter((s) => s.start >= since);
  const auth = readRecords("auth", since).filter((r) => r._t >= since);
  const notifications = readRecords("notifications", since).filter((r) => r._t >= since);
  const recipients = notifications.flatMap((r) => (Array.isArray(r.recipients) ? (r.recipients as Record<string, number>[]) : []));
  return {
    days: 30,
    devices: qualityByDevice(seances),
    habits: habitsOf(seances),
    // Le titre ou l'appareil : les réussites de la période comptent autant que les échecs, ce sont
    // elles qui innocentent l'un ou l'autre.
    diagnosis: diagnoseTitles(seances),
    logins: {
      ok: auth.filter((r) => r.kind === "login").length,
      failed: auth.filter((r) => r.kind === "login-failed").length,
      recentFailures: auth
        .filter((r) => r.kind === "login-failed")
        .slice(-10)
        .reverse()
        .map((r) => ({ at: r._t, user: String(r.user ?? "?"), reason: r.reason ?? null, device: r.device ?? null, ip: r.ip ?? null })),
    },
    notifications: {
      sent: notifications.length,
      delivered: recipients.reduce((n, x) => n + (Number(x.sent) || 0), 0),
      failed: recipients.reduce((n, x) => n + (Number(x.failed) || 0) + (Number(x.removed) || 0), 0),
      byCategory: [...notifications.reduce((m, r) => m.set(String(r.category ?? "?"), (m.get(String(r.category ?? "?")) ?? 0) + 1), new Map<string, number>())]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count),
    },
  };
}
