"use client";

import { useEffect, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import {
  Activity,
  AlertTriangle,
  Bell,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  Clapperboard,
  Clock,
  Download,
  Gauge,
  Globe,
  Hourglass,
  KeyRound,
  Link2,
  ListTree,
  MessageSquareWarning,
  MonitorSmartphone,
  Radio,
  RefreshCw,
  Route,
  Search,
  ServerCrash,
  ShieldAlert,
  ShieldCheck,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  X,
  Stethoscope,
  Users,
  Wrench,
} from "lucide-react";
import { fetcher } from "@/lib/swr";
import { fmtTime } from "@/lib/format";
import { apiAction } from "@/lib/apiAction";
import { useToast } from "@/components/Toast";
import { ErrorState } from "@/components/StateViews";
import { useT } from "@/components/TranslationProvider";
import { AlertChip, Avatar, ConfirmButton, Panel, Poster, PresenceBadge, Progress, SeanceRow, Tile, ago, clock, hours, latest, reasonLabel, secs, uiLocale, type T } from "@/components/activity/parts";
import { Bars, Fold, KpiRow, PATH_COLORS, RankList, Segmented, StackBar, TitleRank, handledSum, pct, shortDay } from "@/components/activity/DashboardParts";
import type { AccountSummary, WeekSignals, household } from "@/lib/activity/accounts";
import type { Dashboard, FeedFilter, PeriodStats, RequestStats } from "@/lib/activity/dashboard";
import { isOwnAppName, isPlaybackClient } from "@/lib/playbackClients";
import { APP_NAME } from "@/lib/appBuild";
import { scrollBehavior } from "@/lib/reducedMotion";
import type { ReportSummary } from "@/lib/reports";
import { NOTIFICATION_CATEGORIES } from "@/lib/notifications";
import { ReportRowView } from "@/components/reports/ReportParts";
import { ADMIN_REPORTS_KEY } from "@/components/reports/reportCache";
import { DiagnosisPanel } from "@/components/activity/Diagnosis";
import { DeviceQualityList, Heatmap, AuthList } from "@/components/activity/insights";
import type { Seance } from "@/lib/activity/seances";
import { liveAccounts, pendingReports } from "@/lib/activity/summary";
import { ActivityLink, goTo, type ActivityView } from "@/components/activity/nav";
import { NEWS_ADMIN_KEY, NewsTiles, type NewsAdminData } from "@/components/activity/views/ActivityNews";
import { DOWNLOADS_ADMIN_KEY, DownloadsTiles } from "@/components/activity/views/ActivityDownloads";
import type { DownloadsOverview } from "@/lib/activity/offlineDownloads";
import { SharesTiles, type SharesOverview } from "@/components/activity/views/ActivityShares";
import { SHARE_ADMIN_KEY } from "@/components/share/shareClient";
import { AddressChangePanel } from "@/components/activity/AddressChange";
import { READINGS_ADMIN_KEY, ReadingsTiles, useBooksAvailable } from "@/components/activity/views/ActivityReadings";
import type { ReadingsOverview } from "@/lib/activity/readings";

// La vue d'ensemble de l'Activité, refaite le 07/11/2026 en tableau de bord : le direct en tête,
// les chiffres de la période, « À gérer » réduit aux vrais problèmes, les courbes et répartitions
// cliquables, puis les comptes et le fil ; le reste replié en sections qu'on ouvre au besoin. Elle
// reste montée sous les autres vues (`PlayerActivityPanel`) : `active` coupe ses relectures pendant
// qu'une autre vue la recouvre.

interface Overview {
  now: number;
  accounts: AccountSummary[];
  signals: WeekSignals;
  recent: Seance[];
  household: ReturnType<typeof household>;
  /** Absent d'une réponse d'avant le 07/11/2026 (onglet ouvert pendant le déploiement). */
  dashboard?: Dashboard;
  /** Les demandes et ce qu'il en advient — `null` quand Seerr ne répond pas. */
  requests?: RequestStats | null;
  /** La date d'effacement des alertes, 0 si rien n'est effacé — voir `alertsCleared.ts`. */
  alertsClearedAt: number;
  /** Depuis quand Jellyfin ne répond plus aux relevés de santé — `null` s'il répond (§92). */
  jellyfinDownSince?: number | null;
}

/** Le direct se relit souvent ; une vue cachée sous une autre ne se relit pas. */
const LIVE_REFRESH_MS = 10_000;
const DAY = 24 * 60 * 60 * 1000;

type PeriodKey = "day" | "week" | "month" | "all";

/**
 * « Effacer les alertes » : tout incident d'avant maintenant sort de toutes les statistiques, sur
 * toutes les périodes (09/10/2026, DECISIONS.md §59 ; définitif et pour toutes les périodes depuis le
 * 07/11/2026, §136). Les journaux restent intacts. Confirmé d'un second appui, comme les gestes du compte.
 */
function AlertsClearControl({ clearedAt, now }: { clearedAt: number; now: number }) {
  const t = useT();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const clear = async () => {
    try {
      await apiAction("/api/admin/activity/alerts", { method: "POST", body: JSON.stringify({ action: "clear" }) });
      // Toutes les vues du panneau en dépendent : la vue d'ensemble, les périodes, chaque fiche de compte.
      await mutate((key) => typeof key === "string" && key.startsWith("/api/admin/activity"));
      toast.success(t("activity.alerts.cleared"));
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t("common.error"));
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {clearedAt > 0 && <span className="text-xs text-subtle">{t("activity.alerts.clearedOn", { when: ago(clearedAt, now, t) })}</span>}
      <ConfirmButton label={t("activity.alerts.clear")} confirm={t("activity.alerts.clearConfirm")} onConfirm={clear} />
    </div>
  );
}

/**
 * Les signalements : ceux qui attendent (ouverts, en cours) en tête. Les réglés restent consultables
 * d'un geste, jamais supprimés.
 */
function ReportsList({ data, now }: { data: { reports: ReportSummary[] }; now: number }) {
  const t = useT();
  const [showDone, setShowDone] = useState(false);
  const pending = pendingReports(data.reports);
  const done = data.reports.filter((r) => r.status === "resolved" || r.status === "closed");
  const shown = showDone ? done : pending;
  return (
    <div>
      {shown.length ? (
        <div className="scrollbar-thin max-h-96 divide-y divide-white/5 overflow-y-auto">
          {shown.map((r) => (
            <ReportRowView key={r.id} r={r} showUser when={ago(r.sentAt, now, t)} onOpen={() => goTo({ kind: "report", id: r.id })} />
          ))}
        </div>
      ) : (
        <p className="px-4 py-6 text-sm text-subtle">{showDone ? t("activity.reports.noneDone") : t("activity.reports.none")}</p>
      )}
      {done.length > 0 && (
        <button type="button" onClick={() => setShowDone((v) => !v)} className="w-full border-t border-white/5 px-4 py-2.5 text-left text-xs text-accent-400 hover:underline">
          {showDone ? t("activity.reports.showPending") : t("activity.reports.showDone", { n: done.length })}
        </button>
      )}
    </div>
  );
}

function categoryLabel(id: string, t: T): string {
  const known = NOTIFICATION_CATEGORIES.find((c) => c.id === id);
  return known ? t(known.labelKey) : id;
}

function alertLabel(a: AccountSummary["alerts"][number], t: T, now: number): string {
  if (a.kind === "tokenRefused") return t("activity.alerts.tokenRefused");
  // Dit ce qu'on voit, avec depuis quand : l'application l'a vu cette semaine, Jellyfin non.
  if (a.kind === "tokenStale") return a.at ? t("activity.alerts.tokenStaleSince", { when: ago(a.at, now, t) }) : t("activity.alerts.tokenStaleNever");
  return t("activity.alerts.clientErrors", { n: a.count ?? 0 });
}

/** Le nom du client d'une lecture : Laterna, sous tous ses noms (`playbackClients.ts`), ou celui de l'autre client. */
function clientLabel(client: string | null): { laterna: boolean; label: string | null } {
  if (isPlaybackClient(client) || isOwnAppName(client)) return { laterna: true, label: APP_NAME };
  return { laterna: false, label: client };
}

/**
 * Ceux qui regardent en ce moment : l'affiche, où ils en sont, sur quoi, **par quoi** — Laterna et son
 * chemin (application, serveur, télévision, hors ligne), ou l'autre client que Jellyfin voit (Jellyfin
 * Web, Infuse…). Le « DirectPlay » que Jellyfin donne pour Laterna ne disait rien : il le voit toujours.
 */
function LiveCard({ a, now }: { a: AccountSummary; now: number }) {
  const t = useT();
  const playing = a.nowPlaying;
  const pingTitle = a.presence.playing?.title;
  return (
    <ActivityLink to={{ kind: "account", id: a.id }} className="card flex min-w-0 gap-3 p-3 transition-colors hover:bg-white/[0.05]">
      {playing ? <Poster itemId={playing.itemId} kind={playing.title.includes(" — S") ? "episode" : "movie"} className="h-[84px] w-14" /> : <Avatar name={a.name} size={44} />}
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            {playing && <Avatar name={a.name} size={20} />}
            <span className="truncate font-semibold text-white">{a.name}</span>
          </span>
          <PresenceBadge presence={a.presence} nowPlaying={playing} now={now} seenAt={latest(a.app.lastSeen, a.jellyfin.lastActivity)} />
        </span>
        {playing ? (
          // Chaque lecture du compte, une par appareil : la première seule cachait les autres.
          [playing, ...(a.alsoPlaying ?? [])].map((p, i) => {
            const c = clientLabel(p.client);
            return (
              <span key={i} className={`block ${i > 0 ? "mt-2 border-t border-white/5 pt-2" : ""}`}>
                <span className="mt-1 block truncate text-sm text-white">{p.title}</span>
                <Progress position={p.positionSeconds} runtime={p.runtimeSeconds} />
                <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
                  <span className="tabular-nums">
                    {clock(p.positionSeconds)} / {clock(p.runtimeSeconds)}
                  </span>
                  {p.paused && <span className="text-warning">{t("activity.live.paused")}</span>}
                  {c.label && (
                    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${c.laterna ? "bg-white/10 text-white" : "bg-sky-500/15 text-sky-300"}`}>
                      {c.label}
                      {/* Le chemin seulement quand ce n'est pas le lecteur de l'application : c'est le cas ordinaire. */}
                      {c.laterna && p.path && p.path !== "natif" ? ` · ${t(`activity.dash.path.${p.path}`)}` : ""}
                    </span>
                  )}
                  {p.device && <span>{p.device}</span>}
                  {!c.laterna && p.method && <span>{p.method}</span>}
                </span>
              </span>
            );
          })
        ) : pingTitle ? (
          <span className="mt-1 block truncate text-sm text-white">{pingTitle}</span>
        ) : (
          <span className="mt-1 block text-xs text-subtle">{a.presence.devices.join(" · ") || t("activity.live.browsing")}</span>
        )}
      </span>
    </ActivityLink>
  );
}

/** Un compte en carte : qui, où il en est, sa semaine, ce qui cloche. */
function AccountCard({ a, now }: { a: AccountSummary; now: number }) {
  const t = useT();
  return (
    <ActivityLink to={{ kind: "account", id: a.id }} className="card flex min-w-0 items-start gap-3 p-3 transition-colors hover:bg-white/[0.05]">
      <Avatar name={a.name} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="truncate font-medium text-white">{a.name}</span>
          {a.admin && <span className="rounded bg-accent-500/15 px-1.5 py-0.5 text-[11px] text-accent-400">{t("activity.accounts.admin")}</span>}
          {a.disabled && <span className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-muted">{t("activity.accounts.disabled")}</span>}
        </span>
        <PresenceBadge presence={a.presence} nowPlaying={a.nowPlaying} now={now} seenAt={latest(a.app.lastSeen, a.jellyfin.lastActivity)} />
        <span className="mt-1 block truncate text-xs text-subtle">
          {t("activity.accounts.weekValue", { n: a.week.seances, d: hours(a.week.watchedSeconds) })}
          {a.week.problems > 0 && <span className="text-warning"> · {t("activity.accounts.problems", { n: a.week.problems })}</span>}
        </span>
        {a.alerts.length > 0 && (
          <span className="mt-1.5 flex flex-wrap gap-1">
            {a.alerts.map((al) => (
              <AlertChip key={al.kind} label={alertLabel(al, t, now)} />
            ))}
          </span>
        )}
      </span>
    </ActivityLink>
  );
}

interface Issue {
  /** La clé sous laquelle la ligne s'efface (`dismissIssue`). */
  key: string;
  /** Son dernier événement : une ligne effacée revient s'il est postérieur à l'effacement. */
  at: number;
  icon: React.ElementType;
  tone: "bad" | "warn";
  text: string;
  detail?: string;
  to: ActivityView;
}

/**
 * Ce qui demande vraiment une main (07/11/2026, §136). Pas une reconstruction rattrapée, pas une bascule
 * sur la version allégée, pas un blocage dû au réseau du spectateur, pas un lecteur serveur pris pour un
 * fichier qu'un appareil ne lit pas, pas un retour d'arrière-plan, pas un avertissement du serveur : le
 * lecteur et le serveur les ont gérés comme prévu. Restent les comptes que Jellyfin refuse ou ne voit
 * plus, les erreurs du navigateur, les titres qui ont vraiment échoué cette semaine, les signalements
 * sans réponse, les connexions refusées, les notifications non remises et les vraies erreurs du serveur.
 * Chaque ligne s'efface à part ; elle revient avec un nouvel événement.
 */
function issuesOf(data: Overview, pending: ReportSummary[], t: T, now: number): Issue[] {
  const out: Issue[] = [];
  for (const a of data.accounts) {
    for (const al of a.alerts) {
      out.push({ key: `compte:${a.id}:${al.kind}`, at: al.at ?? 0, icon: al.kind === "clientErrors" ? AlertTriangle : KeyRound, tone: al.kind === "tokenRefused" ? "bad" : "warn", text: a.name, detail: alertLabel(al, t, now), to: { kind: "account", id: a.id } });
    }
  }
  if (pending.length > 0) {
    out.push({ key: "signalements", at: Math.max(...pending.map((r) => r.sentAt ?? 0)), icon: MessageSquareWarning, tone: "warn", text: t("activity.dash.issue.reports", { n: pending.length }), to: { kind: "report", id: pending[0].id } });
  }
  for (const d of data.household.diagnosis) {
    if (d.lastFailure < now - 7 * DAY) continue;
    const seance = d.viewers.flatMap((v) => v.failedSeances)[0];
    out.push({
      key: `titre:${d.key}`,
      at: d.lastFailure,
      icon: Clapperboard,
      tone: "bad",
      text: d.title,
      detail: `${t("activity.dash.issue.failures", { n: d.failures })}${d.reasons[0] ? ` · ${reasonLabel(d.reasons[0].reason, t).slice(0, 90)}` : ""} · ${ago(d.lastFailure, now, t)}`,
      to: seance ? { kind: "seance", id: seance } : { kind: "logs", preset: { source: "player" } },
    });
  }
  const alarms = data.dashboard?.alarms;
  if (alarms) {
    if (alarms.logins) out.push({ key: "connexions", at: alarms.logins.lastAt, icon: ShieldAlert, tone: "warn", text: t("activity.dash.issue.logins", { n: alarms.logins.count }), detail: ago(alarms.logins.lastAt, now, t), to: { kind: "logs", preset: { source: "auth", type: "login-failed" } } });
    if (alarms.notifications) out.push({ key: "notifications", at: alarms.notifications.lastAt, icon: Bell, tone: "warn", text: t("activity.dash.issue.notifs", { n: alarms.notifications.count }), detail: ago(alarms.notifications.lastAt, now, t), to: { kind: "logs", preset: { source: "notifications" } } });
    for (const e of alarms.server) {
      out.push({ key: `serveur:${e.scope}`, at: e.lastAt, icon: ServerCrash, tone: "warn", text: t("activity.dash.issue.server", { n: e.count }), detail: `${e.scope} · ${ago(e.lastAt, now, t)}`, to: { kind: "logs", preset: { source: "server", type: e.scope } } });
    }
  }
  const dismissed = data.dashboard?.dismissed ?? {};
  return out.filter((i) => !(dismissed[i.key] && i.at <= dismissed[i.key]));
}

function handledDetail(h: PeriodStats["handled"], t: T): string {
  const parts: string[] = [];
  if (h.recovered) parts.push(t("activity.dash.handled.recovered", { n: h.recovered }));
  if (h.network) parts.push(t("activity.dash.handled.network", { n: h.network }));
  if (h.slowLinks) parts.push(t("activity.dash.handled.slowLinks", { n: h.slowLinks }));
  if (h.planned) parts.push(t("activity.dash.handled.planned", { n: h.planned }));
  if (h.background) parts.push(t("activity.dash.handled.background", { n: h.background }));
  return parts.join(" · ");
}

function ToHandle({ data, week, now }: { data: Overview; week: PeriodStats | null; now: number }) {
  const t = useT();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const { data: reports } = useSWR<{ reports: ReportSummary[]; unread: number }>(ADMIN_REPORTS_KEY, fetcher, { refreshInterval: 30_000 });
  // Effacée à l'appui, sans attendre le serveur : la ligne part tout de suite, la relecture confirme.
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const pending = reports ? pendingReports(reports.reports) : [];
  const issues = issuesOf(data, pending, t, now).filter((i) => !gone.has(i.key));
  const handledTotal = week ? handledSum(week.handled) : 0;
  const dismiss = async (key: string) => {
    setGone((prev) => new Set(prev).add(key));
    try {
      await apiAction("/api/admin/activity/alerts", { method: "POST", body: JSON.stringify({ action: "dismiss", key }) });
      await mutate("/api/admin/activity");
    } catch (error) {
      setGone((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      toast.error(error instanceof Error && error.message ? error.message : t("common.error"));
    }
  };
  return (
    <Panel title={t("activity.dash.toHandle")} icon={issues.length ? ShieldAlert : ShieldCheck}>
      {issues.length ? (
        <ul className="divide-y divide-white/5">
          {issues.map((i) => (
            <li key={i.key} className="flex items-center">
              <ActivityLink to={i.to} className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 pr-2 transition-colors hover:bg-white/[0.03]">
                <i.icon size={15} className={`shrink-0 ${i.tone === "bad" ? "text-danger" : "text-warning"}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-white">{i.text}</span>
                  {i.detail && <span className="block truncate text-xs text-subtle">{i.detail}</span>}
                </span>
              </ActivityLink>
              <button
                type="button"
                onClick={() => void dismiss(i.key)}
                aria-label={t("activity.dash.dismiss")}
                title={t("activity.dash.dismiss")}
                className="mr-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-subtle transition-colors hover:bg-white/5 hover:text-white"
              >
                <X size={15} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-2 px-4 py-4 text-sm text-white">
          <CheckCircle2 size={16} className="shrink-0 text-success" />
          {t("activity.dash.nothingToHandle")}
        </p>
      )}
      {week && handledTotal > 0 && (
        <p className="border-t border-white/5 px-4 py-2.5 text-xs text-subtle">
          {t("activity.dash.handledLine", { n: handledTotal })} {handledDetail(week.handled, t)}
        </p>
      )}
    </Panel>
  );
}

/** Ce qu'on a touché sur le tableau de bord, et qui filtre le fil des séances. */
type Filter =
  | { kind: "day"; value: string }
  | { kind: "hour"; value: number }
  | { kind: "device"; value: string }
  | { kind: "title"; value: string }
  | { kind: "path"; value: NonNullable<FeedFilter["path"]> }
  | { kind: "user"; value: string };

function PeriodBreakdowns({
  stats,
  filter,
  onFilter,
}: {
  stats: PeriodStats;
  filter: Filter | null;
  onFilter: (f: Filter | null) => void;
}) {
  const t = useT();
  const paths = [
    { key: "natif", label: t("activity.dash.path.natif"), value: stats.paths.natif, color: PATH_COLORS.natif },
    { key: "serveur", label: t("activity.dash.path.serveur"), value: stats.paths.serveur, color: PATH_COLORS.serveur },
    { key: "tv", label: t("activity.dash.path.tv"), value: stats.paths.tv, color: PATH_COLORS.tv },
    { key: "horsLigne", label: t("activity.dash.path.horsLigne"), value: stats.paths.horsLigne, color: PATH_COLORS.horsLigne },
  ];
  const empty = t("activity.dash.empty");
  const is = (kind: Filter["kind"], value: string) => filter?.kind === kind && filter.value === value;
  const toggle = (f: Filter) => onFilter(filter?.kind === f.kind && filter.value === f.value ? null : f);
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Panel title={t("activity.dash.people")} icon={Users}>
        <RankList
          empty={empty}
          rows={stats.people.map((p) => {
            // Le débit habituel de quelqu'un : en ambre seulement quand il n'atteint pas celui de ses fichiers.
            const weak = p.linkMbps !== null && p.needMbps !== null && p.linkMbps < p.needMbps;
            const link = p.linkMbps !== null ? t("activity.dash.linkMbps", { n: mbps(p.linkMbps) }) : null;
            return {
              key: p.user,
              label: p.user,
              value: p.watchedSeconds || p.seances,
              valueLabel: hours(p.watchedSeconds),
              note: (
                <>
                  {t("activity.dash.seancesN", { n: p.seances })}
                  {link && <span className={weak ? "text-warning" : ""}> · {link}{weak ? ` · ${t("activity.dash.linkWeak")}` : ""}</span>}
                </>
              ),
              leading: <Avatar name={p.user} size={28} />,
              selected: is("user", p.user),
              onOpen: () => toggle({ kind: "user", value: p.user }),
            };
          })}
        />
      </Panel>
      <Panel title={t("activity.dash.titles")} icon={Clapperboard}>
        <TitleRank titles={stats.titles} empty={empty} selected={filter?.kind === "title" ? filter.value : null} onSelect={(title) => onFilter(title ? { kind: "title", value: title } : null)} />
      </Panel>
      <Panel title={t("activity.dash.paths")} icon={Route}>
        <div className="p-4">
          <StackBar
            parts={paths}
            empty={empty}
            selected={filter?.kind === "path" ? filter.value : null}
            onSelect={(key) => onFilter(key ? { kind: "path", value: key as NonNullable<FeedFilter["path"]> } : null)}
          />
        </div>
      </Panel>
      <Panel title={t("activity.dash.devices")} icon={MonitorSmartphone}>
        <RankList
          empty={empty}
          rows={stats.devices.map((d) => ({
            key: d.label,
            label: d.label,
            value: d.seances,
            valueLabel: t("activity.dash.seancesN", { n: d.seances }),
            note: d.real ? <span className="text-warning">{t("activity.dash.realN", { n: d.real })}</span> : hours(d.watchedSeconds),
            selected: is("device", d.label),
            onOpen: () => toggle({ kind: "device", value: d.label }),
          }))}
        />
      </Panel>
    </div>
  );
}

function mbps(n: number): string {
  return n.toLocaleString(uiLocale(), { maximumFractionDigits: n < 10 ? 1 : 0 });
}

/** Les heures et minutes d'un délai : « 2 j 4 h », « 5 h », « 40 min ». */
function delayLabel(ms: number, t: T): string {
  const h = Math.round(ms / 3600_000);
  if (h >= 48) return t("activity.dash.habits.days", { n: Math.round(h / 24) });
  if (h >= 1) return t("activity.dash.habits.hoursN", { n: h });
  return t("activity.dash.habits.minutes", { n: Math.max(1, Math.round(ms / 60_000)) });
}

type HabitTab = "end" | "series" | "reads" | "requests";

/**
 * Les habitudes (07/11/2026) : ce qu'on mène au bout, les séries en cours et leur rythme, d'où viennent
 * les octets, et ce que deviennent les demandes. Quatre onglets dans un seul encadré, chacun avec son
 * chiffre sur l'onglet — rien de plus à ouvrir pour voir l'essentiel.
 */
function Habits({
  stats,
  requests,
  periodDays,
  now,
  onFilter,
}: {
  stats: PeriodStats;
  requests: RequestStats | null;
  periodDays: number;
  now: number;
  onFilter: (f: Filter | null) => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<HabitTab>("end");
  const finishedShare = stats.completion.closed ? stats.completion.finished / stats.completion.closed : null;
  const readTotal = stats.reads.reserveMB + stats.reads.deviceMB + stats.reads.networkMB;
  const savedShare = readTotal ? (stats.reads.reserveMB + stats.reads.deviceMB) / readTotal : null;
  const tabs: { key: HabitTab; label: string; value: string }[] = [
    { key: "end", label: t("activity.dash.habits.end"), value: finishedShare === null ? "—" : `${Math.round(finishedShare * 100)} %` },
    { key: "series", label: t("activity.dash.habits.series"), value: String(stats.series.length) },
    { key: "reads", label: t("activity.dash.habits.reads"), value: savedShare === null ? "—" : `${Math.round(savedShare * 100)} %` },
    { key: "requests", label: t("activity.dash.habits.requests"), value: requests ? `${requests.watched}/${requests.requested}` : "—" },
  ];
  const weeks = Math.max(1, periodDays / 7);
  return (
    <Panel title={t("activity.dash.habits.title")} icon={Sparkles}>
      <div className="grid grid-cols-2 gap-px bg-white/5 sm:grid-cols-4" role="tablist" aria-label={t("activity.dash.habits.title")}>
        {tabs.map((x) => (
          <button
            key={x.key}
            type="button"
            role="tab"
            aria-selected={tab === x.key}
            onClick={() => setTab(x.key)}
            className={`flex flex-col items-start gap-0.5 px-4 py-3 text-left transition-colors ${tab === x.key ? "bg-white/[0.07]" : "bg-surface hover:bg-white/[0.03]"}`}
          >
            <span className="text-xl font-semibold tabular-nums text-white">{x.value}</span>
            <span className={`text-xs ${tab === x.key ? "text-white" : "text-muted"}`}>{x.label}</span>
          </button>
        ))}
      </div>

      {tab === "end" && (
        <div>
          <p className="px-4 pt-3 text-xs text-subtle">
            {t("activity.dash.habits.endHint", { n: stats.completion.finished, total: stats.completion.closed })}
          </p>
          <p className="px-4 pb-1 pt-3 text-xs font-medium text-muted">{t("activity.dash.habits.abandoned")}</p>
          <RankList
            empty={t("activity.dash.habits.noAbandon")}
            rows={stats.completion.abandoned.map((a) => ({
              key: a.title,
              label: a.title,
              value: a.count,
              valueLabel: t("activity.dash.habits.timesN", { n: a.count }),
              leading: <Poster itemId={a.itemId} kind="movie" className="h-10 w-7" />,
              onOpen: () => onFilter({ kind: "title", value: a.title }),
            }))}
          />
        </div>
      )}

      {tab === "series" && (
        <RankList
          empty={t("activity.dash.empty")}
          rows={stats.series.map((x) => ({
            key: `${x.user}|${x.series}`,
            label: (
              <>
                <span className="text-accent-400">{x.user}</span> · {x.series}
              </>
            ),
            value: x.episodes,
            valueLabel: x.last,
            note: `${t("activity.dash.habits.episodesN", { n: x.episodes })} · ${t("activity.dash.habits.perWeek", { n: (x.episodes / weeks).toLocaleString(uiLocale(), { maximumFractionDigits: 1 }) })} · ${ago(x.lastAt, now, t)}`,
            leading: <Poster itemId={x.itemId} kind="episode" className="h-10 w-7" />,
            onOpen: () => onFilter({ kind: "title", value: x.series }),
          }))}
        />
      )}

      {tab === "reads" && (
        <div className="space-y-3 p-4">
          <StackBar
            empty={t("activity.dash.empty")}
            parts={[
              { key: "reserve", label: t("activity.dash.habits.fromReserve"), value: Math.round(stats.reads.reserveMB), color: PATH_COLORS.natif },
              { key: "device", label: t("activity.dash.habits.fromDevice"), value: Math.round(stats.reads.deviceMB), color: PATH_COLORS.tv },
              { key: "network", label: t("activity.dash.habits.fromNetwork"), value: Math.round(stats.reads.networkMB), color: PATH_COLORS.serveur },
            ]}
          />
          <p className="text-xs text-subtle">{t("activity.dash.habits.readsHint", { n: stats.reads.withReserve })}</p>
        </div>
      )}

      {tab === "requests" &&
        (requests ? (
          <div>
            <div className="grid grid-cols-2 gap-3 p-3 md:grid-cols-4">
              <Tile icon={Download} label={t("activity.dash.habits.requested")} value={requests.requested} hint={t("activity.dash.habits.last30")} />
              <Tile icon={CheckCircle2} label={t("activity.dash.habits.arrived")} value={requests.available} />
              <Tile icon={Clapperboard} label={t("activity.dash.habits.watchedByRequester")} value={requests.watched} />
              <Tile icon={Clock} label={t("activity.dash.habits.delay")} value={requests.medianDelayMs !== null ? delayLabel(requests.medianDelayMs, t) : "—"} />
            </div>
            {requests.recent.length > 0 && (
              <ul className="divide-y divide-white/5 border-t border-white/5">
                {requests.recent.map((r, i) => (
                  <li key={`${r.title}|${r.createdAt}|${i}`} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-white">{r.title}</span>
                      <span className="block truncate text-xs text-subtle">
                        {r.requester} · {ago(r.createdAt, now, t)}
                      </span>
                    </span>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${
                        r.watchedAt ? "bg-success/15 text-success" : r.available ? "bg-white/10 text-white" : "bg-white/5 text-muted"
                      }`}
                    >
                      {r.watchedAt
                        ? t("activity.dash.habits.watchedAfter", { d: delayLabel(r.watchedAt - r.createdAt, t) })
                        : r.available
                          ? t("activity.dash.habits.availableBadge")
                          : t("activity.dash.habits.pendingBadge")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <p className="px-4 py-6 text-sm text-subtle">{t("activity.dash.habits.noRequests")}</p>
        ))}
    </Panel>
  );
}

/** Le jour `day` décalé de `n` jours, en jour local. */
function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00`);
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12);
  return `${out.getFullYear()}-${String(out.getMonth() + 1).padStart(2, "0")}-${String(out.getDate()).padStart(2, "0")}`;
}

/**
 * Les courbes. Celle des heures regardées remonte tout l'historique, trente jours par trente jours
 * (`/api/admin/activity/series`, jours gardés en base) ; toucher une barre la choisit, et la barre de
 * filtre en bas de l'écran mène à ses séances — rien ne saute sous le doigt (07/11/2026 : sur téléphone,
 * le premier toucher envoyait déjà au fil).
 */
function Charts({ dash, filter, onFilter }: { dash: Dashboard; filter: Filter | null; onFilter: (f: Filter | null) => void }) {
  const t = useT();
  const [end, setEnd] = useState<string | null>(null);
  const { data: older, isLoading: loadingOlder } = useSWR<{ first: string | null; series: Dashboard["series"] }>(end ? `/api/admin/activity/series?end=${end}` : null, fetcher, { keepPreviousData: true });
  const today = dash.series[dash.series.length - 1]?.day ?? null;
  const series = end ? (older?.series ?? dash.series) : dash.series;
  const first = older?.first ?? null;
  const canBack = series.length > 0 && (end === null || (first !== null && first < series[0].day));
  const move = (dir: -1 | 1) => {
    if (!today) return;
    const next = shiftDay(end ?? today, dir * 30);
    setEnd(next >= today ? null : next);
  };
  // Les versions du jour, réunies : deux déploiements le même jour font un seul trait. Seulement sur les
  // trente derniers jours, que le journal du lecteur couvre.
  const releases = new Map<string, string[]>();
  if (!end) for (const r of dash.releases ?? []) releases.set(r.day, [...(releases.get(r.day) ?? []), r.version]);
  const perDay = series.map((d, i) => {
    const versions = releases.get(d.day);
    return {
      key: d.day,
      // Une étiquette sur cinq, la plus récente comprise : trente dates se chevauchaient.
      label: (series.length - 1 - i) % 5 === 0 ? String(new Date(d.day + "T12:00:00").getDate()) : "",
      detail: `${shortDay(d.day)} · ${hours(d.watchedSeconds)} · ${t("activity.dash.seancesN", { n: d.seances })}${d.real ? ` · ${t("activity.dash.realN", { n: d.real })}` : ""}${versions ? ` · ${t("activity.dash.release", { v: versions.join(", ") })}` : ""}`,
      value: d.watchedSeconds,
      flagged: d.real > 0,
      mark: versions?.join(", "),
    };
  });
  const byHour = dash.hours.map((sec, h) => ({
    key: String(h),
    label: h % 3 === 0 ? String(h) : "",
    detail: `${h} h – ${h + 1} h · ${hours(sec)}`,
    value: sec,
  }));
  const total = series.reduce((n, d) => n + d.watchedSeconds, 0);
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
      <Panel
        title={t("activity.dash.watchedPerDay")}
        icon={Activity}
        className="lg:col-span-3"
        action={
          <span className="flex items-center gap-1">
            <button type="button" onClick={() => move(-1)} disabled={!canBack} aria-label={t("activity.dash.olderDays")} className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-white/5 hover:text-white disabled:opacity-30">
              <ChevronLeft size={16} />
            </button>
            <button type="button" onClick={() => move(1)} disabled={end === null} aria-label={t("activity.dash.newerDays")} className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-white/5 hover:text-white disabled:opacity-30">
              <ChevronRight size={16} />
            </button>
          </span>
        }
      >
        <div className={`p-4 transition-opacity ${end && loadingOlder ? "opacity-50" : ""}`}>
          {series.length > 0 && (
            <p className="mb-1 text-xs text-subtle">
              {shortDay(series[0].day)} – {shortDay(series[series.length - 1].day)} · {t("activity.dash.watchedTotal", { d: hours(total) })}
              {end && (
                <button type="button" onClick={() => setEnd(null)} className="ml-2 text-accent-400 hover:underline">
                  {t("activity.dash.backToToday")}
                </button>
              )}
            </p>
          )}
          <Bars
            points={perDay}
            empty={t("activity.dash.empty")}
            selected={filter?.kind === "day" ? filter.value : null}
            onSelect={(day) => onFilter(day ? { kind: "day", value: day } : null)}
          />
          {!end && (dash.releases?.length ?? 0) > 0 && (
            <p className="mt-3 flex items-center gap-1.5 text-[11px] text-subtle">
              <span className="inline-block h-3 w-px bg-white/30" aria-hidden />
              {t("activity.dash.releaseLegend")}
            </p>
          )}
        </div>
      </Panel>
      <Panel title={t("activity.dash.byHour")} icon={CalendarClock} className="lg:col-span-2">
        <div className="p-4">
          <Bars
            points={byHour}
            empty={t("activity.dash.empty")}
            selected={filter?.kind === "hour" ? String(filter.value) : null}
            onSelect={(h) => onFilter(h === null ? null : { kind: "hour", value: Number(h) })}
          />
        </div>
      </Panel>
    </div>
  );
}

/**
 * Le filtre en cours, flottant en bas de l'écran tant que le fil n'est pas visible : ce qu'on a
 * choisi, combien de séances, « Voir » pour y descendre, « × » pour tout relâcher.
 */
function FilterBar({ label, count, onShow, onClear, hidden }: { label: string; count: number | null; onShow: () => void; onClear: () => void; hidden: boolean }) {
  const t = useT();
  return (
    <div
      className={`pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+6.5rem)] z-30 flex justify-center px-4 transition-all duration-200 md:bottom-6 ${hidden ? "translate-y-4 opacity-0" : "opacity-100"}`}
      aria-hidden={hidden}
    >
      <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full bg-neutral-800/95 py-1.5 pl-4 pr-1.5 shadow-2xl ring-1 ring-white/10 backdrop-blur">
        <span className="min-w-0 truncate text-sm text-white">{label}</span>
        {count !== null && <span className="shrink-0 text-xs text-subtle">{t("activity.dash.seancesN", { n: count })}</span>}
        <button type="button" tabIndex={hidden ? -1 : 0} onClick={onShow} className="shrink-0 rounded-full bg-white px-3 py-1 text-xs font-semibold text-black">
          {t("activity.dash.showSeances")}
        </button>
        <button type="button" tabIndex={hidden ? -1 : 0} onClick={onClear} aria-label={t("activity.dash.clearFilter")} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-white/10 hover:text-white">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

/** Vrai tant que l'élément est à l'écran. `ready` : l'élément existe (il n'est rendu qu'avec les données). */
function useOnScreen(ref: React.RefObject<HTMLElement | null>, ready: boolean): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.05 });
    io.observe(node);
    return () => io.disconnect();
  }, [ref, ready]);
  return visible;
}

/** Le filtre en mots, pour l'étiquette au-dessus du fil. */
function filterLabel(f: Filter, t: T): string {
  switch (f.kind) {
    case "day":
      return shortDay(f.value);
    case "hour":
      return `${f.value} h – ${f.value + 1} h`;
    case "path":
      return t(`activity.dash.path.${f.value}`);
    default:
      return f.value;
  }
}

/**
 * Le fil des séances : les dernières, ou celles de ce qu'on a touché sur le tableau de bord. Le filtre
 * se lit dans une pastille qu'on ferme ; un compte filtré mène aussi à sa fiche.
 */
function Feed({
  recent,
  now,
  filter,
  feed,
  accounts,
  onFilter,
  anchor,
}: {
  recent: Seance[];
  now: number;
  filter: Filter | null;
  feed: { data: { seances: Seance[] } | undefined; isLoading: boolean };
  accounts: AccountSummary[];
  onFilter: (f: Filter | null) => void;
  anchor: React.RefObject<HTMLDivElement | null>;
}) {
  const t = useT();
  const { data, isLoading } = feed;
  const list = filter ? (data?.seances ?? []) : recent;
  const userId = filter?.kind === "user" ? accounts.find((a) => a.name.toLowerCase() === filter.value.toLowerCase())?.id : undefined;
  return (
    <div ref={anchor} className="scroll-mt-4">
      <Panel
        title={t("activity.recent.title")}
        icon={Clapperboard}
        action={
          <ActivityLink to={{ kind: "logs", preset: {} }} className="text-xs text-accent-400 hover:underline">
            {t("activity.logs.open")}
          </ActivityLink>
        }
      >
        {filter && (
          <div className="flex flex-wrap items-center gap-2 border-b border-white/5 px-4 py-2.5">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 py-1 pl-3 pr-1 text-xs text-white">
              {filterLabel(filter, t)}
              <button type="button" onClick={() => onFilter(null)} aria-label={t("activity.dash.clearFilter")} className="flex h-5 w-5 items-center justify-center rounded-full hover:bg-white/15">
                <X size={12} />
              </button>
            </span>
            <span className="text-xs text-subtle">{isLoading && !data ? "…" : t("activity.dash.seancesN", { n: list.length })}</span>
            {userId && (
              <ActivityLink to={{ kind: "account", id: userId }} className="ml-auto text-xs text-accent-400 hover:underline">
                {t("activity.dash.openAccount")}
              </ActivityLink>
            )}
          </div>
        )}
        <div className={`divide-y divide-white/5 transition-opacity ${filter && isLoading ? "opacity-60" : ""}`}>
          {list.map((seance) => (
            <SeanceRow key={seance.id} s={seance} now={now} showUser />
          ))}
          {filter && !isLoading && list.length === 0 && <p className="px-4 py-6 text-sm text-subtle">{t("activity.dash.empty")}</p>}
        </div>
      </Panel>
    </div>
  );
}

/** Les comptes : ceux qui ont regardé cette semaine, ou sont là ; les autres repliés en une ligne. */
function Accounts({ accounts, now }: { accounts: AccountSummary[]; now: number }) {
  const t = useT();
  const [showAll, setShowAll] = useState(false);
  const active = accounts.filter((a) => a.week.seances > 0 || a.nowPlaying || a.presence.state !== "away" || a.alerts.length > 0);
  const quiet = accounts.length - active.length;
  const shown = showAll ? accounts : active;
  return (
    <Panel title={t("activity.accounts.title", { n: accounts.length })} icon={Users}>
      <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((a) => (
          <AccountCard key={a.id} a={a} now={now} />
        ))}
      </div>
      {quiet > 0 && (
        <button type="button" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll} className="w-full border-t border-white/5 px-4 py-2.5 text-left text-xs text-accent-400 hover:underline">
          {showAll ? t("activity.dash.hideQuiet") : t("activity.dash.showQuiet", { n: quiet })}
        </button>
      )}
    </Panel>
  );
}

function NewsFold() {
  const t = useT();
  const { data } = useSWR<NewsAdminData>(NEWS_ADMIN_KEY, fetcher, { refreshInterval: 60_000 });
  if (!data) return null;
  return (
    <Fold id="news" title={t("news.title")} icon={Sparkles}>
      <div className="space-y-3 p-3">
        <NewsTiles s={data.synthesis} />
        <ActivityLink to={{ kind: "news" }} className="inline-block text-xs text-accent-400 hover:underline">
          {t("activity.news.open")}
        </ActivityLink>
      </div>
    </Fold>
  );
}

function DownloadsFold() {
  const t = useT();
  const { data } = useSWR<DownloadsOverview>(DOWNLOADS_ADMIN_KEY, fetcher, { refreshInterval: 60_000 });
  if (!data || (data.copies.length === 0 && data.events.length === 0)) return null;
  return (
    <Fold id="downloads" title={t("activity.downloads.title")} icon={Download}>
      <div className="space-y-3 p-3">
        <DownloadsTiles data={data} />
        <ActivityLink to={{ kind: "downloads" }} className="inline-block text-xs text-accent-400 hover:underline">
          {t("activity.downloads.open")}
        </ActivityLink>
      </div>
    </Fold>
  );
}

function SharesFold() {
  const t = useT();
  const { data } = useSWR<SharesOverview>(SHARE_ADMIN_KEY, fetcher, { refreshInterval: 60_000 });
  if (!data?.shares?.length) return null;
  return (
    <Fold id="shares" title={t("activity.shares.title")} icon={Link2}>
      <div className="space-y-3 p-3">
        <SharesTiles data={data} compact />
        <ActivityLink to={{ kind: "shares" }} className="inline-block text-xs text-accent-400 hover:underline">
          {t("activity.shares.open")}
        </ActivityLink>
      </div>
    </Fold>
  );
}

function ReadingsFold() {
  const t = useT();
  const available = useBooksAvailable();
  const { data } = useSWR<ReadingsOverview>(available ? READINGS_ADMIN_KEY : null, fetcher, { refreshInterval: 60_000 });
  if (!data?.accounts?.length) return null;
  return (
    <Fold id="readings" title={t("activity.readings.title")} icon={BookOpen}>
      <div className="space-y-3 p-3">
        <ReadingsTiles data={data} />
        <ActivityLink to={{ kind: "readings" }} className="inline-block text-xs text-accent-400 hover:underline">
          {t("activity.readings.open")}
        </ActivityLink>
      </div>
    </Fold>
  );
}

function ReportsFold({ now }: { now: number }) {
  const t = useT();
  const { data } = useSWR<{ reports: ReportSummary[]; unread: number }>(ADMIN_REPORTS_KEY, fetcher, { refreshInterval: 30_000 });
  if (!data) return null;
  const pending = pendingReports(data.reports).length;
  return (
    <Fold id="reports" title={t("activity.reports.title", { n: pending })} icon={MessageSquareWarning}>
      <ReportsList data={data} now={now} />
    </Fold>
  );
}

/** Les détails repliés : tout ce que les journaux disent, sans l'imposer à chaque ouverture. */
function Details({ data, dash }: { data: Overview; dash: Dashboard | undefined }) {
  const t = useT();
  const { now, household: h, signals: s } = data;
  const deliveredShare = h.notifications.delivered + h.notifications.failed > 0 ? h.notifications.delivered / (h.notifications.delivered + h.notifications.failed) : null;
  // Un encadré déjà titré (`Panel`) se fond dans la section qui l'ouvre.
  const bare = "[&>section]:rounded-none [&>section]:border-0 [&>section]:bg-transparent [&>section]:shadow-none [&>section>header]:hidden";
  return (
    <div className="space-y-3">
      <h2 className="pt-2 text-xs font-medium uppercase tracking-wide text-subtle">{t("activity.dash.details")}</h2>
      <ReportsFold now={now} />
      <Fold id="diagnosis" title={t("activity.diagnosis.title", { n: h.days })} icon={Stethoscope} summary={t("activity.dash.diagnosisSummary", { n: h.diagnosis.length })}>
        <div className={bare}>
          <DiagnosisPanel items={h.diagnosis} now={now} days={h.days} />
        </div>
      </Fold>
      <Fold id="quality" title={t("activity.quality.title")} icon={MonitorSmartphone} summary={t("activity.dash.devicesSummary", { n: h.devices.length })}>
        <DeviceQualityList devices={h.devices} />
      </Fold>
      <Fold id="habits" title={t("activity.habits.when")} icon={CalendarClock}>
        <div className="p-4">
          <Heatmap heatmap={h.habits.heatmap} />
        </div>
      </Fold>
      <Fold id="causes" title={t("activity.dash.causes")} icon={Wrench} summary={t("activity.dash.causesSummary", { r: s.rebuildReasons.length, e: s.serverErrors.length })}>
        <div className="grid grid-cols-1 divide-y divide-white/5 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
          <div>
            <p className="px-4 pt-3 text-xs font-medium text-muted">{t("activity.week.rebuildReasons")}</p>
            {s.rebuildReasons.length ? (
              <ul className="divide-y divide-white/5">
                {s.rebuildReasons.map((r) => (
                  <li key={r.reason} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                    <span className="truncate font-mono text-xs text-muted">{r.reason}</span>
                    <span className="shrink-0 tabular-nums text-muted">{r.count}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-4 text-sm text-subtle">{t("activity.week.noRebuild")}</p>
            )}
          </div>
          <div>
            <p className="px-4 pt-3 text-xs font-medium text-muted">{t("activity.week.serverErrors")}</p>
            {s.serverErrors.length ? (
              <ul className="divide-y divide-white/5">
                {s.serverErrors.map((e) => (
                  <li key={e.scope} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                    <ActivityLink to={{ kind: "logs", preset: { source: "server", type: e.scope } }} className="truncate font-mono text-xs text-muted hover:text-white">
                      {e.scope}
                    </ActivityLink>
                    <span className="shrink-0 tabular-nums text-muted">{e.count}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-4 text-sm text-subtle">{t("activity.week.noServerError")}</p>
            )}
            <p className="px-4 pb-3 pt-1 text-xs text-subtle">
              {t("activity.week.clientErrors")} : {s.clientErrors}
              {s.staleReloads ? ` · ${t("activity.week.staleReloads", { n: s.staleReloads })}` : ""} · {t("activity.week.tokenRefusals")} : {s.tokenRefusals}
            </p>
          </div>
        </div>
      </Fold>
      <Fold id="auth" title={t("activity.auth.title")} icon={KeyRound} summary={`${t("activity.auth.ok")} ${h.logins.ok} · ${t("activity.auth.failed")} ${h.logins.failed}`}>
        <div className="grid grid-cols-2 gap-3 p-3">
          <Tile icon={KeyRound} label={t("activity.auth.ok")} value={h.logins.ok} tone="good" />
          <Tile icon={ShieldAlert} label={t("activity.auth.failed")} value={h.logins.failed} tone={h.logins.failed ? "warn" : "good"} />
        </div>
        {h.logins.recentFailures.length > 0 && <AuthList now={now} showUser events={h.logins.recentFailures.map((f) => ({ ...f, kind: "login-failed" }))} />}
        <ActivityLink to={{ kind: "logs", preset: { source: "auth" } }} className="block border-t border-white/5 px-4 py-2.5 text-xs text-accent-400 hover:underline">
          {t("activity.logs.open")}
        </ActivityLink>
      </Fold>
      <Fold id="notifs" title={t("activity.notifs.title")} icon={Bell} summary={`${t("activity.notifs.sent")} ${h.notifications.sent} · ${t("activity.notifs.failedTile")} ${h.notifications.failed}`}>
        <div className="grid grid-cols-3 gap-3 p-3">
          <Tile icon={Bell} label={t("activity.notifs.sent")} value={h.notifications.sent} />
          <Tile icon={Bell} label={t("activity.notifs.deliveredTile")} value={h.notifications.delivered} hint={deliveredShare !== null ? `${Math.round(deliveredShare * 100)} %` : undefined} tone="good" />
          <Tile icon={AlertTriangle} label={t("activity.notifs.failedTile")} value={h.notifications.failed} tone={h.notifications.failed ? "warn" : "good"} />
        </div>
        {h.notifications.byCategory.length > 0 && (
          <ul className="divide-y divide-white/5 border-t border-white/5">
            {h.notifications.byCategory.map((c) => (
              <li key={c.category} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                <span className="truncate text-muted">{categoryLabel(c.category, t)}</span>
                <span className="shrink-0 tabular-nums text-muted">{c.count}</span>
              </li>
            ))}
          </ul>
        )}
        <ActivityLink to={{ kind: "logs", preset: { source: "notifications" } }} className="block border-t border-white/5 px-4 py-2.5 text-xs text-accent-400 hover:underline">
          {t("activity.logs.open")}
        </ActivityLink>
      </Fold>
      {dash && dash.describe.searches > 0 && (
        <Fold id="describe" title={t("activity.dash.describe.title")} icon={Search} summary={t("activity.dash.describe.summary", { n: dash.describe.searches })}>
          <div className="grid grid-cols-2 gap-3 p-3 md:grid-cols-4">
            <Tile icon={Search} label={t("activity.dash.describe.searches")} value={dash.describe.searches} hint={t("activity.dash.describe.accounts", { n: dash.describe.accounts })} />
            <Tile icon={Sparkles} label={t("activity.dash.describe.model")} value={dash.describe.modelCalls} hint={pct(dash.describe.modelCalls, dash.describe.searches)} />
            <Tile icon={Gauge} label={t("activity.dash.describe.median")} value={dash.describe.medianMs !== null ? secs(dash.describe.medianMs) : "—"} />
            <Tile icon={AlertTriangle} label={t("activity.dash.describe.errors")} value={dash.describe.errors} tone={dash.describe.errors ? "warn" : "good"} />
          </div>
          <ActivityLink to={{ kind: "logs", preset: { source: "search" } }} className="block border-t border-white/5 px-4 py-2.5 text-xs text-accent-400 hover:underline">
            {t("activity.logs.open")}
          </ActivityLink>
        </Fold>
      )}
      <NewsFold />
      <DownloadsFold />
      <SharesFold />
      <ReadingsFold />
    </div>
  );
}

/** Le changement d'adresse (§119), derrière un bouton discret en bas de page — il ne sert plus qu'à l'occasion. */
function AddressFooter() {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3 pt-4">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="mx-auto flex items-center gap-1.5 text-xs text-subtle hover:text-muted">
        <Globe size={12} />
        {open ? t("activity.dash.addressHide") : t("activity.dash.addressShow")}
      </button>
      {open && <AddressChangePanel />}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="h-28 animate-pulse rounded-2xl bg-white/[0.03]" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-2xl bg-white/[0.03]" />
        ))}
      </div>
      <div className="h-56 animate-pulse rounded-2xl bg-white/[0.03]" />
    </div>
  );
}

/** La vue d'ensemble : en direct, la période, à gérer, les courbes, les comptes, le fil, le détail. */
export function ActivityOverview({ active = true }: { active?: boolean }) {
  const t = useT();
  const { data, isLoading, mutate } = useSWR<Overview>("/api/admin/activity", fetcher, { refreshInterval: active ? LIVE_REFRESH_MS : 0 });
  const [period, setPeriod] = useState<PeriodKey>("week");
  // Choisir une barre, un appareil, un titre… filtre le fil sans faire bouger la page : la barre de
  // filtre, en bas de l'écran, y mène quand on le veut.
  const [filter, setFilter] = useState<Filter | null>(null);
  const feedAnchor = useRef<HTMLDivElement>(null);
  const feedVisible = useOnScreen(feedAnchor, data !== undefined);
  const feedKeyPeriod = period === "all" ? "month" : period;
  const feedKey = filter ? `/api/admin/activity/feed?${new URLSearchParams({ period: feedKeyPeriod, [filter.kind]: String(filter.value) })}` : null;
  const feed = useSWR<{ seances: Seance[] }>(feedKey, fetcher, { keepPreviousData: true });
  const { data: all } = useSWR<WeekSignals>(period === "all" ? "/api/admin/activity/period?period=all" : null, fetcher, { refreshInterval: active ? 60_000 : 0 });

  if (isLoading && !data) return <Skeleton />;
  // Une relecture de fond qui échoue (un redéploiement) garde les données en main : seul un
  // écran qui n'a encore rien reçu devient un écran d'erreur (08/10/2026).
  if (!data) return <ErrorState message={t("activity.loadError")} onRetry={() => mutate()} />;

  const { now, accounts, recent } = data;
  const dash = data.dashboard;
  // La règle est partagée avec l'accueil de la gestion (`liveAccounts`, DECISIONS.md §81).
  const { live, playing: playingCount, browsing } = liveAccounts(accounts);
  const stats = dash && period !== "all" ? dash.periods[period] : null;
  // « Tout » : qui regarde vient de l'historique gardé jour par jour ; les autres répartitions (titres,
  // chemins, appareils) n'y sont pas gardées et suivent les trente derniers jours.
  const breakdown = dash
    ? period === "all"
      ? { ...dash.periods.month, people: (all?.people ?? []).map((p) => ({ ...p, linkMbps: null, needMbps: null })) }
      : dash.periods[period]
    : null;
  const prev = dash?.previous && period !== "all" ? dash.previous[period] : null;


  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">{t("activity.subtitle", { playing: playingCount, app: browsing, total: accounts.length })}</p>
        <div className="flex flex-wrap items-center gap-2">
          <AlertsClearControl clearedAt={data.alertsClearedAt ?? 0} now={now} />
          <button type="button" onClick={() => mutate()} className="btn-ghost px-3 py-1.5 text-xs">
            <RefreshCw size={14} />
            <span className="hidden sm:inline">{t("activity.refresh")}</span>
          </button>
          <ActivityLink to={{ kind: "logs", preset: {} }} className="btn-ghost px-3 py-1.5 text-xs">
            <ListTree size={14} />
            <span className="hidden sm:inline">{t("activity.logs.title")}</span>
          </ActivityLink>
        </div>
      </div>

      {/* Jellyfin injoignable : avant tout le reste, puisque rien ne se lit tant qu'il manque (§92). */}
      {data.jellyfinDownSince ? (
        <div role="status" data-testid="activity-jellyfin-down" className="card flex items-center gap-2 px-4 py-3 text-sm text-white">
          <ServerCrash size={16} className="shrink-0 text-danger" />
          <span>
            {t("activity.jellyfinDown", { time: fmtTime(data.jellyfinDownSince) })}
            <span className="text-subtle"> · {ago(data.jellyfinDownSince, now, t)}</span>
          </span>
        </div>
      ) : null}

      {/* 1. Maintenant. `grid-cols-1` et non une grille sans colonne : sur téléphone, sa colonne
          implicite prenait la largeur du plus long titre, et les cartes débordaient (06/10/2026). */}
      <Panel title={t("activity.live.title")} icon={Radio}>
        {live.length ? (
          <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3">
            {live.map((a) => (
              <LiveCard key={a.id} a={a} now={now} />
            ))}
          </div>
        ) : (
          <p className="px-4 py-6 text-sm text-subtle">{t("activity.live.nobody")}</p>
        )}
      </Panel>

      {/* 2. La période. */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-subtle">{t(`activity.dash.periodTitle.${period}`)}</h2>
          <Segmented
            label={t("activity.period.label")}
            value={period}
            onChange={setPeriod}
            options={[
              { value: "day", label: t("activity.dash.period.day") },
              { value: "week", label: t("activity.dash.period.week") },
              { value: "month", label: t("activity.dash.period.month") },
              { value: "all", label: t("activity.dash.period.all") },
            ]}
          />
        </div>
        <KpiRow stats={stats} prev={prev} all={period === "all" ? (all ?? null) : null} />
      </div>

      {/* 3. Ce qui demande vraiment une main. */}
      <ToHandle data={data} week={dash?.periods.week ?? null} now={now} />

      {/* 4. Les courbes, puis les répartitions de la période. */}
      {dash && <Charts dash={dash} filter={filter} onFilter={setFilter} />}
      {breakdown && <PeriodBreakdowns stats={breakdown} filter={filter} onFilter={setFilter} />}
      {breakdown && breakdown.completion && (
        <Habits stats={breakdown} requests={data.requests ?? null} periodDays={period === "day" ? 1 : period === "week" ? 7 : 30} now={now} onFilter={setFilter} />
      )}

      {/* 5. Le fil des séances, filtré par ce qu'on a touché plus haut. */}
      {filter && (
        <FilterBar
          label={filterLabel(filter, t)}
          count={feed.data ? feed.data.seances.length : null}
          hidden={feedVisible}
          onShow={() => feedAnchor.current?.scrollIntoView({ behavior: scrollBehavior(), block: "start" })}
          onClear={() => setFilter(null)}
        />
      )}
      <Feed recent={recent} now={now} filter={filter} feed={{ data: feed.data, isLoading: feed.isLoading }} accounts={accounts} onFilter={setFilter} anchor={feedAnchor} />

      {/* 6. Les comptes. */}
      <Accounts accounts={accounts} now={now} />

      {/* 7. Le détail, replié. */}
      <Details data={data} dash={dash} />

      <AddressFooter />
    </div>
  );
}
