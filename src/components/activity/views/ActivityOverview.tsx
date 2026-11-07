"use client";

import { useState } from "react";
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
  Sparkles,
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
import { AlertChip, Avatar, ConfirmButton, Panel, Poster, PresenceBadge, Progress, SeanceRow, Tile, ago, clock, hours, latest, secs, type T } from "@/components/activity/parts";
import { Bars, Fold, Kpi, PATH_COLORS, RankList, Segmented, StackBar, TitleRank, shortDay } from "@/components/activity/DashboardParts";
import type { AccountSummary, WeekSignals, household } from "@/lib/activity/accounts";
import type { Dashboard, PeriodStats } from "@/lib/activity/dashboard";
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
 * « Effacer les alertes » : tout ce qui est rouge, orange ou jaune dans le panneau ne se compte
 * plus qu'à partir de maintenant (09/10/2026, DECISIONS.md §59). Les journaux restent intacts, et
 * « Réafficher » remet tout comme avant. Confirmé d'un second appui, comme les gestes du compte.
 */
function AlertsClearControl({ clearedAt, now }: { clearedAt: number; now: number }) {
  const t = useT();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const send = async (action: "clear" | "restore") => {
    try {
      await apiAction("/api/admin/activity/alerts", { method: "POST", body: JSON.stringify({ action }) });
      // Toutes les vues du panneau en dépendent : la vue d'ensemble, et chaque fiche de compte.
      await mutate((key) => typeof key === "string" && key.startsWith("/api/admin/activity"));
      toast.success(action === "clear" ? t("activity.alerts.cleared") : t("activity.alerts.restored"));
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t("common.error"));
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {clearedAt > 0 && (
        <span className="text-xs text-subtle">
          {t("activity.alerts.clearedOn", { when: ago(clearedAt, now, t) })}
          {" · "}
          <button type="button" onClick={() => void send("restore")} className="text-accent-400 hover:underline">
            {t("activity.alerts.restore")}
          </button>
        </span>
      )}
      <ConfirmButton label={t("activity.alerts.clear")} confirm={t("activity.alerts.clearConfirm")} onConfirm={() => send("clear")} />
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

/** Ceux qui regardent en ce moment : l'affiche, où ils en sont, sur quoi, par quel chemin. */
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
          [playing, ...(a.alsoPlaying ?? [])].map((p, i) => (
            <span key={i} className={`block ${i > 0 ? "mt-2 border-t border-white/5 pt-2" : ""}`}>
              <span className="mt-1 block truncate text-sm text-white">{p.title}</span>
              <Progress position={p.positionSeconds} runtime={p.runtimeSeconds} />
              <span className="mt-1 flex flex-wrap gap-x-2 text-xs text-subtle">
                <span className="tabular-nums">
                  {clock(p.positionSeconds)} / {clock(p.runtimeSeconds)}
                </span>
                {p.paused && <span className="text-warning">{t("activity.live.paused")}</span>}
                {p.device && <span>{p.device}</span>}
                {p.method && <span>{p.method}</span>}
              </span>
            </span>
          ))
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
  key: string;
  icon: React.ElementType;
  tone: "bad" | "warn";
  text: string;
  detail?: string;
  to: ActivityView;
}

/**
 * Ce qui demande vraiment une main (07/11/2026). Pas une reconstruction rattrapée, pas une bascule sur
 * la version allégée, pas un lecteur serveur pris pour un fichier qu'un appareil ne lit pas, pas un
 * retour d'arrière-plan : le lecteur les a gérés comme prévu (`problemsOf`, `handledOf`). Restent les
 * comptes que Jellyfin refuse ou ne voit plus, les erreurs du navigateur, les titres qui ont vraiment
 * échoué cette semaine, les signalements sans réponse, les connexions refusées, les notifications non
 * remises et les erreurs du serveur.
 */
function issuesOf(data: Overview, pending: ReportSummary[], t: T, now: number): Issue[] {
  const out: Issue[] = [];
  for (const a of data.accounts) {
    for (const al of a.alerts) {
      out.push({ key: `${a.id}:${al.kind}`, icon: al.kind === "clientErrors" ? AlertTriangle : KeyRound, tone: al.kind === "tokenRefused" ? "bad" : "warn", text: a.name, detail: alertLabel(al, t, now), to: { kind: "account", id: a.id } });
    }
  }
  if (pending.length > 0) out.push({ key: "reports", icon: MessageSquareWarning, tone: "warn", text: t("activity.dash.issue.reports", { n: pending.length }), to: { kind: "report", id: pending[0].id } });
  for (const d of data.household.diagnosis) {
    if (d.lastFailure < now - 7 * DAY) continue;
    const seance = d.viewers.flatMap((v) => v.failedSeances)[0];
    out.push({
      key: `title:${d.key}`,
      icon: Clapperboard,
      tone: "bad",
      text: d.title,
      detail: `${t("activity.dash.issue.failures", { n: d.failures })}${d.reasons[0] ? ` · ${d.reasons[0].reason.slice(0, 90)}` : ""} · ${ago(d.lastFailure, now, t)}`,
      to: seance ? { kind: "seance", id: seance } : { kind: "logs", preset: { source: "player" } },
    });
  }
  if (data.household.logins.failed > 0) out.push({ key: "logins", icon: ShieldAlert, tone: "warn", text: t("activity.dash.issue.logins", { n: data.household.logins.failed }), to: { kind: "logs", preset: { source: "auth", type: "login-failed" } } });
  if (data.household.notifications.failed > 0) out.push({ key: "notifs", icon: Bell, tone: "warn", text: t("activity.dash.issue.notifs", { n: data.household.notifications.failed }), to: { kind: "logs", preset: { source: "notifications" } } });
  for (const e of data.signals.serverErrors) {
    out.push({ key: `server:${e.scope}`, icon: ServerCrash, tone: "warn", text: t("activity.dash.issue.server", { n: e.count }), detail: e.scope, to: { kind: "logs", preset: { source: "server", type: e.scope } } });
  }
  return out;
}

function handledDetail(h: PeriodStats["handled"], t: T): string {
  const parts: string[] = [];
  if (h.recovered) parts.push(t("activity.dash.handled.recovered", { n: h.recovered }));
  if (h.slowLinks) parts.push(t("activity.dash.handled.slowLinks", { n: h.slowLinks }));
  if (h.planned) parts.push(t("activity.dash.handled.planned", { n: h.planned }));
  if (h.background) parts.push(t("activity.dash.handled.background", { n: h.background }));
  return parts.join(" · ");
}

function ToHandle({ data, week, now }: { data: Overview; week: PeriodStats | null; now: number }) {
  const t = useT();
  const { data: reports } = useSWR<{ reports: ReportSummary[]; unread: number }>(ADMIN_REPORTS_KEY, fetcher, { refreshInterval: 30_000 });
  const pending = reports ? pendingReports(reports.reports) : [];
  const issues = issuesOf(data, pending, t, now);
  const handledTotal = week ? week.handled.recovered + week.handled.slowLinks + week.handled.planned + week.handled.background : 0;
  return (
    <Panel title={t("activity.dash.toHandle")} icon={issues.length ? ShieldAlert : ShieldCheck}>
      {issues.length ? (
        <ul className="divide-y divide-white/5">
          {issues.map((i) => (
            <li key={i.key}>
              <ActivityLink to={i.to} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-white/[0.03]">
                <i.icon size={15} className={`shrink-0 ${i.tone === "bad" ? "text-danger" : "text-warning"}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-white">{i.text}</span>
                  {i.detail && <span className="block truncate text-xs text-subtle">{i.detail}</span>}
                </span>
                <span className="shrink-0 text-subtle">›</span>
              </ActivityLink>
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

function pct(part: number, total: number): string {
  return total ? `${Math.round((part / total) * 100)} %` : "—";
}

/** Les chiffres clés de la période. « Tout » vient de l'historique gardé (`/api/admin/activity/period`). */
function KpiRow({ stats, all }: { stats: PeriodStats | null; all: WeekSignals | null }) {
  const t = useT();
  if (!stats) {
    if (!all) return <div className="h-28 animate-pulse rounded-2xl bg-white/[0.03]" />;
    const real = all.perDay.reduce((n, d) => n + d.problems, 0);
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi icon={Clapperboard} label={t("activity.dash.kpi.seances")} value={all.seances} hint={t("activity.week.viewers", { n: all.viewers })} />
        <Kpi icon={Clock} label={t("activity.dash.kpi.watched")} value={hours(all.watchedSeconds)} />
        <Kpi icon={Hourglass} label={t("activity.dash.kpi.waits")} value={all.waits} hint={t("activity.week.waitsHint", { d: secs(all.waitedMs) })} />
        <Kpi icon={AlertTriangle} label={t("activity.dash.kpi.real")} value={real} tone={real ? "warn" : "good"} />
      </div>
    );
  }
  const cleanShare = stats.seances ? stats.clean / stats.seances : 1;
  const handled = stats.handled.recovered + stats.handled.slowLinks + stats.handled.planned + stats.handled.background;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <Kpi icon={Clapperboard} label={t("activity.dash.kpi.seances")} value={stats.seances} hint={t("activity.week.viewers", { n: stats.viewers })} />
      <Kpi icon={Clock} label={t("activity.dash.kpi.watched")} value={hours(stats.watchedSeconds)} />
      <Kpi
        icon={CheckCircle2}
        label={t("activity.dash.kpi.clean")}
        value={pct(stats.clean, stats.seances)}
        hint={t("activity.dash.kpi.cleanHint", { n: stats.clean, total: stats.seances })}
        tone={!stats.seances ? "default" : cleanShare >= 0.95 ? "good" : cleanShare >= 0.85 ? "warn" : "bad"}
      />
      <Kpi icon={Gauge} label={t("activity.dash.kpi.open")} value={stats.openMedianMs !== null ? secs(stats.openMedianMs) : "—"} hint={stats.openP90Ms !== null ? t("activity.dash.kpi.openHint", { d: secs(stats.openP90Ms) }) : undefined} />
      <Kpi icon={Hourglass} label={t("activity.dash.kpi.waits")} value={stats.waits} hint={t("activity.week.waitsHint", { d: secs(stats.waitedMs) })} />
      <Kpi icon={Wrench} label={t("activity.dash.kpi.handled")} value={handled} hint={t("activity.dash.kpi.handledHint", { n: stats.real })} tone={stats.real ? "warn" : "default"} />
    </div>
  );
}

function PeriodBreakdowns({ stats, accounts }: { stats: PeriodStats; accounts: AccountSummary[] }) {
  const t = useT();
  const idOf = new Map(accounts.map((a) => [a.name.toLowerCase(), a.id]));
  const paths = [
    { key: "natif", label: t("activity.dash.path.natif"), value: stats.paths.natif, color: PATH_COLORS.natif },
    { key: "serveur", label: t("activity.dash.path.serveur"), value: stats.paths.serveur, color: PATH_COLORS.serveur },
    { key: "tv", label: t("activity.dash.path.tv"), value: stats.paths.tv, color: PATH_COLORS.tv },
    { key: "horsLigne", label: t("activity.dash.path.horsLigne"), value: stats.paths.horsLigne, color: PATH_COLORS.horsLigne },
  ];
  const empty = t("activity.dash.empty");
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Panel title={t("activity.dash.people")} icon={Users}>
        <RankList
          empty={empty}
          rows={stats.people.map((p) => {
            const id = idOf.get(p.user.toLowerCase());
            return {
              key: p.user,
              label: p.user,
              value: p.watchedSeconds || p.seances,
              valueLabel: hours(p.watchedSeconds),
              note: t("activity.dash.seancesN", { n: p.seances }),
              leading: <Avatar name={p.user} size={28} />,
              onOpen: id ? () => goTo({ kind: "account", id }) : undefined,
            };
          })}
        />
      </Panel>
      <Panel title={t("activity.dash.titles")} icon={Clapperboard}>
        <TitleRank titles={stats.titles} empty={empty} />
      </Panel>
      <Panel title={t("activity.dash.paths")} icon={Route}>
        <div className="p-4">
          <StackBar parts={paths} empty={empty} />
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
          }))}
        />
      </Panel>
    </div>
  );
}

function Charts({ dash }: { dash: Dashboard }) {
  const t = useT();
  const perDay = dash.series.map((d, i) => ({
    key: d.day,
    // Une étiquette sur cinq, la plus récente comprise : trente dates se chevauchaient.
    label: (dash.series.length - 1 - i) % 5 === 0 ? shortDay(d.day) : "",
    detail: `${shortDay(d.day)} · ${hours(d.watchedSeconds)} · ${t("activity.dash.seancesN", { n: d.seances })}${d.real ? ` · ${t("activity.dash.realN", { n: d.real })}` : ""}`,
    value: d.watchedSeconds,
    flagged: d.real > 0,
  }));
  const byHour = dash.hours.map((s, h) => ({
    key: String(h),
    label: h % 3 === 0 ? `${h} h` : "",
    detail: `${h} h – ${h + 1} h · ${hours(s)}`,
    value: s,
  }));
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
      <Panel title={t("activity.dash.watchedPerDay")} icon={Activity} className="lg:col-span-3">
        <div className="p-4">
          <Bars points={perDay} empty={t("activity.dash.empty")} />
        </div>
      </Panel>
      <Panel title={t("activity.dash.byHour")} icon={CalendarClock} className="lg:col-span-2">
        <div className="p-4">
          <Bars points={byHour} empty={t("activity.dash.empty")} />
        </div>
      </Panel>
    </div>
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
  // « Tout » n'a pas de répartitions gardées : elles suivent alors les trente derniers jours.
  const breakdown = dash ? (period === "all" ? dash.periods.month : dash.periods[period]) : null;

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
        <KpiRow stats={stats} all={period === "all" ? (all ?? null) : null} />
      </div>

      {/* 3. Ce qui demande vraiment une main. */}
      <ToHandle data={data} week={dash?.periods.week ?? null} now={now} />

      {/* 4. Les courbes, puis les répartitions de la période. */}
      {dash && <Charts dash={dash} />}
      {breakdown && <PeriodBreakdowns stats={breakdown} accounts={accounts} />}

      {/* 5. Les comptes. */}
      <Panel title={t("activity.accounts.title", { n: accounts.length })} icon={Users}>
        <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3">
          {accounts.map((a) => (
            <AccountCard key={a.id} a={a} now={now} />
          ))}
        </div>
      </Panel>

      {/* 6. Le fil des séances. */}
      <Panel
        title={t("activity.recent.title")}
        icon={Clapperboard}
        action={
          <ActivityLink to={{ kind: "logs", preset: {} }} className="text-xs text-accent-400 hover:underline">
            {t("activity.logs.open")}
          </ActivityLink>
        }
      >
        <div className="divide-y divide-white/5">
          {recent.map((seance) => (
            <SeanceRow key={seance.id} s={seance} now={now} showUser />
          ))}
        </div>
      </Panel>

      {/* 7. Le détail, replié. */}
      <Details data={data} dash={dash} />

      <AddressFooter />
    </div>
  );
}
