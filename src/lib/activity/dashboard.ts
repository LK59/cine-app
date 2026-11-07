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
import { lastLocalDays, problemsOf, seancesSince } from "@/lib/activity/accounts";
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
  waits: number;
  waitedMs: number;
  seeks: number;
  slowSeeks: number;
  /** Les chemins pris. `tv` : une diffusion établie, quel que soit le lecteur. */
  paths: { natif: number; serveur: number; tv: number; horsLigne: number };
  devices: { label: string; seances: number; watchedSeconds: number; real: number }[];
  titles: { title: string; itemId: string | null; episode: boolean; seances: number; watchedSeconds: number }[];
  people: { user: string; seances: number; watchedSeconds: number }[];
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
  const out: PeriodStats = {
    seances: 0, viewers: 0, watchedSeconds: 0, clean: 0, real: 0,
    handled: { recovered: 0, planned: 0, slowLinks: 0, network: 0, background: 0 },
    openMedianMs: null, openP90Ms: null, waits: 0, waitedMs: 0, seeks: 0, slowSeeks: 0,
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
    if (s.openedMs !== null && s.openedMs > 0 && s.openedMs < 120_000) opens.push(s.openedMs);
    if (s.onTv) out.paths.tv += 1;
    else if (s.player === "hors-ligne") out.paths.horsLigne += 1;
    else if (s.player === "serveur") out.paths.serveur += 1;
    else out.paths.natif += 1;
    const user = s.user;
    viewers.add(user.toLowerCase());
    const p = people.get(user.toLowerCase()) ?? { user, seances: 0, watchedSeconds: 0 };
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

export function dashboard(now = Date.now(), clearedAt = 0): Dashboard {
  // Les incidents d'avant « Effacer les alertes » ne comptent sur aucune période (07/11/2026) ; les
  // séances et le temps regardé restent.
  const month = acknowledgeSeances(seancesSince(now - 30 * DAY, now), clearedAt);
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
