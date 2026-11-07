// Le tableau de bord de l'Activité (07/11/2026) : ce que les séances des trente derniers jours disent,
// en chiffres prêts à dessiner — une seule construction des séances (`seancesSince`), plusieurs
// lectures.
//
// Né de la refonte demandée ce jour-là : la vue d'ensemble empilait des encadrés, mettait en avant des
// « erreurs » que le lecteur avait gérées comme prévu (reconstruction rattrapée, bascule sur la
// version allégée, lecteur serveur pour un fichier qu'un appareil ne lit pas), et ne disait ni le
// taux de séances sans accroc, ni les chemins pris, ni les heures regardées jour par jour.

import { readRecords, type LogRecord } from "@/lib/activity/logReader";
import { acknowledgeSeances, dismissedIssues } from "@/lib/activity/alertsCleared";
import { lastLocalDays, localDay, problemsOf, seancesSince } from "@/lib/activity/accounts";
import type { Seance } from "@/lib/activity/seances";

const DAY = 24 * 60 * 60 * 1000;

export interface PeriodStats {
  seances: number;
  viewers: number;
  watchedSeconds: number;
  /** Séances sans vrai incident (`problemsOf`) — le taux affiché. */
  clean: number;
  /** Vrais incidents, toutes séances. */
  real: number;
  /** Ce que le lecteur a géré seul, par sorte. */
  handled: { recovered: number; planned: number; slowLinks: number; network: number; background: number };
  /** Temps d'ouverture : médiane et 90e centile, en ms — `null` sans mesure. */
  openMedianMs: number | null;
  openP90Ms: number | null;
  /** Médiane d'ouverture selon l'origine des premiers octets : l'appareil (reprise instantanée) ou le réseau. */
  openDeviceMs: number | null;
  openNetworkMs: number | null;
  waits: number;
  waitedMs: number;
  seeks: number;
  slowSeeks: number;
  /** Les chemins pris. `tv` : une diffusion établie, quel que soit le lecteur. */
  paths: { natif: number; serveur: number; tv: number; horsLigne: number };
  devices: { label: string; seances: number; watchedSeconds: number; real: number }[];
  titles: { title: string; itemId: string | null; episode: boolean; seances: number; watchedSeconds: number }[];
  /** `linkMbps` / `needMbps` : médianes du débit mesuré et de celui qu'exigeaient ses fichiers. */
  people: { user: string; seances: number; watchedSeconds: number; linkMbps: number | null; needMbps: number | null }[];
}

/** Les chiffres d'une période sans ses répartitions : la période d'avant, pour les écarts. */
export type PeriodTotals = Omit<PeriodStats, "devices" | "titles" | "people">;

/** Une ligne du fil filtré (`feedOf`). */
export interface FeedFilter {
  period: "day" | "week" | "month";
  day?: string;
  hour?: number;
  device?: string;
  title?: string;
  path?: "natif" | "serveur" | "tv" | "horsLigne";
  user?: string;
}

export interface DescribeStats {
  searches: number;
  modelCalls: number;
  medianMs: number | null;
  accounts: number;
  errors: number;
}

export interface Alarms {
  /** Les vraies erreurs du serveur, par portée, avec la dernière. */
  server: { scope: string; count: number; lastAt: number }[];
  logins: { count: number; lastAt: number } | null;
  notifications: { count: number; lastAt: number } | null;
}

export interface Dashboard {
  periods: { day: PeriodStats; week: PeriodStats; month: PeriodStats };
  /** Les mêmes chiffres sur la période d'avant (les 24 h d'avant, les 7 jours d'avant, les 30 d'avant). */
  previous: { day: PeriodTotals; week: PeriodTotals; month: PeriodTotals };
  /** Les versions apparues dans le journal du lecteur ces trente jours, au jour de leur première ligne. */
  releases: { day: string; version: string }[];
  /** Trente jours, du plus ancien au plus récent. */
  series: { day: string; seances: number; watchedSeconds: number; real: number }[];
  /** Le temps regardé sur trente jours, par heure de la journée (heure du foyer). */
  hours: number[];
  describe: DescribeStats;
  /** Les lignes de « À gérer » qui viennent des journaux du serveur, d'après l'effacement. */
  alarms: Alarms;
  /** Les lignes effacées une à une — `alertsCleared.ts`. */
  dismissed: Record<string, number>;
}

