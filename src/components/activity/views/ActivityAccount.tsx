"use client";

import { useState } from "react";
import useSWR from "swr";
import {
  AlertTriangle,
  Bell,
  CalendarClock,
  Check,
  Clapperboard,
  Clock,
  Eye,
  EyeOff,
  History,
  KeyRound,
  ListChecks,
  LogOut,
  MessageSquareWarning,
  MonitorSmartphone,
  Pencil,
  PlayCircle,
  RotateCcw,
  Send,
  ShieldCheck,
  Smartphone,
  UserRound,
  Wrench,
  X,
} from "lucide-react";
import { fetcher } from "@/lib/swr";
import { apiAction } from "@/lib/apiAction";
import { useToast } from "@/components/Toast";
import { LoadingState, ErrorState } from "@/components/StateViews";
import { useT } from "@/components/TranslationProvider";
import {
  Avatar,
  Panel,
  Poster,
  PresenceBadge,
  Progress,
  SeanceRow,
  Tile,
  ago,
  clock,
  fullDate,
  hours,
  type T,
} from "@/components/activity/parts";
import { DeviceQualityList, Heatmap, TopTitles, AuthList, NotificationList } from "@/components/activity/insights";
import { ReportRowView } from "@/components/reports/ReportParts";
import { goTo } from "@/components/activity/nav";
import type { AccountDetail, MediaEntry } from "@/lib/activity/accounts";
import { NOTIFICATION_CATEGORIES } from "@/lib/notifications";

type Detail = AccountDetail & { now: number };
type Tab = "seances" | "resume" | "recent" | "watchlist" | "requests" | "devices" | "habits" | "auth" | "notifications" | "reports" | "errors";

/** Un « oui / non » sans fenêtre : le bouton demande confirmation à lui-même, le temps d'un clic. */
function ConfirmButton({ label, confirm, onConfirm, danger = false }: { label: string; confirm: string; onConfirm: () => Promise<void>; danger?: boolean }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  return armed ? (
    <span className="inline-flex gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onConfirm();
          } finally {
            setBusy(false);
            setArmed(false);
          }
        }}
        className={`${danger ? "btn-danger" : "btn-primary"} px-2.5 py-1 text-xs`}
      >
        <Check size={13} />
        {confirm}
      </button>
      <button type="button" onClick={() => setArmed(false)} className="btn-ghost px-2 py-1 text-xs">
        <X size={13} />
      </button>
    </span>
  ) : (
    <button type="button" onClick={() => setArmed(true)} className={`btn-ghost px-2.5 py-1 text-xs ${danger ? "text-rose-300" : ""}`}>
      {label}
    </button>
  );
}

function requestStatus(status: number, t: T): { label: string; tone: string } {
  switch (status) {
    case 1:
      return { label: t("activity.requests.pending"), tone: "bg-amber-500/15 text-amber-300" };
    case 2:
      return { label: t("activity.requests.approved"), tone: "bg-sky-500/15 text-sky-300" };
    case 3:
      return { label: t("activity.requests.declined"), tone: "bg-rose-500/15 text-rose-300" };
    case 4:
      return { label: t("activity.requests.failed"), tone: "bg-rose-500/15 text-rose-300" };
    default:
      return { label: t("activity.requests.available"), tone: "bg-emerald-500/15 text-emerald-300" };
  }
}

