"use client";

// Les vues qui servent à la fois au foyer (vue d'ensemble) et à un compte : la qualité par
// appareil, les habitudes, les connexions, les notifications. Écrites une fois, pour que les deux
// écrans ne divergent pas.

import { useT } from "@/components/TranslationProvider";
import { ago, fullDate, hours, secs, type T } from "@/components/activity/parts";
import type { DeviceQuality, Habits } from "@/lib/activity/accounts";

/** Un tableau sur grand écran, des cartes sur téléphone : un appareil par ligne. */
export function DeviceQualityList({ devices }: { devices: DeviceQuality[] }) {
  const t = useT();
  if (!devices.length) return <p className="px-4 py-6 text-sm text-slate-500">{t("activity.quality.none")}</p>;
  const tone = (share: number) => (share >= 0.3 ? "text-rose-300" : share >= 0.1 ? "text-amber-300" : "text-emerald-300");
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500">
            <tr className="border-b border-white/5">
              <th className="px-4 py-2 font-medium">{t("activity.quality.device")}</th>
              <th className="px-3 py-2 text-right font-medium">{t("activity.quality.seances")}</th>
              <th className="px-3 py-2 text-right font-medium">{t("activity.quality.watched")}</th>
              <th className="px-3 py-2 text-right font-medium">{t("activity.quality.open")}</th>
              <th className="px-3 py-2 text-right font-medium">{t("activity.quality.waits")}</th>
              <th className="px-3 py-2 text-right font-medium">{t("activity.quality.slowSeeks")}</th>
              <th className="px-3 py-2 text-right font-medium">{t("activity.quality.rebuilds")}</th>
              <th className="px-3 py-2 text-right font-medium">{t("activity.quality.fallbacks")}</th>
              <th className="px-4 py-2 text-right font-medium">{t("activity.quality.troubled")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5 tabular-nums">
            {devices.map((d) => (
              <tr key={d.device}>
                <td className="px-4 py-2 text-slate-200">{d.device}</td>
                <td className="px-3 py-2 text-right text-slate-300">{d.seances}</td>
                <td className="px-3 py-2 text-right text-slate-300">{hours(d.watchedSeconds)}</td>
                <td className="px-3 py-2 text-right text-slate-300">{secs(d.openMs)}</td>
                <td className="px-3 py-2 text-right text-slate-300">
                  {d.waits}
                  {d.waitedMs > 0 && <span className="text-slate-500"> · {secs(d.waitedMs)}</span>}
                </td>
                <td className="px-3 py-2 text-right text-slate-300">{d.slowSeeks}</td>
                <td className="px-3 py-2 text-right text-slate-300">
                  {d.rebuilds}
                  {d.stalls > 0 && <span className="text-slate-500"> · {d.stalls}</span>}
                </td>
                <td className="px-3 py-2 text-right text-slate-300">{d.fallbacks + d.errors}</td>
                <td className={`px-4 py-2 text-right font-medium ${tone(d.troubledShare)}`}>{Math.round(d.troubledShare * 100)} %</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-white/5 md:hidden">
        {devices.map((d) => (
          <li key={d.device} className="px-4 py-3 text-sm">
            <span className="flex items-center justify-between gap-2">
              <span className="truncate font-medium text-slate-200">{d.device}</span>
              <span className={`shrink-0 text-xs font-medium ${tone(d.troubledShare)}`}>{t("activity.quality.troubledShort", { p: Math.round(d.troubledShare * 100) })}</span>
            </span>
            <span className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-400">
              <span>{t("activity.quality.nSeances", { n: d.seances })}</span>
              <span>{hours(d.watchedSeconds)}</span>
              <span>
                {t("activity.quality.open")} {secs(d.openMs)}
              </span>
              <span>{t("activity.quality.nWaits", { n: d.waits })}</span>
              <span>{t("activity.quality.nRebuilds", { n: d.rebuilds })}</span>
              <span>{t("activity.quality.nFallbacks", { n: d.fallbacks + d.errors })}</span>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Jour × heure : l'intensité dit le temps regardé. Lundi en haut, comme un agenda. */
export function Heatmap({ heatmap }: { heatmap: number[][] }) {
  const t = useT();
  const max = Math.max(1, ...heatmap.flat());
  const days = t("activity.habits.days").split("|");
  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[520px] gap-[3px]" style={{ gridTemplateColumns: "2.25rem repeat(24, minmax(0, 1fr))" }}>
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="text-center text-[9px] tabular-nums text-slate-600">
            {h % 3 === 0 ? h : ""}
          </span>
        ))}
        {heatmap.map((row, d) => (
          <div key={d} className="contents">
            <span className="pr-1 text-right text-[10px] leading-4 text-slate-500">{days[d] ?? d}</span>
            {row.map((v, h) => (
              <span
                key={h}
                title={`${days[d] ?? d} ${h}h — ${hours(v)}`}
                className="h-4 rounded-[3px]"
                style={{ background: v ? `rgb(var(--accent-500) / ${0.15 + 0.85 * (v / max)})` : "rgba(255,255,255,0.04)" }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function TopTitles({ habits }: { habits: Habits }) {
  const t = useT();
  if (!habits.topTitles.length) return <p className="px-4 py-6 text-sm text-slate-500">{t("activity.habits.none")}</p>;
  const max = Math.max(1, ...habits.topTitles.map((x) => x.watchedSeconds));
  return (
    <ul className="divide-y divide-white/5">
      {habits.topTitles.map((x) => (
        <li key={x.title} className="px-4 py-2 text-sm">
          <span className="flex items-center justify-between gap-3">
            <span className="truncate text-slate-200">{x.title}</span>
            <span className="shrink-0 text-xs tabular-nums text-slate-500">
              {/* Le temps regardé vient du bilan de séance, qui n'existe que depuis le 23/09/2026 : un
                  « 0 » y serait faux, les séances seules disent la vérité. */}
              {x.watchedSeconds ? `${hours(x.watchedSeconds)} · ` : ""}
              {t("activity.quality.nSeances", { n: x.seances })}
            </span>
          </span>
          <span className="mt-1 block h-1 rounded-full bg-white/5">
            <span className="block h-full rounded-full bg-accent-500/60" style={{ width: `${(x.watchedSeconds / max) * 100}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export interface AuthEvent {
  at: number;
  kind: string;
  user?: string;
  device: unknown;
  ip: unknown;
  reason: unknown;
  count?: unknown;
  by?: unknown;
}

const AUTH_TONE: Record<string, string> = {
  login: "bg-emerald-400",
  "login-failed": "bg-rose-400",
  "token-refused": "bg-rose-400",
  expired: "bg-amber-400",
  logout: "bg-slate-500",
  "others-closed": "bg-sky-400",
  "closed-by-admin": "bg-sky-400",
};

export function authLabel(e: AuthEvent, t: T): string {
  const known = ["login", "login-failed", "logout", "others-closed", "closed-by-admin", "token-refused", "expired"];
  return known.includes(e.kind) ? t(`activity.auth.kinds.${e.kind}`, { n: Number(e.count) || 0 }) : e.kind;
}

/** Les connexions : qui, quoi, depuis quel appareil et quelle adresse. */
export function AuthList({ events, now, showUser = false }: { events: AuthEvent[]; now: number; showUser?: boolean }) {
  const t = useT();
  if (!events.length) return <p className="px-4 py-6 text-sm text-slate-500">{t("activity.auth.none")}</p>;
  return (
    <ul className="divide-y divide-white/5">
      {events.map((e, i) => (
        <li key={i} className="flex items-start gap-3 px-4 py-2.5 text-sm">
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${AUTH_TONE[e.kind] ?? "bg-slate-500"}`} />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-slate-200">
                {showUser && e.user ? `${e.user} — ` : ""}
                {authLabel(e, t)}
              </span>
              {typeof e.reason === "string" && e.reason && <span className="font-mono text-[11px] text-slate-500">{e.reason}</span>}
            </span>
            <span className="block truncate text-xs text-slate-500">
              {[typeof e.device === "string" ? e.device : null, typeof e.ip === "string" ? e.ip : null, typeof e.by === "string" ? t("activity.auth.by", { who: e.by }) : null]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </span>
          <span className="shrink-0 text-xs text-slate-500" title={fullDate(e.at)}>
            {ago(e.at, now, t)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export interface ReceivedNotification {
  at: number;
  category: unknown;
  title: string;
  body: string;
  outcome: Record<string, unknown>;
}

/** Ce qu'il en est advenu chez une personne : remise, refusée, abonnement retiré, ou coupée par son choix. */
function outcomeOf(o: Record<string, unknown>, t: T): { label: string; tone: string } {
  const n = (k: string) => Number(o[k]) || 0;
  if (n("sent") > 0 && n("failed") + n("removed") === 0) return { label: t("activity.notifs.delivered", { n: n("sent") }), tone: "text-emerald-300" };
  if (n("sent") > 0) return { label: t("activity.notifs.partial", { ok: n("sent"), ko: n("failed") + n("removed") }), tone: "text-amber-300" };
  if (n("removed") > 0) return { label: t("activity.notifs.removed"), tone: "text-rose-300" };
  if (n("failed") > 0) return { label: t("activity.notifs.failed"), tone: "text-rose-300" };
  if (o.muted === true) return { label: t("activity.notifs.muted"), tone: "text-slate-500" };
  return { label: t("activity.notifs.noDevice"), tone: "text-slate-500" };
}

export function NotificationList({ items, now }: { items: ReceivedNotification[]; now: number }) {
  const t = useT();
  if (!items.length) return <p className="px-4 py-6 text-sm text-slate-500">{t("activity.notifs.none")}</p>;
  return (
    <ul className="divide-y divide-white/5">
      {items.map((n, i) => {
        const o = outcomeOf(n.outcome, t);
        return (
          <li key={i} className="px-4 py-2.5 text-sm">
            <span className="flex items-center justify-between gap-3">
              <span className="truncate text-slate-200">{n.title}</span>
              <span className="shrink-0 text-xs text-slate-500" title={fullDate(n.at)}>
                {ago(n.at, now, t)}
              </span>
            </span>
            <span className="flex items-center justify-between gap-3 text-xs">
              <span className="truncate text-slate-500">{n.body}</span>
              <span className={`shrink-0 ${o.tone}`}>{o.label}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
