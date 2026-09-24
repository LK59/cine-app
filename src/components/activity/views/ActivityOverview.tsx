"use client";

import { useState } from "react";
import useSWR from "swr";
import {
  Activity,
  AlertTriangle,
  Bell,
  CalendarClock,
  Clapperboard,
  Clock,
  FastForward,
  Hourglass,
  KeyRound,
  ListTree,
  MessageSquareWarning,
  MonitorSmartphone,
  Radio,
  RefreshCw,
  ServerCrash,
  ShieldAlert,
  Users,
  Wrench,
} from "lucide-react";
import { fetcher } from "@/lib/swr";
import { LoadingState, ErrorState } from "@/components/StateViews";
import { useT } from "@/components/TranslationProvider";
import { AlertChip, Avatar, DayBars, Panel, PresenceBadge, Progress, SeanceRow, Tile, ago, clock, hours, secs, type T } from "@/components/activity/parts";
import type { AccountSummary, WeekSignals, household } from "@/lib/activity/accounts";
import type { ReportSummary } from "@/lib/reports";
import { NOTIFICATION_CATEGORIES } from "@/lib/notifications";
import { ReportRowView } from "@/components/reports/ReportParts";
import { DeviceQualityList, Heatmap, TopTitles, AuthList } from "@/components/activity/insights";
import type { Seance } from "@/lib/activity/seances";
import { ActivityLink, goTo } from "@/components/activity/nav";

interface Overview {
  now: number;
  accounts: AccountSummary[];
  signals: WeekSignals;
  recent: Seance[];
  household: ReturnType<typeof household>;
}

/**
 * La petite fenêtre des signalements : ceux qui attendent (ouverts, en cours) en tête, le nouveau
 * marqué d'une pastille. Les réglés restent consultables d'un geste, jamais supprimés.
 */
function ReportsPanel({ now }: { now: number }) {
  const t = useT();
  const [showDone, setShowDone] = useState(false);
  const { data } = useSWR<{ reports: ReportSummary[]; unread: number }>("/api/admin/activity/reports", fetcher, { refreshInterval: 30_000 });
  if (!data) return null;
  const pending = data.reports.filter((r) => r.status === "open" || r.status === "in_progress");
  const done = data.reports.filter((r) => r.status === "resolved" || r.status === "closed");
  const shown = showDone ? done : pending;
  return (
    <Panel
      title={t("activity.reports.title", { n: pending.length })}
      icon={MessageSquareWarning}
      action={
        done.length > 0 && (
          <button type="button" onClick={() => setShowDone((v) => !v)} className="text-xs text-accent-300 hover:underline">
            {showDone ? t("activity.reports.showPending") : t("activity.reports.showDone", { n: done.length })}
          </button>
        )
      }
    >
      {shown.length ? (
        <div className="scrollbar-thin max-h-96 divide-y divide-white/5 overflow-y-auto">
          {shown.map((r) => (
            <ReportRowView key={r.id} r={r} showUser when={ago(r.sentAt, now, t)} onOpen={() => goTo({ kind: "report", id: r.id })} />
          ))}
        </div>
      ) : (
        <p className="px-4 py-6 text-sm text-slate-500">{showDone ? t("activity.reports.noneDone") : t("activity.reports.none")}</p>
      )}
    </Panel>
  );
}

