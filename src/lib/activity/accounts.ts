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
import { clearedDiagnosis, withoutCleared } from "@/lib/activity/diagnosisCleared";
import { acknowledgeSeances, afterClear, alertsClearedAt } from "@/lib/activity/alertsCleared";
import { cachedJellyfinDevices } from "@/lib/server-cache";

/**
 * Une « erreur » de navigateur qui n'en est pas une : la page était ouverte pendant un
 * déploiement, et elle a demandé un morceau de code renommé depuis. L'écran d'erreur recharge
 * alors l'application d'office, une fois (`chunkError.ts`) — il n'y a rien à réparer. Comptée à
 * part pour ne pas lever d'alerte : Sarah et Lucas en avaient chacun une le 23/09/2026, un jour
 * de déploiements, et elles se lisaient comme des pannes.
 */
export function isStaleClientChunk(r: LogRecord): boolean {
  return r.scope === "client" && isChunkLoadError({ message: String(r.message ?? ""), name: String(r.name ?? "") });
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * La date d'un jour, telle qu'on la lit ici — l'heure du serveur, celle du foyer. `toISOString`
 * la donnait en UTC : minuit à Paris est 22 h la veille, et chaque barre portait le jour d'avant
 * (relu le 24/09/2026).
 */
export function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Une ligne du journal du serveur qui est une erreur — pas un geste de l'administrateur (`info`). */
function isError(r: LogRecord): boolean {
  return r.level !== "info" && r.scope !== "admin";
}
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
  // Une connexion trop lente (§77) est un problème vécu par le spectateur — son lien, pas le fichier.
  return s.stalls + s.rebuilds + s.fallbacks + s.errors + s.slowSeeks + (s.slowLinks ?? 0);
}

function serverRecordsSince(since: number): LogRecord[] {
  return readRecords("server", since).filter((r) => r._t >= since);
}

/**
 * La dernière fois que Jellyfin a vu ce compte : sa propre « dernière activité », ou le dernier usage
 * de l'un de ses appareils, la plus récente des deux (07/10/2026).
 *
 * Jellyfin ne remet `LastActivityDate` à jour qu'à une connexion ou une lecture. Un compte qui ouvre
 * CineApp chaque jour sans rien lancer gardait la date de son dernier film, et l'alerte « Jellyfin ne
 * le voit plus » le désignait à tort : Charlotte et Raphaël, dont l'appareil CineApp était passé chez
 * Jellyfin le matin même. Le dernier usage d'un appareil, lui, bouge à chaque requête signée par son
 * jeton — c'est la preuve que ce jeton vit.
 */
export function serverSeenAt(user: JellyfinUser, devices: JellyfinDevice[] | null): number | null {
  const lower = user.Name.toLowerCase();
  const own = (devices ?? []).filter((d) => d.LastUserId === user.Id || d.LastUserName?.toLowerCase() === lower);
  const stamps = [time(user.LastActivityDate), ...own.map((d) => time(d.DateLastActivity))].filter((t): t is number => t !== null);
  return stamps.length ? Math.max(...stamps) : null;
}