/** Un titre de la bibliothèque, avec ce qu'on peut y faire pour cette personne. */
function MediaRow({
  m,
  now,
  onAction,
  actions,
}: {
  m: MediaEntry;
  now: number;
  onAction: (action: string, itemId: string, seconds?: number) => Promise<void>;
  actions: ("played" | "unplayed" | "position" | "clear")[];
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [minutes, setMinutes] = useState(() => String(Math.round((m.positionSeconds ?? 0) / 60)));
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <Poster itemId={m.itemId} tag={m.imageTag} kind={m.kind} className="h-14 w-10" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-white">{m.title}</span>
        <span className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-slate-500">
          {m.year && <span>{m.year}</span>}
          {m.positionSeconds != null && (
            <span>
              {clock(m.positionSeconds)} / {clock(m.runtimeSeconds)}
            </span>
          )}
          {m.lastPlayed && <span title={fullDate(m.lastPlayed)}>{ago(m.lastPlayed, now, t)}</span>}
          {m.played && <span className="text-emerald-300">{t("activity.media.played")}</span>}
        </span>
        <Progress position={m.positionSeconds} runtime={m.runtimeSeconds} />
        {editing && (
          <span className="mt-2 flex items-center gap-2">
            <input
              type="number"
              min={0}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              className="input w-24 py-1 text-xs"
              aria-label={t("activity.media.minutes")}
            />
            <span className="text-xs text-slate-500">{t("activity.media.minutes")}</span>
            <button
              type="button"
              className="btn-primary px-2.5 py-1 text-xs"
              onClick={async () => {
                await onAction("setPosition", m.itemId, Math.max(0, Number(minutes) || 0) * 60);
                setEditing(false);
              }}
            >
              {t("activity.media.save")}
            </button>
            <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setEditing(false)}>
              <X size={13} />
            </button>
          </span>
        )}
      </span>
      <span className="flex shrink-0 flex-wrap justify-end gap-1">
        {actions.includes("position") && !editing && (
          <button type="button" title={t("activity.media.setPosition")} onClick={() => setEditing(true)} className="btn-ghost p-1.5">
            <Pencil size={14} />
          </button>
        )}
        {actions.includes("clear") && (
          <button type="button" title={t("activity.media.clear")} onClick={() => onAction("setPosition", m.itemId, 0)} className="btn-ghost p-1.5">
            <RotateCcw size={14} />
          </button>
        )}
        {actions.includes("played") && (
          <button type="button" title={t("activity.media.markPlayed")} onClick={() => onAction("markPlayed", m.itemId)} className="btn-ghost p-1.5">
            <Eye size={14} />
          </button>
        )}
        {actions.includes("unplayed") && (
          <button type="button" title={t("activity.media.markUnplayed")} onClick={() => onAction("markUnplayed", m.itemId)} className="btn-ghost p-1.5">
            <EyeOff size={14} />
          </button>
        )}
      </span>
    </li>
  );
}

function Empty({ label }: { label: string }) {
  return <p className="px-4 py-8 text-center text-sm text-slate-500">{label}</p>;
}

function Unavailable() {
  const t = useT();
  return <Empty label={t("activity.unavailable")} />;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 py-2 text-sm">
      <span className="text-slate-400">{label}</span>
      <span className="text-right text-slate-200">{value}</span>
    </div>
  );
}