/** Le foyer sur trente jours : appareils, habitudes, connexions, notifications. */
function HouseholdSection({ h, now }: { h: Overview["household"]; now: number }) {
  const t = useT();
  const deliveredShare = h.notifications.delivered + h.notifications.failed > 0 ? h.notifications.delivered / (h.notifications.delivered + h.notifications.failed) : null;
  return (
    <div className="space-y-6">
      <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500">{t("activity.household.title", { n: h.days })}</h2>
      <Panel title={t("activity.quality.title")} icon={MonitorSmartphone}>
        <DeviceQualityList devices={h.devices} />
      </Panel>
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title={t("activity.habits.when")} icon={CalendarClock}>
          <div className="p-4">
            <Heatmap heatmap={h.habits.heatmap} />
          </div>
        </Panel>
        <Panel title={t("activity.habits.top")} icon={Clapperboard}>
          <TopTitles habits={h.habits} />
        </Panel>
        <Panel
          title={t("activity.auth.title")}
          icon={KeyRound}
          action={
            <ActivityLink to={{ kind: "logs", preset: { source: "auth" } }} className="text-xs text-accent-300 hover:underline">
              {t("activity.logs.open")}
            </ActivityLink>
          }
        >
          <div className="grid grid-cols-2 gap-3 p-3">
            <Tile icon={KeyRound} label={t("activity.auth.ok")} value={h.logins.ok} tone="good" />
            <Tile icon={ShieldAlert} label={t("activity.auth.failed")} value={h.logins.failed} tone={h.logins.failed ? "warn" : "good"} />
          </div>
          {h.logins.recentFailures.length > 0 && (
            <AuthList
              now={now}
              showUser
              events={h.logins.recentFailures.map((f) => ({ ...f, kind: "login-failed" }))}
            />
          )}
        </Panel>
        <Panel
          title={t("activity.notifs.title")}
          icon={Bell}
          action={
            <ActivityLink to={{ kind: "logs", preset: { source: "notifications" } }} className="text-xs text-accent-300 hover:underline">
              {t("activity.logs.open")}
            </ActivityLink>
          }
        >
          <div className="grid grid-cols-3 gap-3 p-3">
            <Tile icon={Bell} label={t("activity.notifs.sent")} value={h.notifications.sent} />
            <Tile icon={Bell} label={t("activity.notifs.deliveredTile")} value={h.notifications.delivered} hint={deliveredShare !== null ? `${Math.round(deliveredShare * 100)} %` : undefined} tone="good" />
            <Tile icon={AlertTriangle} label={t("activity.notifs.failedTile")} value={h.notifications.failed} tone={h.notifications.failed ? "warn" : "good"} />
          </div>
          {h.notifications.byCategory.length > 0 && (
            <ul className="divide-y divide-white/5 border-t border-white/5">
              {h.notifications.byCategory.map((c) => (
                <li key={c.category} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                  <span className="truncate text-slate-300">{categoryLabel(c.category, t)}</span>
                  <span className="shrink-0 tabular-nums text-slate-400">{c.count}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

function categoryLabel(id: string, t: T): string {
  const known = NOTIFICATION_CATEGORIES.find((c) => c.id === id);
  return known ? t(known.labelKey) : id;
}

function alertLabel(a: AccountSummary["alerts"][number], t: T): string {
  if (a.kind === "tokenRefused") return t("activity.alerts.tokenRefused");
  if (a.kind === "tokenStale") return t("activity.alerts.tokenStale");
  return t("activity.alerts.clientErrors", { n: a.count ?? 0 });
}

/** Ceux qui sont là maintenant : ce qu'ils regardent, sur quoi, où ils en sont. */
function LiveCard({ a, now }: { a: AccountSummary; now: number }) {
  const t = useT();
  const playing = a.nowPlaying;
  const pingTitle = a.presence.playing?.title;
  return (
    <ActivityLink to={{ kind: "account", id: a.id }} className="card flex gap-3 p-3 transition-colors hover:bg-white/[0.04]">
      <Avatar name={a.name} size={40} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate font-semibold text-white">{a.name}</span>
          <PresenceBadge presence={a.presence} nowPlaying={playing} now={now} />
        </span>
        {playing ? (
          <>
            <span className="mt-1 block truncate text-sm text-slate-200">{playing.title}</span>
            <Progress position={playing.positionSeconds} runtime={playing.runtimeSeconds} />
            <span className="mt-1 flex flex-wrap gap-x-2 text-xs text-slate-500">
              <span>
                {clock(playing.positionSeconds)} / {clock(playing.runtimeSeconds)}
              </span>
              {playing.paused && <span className="text-amber-300">{t("activity.live.paused")}</span>}
              {playing.device && <span>{playing.device}</span>}
              {playing.method && <span>{playing.method}</span>}
            </span>
          </>
        ) : pingTitle ? (
          <span className="mt-1 block truncate text-sm text-slate-200">{pingTitle}</span>
        ) : (
          <span className="mt-1 block text-xs text-slate-500">{a.presence.devices.join(" · ") || t("activity.live.browsing")}</span>
        )}
      </span>
    </ActivityLink>
  );
}

function AccountRow({ a, now }: { a: AccountSummary; now: number }) {
  const t = useT();
  return (
    <ActivityLink to={{ kind: "account", id: a.id }} className="group grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03] md:grid-cols-[auto_minmax(0,1.4fr)_repeat(4,minmax(0,1fr))_auto]">
      <Avatar name={a.name} />
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="truncate font-medium text-white">{a.name}</span>
          {a.admin && <span className="rounded bg-accent-500/15 px-1.5 py-0.5 text-[10px] text-accent-300">{t("activity.accounts.admin")}</span>}
          {a.disabled && <span className="rounded bg-slate-500/20 px-1.5 py-0.5 text-[10px] text-slate-300">{t("activity.accounts.disabled")}</span>}
          {a.alerts.map((al) => (
            <AlertChip key={al.kind} label={alertLabel(al, t)} />
          ))}
        </span>
        <PresenceBadge presence={a.presence} nowPlaying={a.nowPlaying} now={now} />
      </span>
      <span className="hidden text-xs md:block">
        <span className="block text-slate-500">{t("activity.accounts.appSeen")}</span>
        <span className="text-slate-300">{ago(a.app.lastSeen, now, t)}</span>
      </span>
      <span className="hidden text-xs md:block">
        <span className="block text-slate-500">{t("activity.accounts.serverSeen")}</span>
        <span className="text-slate-300">{ago(a.jellyfin.lastActivity, now, t)}</span>
      </span>
      <span className="hidden text-xs md:block">
        <span className="block text-slate-500">{t("activity.accounts.week")}</span>
        <span className="text-slate-300">
          {t("activity.accounts.weekValue", { n: a.week.seances, d: hours(a.week.watchedSeconds) })}
        </span>
      </span>
      <span className="hidden text-xs md:block">
        <span className="block text-slate-500">{t("activity.accounts.sessions")}</span>
        <span className={a.week.problems ? "text-amber-300" : "text-slate-300"}>
          {a.app.sessions} · {t("activity.accounts.problems", { n: a.week.problems })}
        </span>
      </span>
      <span className="text-slate-600 transition-transform group-hover:translate-x-0.5">›</span>
    </ActivityLink>
  );
}

/** La vue d'ensemble : en direct, à regarder, la semaine, les comptes, le fil des séances. */
export function ActivityOverview() {
  const t = useT();
  const { data, error, isLoading, mutate } = useSWR<Overview>("/api/admin/activity", fetcher, { refreshInterval: 20_000 });

  if (isLoading && !data) return <LoadingState />;
  if (error || !data) return <ErrorState message={t("activity.loadError")} onRetry={() => mutate()} />;

  const { now, accounts, signals: s, recent } = data;
  const live = accounts.filter((a) => a.nowPlaying || a.presence.state !== "away");
  const playingCount = live.filter((a) => a.nowPlaying || a.presence.state === "playing").length;
  const alerts = accounts.filter((a) => a.alerts.length);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-400">
          {t("activity.subtitle", { playing: playingCount, app: live.length - playingCount, total: accounts.length })}
        </p>
        <div className="flex gap-2">
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

      {/* 1. Maintenant. */}
      <Panel title={t("activity.live.title")} icon={Radio}>
        {live.length ? (
          <div className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3">
            {live.map((a) => (
              <LiveCard key={a.id} a={a} now={now} />
            ))}
          </div>
        ) : (
          <p className="px-4 py-6 text-sm text-slate-500">{t("activity.live.nobody")}</p>
        )}
      </Panel>

      {/* 2. Ce qui demande un regard. */}
      {alerts.length > 0 && (
        <Panel title={t("activity.alerts.title")} icon={ShieldAlert}>
          <ul className="divide-y divide-white/5">
            {alerts.map((a) => (
              <li key={a.id}>
                <ActivityLink to={{ kind: "account", id: a.id }} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm hover:bg-white/[0.03]">
                  <span className="font-medium text-white">{a.name}</span>
                  {a.alerts.map((al) => (
                    <span key={al.kind} className="text-xs text-slate-400">
                      {alertLabel(al, t)} · {ago(al.at, now, t)}
                    </span>
                  ))}
                </ActivityLink>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {/* Les signalements qui attendent une réponse. */}
      <ReportsPanel now={now} />

      {/* 3. La semaine en chiffres. */}
      <div>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">{t("activity.week.title")}</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile icon={Clapperboard} label={t("activity.week.seances")} value={s.seances} hint={t("activity.week.viewers", { n: s.viewers })} />
          <Tile icon={Clock} label={t("activity.week.watched")} value={hours(s.watchedSeconds)} />
          <Tile
            icon={Hourglass}
            label={t("activity.week.waits")}
            value={s.waits}
            hint={t("activity.week.waitsHint", { d: secs(s.waitedMs) })}
            tone={s.waits > 20 ? "warn" : "default"}
          />
          <Tile
            icon={FastForward}
            label={t("activity.week.slowSeeks")}
            value={s.slowSeeks}
            hint={t("activity.week.slowSeeksHint", { n: s.seeks })}
            tone={s.slowSeeks > 0 ? "warn" : "good"}
          />
          <Tile icon={Wrench} label={t("activity.week.rebuilds")} value={s.rebuilds} hint={t("activity.week.stalls", { n: s.stalls })} tone={s.rebuilds ? "warn" : "good"} />
          <Tile icon={ServerCrash} label={t("activity.week.fallbacks")} value={s.fallbacks} hint={t("activity.week.lost", { n: s.lost })} tone={s.fallbacks ? "warn" : "good"} />
          <Tile
            icon={AlertTriangle}
            label={t("activity.week.clientErrors")}
            value={s.clientErrors}
            hint={s.staleReloads ? t("activity.week.staleReloads", { n: s.staleReloads }) : undefined}
            tone={s.clientErrors ? "bad" : "good"}
          />
          <Tile icon={KeyRound} label={t("activity.week.tokenRefusals")} value={s.tokenRefusals} tone={s.tokenRefusals ? "bad" : "good"} />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title={t("activity.week.perDay")} icon={Activity}>
          <div className="p-4">
            <DayBars days={s.perDay} />
            <p className="mt-3 flex gap-4 text-xs text-slate-500">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-sm bg-accent-500/70" />
                {t("activity.week.legendSeances")}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-sm bg-amber-400/80" />
                {t("activity.week.legendProblems")}
              </span>
            </p>
          </div>
        </Panel>

        <Panel title={t("activity.week.troubled")} icon={AlertTriangle}>
          {s.troubledTitles.length ? (
            <ul className="divide-y divide-white/5">
              {s.troubledTitles.map((tt) => (
                <li key={tt.itemId ?? tt.title} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                  <span className="truncate text-slate-200">{tt.title}</span>
                  <span className="shrink-0 text-xs text-slate-500">
                    {t("activity.week.troubledValue", { p: tt.problems, n: tt.seances })}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-6 text-sm text-slate-500">{t("activity.week.noTrouble")}</p>
          )}
        </Panel>

        <Panel title={t("activity.week.rebuildReasons")} icon={Wrench}>
          {s.rebuildReasons.length ? (
            <ul className="divide-y divide-white/5">
              {s.rebuildReasons.map((r) => (
                <li key={r.reason} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                  <span className="truncate font-mono text-xs text-slate-300">{r.reason}</span>
                  <span className="shrink-0 tabular-nums text-slate-400">{r.count}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-6 text-sm text-slate-500">{t("activity.week.noRebuild")}</p>
          )}
        </Panel>

        <Panel
          title={t("activity.week.serverErrors")}
          icon={ServerCrash}
          action={
            <ActivityLink to={{ kind: "logs", preset: { source: "server" } }} className="text-xs text-accent-300 hover:underline">
              {t("activity.logs.open")}
            </ActivityLink>
          }
        >
          {s.serverErrors.length ? (
            <ul className="divide-y divide-white/5">
              {s.serverErrors.map((e) => (
                <li key={e.scope} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                  <ActivityLink to={{ kind: "logs", preset: { source: "server", type: e.scope } }} className="truncate font-mono text-xs text-slate-300 hover:text-white">
                    {e.scope}
                  </ActivityLink>
                  <span className="shrink-0 tabular-nums text-slate-400">{e.count}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-6 text-sm text-slate-500">{t("activity.week.noServerError")}</p>
          )}
        </Panel>
      </div>

      {/* 4. Les comptes. */}
      <Panel title={t("activity.accounts.title", { n: accounts.length })} icon={Users}>
        <div className="divide-y divide-white/5">
          {accounts.map((a) => (
            <AccountRow key={a.id} a={a} now={now} />
          ))}
        </div>
      </Panel>

      <HouseholdSection h={data.household} now={now} />

      {/* 5. Le fil des séances. */}
      <Panel
        title={t("activity.recent.title")}
        icon={Clapperboard}
        action={
          <ActivityLink to={{ kind: "logs", preset: {} }} className="text-xs text-accent-300 hover:underline">
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
    </div>
  );
}
