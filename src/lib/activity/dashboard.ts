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
import { aiCostStats, utcDay, type AiCostStats } from "@/lib/activity/aiCost";
import { aiUsageStats, type AiUsageStats } from "@/lib/activity/aiUsage";
import { aiBudget } from "@/lib/aiFeatures";
import { spendDb } from "@/lib/subtitleGen/store";
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
  /**
   * Menées au bout : une fin atteinte (`ended`) ou l'épisode suivant enchaîné (`why: next`), sur les
   * séances qui ont un bilan. `abandoned` : les titres le plus souvent quittés avant dix minutes.
   */
  completion: { finished: number; closed: number; abandoned: { title: string; itemId: string | null; count: number }[] };
  /** Les séries en cours, par spectateur : le dernier épisode vu et combien d'épisodes sur la période. */
  series: { user: string; series: string; itemId: string | null; last: string; lastAt: number; episodes: number }[];
  /** D'où le lecteur a lu ses octets, en Mo : la réserve en mémoire, l'appareil (reprise), le réseau. */
  reads: { reserveMB: number; deviceMB: number; networkMB: number; withReserve: number };
  /** `linkMbps` / `needMbps` : médianes du débit mesuré et de celui qu'exigeaient ses fichiers. */
  people: { user: string; seances: number; watchedSeconds: number; linkMbps: number | null; needMbps: number | null }[];
}

/** Les chiffres d'une période sans ses répartitions : la période d'avant, pour les écarts. */
export type PeriodTotals = Omit<PeriodStats, "devices" | "titles" | "people" | "series" | "reads">;

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
  /**
   * Le taux sans accroc depuis la plus récente version qui a déjà dix séances — « depuis la 10.16 :
   * 96 % » sous le chiffre (07/11/2026). `null` sans version assez vue.
   */
  sinceVersion: { version: string; seances: number; clean: number } | null;
  /** Trente jours, du plus ancien au plus récent. */
  series: { day: string; seances: number; watchedSeconds: number; real: number }[];
  /** Le temps regardé sur trente jours, par heure de la journée (heure du foyer). */
  hours: number[];
  describe: DescribeStats;
  /** Ce que coûtent les fonctions d'IA payantes, lu de la source du plafond (10.28.0, `aiCost.ts`, §140). */
  aiCost: AiCostStats;
  /** Sept jours d'acteurs à l'écran, de questions et de « Jusqu'ici » (11/11/2026, `aiUsage.ts`). */
  aiUsage: AiUsageStats;
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

/**
 * La durée de chaque titre, en secondes, gardée tant que le serveur vit (sur `globalThis`, comme les
 * séances) : le lecteur de l'application n'écrit pas la durée dans son bilan, seulement la position
 * d'arrêt. `null` : Jellyfin ne la connaît pas.
 */
const runtimes = ((globalThis as Record<symbol, unknown>)[Symbol.for("cine-app.activityRuntimes")] ??= new Map<string, number | null>()) as Map<string, number | null>;

/** Demande à Jellyfin les durées qui manquent, par lots ; ne lève jamais. */
export async function ensureRuntimes(itemIds: Iterable<string | null>): Promise<void> {
  const missing = [...new Set([...itemIds].filter((id): id is string => !!id && !runtimes.has(id)))];
  if (!missing.length) return;
  const { jellyfin } = await import("@/lib/clients/jellyfin");
  for (let i = 0; i < missing.length; i += 80) {
    const batch = missing.slice(i, i + 80);
    try {
      const got = await jellyfin.getItemsRunTimeTicks(batch);
      for (const id of batch) {
        const ticks = got.get(id);
        runtimes.set(id, ticks ? ticks / 1e7 : null);
      }
    } catch {
      return;
    }
  }
}

/**
 * Menée au bout : la fin atteinte, l'épisode suivant enchaîné, ou arrêtée après 90 % de la durée — le
 * générique d'un film en prend souvent dix minutes, et qui le ferme a bien vu le film (07/11/2026 : 41 %
 * « menées au bout » avec la seule fin atteinte).
 */
export function isFinished(s: Seance): boolean {
  if (!s.stop) return false;
  if (s.stop.ended || s.stop.why === "next") return true;
  const runtime = s.itemId ? runtimes.get(s.itemId) : null;
  return !!runtime && s.stop.at !== null && s.stop.at >= runtime * 0.9;
}