/** Tout ce que l'application et le serveur média savent d'un compte, et les actions sur lui. */
export function ActivityAccount({ id }: { id: string }) {
  const t = useT();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("seances");
  const { data, error, isLoading, mutate } = useSWR<Detail>(`/api/admin/activity/accounts/${id}`, fetcher, { refreshInterval: 30_000 });

  if (isLoading && !data) return <LoadingState />;
  if (error || !data) return <ErrorState message={t("activity.loadError")} onRetry={() => mutate()} />;

  const d = data;
  const now = d.now;

  const act = async (action: string, itemId?: string, seconds?: number, jti?: string) => {
    try {
      await apiAction(`/api/admin/activity/accounts/${id}`, { method: "POST", body: JSON.stringify({ action, itemId, seconds, jti }) });
      toast.success(t("activity.actions.done"));
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("activity.actions.failed"));
    }
  };

  const tabs: { key: Tab; label: string; count: number | null; icon: React.ElementType }[] = [
    { key: "seances", label: t("activity.tabs.seances"), count: d.seances.length, icon: Clapperboard },
    { key: "resume", label: t("activity.tabs.resume"), count: d.library.resume?.length ?? null, icon: PlayCircle },
    { key: "recent", label: t("activity.tabs.recent"), count: d.library.recent?.length ?? null, icon: History },
    { key: "watchlist", label: t("activity.tabs.watchlist"), count: d.watchlist.length, icon: ListChecks },
    { key: "requests", label: t("activity.tabs.requests"), count: d.requests?.length ?? null, icon: Send },
    { key: "devices", label: t("activity.tabs.devices"), count: d.quality.length, icon: MonitorSmartphone },
    { key: "habits", label: t("activity.tabs.habits"), count: null, icon: CalendarClock },
    { key: "auth", label: t("activity.tabs.auth"), count: d.auth.length, icon: KeyRound },
    { key: "notifications", label: t("activity.tabs.notifications"), count: d.notificationsReceived.length, icon: Bell },
    { key: "reports", label: t("activity.tabs.reports"), count: d.reports.length, icon: MessageSquareWarning },
    { key: "errors", label: t("activity.tabs.errors"), count: d.errors.length, icon: AlertTriangle },
  ];

  const p = d.profile;
  const playing = d.nowPlaying;

  return (
    <div className="space-y-6">
      {/* L'identité, l'état, et l'action qui compte. */}
      <div className="flex flex-wrap items-center gap-4">
        <Avatar name={d.name} size={56} />
        <div className="min-w-0 flex-1">
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold text-white">
            {d.name}
            {p.admin && <span className="rounded bg-accent-500/15 px-1.5 py-0.5 text-xs font-medium text-accent-300">{t("activity.accounts.admin")}</span>}
            {p.disabled && <span className="rounded bg-slate-500/20 px-1.5 py-0.5 text-xs text-slate-300">{t("activity.accounts.disabled")}</span>}
          </h1>
          <PresenceBadge presence={d.presence} nowPlaying={playing} now={now} />
        </div>
        {d.appSessions.length > 0 && (
          <ConfirmButton
            label={t("activity.actions.closeAll", { n: d.appSessions.length })}
            confirm={t("activity.actions.confirm")}
            danger
            onConfirm={() => act("closeSessions")}
          />
        )}
      </div>

      {playing && (
        <div className="card flex items-center gap-4 border border-emerald-500/20 p-4">
          <Poster itemId={playing.itemId} className="h-16 w-11" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium uppercase tracking-wide text-emerald-300">{t("activity.live.nowWatching")}</p>
            <p className="truncate text-white">{playing.title}</p>
            <Progress position={playing.positionSeconds} runtime={playing.runtimeSeconds} />
            <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-400">
              <span>
                {clock(playing.positionSeconds)} / {clock(playing.runtimeSeconds)}
              </span>
              {playing.paused && <span className="text-amber-300">{t("activity.live.paused")}</span>}
              {playing.device && <span>{playing.device}</span>}
              {playing.client && <span>{playing.client}</span>}
              {playing.method && <span>{playing.method}</span>}
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Tile icon={Clapperboard} label={t("activity.account.seances")} value={d.stats.seances} hint={t("activity.account.historyHint", { n: d.historyDays })} />
        <Tile icon={Clock} label={t("activity.account.watched")} value={hours(d.stats.watchedSeconds)} hint={t("activity.account.historyHint", { n: d.historyDays })} />
        <Tile icon={CalendarClock} label={t("activity.account.thisWeek")} value={d.stats.weekSeances} hint={hours(d.stats.weekWatchedSeconds)} />
        <Tile icon={Wrench} label={t("activity.account.problems")} value={d.stats.problems} tone={d.stats.problems ? "warn" : "good"} />
        <Tile icon={Eye} label={t("activity.account.played")} value={d.library.playedMovies ?? "—"} hint={t("activity.account.playedEpisodes", { n: d.library.playedEpisodes ?? "—" })} />
        <Tile icon={UserRound} label={t("activity.account.firstSeen")} value={d.stats.firstSeen ? ago(d.stats.firstSeen, now, t) : "—"} hint={d.stats.devices.join(" · ")} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* Ce qu'il a fait. */}
        <section className="card min-w-0 self-start overflow-hidden">
          <div className="scrollbar-thin flex gap-1 overflow-x-auto border-b border-white/5 px-2">
            {tabs.map(({ key, label, count, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm transition-colors ${
                  tab === key ? "border-accent-500 text-white" : "border-transparent text-slate-400 hover:text-slate-200"
                }`}
              >
                <Icon size={14} />
                {label}
                {count != null && <span className="rounded-full bg-white/10 px-1.5 text-[10px] tabular-nums">{count}</span>}
              </button>
            ))}
          </div>

          {tab === "seances" &&
            (d.seances.length ? (
              <div className="divide-y divide-white/5">
                {d.seances.map((s) => (
                  <SeanceRow key={s.id} s={s} now={now} />
                ))}
              </div>
            ) : (
              <Empty label={t("activity.empty.seances")} />
            ))}

          {tab === "resume" &&
            (d.library.resume === null ? (
              <Unavailable />
            ) : d.library.resume.length ? (
              <ul className="divide-y divide-white/5">
                {d.library.resume.map((m) => (
                  <MediaRow key={m.itemId} m={m} now={now} onAction={(a, i, s) => act(a, i, s)} actions={["position", "clear", "played"]} />
                ))}
              </ul>
            ) : (
              <Empty label={t("activity.empty.resume")} />
            ))}

          {tab === "recent" &&
            (d.library.recent === null ? (
              <Unavailable />
            ) : d.library.recent.length ? (
              <ul className="divide-y divide-white/5">
                {d.library.recent.map((m) => (
                  <MediaRow key={m.itemId} m={m} now={now} onAction={(a, i, s) => act(a, i, s)} actions={["unplayed"]} />
                ))}
              </ul>
            ) : (
              <Empty label={t("activity.empty.recent")} />
            ))}

          {tab === "watchlist" &&
            (d.watchlist.length ? (
              <ul className="divide-y divide-white/5">
                {d.watchlist.map((w) => (
                  <li key={w.id} className="flex items-center gap-3 px-4 py-2.5">
                    {w.posterPath ? (
                      // eslint-disable-next-line @next/next/no-img-element -- affiche TMDB déjà en petite taille
                      <img src={`https://image.tmdb.org/t/p/w92${w.posterPath}`} alt="" loading="lazy" className="h-14 w-10 shrink-0 rounded bg-white/5 object-cover" />
                    ) : (
                      <Poster itemId={null} className="h-14 w-10" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-white">{w.title}</span>
                      <span className="text-xs text-slate-500">
                        {w.year ?? ""} · {w.mediaType === "movie" ? t("activity.media.movie") : t("activity.media.series")} ·{" "}
                        {t("activity.media.added", { when: ago(w.createdAt, now, t) })}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty label={t("activity.empty.watchlist")} />
            ))}

          {tab === "requests" &&
            (d.requests === null ? (
              <Unavailable />
            ) : d.requests.length ? (
              <ul className="divide-y divide-white/5">
                {d.requests.map((r) => {
                  const st = requestStatus(r.mediaStatus === 5 ? 5 : r.status, t);
                  return (
                    <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                      {r.posterPath ? (
                        // eslint-disable-next-line @next/next/no-img-element -- affiche TMDB déjà en petite taille
                        <img src={`https://image.tmdb.org/t/p/w92${r.posterPath}`} alt="" loading="lazy" className="h-14 w-10 shrink-0 rounded bg-white/5 object-cover" />
                      ) : (
                        <Poster itemId={null} className="h-14 w-10" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-white">{r.title}</span>
                        <span className="text-xs text-slate-500">
                          {r.mediaType === "movie" ? t("activity.media.movie") : t("activity.media.series")} · {ago(r.createdAt, now, t)}
                        </span>
                      </span>
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${st.tone}`}>{st.label}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Empty label={t("activity.empty.requests")} />
            ))}

          {tab === "devices" && <DeviceQualityList devices={d.quality} />}

          {tab === "habits" && (
            <div className="space-y-5 py-4">
              <div className="px-4">
                <Heatmap heatmap={d.habits.heatmap} />
              </div>
              <div>
                <h3 className="px-4 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{t("activity.habits.top")}</h3>
                <TopTitles habits={d.habits} />
              </div>
              <div>
                <h3 className="px-4 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{t("activity.habits.seriesInProgress")}</h3>
                {d.seriesInProgress === null ? (
                  <Unavailable />
                ) : d.seriesInProgress.length ? (
                  <ul className="divide-y divide-white/5">
                    {d.seriesInProgress.map((m) => (
                      <MediaRow key={m.itemId} m={m} now={now} onAction={(a, i, s) => act(a, i, s)} actions={["played"]} />
                    ))}
                  </ul>
                ) : (
                  <Empty label={t("activity.habits.noSeries")} />
                )}
              </div>
            </div>
          )}

          {tab === "auth" && <AuthList events={d.auth} now={now} />}

          {tab === "notifications" && <NotificationList items={d.notificationsReceived} now={now} />}

          {tab === "reports" &&
            (d.reports.length ? (
              <div className="divide-y divide-white/5">
                {d.reports.map((r) => (
                  <ReportRowView key={r.id} r={r} when={ago(r.sentAt, now, t)} onOpen={() => goTo({ kind: "report", id: r.id })} />
                ))}
              </div>
            ) : (
              <Empty label={t("activity.empty.reports")} />
            ))}

          {tab === "errors" &&
            (d.errors.length ? (
              <ul className="divide-y divide-white/5">
                {d.errors.map((e) => (
                  <li key={`${e._file}:${e._line}`} className="px-4 py-2.5 text-sm">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">{String(e.scope ?? e.level ?? "?")}</span>
                      <span className="text-xs text-slate-500" title={fullDate(e._t)}>
                        {ago(e._t, now, t)}
                      </span>
                      {typeof e.source === "string" && <span className="font-mono text-[10px] text-slate-500">{e.source}</span>}
                    </span>
                    <span className="mt-1 block break-words text-slate-200">{String(e.message ?? "")}</span>
                    {typeof e.url === "string" && <span className="block truncate font-mono text-[11px] text-slate-500">{e.url}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty label={t("activity.empty.errors")} />
            ))}
        </section>

        {/* Qui il est, et par où il passe. */}
        <div className="space-y-6">
          <Panel title={t("activity.account.profile")} icon={ShieldCheck}>
            <div className="divide-y divide-white/5">
              <Row label={t("activity.account.lastLogin")} value={<span title={fullDate(p.lastLogin)}>{ago(p.lastLogin, now, t)}</span>} />
              <Row label={t("activity.account.lastServerActivity")} value={<span title={fullDate(p.lastActivity)}>{ago(p.lastActivity, now, t)}</span>} />
              <Row label={t("activity.account.remoteAccess")} value={p.remoteAccess ? t("activity.yes") : t("activity.no")} />
              <Row label={t("activity.account.playback")} value={p.playback ? t("activity.yes") : t("activity.no")} />
              <Row label={t("activity.account.invalidLogins")} value={<span className={p.invalidLogins ? "text-amber-300" : ""}>{p.invalidLogins}</span>} />
              <Row label={t("activity.account.language")} value={p.lang || t("activity.account.defaultLanguage")} />
              <Row label={t("activity.account.onboarding")} value={p.onboardingPending ? t("activity.account.onboardingPending") : t("activity.account.onboardingDone")} />
            </div>
          </Panel>

          <Panel title={t("activity.account.notifications")} icon={Bell}>
            <div className="divide-y divide-white/5">
              <Row label={t("activity.account.pushDevices")} value={p.pushDevices} />
              <Row label={t("activity.account.followedRequests")} value={p.followedRequests} />
              {NOTIFICATION_CATEGORIES.map((category) => (
                <Row
                  key={category.id}
                  label={t(category.labelKey)}
                  value={p.notifications[category.id] ? t("activity.yes") : t("activity.no")}
                />
              ))}
            </div>
          </Panel>

          <Panel title={t("activity.account.appSessions", { n: d.appSessions.length })} icon={KeyRound}>
            {d.appSessions.length ? (
              <ul className="divide-y divide-white/5">
                {d.appSessions.map((s) => (
                  <li key={s.jti} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <Smartphone size={15} className="shrink-0 text-slate-500" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-slate-200">{s.device ?? t("activity.account.unknownDevice")}</span>
                      <span className="text-xs text-slate-500">
                        {t("activity.account.sessionDates", { opened: ago(s.createdAt, now, t), seen: ago(s.lastSeenAt, now, t) })}
                      </span>
                    </span>
                    <ConfirmButton label={t("activity.actions.close")} confirm={t("activity.actions.confirm")} danger onConfirm={() => act("closeSessions", undefined, undefined, s.jti)} />
                  </li>
                ))}
              </ul>
            ) : (
              <Empty label={t("activity.empty.sessions")} />
            )}
          </Panel>

          <Panel title={t("activity.account.devices", { n: d.devices?.length ?? 0 })} icon={MonitorSmartphone}>
            {d.devices === null ? (
              <Unavailable />
            ) : d.devices.length ? (
              <ul className="scrollbar-thin max-h-80 divide-y divide-white/5 overflow-y-auto">
                {d.devices.map((dev) => (
                  <li key={dev.id} className="px-4 py-2 text-sm">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-slate-200">{dev.app}</span>
                      <span className="shrink-0 text-xs text-slate-500" title={fullDate(dev.lastActivity)}>
                        {ago(dev.lastActivity, now, t)}
                      </span>
                    </span>
                    <span className="block truncate text-xs text-slate-500">
                      {dev.name}
                      {dev.version ? ` · ${dev.version}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty label={t("activity.empty.devices")} />
            )}
          </Panel>

          <p className="flex items-start gap-2 px-1 text-xs text-slate-500">
            <LogOut size={13} className="mt-0.5 shrink-0" />
            {t("activity.account.closeHint")}
          </p>
        </div>
      </div>
    </div>
  );
}