/** Qui est dans l'application, qui regarde quoi, et les comptes d'un coup d'œil. */
export async function listAccounts(now = Date.now(), clearedAt = alertsClearedAt()): Promise<AccountSummary[]> {
  const [users, sessions, devices] = await Promise.all([
    jellyfin.getUsers().catch(() => [] as JellyfinUser[]),
    jellyfin.getSessions().catch(() => [] as JellyfinSession[]),
    // Sans les appareils, on retombe sur la seule date du compte — l'alerte d'hier, rien de pire.
    // Gardés une minute et relus en arrière-plan (`cachedJellyfinDevices`) : Jellyfin met 0,8 à 1 s
    // à les rendre, et la vue d'ensemble l'attendait à chaque relecture (13/10/2026). Les comptes et
    // les lectures en cours, eux, restent demandés à chaque fois — c'est le direct.
    Promise.resolve()
      .then(() => cachedJellyfinDevices())
      .catch(() => null),
  ]);
  const appSessions = sessionDb.summaryByUser();
  const weekStart = now - 7 * DAY;
  // Les alertes effacées ne se recomptent pas : incidents des séances finies avant, lignes du
  // journal d'avant — voir `alertsCleared.ts`.
  const seances = acknowledgeSeances(buildSeances(readRecords("player", weekStart)).filter((s) => s.start >= weekStart), clearedAt);
  const server = serverRecordsSince(weekStart).filter(afterClear(clearedAt));

  return users
    .map((user): AccountSummary => {
      const name = user.Name;
      const lower = name.toLowerCase();
      const app = appSessions.get(user.Id);
      const lastActivity = serverSeenAt(user, devices);
      const mine = seances.filter((s) => s.user.toLowerCase() === lower);
      const refused = server.filter((r) => r.scope === "jellyfin-token" && String(r.user ?? "").toLowerCase() === lower);
      const clientErrors = server.filter((r) => r.scope === "client" && !isStaleClientChunk(r) && String(r.user ?? "").toLowerCase() === lower);
      const alerts: AccountSummary["alerts"] = [];
      if (refused.length) alerts.push({ kind: "tokenRefused", at: refused[refused.length - 1]._t });
      // Un état, pas un événement : effacé, il ne revient que si Jellyfin revoit le compte puis le
      // perd de nouveau — un `at` postérieur à l'effacement.
      else if (
        app &&
        app.lastSeenAt > weekStart &&
        (lastActivity === null || app.lastSeenAt - lastActivity > TOKEN_GAP_MS) &&
        !(clearedAt && (lastActivity ?? 0) <= clearedAt)
      ) {
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
          watchedSeconds: mine.reduce((n, s) => n + (s.watched ?? 0), 0),
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
  /** Les séances par jour, pour la courbe — par semaine ou par mois sur tout l'historique (`bucket`). */
  perDay: { day: string; seances: number; problems: number }[];
  /** Ce que couvre une barre de `perDay` ; absent : un jour. */
  bucket?: "day" | "week" | "month";
}

/**
 * Ce que comptent des séances et des lignes du serveur, sous une forme qui s'additionne d'un jour à
 * l'autre : les spectateurs sont des noms (on n'additionne pas des « 3 spectateurs »), les causes des
 * tables. Une seule façon de compter pour la semaine, les trente jours et tout l'historique
 * (`activityHistory.ts`), qui en garde un par jour.
 */
export interface SignalTally {
  seances: number;
  viewers: string[];
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
  problems: number;
  clientErrors: number;
  staleReloads: number;
  tokenRefusals: number;
  serverErrors: Record<string, number>;
  rebuildReasons: Record<string, number>;
}

export function emptyTally(): SignalTally {
  return {
    seances: 0, viewers: [], watchedSeconds: 0, waits: 0, waitedMs: 0, slowSeeks: 0, seeks: 0, stalls: 0, rebuilds: 0,
    fallbacks: 0, errors: 0, lost: 0, audioSwitches: 0, problems: 0, clientErrors: 0, staleReloads: 0, tokenRefusals: 0,
    serverErrors: {}, rebuildReasons: {},
  };
}

/**
 * Le compte de ces séances (déjà passées par `acknowledgeSeances` quand il le faut) et de ces lignes
 * du serveur. Les erreurs effacées ne se comptent plus (`alertsCleared.ts`) ; les rechargements après
 * un déploiement, qui n'en sont pas, se comptent toujours.
 */
export function tallySignals(seances: readonly Seance[], allServer: readonly LogRecord[], clearedAt = 0): SignalTally {
  const t = emptyTally();
  const viewers = new Set<string>();
  for (const s of seances) {
    t.seances += 1;
    viewers.add(s.user.toLowerCase());
    t.watchedSeconds += s.watched ?? 0;
    t.waits += s.stop?.waits ?? 0;
    t.waitedMs += s.stop?.waitedMs ?? 0;
    t.slowSeeks += s.slowSeeks;
    t.seeks += s.seeks;
    t.stalls += s.stalls;
    t.rebuilds += s.rebuilds;
    t.fallbacks += s.fallbacks;
    t.errors += s.errors;
    if (s.stop?.why === "lost") t.lost += 1;
    t.audioSwitches += s.audioSwitches;
    t.problems += problemsOf(s);
    for (const i of s.incidents) {
      if (i.kind !== "rebuild") continue;
      // Le motif sans son état détaillé : « InvalidStateError … (MediaSource closed, …) » est la
      // famille qui se compte. Les retours d'arrière-plan n'en sont plus (`backgroundRebuilds`).
      const family = i.reason.replace(/\s*\(.*$/, "").slice(0, 80) || "?";
      t.rebuildReasons[family] = (t.rebuildReasons[family] ?? 0) + 1;
    }
  }
  t.viewers = [...viewers].sort();
  const fresh = afterClear(clearedAt);
  for (const r of allServer) {
    if (isStaleClientChunk(r)) {
      t.staleReloads += 1;
      continue;
    }
    if (!fresh(r)) continue;
    if (r.scope === "client") t.clientErrors += 1;
    else if (r.scope === "jellyfin-token") t.tokenRefusals += 1;
    // Les gestes de l'administrateur (`logAdminAction`, niveau « info ») vivent dans le même
    // journal : chaque session fermée comptait comme une erreur serveur (relu le 24/09/2026).
    else if (isError(r)) {
      const scope = String(r.scope ?? "?");
      t.serverErrors[scope] = (t.serverErrors[scope] ?? 0) + 1;
    }
  }
  return t;
}

/** `into` augmenté de `add` — pour sommer des jours. */
export function addTally(into: SignalTally, add: SignalTally): SignalTally {
  const viewers = new Set([...into.viewers, ...add.viewers]);
  const sumMaps = (a: Record<string, number>, b: Record<string, number>) => {
    const out = { ...a };
    for (const [k, n] of Object.entries(b)) out[k] = (out[k] ?? 0) + n;
    return out;
  };
  return {
    seances: into.seances + add.seances,
    viewers: [...viewers].sort(),
    watchedSeconds: into.watchedSeconds + add.watchedSeconds,
    waits: into.waits + add.waits,
    waitedMs: into.waitedMs + add.waitedMs,
    slowSeeks: into.slowSeeks + add.slowSeeks,
    seeks: into.seeks + add.seeks,
    stalls: into.stalls + add.stalls,
    rebuilds: into.rebuilds + add.rebuilds,
    fallbacks: into.fallbacks + add.fallbacks,
    errors: into.errors + add.errors,
    lost: into.lost + add.lost,
    audioSwitches: into.audioSwitches + add.audioSwitches,
    problems: into.problems + add.problems,
    clientErrors: into.clientErrors + add.clientErrors,
    staleReloads: into.staleReloads + add.staleReloads,
    tokenRefusals: into.tokenRefusals + add.tokenRefusals,
    serverErrors: sumMaps(into.serverErrors, add.serverErrors),
    rebuildReasons: sumMaps(into.rebuildReasons, add.rebuildReasons),
  };
}

/** Le bilan affiché, à partir d'un compte et de ses barres. */
export function signalsOf(t: SignalTally, since: number, perDay: WeekSignals["perDay"], bucket?: WeekSignals["bucket"]): WeekSignals {
  const top = (m: Record<string, number>, n: number) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n);
  return {
    since,
    seances: t.seances,
    viewers: t.viewers.length,
    watchedSeconds: t.watchedSeconds,
    waits: t.waits,
    waitedMs: t.waitedMs,
    slowSeeks: t.slowSeeks,
    seeks: t.seeks,
    stalls: t.stalls,
    rebuilds: t.rebuilds,
    fallbacks: t.fallbacks,
    errors: t.errors,
    lost: t.lost,
    audioSwitches: t.audioSwitches,
    clientErrors: t.clientErrors,
    staleReloads: t.staleReloads,
    tokenRefusals: t.tokenRefusals,
    serverErrors: top(t.serverErrors, 8).map(([scope, count]) => ({ scope, count })),
    rebuildReasons: top(t.rebuildReasons, 6).map(([reason, count]) => ({ reason, count })),
    perDay,
    ...(bucket ? { bucket } : {}),
  };
}

/** Les débuts des `n` derniers jours locaux, aujourd'hui compris, du plus ancien au plus récent. */
export function lastLocalDays(now: number, n: number): { day: string; start: number; end: number }[] {
  // Les bornes sont des minuits locaux calculés par le calendrier, jamais « minuit + 24 h » ni
  // « maintenant − d × 24 h » : aux changements d'heure un jour dure 23 ou 25 h, et une séance
  // à 23 h 30 le jour du passage à l'heure d'hiver comptait dans la semaine sans tomber dans
  // aucune barre (celle du passage à l'heure d'été débordait, elle, sur le lendemain).
  const today = new Date(now);
  const out: { day: string; start: number; end: number }[] = [];
  for (let d = n - 1; d >= 0; d--) {
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - d);
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() - d + 1).getTime();
    out.push({ day: localDay(start), start: start.getTime(), end });
  }
  return out;
}

/**
 * Le bilan des `days` derniers jours : ce que le journal du lecteur et celui du serveur en disent.
 * La semaine (7) suit « Effacer les alertes » ; les trente jours passent `clearedAt = 0` — c'est de
 * l'historique, pas une alerte.
 */
function signalsForDays(days: number, now: number, clearedAt: number): WeekSignals {
  const since = now - days * DAY;
  // Les séances et le temps regardé restent ceux de la période ; seuls les incidents et les erreurs
  // effacés ne se comptent plus (`alertsCleared.ts`).
  const seances = acknowledgeSeances(buildSeances(readRecords("player", since)).filter((s) => s.start >= since), clearedAt);
  const perDay = lastLocalDays(now, days).map(({ day, start, end }) => {
    const of = seances.filter((s) => s.start >= start && s.start < end);
    return { day, seances: of.length, problems: of.reduce((n, s) => n + problemsOf(s), 0) };
  });
  return signalsOf(tallySignals(seances, serverRecordsSince(since), clearedAt), since, perDay);
}

/** Le bilan de la semaine : ce que le journal du lecteur et celui du serveur en disent. */
export function weekSignals(now = Date.now(), clearedAt = alertsClearedAt()): WeekSignals {
  return signalsForDays(7, now, clearedAt);
}

/** Les trente derniers jours, alertes effacées comprises. */
export function monthSignals(now = Date.now()): WeekSignals {
  return signalsForDays(30, now, 0);
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

export async function accountDetail(id: string, now = Date.now(), clearedAt = alertsClearedAt()) {
  const users = await jellyfin.getUsers().catch(() => [] as JellyfinUser[]);
  const user = users.find((u) => u.Id === id);
  if (!user) return null;
  const name = user.Name;
  const lower = name.toLowerCase();

  // Tout en parallèle, « À suivre » compris : il partait après les neuf autres, 50 ms de plus en
  // série (13/10/2026). Les appareils viennent du cache d'une minute — voir `listAccounts`.
  const [sessions, devices, resume, recentMovies, recentEpisodes, favorites, playedMovies, playedEpisodes, requests, nextUp] = await Promise.all([
    part(jellyfin.getSessions()),
    part(cachedJellyfinDevices()),
    part(jellyfin.getResumeItems(id).then((r) => (r.Items as JellyfinItemLike[]).map(mediaEntry))),
    part(jellyfin.getRecentlyPlayed(id, "Movie", 25).then((r) => (r.Items as JellyfinItemLike[]).map(mediaEntry))),
    part(jellyfin.getRecentlyPlayed(id, "Episode", 25).then((r) => (r.Items as JellyfinItemLike[]).map(mediaEntry))),
    part(jellyfin.getFavorites(id).then((items) => (items as JellyfinItemLike[]).map(mediaEntry))),
    part(jellyfin.getPlayedCount(id, "Movie").then((r) => r.TotalRecordCount)),
    part(jellyfin.getPlayedCount(id, "Episode").then((r) => r.TotalRecordCount)),
    part(requestsOf(id)),
    part(jellyfin.getNextUpGlobal(id, 12).then((items) => (items as unknown as JellyfinItemLike[]).map(mediaEntry))),
  ]);

  const historyStart = now - ACCOUNT_HISTORY_DAYS * DAY;
  // Ses séances restent toutes listées ; celles d'avant l'effacement ne colorent plus rien.
  const seances = acknowledgeSeances(
    buildSeances(readRecords("player", historyStart)).filter((s) => s.user.toLowerCase() === lower && s.start >= historyStart),
    clearedAt
  );
  const errors = readRecords("server", historyStart)
    .filter((r) => isError(r) && String(r.user ?? "").toLowerCase() === lower)
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
      lastActivity: serverSeenAt(user, devices.ok ? devices.value : null),
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
      watchedSeconds: seances.reduce((n, s) => n + (s.watched ?? 0), 0),
      weekSeances: week.length,
      weekWatchedSeconds: week.reduce((n, s) => n + (s.watched ?? 0), 0),
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
export function recentSeances(limit = 20, now = Date.now(), clearedAt = alertsClearedAt()): Seance[] {
  return acknowledgeSeances(buildSeances(readRecords("player", now - 30 * DAY)).slice(0, limit), clearedAt);
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
      watchedSeconds: list.reduce((n, s) => n + (s.watched ?? 0), 0),
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
    heatmap[day][d.getHours()] += s.watched ?? 60;
    const key = workTitle(s.title);
    const t = titles.get(key) ?? { title: key, seances: 0, watchedSeconds: 0 };
    t.seances += 1;
    t.watchedSeconds += s.watched ?? 0;
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

/**
 * Les clés de tous les titres en échec sur trente jours, affichés ou non — « Tout effacer » vide la
 * liste au lieu de faire monter les suivants (relu le 06/10/2026 : deux titres remontaient).
 */
export function failingTitleKeys(now = Date.now()): string[] {
  const since = now - 30 * DAY;
  const seances = buildSeances(readRecords("player", since)).filter((s) => s.start >= since);
  return diagnoseTitles(seances, Number.POSITIVE_INFINITY).map((d) => d.key);
}

/** Le foyer sur trente jours : appareils, habitudes, connexions et notifications. */
export function household(now = Date.now(), clearedAt = alertsClearedAt()) {
  const since = now - 30 * DAY;
  const seances = buildSeances(readRecords("player", since)).filter((s) => s.start >= since);
  const fresh = afterClear(clearedAt);
  const auth = readRecords("auth", since).filter((r) => r._t >= since);
  const notifications = readRecords("notifications", since).filter((r) => r._t >= since);
  const recipients = notifications.flatMap((r) => (Array.isArray(r.recipients) ? (r.recipients as Record<string, number>[]) : []));
  return {
    days: 30,
    devices: qualityByDevice(acknowledgeSeances(seances, clearedAt)),
    habits: habitsOf(seances),
    // Le titre ou l'appareil : les réussites de la période comptent autant que les échecs, ce sont
    // elles qui innocentent l'un ou l'autre.
    // Sans les titres effacés par l'administrateur (`diagnosisCleared.ts`) : on en demande davantage
    // au classement, pour que l'effacement fasse place aux suivants au lieu de raccourcir la liste.
    // Le diagnostic garde toutes les séances — une réussite innocente un titre ou un appareil —, mais
    // un titre dont le dernier échec précède l'effacement général sort de la liste.
    diagnosis: withoutCleared(diagnoseTitles(seances, 60), clearedDiagnosis())
      .filter((d) => d.lastFailure > clearedAt)
      .slice(0, 12),
    logins: {
      ok: auth.filter((r) => r.kind === "login").length,
      failed: auth.filter((r) => r.kind === "login-failed" && fresh(r)).length,
      recentFailures: auth
        .filter((r) => r.kind === "login-failed" && fresh(r))
        .slice(-10)
        .reverse()
        .map((r) => ({ at: r._t, user: String(r.user ?? "?"), reason: r.reason ?? null, device: r.device ?? null, ip: r.ip ?? null })),
    },
    notifications: {
      sent: notifications.length,
      delivered: recipients.reduce((n, x) => n + (Number(x.sent) || 0), 0),
      failed: notifications
        .filter(fresh)
        .flatMap((r) => (Array.isArray(r.recipients) ? (r.recipients as Record<string, number>[]) : []))
        .reduce((n, x) => n + (Number(x.failed) || 0) + (Number(x.removed) || 0), 0),
      byCategory: [...notifications.reduce((m, r) => m.set(String(r.category ?? "?"), (m.get(String(r.category ?? "?")) ?? 0) + 1), new Map<string, number>())]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count),
    },
  };
}