function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

/** Le nom de l'œuvre : « Ted Lasso — S04E01 · … » → « Ted Lasso ». */
function workOf(title: string): { title: string; episode: boolean } {
  const cut = title.indexOf(" — S");
  return cut > 0 ? { title: title.slice(0, cut), episode: true } : { title, episode: false };
}

function top<T extends { watchedSeconds: number; seances: number }>(map: Map<string, T>, n: number): T[] {
  return [...map.values()].sort((a, b) => b.watchedSeconds - a.watchedSeconds || b.seances - a.seances).slice(0, n);
}

export function periodStats(seances: readonly Seance[]): PeriodStats {
  const viewers = new Set<string>();
  const opens: number[] = [];
  const devices = new Map<string, PeriodStats["devices"][number]>();
  const titles = new Map<string, PeriodStats["titles"][number]>();
  const people = new Map<string, PeriodStats["people"][number]>();
  const links = new Map<string, { link: number[]; need: number[] }>();
  const fromDevice: number[] = [];
  const fromNetwork: number[] = [];
  const out: PeriodStats = {
    seances: 0, viewers: 0, watchedSeconds: 0, clean: 0, real: 0,
    handled: { recovered: 0, planned: 0, slowLinks: 0, network: 0, background: 0 },
    openMedianMs: null, openP90Ms: null, openDeviceMs: null, openNetworkMs: null, waits: 0, waitedMs: 0, seeks: 0, slowSeeks: 0,
    paths: { natif: 0, serveur: 0, tv: 0, horsLigne: 0 },
    devices: [], titles: [], people: [],
  };
  for (const s of seances) {
    const watched = s.watched ?? 0;
    const real = problemsOf(s);
    out.seances += 1;
    out.watchedSeconds += watched;
    out.real += real;
    if (real === 0) out.clean += 1;
    out.handled.recovered += s.recovered ?? 0;
    out.handled.planned += s.planned ?? 0;
    out.handled.slowLinks += s.slowLinks ?? 0;
    out.handled.network += s.netStalls ?? 0;
    out.handled.background += s.backgroundRebuilds;
    out.waits += s.stop?.waits ?? 0;
    out.waitedMs += s.stop?.waitedMs ?? 0;
    out.seeks += s.seeks;
    out.slowSeeks += s.slowSeeks;
    if (s.openedMs !== null && s.openedMs > 0 && s.openedMs < 120_000) {
      opens.push(s.openedMs);
      if (s.openedFrom === "appareil" || s.openedFrom === "mémoire") fromDevice.push(s.openedMs);
      else if (s.openedFrom === "réseau" || s.openedFrom === "mixte") fromNetwork.push(s.openedMs);
    }
    if (s.onTv) out.paths.tv += 1;
    else if (s.player === "hors-ligne") out.paths.horsLigne += 1;
    else if (s.player === "serveur") out.paths.serveur += 1;
    else out.paths.natif += 1;
    const user = s.user;
    viewers.add(user.toLowerCase());
    const p = people.get(user.toLowerCase()) ?? { user, seances: 0, watchedSeconds: 0, linkMbps: null, needMbps: null };
    const l = links.get(user.toLowerCase()) ?? { link: [], need: [] };
    if (s.linkMbps) l.link.push(s.linkMbps);
    if (s.needMbps) l.need.push(s.needMbps);
    links.set(user.toLowerCase(), l);
    p.seances += 1;
    p.watchedSeconds += watched;
    people.set(user.toLowerCase(), p);
    const label = s.device ?? "?";
    const d = devices.get(label) ?? { label, seances: 0, watchedSeconds: 0, real: 0 };
    d.seances += 1;
    d.watchedSeconds += watched;
    d.real += real;
    devices.set(label, d);
    const work = workOf(s.title);
    const tKey = work.title.toLowerCase();
    // L'affiche : celle de la séance la plus récente (les séances arrivent les plus récentes d'abord) ;
    // pour une série, un épisode — l'affiche d'épisode est celle que Jellyfin a pour cet identifiant.
    const tt = titles.get(tKey) ?? { title: work.title, itemId: s.itemId, episode: work.episode, seances: 0, watchedSeconds: 0 };
    tt.seances += 1;
    tt.watchedSeconds += watched;
    titles.set(tKey, tt);
  }
  out.viewers = viewers.size;
  out.openMedianMs = quantile(opens, 0.5);
  out.openP90Ms = quantile(opens, 0.9);
  out.openDeviceMs = quantile(fromDevice, 0.5);
  out.openNetworkMs = quantile(fromNetwork, 0.5);
  for (const [k, p] of people) {
    const l = links.get(k);
    p.linkMbps = l ? quantile(l.link, 0.5) : null;
    p.needMbps = l ? quantile(l.need, 0.5) : null;
  }
  out.devices = top(devices, 8);
  out.titles = top(titles, 8);
  out.people = top(people, 12);
  return out;
}