export function periodStats(seances: readonly Seance[]): PeriodStats {
  const viewers = new Set<string>();
  const opens: number[] = [];
  const devices = new Map<string, PeriodStats["devices"][number]>();
  const titles = new Map<string, PeriodStats["titles"][number]>();
  const people = new Map<string, PeriodStats["people"][number]>();
  const links = new Map<string, { link: number[]; need: number[] }>();
  const fromDevice: number[] = [];
  const abandoned = new Map<string, { title: string; itemId: string | null; count: number }>();
  const series = new Map<string, PeriodStats["series"][number]>();
  const fromNetwork: number[] = [];
  const out: PeriodStats = {
    seances: 0, viewers: 0, watchedSeconds: 0, clean: 0, real: 0,
    handled: { recovered: 0, planned: 0, slowLinks: 0, network: 0, background: 0 },
    openMedianMs: null, openP90Ms: null, openDeviceMs: null, openNetworkMs: null, waits: 0, waitedMs: 0, seeks: 0, slowSeeks: 0,
    paths: { natif: 0, serveur: 0, tv: 0, horsLigne: 0 },
    completion: { finished: 0, closed: 0, abandoned: [] },
    series: [],
    reads: { reserveMB: 0, deviceMB: 0, networkMB: 0, withReserve: 0 },
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
    if (s.stop && s.stop.why !== "lost") {
      out.completion.closed += 1;
      const finished = isFinished(s);
      if (finished) out.completion.finished += 1;
      else if (watched < 600) {
        const a = abandoned.get(work.title.toLowerCase()) ?? { title: work.title, itemId: s.itemId, count: 0 };
        a.count += 1;
        abandoned.set(work.title.toLowerCase(), a);
      }
    }
    if (work.episode) {
      const key = `${user.toLowerCase()}|${work.title.toLowerCase()}`;
      const ep = /— (S\d+E\d+)/.exec(s.title)?.[1] ?? "";
      // Les séances arrivent les plus récentes d'abord : la première vue est le dernier épisode.
      const e = series.get(key) ?? { user, series: work.title, itemId: s.itemId, last: ep, lastAt: s.start, episodes: 0 };
      e.episodes += 1;
      series.set(key, e);
    }
    if (s.readMB) {
      out.reads.reserveMB += s.readMB.reserve;
      out.reads.deviceMB += s.readMB.device;
      out.reads.networkMB += s.readMB.network;
      if (s.readMB.reserve > 0) out.reads.withReserve += 1;
    }
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
  out.completion.abandoned = [...abandoned.values()].filter((a) => a.count > 1).sort((a, b) => b.count - a.count).slice(0, 5);
  out.series = [...series.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, 10);
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
 * Le coût des fonctions d'IA (§140, 10.28.0) : la source même du plafond — le mois (`aiBudget`) et les journées
 * par fonction (`ai_spend_days`) —, jamais un second calcul.
 */
/** Sept jours d'usage des fonctions de la séance (`aiUsage.ts`) — les journaux déjà lus, rien de plus. */
export function aiUsageOf(now = Date.now()): AiUsageStats {
  const since = now - 7 * DAY;
  return aiUsageStats(readRecords("player", since), readRecords("search", since), since);
}

export function aiCostOf(now = Date.now()): AiCostStats {
  return aiCostStats(spendDb.days(utcDay(now, 29)), aiBudget(now), now);
}

/**
 * Une erreur du serveur qui demande une main. Pas un avertissement (`warn` : une relance réussie, un
 * service tiers qui a répondu 503 une fois — 1 800 lignes de Google Books en une semaine, le 07/11/2026),
 * pas un EPUB illisible (`EpubDefectError` : caché du catalogue comme prévu, §127), pas une page ouverte
 * pendant un déploiement, ni un geste de l'administrateur.
 */
export function isAlarmingServerLine(r: LogRecord): boolean {
  if (r.level !== "error" || r.scope === "admin" || r.scope === "client" || r.scope === "jellyfin-token") return false;
  // `books/meta` ne journalise que des EPUB illisibles, cachés du catalogue comme prévu. Par la portée et
  // non par la pile : le lecteur des journaux retire `stack` des lignes (`HEAVY_FIELDS`), et le filtre
  // sur la pile laissait passer chacune (revue du 08/11/2026).
  if (r.scope === "books/meta") return false;
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
  // Une notification non remise : un vrai échec d'envoi. Un abonnement que le service déclare mort (404/410) est
  // retiré, c'est le ménage d'un appareil disparu, pas un souci à gérer (10/11/2026).
  const failedNotifs = readRecords("notifications", since).filter(
    (r) => r._t > since && (Array.isArray(r.recipients) ? (r.recipients as Record<string, unknown>[]) : []).some((x) => Number(x.failed) > 0)
  );
  const summary = (list: LogRecord[]) => (list.length ? { count: list.length, lastAt: Math.max(...list.map((r) => r._t)) } : null);
  return {
    server: [...server.values()].sort((a, b) => b.count - a.count),
    logins: summary(failedLogins),
    notifications: summary(failedNotifs),
  };
}

function totalsOf(stats: PeriodStats): PeriodTotals {
  const { devices: _d, titles: _t, people: _p, series: _s, reads: _r, ...rest } = stats;
  void [_d, _t, _p, _s, _r];
  return { ...rest, completion: { ...rest.completion, abandoned: [] } };
}

/**
 * Les versions vues pour la première fois ces trente jours, au jour de leur première ligne — les traits
 * de la courbe. Une version déjà là au début de la fenêtre n'en a pas : elle n'est pas « arrivée » ici.
 */
export function releasesSince(since: number): { day: string; version: string }[] {
  // Seulement les versions qui changent le deuxième chiffre (10.14 → 10.15) : avec une version par
  // correctif, il y avait un trait derrière presque chaque barre (revue du 08/11/2026). Et une version
  // plus ancienne que la plus récente déjà vue n'est pas une arrivée : c'est un onglet resté ouvert.
  const parse = (v: string) => v.split(".").map((n) => Number(n) || 0);
  const newer = (a: number[], b: number[]) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
  const out: { day: string; version: string }[] = [];
  let best: number[] | null = null;
  let earliest = Number.POSITIVE_INFINITY;
  const lines = readRecords("player", since).filter((r) => r._t >= since && !r.bench && typeof r.version === "string");
  for (const r of lines) if (r._t < earliest) earliest = r._t;
  for (const r of [...lines].sort((a, b) => a._t - b._t)) {
    const v = parse(r.version as string);
    if (!best) {
      best = v;
      continue;
    }
    if (newer(v, best)) {
      best = v;
      // Une version déjà là au début de la fenêtre n'est pas « arrivée » ici.
      if (r._t > earliest + 6 * 3600_000) out.push({ day: localDay(new Date(r._t)), version: `${v[0]}.${v[1]}` });
    }
  }
  return out;
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

/**
 * Les séances ouvertes par une version arrivée ces trente jours ou une suivante, depuis la plus
 * récente qui en compte au moins dix : assez pour qu'un taux veuille dire quelque chose.
 */
export function sinceVersionOf(seances: readonly Seance[], releases: readonly { version: string }[]): Dashboard["sinceVersion"] {
  for (let i = releases.length - 1; i >= 0; i--) {
    const versions = new Set(releases.slice(i).map((r) => r.version));
    const of = seances.filter((s) => s.version && versions.has(s.version));
    if (of.length >= 10) return { version: releases[i].version, seances: of.length, clean: of.filter((s) => problemsOf(s) === 0).length };
  }
  return null;
}

export function dashboard(now = Date.now(), clearedAt = 0): Dashboard {
  // Les incidents d'avant « Effacer les alertes » ne comptent sur aucune période (07/11/2026) ; les
  // séances et le temps regardé restent.
  const sixty = acknowledgeSeances(seancesSince(now - 60 * DAY, now), clearedAt);
  const month = sixty.filter((s) => s.start >= now - 30 * DAY);
  const between = (from: number, to: number) => sixty.filter((s) => s.start >= now - from && s.start < now - to);
  const releases = safe(() => releasesSince(now - 30 * DAY), []);
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
  const aiCost = safe(() => aiCostOf(now), aiCostStats([], { spent: 0, cap: 0 }, now));
  const aiUsage = safe(() => aiUsageOf(now), aiUsageStats([], [], now));
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
    releases,
    sinceVersion: sinceVersionOf(month, releases),
    series,
    hours,
    describe,
    aiCost,
    aiUsage,
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

export interface RequestStats {
  /** Demandes de l'ensemble résumé. */
  requested: number;
  available: number;
  /** Regardées par la personne qui les a faites, après la demande. */
  watched: number;
  /** Médiane du délai entre la demande et le premier visionnage par son auteur. */
  medianDelayMs: number | null;
  recent: RequestRow[];
  /** Toutes les demandes lues — pour en tirer celles d'un compte ou d'une période. */
  all: RequestRow[];
}

export interface RequestRow {
  title: string;
  requester: string;
  /** Les noms sous lesquels on reconnaît l'auteur (Jellyfin, Seerr, affiché), en minuscules. */
  names: string[];
  createdAt: number;
  available: boolean;
  watchedAt: number | null;
}

/** Le bilan d'un ensemble de demandes — toutes, celles d'un compte, ou celles d'une période. */
export function summarizeRequests(rows: readonly RequestRow[]): RequestStats {
  const delays = rows.filter((r) => r.watchedAt !== null).map((r) => (r.watchedAt as number) - r.createdAt);
  return {
    requested: rows.length,
    available: rows.filter((r) => r.available).length,
    watched: delays.length,
    medianDelayMs: quantile(delays, 0.5),
    recent: [...rows].sort((a, b) => b.createdAt - a.createdAt),
    all: [...rows],
  };
}

/**
 * Les demandes (Jellyseerr) et ce qu'il en advient : arrivées, regardées par qui les a faites, et en
 * combien de temps (07/11/2026). Une demande et une séance se rejoignent par TMDB — le film de la
 * séance par la fiche Jellyfin, l'épisode par sa série — jamais par le titre, que Radarr et Jellyfin
 * n'écrivent pas pareil. Une demande compte pour son auteur sous son nom Jellyfin, Seerr ou affiché.
 */
export async function requestStats(now = Date.now()): Promise<RequestStats> {
  const [{ jellyseerr }, { cachedJellyfinMoviesAdmin, cachedJellyfinSeriesAdmin }, { enrichRequests }] = await Promise.all([
    import("@/lib/clients/jellyseerr"),
    import("@/lib/server-cache"),
    import("@/lib/jellyseerr-enrich"),
  ]);
  const [{ results }, movies, shows] = await Promise.all([
    jellyseerr.getRecentRequests(200),
    cachedJellyfinMoviesAdmin().catch(() => []),
    cachedJellyfinSeriesAdmin().catch(() => []),
  ]);
  const tmdbOf = (ids: Record<string, string> | undefined) => {
    for (const [k, v] of Object.entries(ids ?? {})) if (k.toLowerCase() === "tmdb" && v) return v;
    return null;
  };
  const movieKey = new Map<string, string>();
  for (const m of movies as { Id: string; ProviderIds?: Record<string, string> }[]) {
    const id = tmdbOf(m.ProviderIds);
    if (id) movieKey.set(m.Id, `movie:${id}`);
  }
  const seriesKey = new Map<string, string>();
  for (const sh of shows as { Name?: string; ProviderIds?: Record<string, string> }[]) {
    const id = tmdbOf(sh.ProviderIds);
    if (id && sh.Name) seriesKey.set(sh.Name.toLowerCase(), `tv:${id}`);
  }
  const keyOfSeance = (x: Seance): string | null => {
    const work = workOf(x.title);
    if (work.episode) return seriesKey.get(work.title.toLowerCase()) ?? null;
    return x.itemId ? (movieKey.get(x.itemId) ?? null) : null;
  };
  const oldest = results.reduce((m, r) => Math.min(m, Date.parse(r.createdAt) || now), now);
  const seances = seancesSince(Math.min(now - 60 * DAY, oldest), now);
  const firstWatch = new Map<string, number>();
  for (const x of seances) {
    const key = keyOfSeance(x);
    if (!key) continue;
    const k = `${key}|${x.user.toLowerCase()}`;
    if (!firstWatch.has(k) || x.start < (firstWatch.get(k) as number)) firstWatch.set(k, x.start);
  }
  // Toutes les demandes lues (les deux cents dernières) : l'écran les découpe selon la période choisie.
  const enriched = await enrichRequests(results).catch(() => results);
  const rows: RequestRow[] = enriched.map((r) => {
    const createdAt = Date.parse(r.createdAt);
    const key = r.media.tmdbId ? `${r.media.mediaType === "tv" ? "tv" : "movie"}:${r.media.tmdbId}` : null;
    const who = r.requestedBy as { displayName?: string; username?: string; jellyfinUsername?: string };
    const names = [who.jellyfinUsername, who.username, who.displayName].filter((n): n is string => !!n).map((n) => n.toLowerCase());
    let watchedAt: number | null = null;
    for (const n of names) {
      const t = key ? firstWatch.get(`${key}|${n}`) : undefined;
      if (t !== undefined && t >= createdAt && (watchedAt === null || t < watchedAt)) watchedAt = t;
    }
    return {
      title: r.media.title ?? "?",
      requester: who.displayName ?? who.username ?? "?",
      names,
      createdAt,
      available: (r.media.status ?? 0) >= 4,
      watchedAt,
    };
  });
  return summarizeRequests(rows);
}

/** Les demandes, gardées cinq minutes : Seerr n'a pas à répondre à chaque relecture. */
export async function cachedRequestStats(now = Date.now()): Promise<RequestStats | null> {
  const { withCache } = await import("@/lib/server-cache");
  return withCache("activity:requests", 5 * 60_000, () => requestStats(now)).catch(() => null);
}

/** Les demandes d'un compte, d'après son nom Jellyfin. */
export function requestsOfUser(stats: RequestStats | null, name: string): RequestStats | null {
  if (!stats) return null;
  const lower = name.toLowerCase();
  return summarizeRequests(stats.all.filter((r) => r.names.includes(lower)));
}