/** Les recherches par description des sept derniers jours (`recherche.log`) — des chiffres, jamais de phrase. */
export function describeStats(now = Date.now()): DescribeStats {
  const since = now - 7 * DAY;
  const lines = readRecords("search", since).filter((r) => r._t >= since && r.kind === "description");
  const ms = lines.map((r) => (typeof r.ms === "number" ? r.ms : null)).filter((v): v is number => v !== null);
  return {
    searches: lines.length,
    modelCalls: lines.filter((r) => r.source === "modèle").length,
    medianMs: quantile(ms, 0.5),
    accounts: new Set(lines.map((r) => String(r.user ?? "").toLowerCase())).size,
    errors: lines.filter((r) => r.status === "erreur").length,
  };
}

/**
 * Une erreur du serveur qui demande une main. Pas un avertissement (`warn` : une relance réussie, un
 * service tiers qui a répondu 503 une fois — 1 800 lignes de Google Books en une semaine, le 07/11/2026),
 * pas un EPUB illisible (`EpubDefectError` : caché du catalogue comme prévu, §127), pas une page ouverte
 * pendant un déploiement, ni un geste de l'administrateur.
 */
export function isAlarmingServerLine(r: LogRecord): boolean {
  if (r.level !== "error" || r.scope === "admin" || r.scope === "client" || r.scope === "jellyfin-token") return false;
  return !String(r.stack ?? "").startsWith("EpubDefectError");
}

export function alarmsOf(now: number, clearedAt: number): Alarms {
  const since = Math.max(now - 7 * DAY, clearedAt);
  const server = new Map<string, { scope: string; count: number; lastAt: number }>();
  for (const r of readRecords("server", since)) {
    if (r._t <= since || !isAlarmingServerLine(r)) continue;
    const scope = String(r.scope ?? "?");
    const e = server.get(scope) ?? { scope, count: 0, lastAt: 0 };
    e.count += 1;
    e.lastAt = Math.max(e.lastAt, r._t);
    server.set(scope, e);
  }
  const failedLogins = readRecords("auth", since).filter((r) => r._t > since && r.kind === "login-failed");
  const failedNotifs = readRecords("notifications", since).filter(
    (r) => r._t > since && (Array.isArray(r.recipients) ? (r.recipients as Record<string, unknown>[]) : []).some((x) => Number(x.failed) > 0 || Number(x.removed) > 0)
  );
  const summary = (list: LogRecord[]) => (list.length ? { count: list.length, lastAt: Math.max(...list.map((r) => r._t)) } : null);
  return {
    server: [...server.values()].sort((a, b) => b.count - a.count),
    logins: summary(failedLogins),
    notifications: summary(failedNotifs),
  };
}

function totalsOf(stats: PeriodStats): PeriodTotals {
  const { devices: _d, titles: _t, people: _p, ...rest } = stats;
  void _d;
  void _t;
  void _p;
  return rest;
}

/**
 * Les versions vues pour la première fois ces trente jours, au jour de leur première ligne — les traits
 * de la courbe. Une version déjà là au début de la fenêtre n'en a pas : elle n'est pas « arrivée » ici.
 */
export function releasesSince(since: number): { day: string; version: string }[] {
  const first = new Map<string, number>();
  let earliest = Number.POSITIVE_INFINITY;
  for (const r of readRecords("player", since)) {
    if (r._t < since || r.bench) continue;
    if (r._t < earliest) earliest = r._t;
    const v = typeof r.version === "string" ? r.version : null;
    if (v && !first.has(v)) first.set(v, r._t);
  }
  return [...first]
    .filter(([, t]) => t > earliest + 6 * 3600_000)
    .sort((a, b) => a[1] - b[1])
    .map(([version, t]) => ({ day: localDay(new Date(t)), version }));
}

/** Le chemin d'une séance, dans les mots du tableau de bord. */
export function pathOf(s: Seance): NonNullable<FeedFilter["path"]> {
  return s.onTv ? "tv" : s.player === "hors-ligne" ? "horsLigne" : s.player === "serveur" ? "serveur" : "natif";
}

/**
 * Le fil des séances d'une période, filtré par ce qu'on a touché sur le tableau de bord : un jour, une
 * heure, un appareil, un titre, un chemin, un compte. 60 séances au plus, les plus récentes d'abord.
 */
export function feedOf(f: FeedFilter, now = Date.now(), clearedAt = 0): Seance[] {
  const span = f.period === "day" ? DAY : f.period === "week" ? 7 * DAY : 30 * DAY;
  // Un jour se lit où qu'il soit dans l'historique (la courbe remonte au-delà de trente jours) ; une
  // heure, sur les trente jours de sa courbe.
  const dayStart = f.day !== undefined ? new Date(`${f.day}T00:00:00`).getTime() : NaN;
  const since = Number.isFinite(dayStart) ? Math.min(now - span, dayStart - DAY) : f.hour !== undefined ? now - 30 * DAY : now - span;
  return acknowledgeSeances(seancesSince(since, now), clearedAt)
    .filter((s) => f.day === undefined || localDay(new Date(s.start)) === f.day)
    .filter((s) => f.hour === undefined || new Date(s.start).getHours() === f.hour)
    .filter((s) => f.device === undefined || (s.device ?? "?") === f.device)
    .filter((s) => f.title === undefined || workOf(s.title).title.toLowerCase() === f.title.toLowerCase())
    .filter((s) => f.path === undefined || pathOf(s) === f.path)
    .filter((s) => f.user === undefined || s.user.toLowerCase() === f.user.toLowerCase())
    .slice(0, 60);
}

export function dashboard(now = Date.now(), clearedAt = 0): Dashboard {
  // Les incidents d'avant « Effacer les alertes » ne comptent sur aucune période (07/11/2026) ; les
  // séances et le temps regardé restent.
  const sixty = acknowledgeSeances(seancesSince(now - 60 * DAY, now), clearedAt);
  const month = sixty.filter((s) => s.start >= now - 30 * DAY);
  const between = (from: number, to: number) => sixty.filter((s) => s.start >= now - from && s.start < now - to);
  const days = lastLocalDays(now, 30);
  const series = days.map(({ day, start, end }) => {
    const of = month.filter((s) => s.start >= start && s.start < end);
    return {
      day,
      seances: of.length,
      watchedSeconds: of.reduce((n, s) => n + (s.watched ?? 0), 0),
      real: of.reduce((n, s) => n + problemsOf(s), 0),
    };
  });
  const hours = Array.from({ length: 24 }, () => 0);
  for (const s of month) hours[new Date(s.start).getHours()] += s.watched ?? 0;
  let describe: DescribeStats;
  try {
    describe = describeStats(now);
  } catch {
    describe = { searches: 0, modelCalls: 0, medianMs: null, accounts: 0, errors: 0 };
  }
  return {
    periods: {
      day: periodStats(month.filter((s) => s.start >= now - DAY)),
      week: periodStats(month.filter((s) => s.start >= now - 7 * DAY)),
      month: periodStats(month),
    },
    previous: {
      day: totalsOf(periodStats(between(2 * DAY, DAY))),
      week: totalsOf(periodStats(between(14 * DAY, 7 * DAY))),
      month: totalsOf(periodStats(between(60 * DAY, 30 * DAY))),
    },
    releases: safe(() => releasesSince(now - 30 * DAY), []),
    series,
    hours,
    describe,
    alarms: safe(() => alarmsOf(now, clearedAt), { server: [], logins: null, notifications: null }),
    dismissed: safe(() => dismissedIssues(), {}),
  };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
