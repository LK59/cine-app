"use client";

// Les briques de la page d'activité de l'administrateur : présence, chiffres, séances.
//
// Les durées relatives (« il y a 3 min ») se calculent contre l'heure que le serveur a renvoyée
// avec les données, jamais contre `Date.now()` pendant le rendu : un rendu doit être pur, et deux
// affichages des mêmes données doivent dire la même chose.

import { useState } from "react";
import { AlertTriangle, ChevronRight, Film, MonitorSmartphone, Tv } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import type { Seance } from "@/lib/activity/seances";
import type { Presence } from "@/lib/activity/presence";
import type { NowPlaying } from "@/lib/activity/accounts";
import { ActivityLink } from "@/components/activity/nav";

export type T = ReturnType<typeof useT>;

/** « il y a 3 min », contre l'heure du serveur. */
export function ago(ts: number | null | undefined, now: number, t: T): string {
  if (!ts) return "—";
  const minutes = Math.floor((now - ts) / 60000);
  if (minutes < 1) return t("common.time.justNow");
  if (minutes < 60) return t("common.time.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("common.time.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("common.time.daysAgo", { n: days });
  return t("common.time.monthsAgo", { n: Math.floor(days / 30) });
}

/** 7 530 s → « 2 h 05 » ; 300 s → « 5 min ». */
export function hours(seconds: number | null | undefined): string {
  if (!seconds || seconds < 60) return seconds ? "< 1 min" : "0";
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`;
}

/** 1 293 ms → « 1,3 s ». */
export function secs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** 3 723 s → « 1:02:03 ». */
export function clock(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function fullDate(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

const STATE_STYLES = {
  playing: { dot: "bg-emerald-400", ring: "shadow-[0_0_0_3px_rgba(52,211,153,0.25)]", text: "text-emerald-300" },
  app: { dot: "bg-sky-400", ring: "shadow-[0_0_0_3px_rgba(56,189,248,0.2)]", text: "text-sky-300" },
  away: { dot: "bg-slate-600", ring: "", text: "text-slate-400" },
} as const;

/** L'état en une pastille : en lecture, dans l'application, ou absent depuis… */
export function PresenceBadge({ presence, nowPlaying, now }: { presence: Presence; nowPlaying?: NowPlaying | null; now: number }) {
  const t = useT();
  const state = nowPlaying ? "playing" : presence.state;
  const style = STATE_STYLES[state];
  const label =
    state === "playing"
      ? t("activity.presence.playing")
      : state === "app"
        ? t("activity.presence.app")
        : presence.lastSeen
          ? t("activity.presence.awaySince", { when: ago(presence.lastSeen, now, t) })
          : t("activity.presence.away");
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${style.text}`}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot} ${style.ring} ${state !== "away" ? "animate-pulse" : ""}`} />
      {label}
    </span>
  );
}

/** Une initiale dans un rond, teinte stable par nom : de quoi reconnaître quelqu'un d'un coup d'œil. */
export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) % 360;
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.42, background: `hsl(${hash} 45% 38%)` }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function Tile({
  icon: Icon,
  label,
  value,
  hint,
  tone = "default",
}: {
  icon: React.ElementType;
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const toneClass = { default: "text-white", good: "text-emerald-300", warn: "text-amber-300", bad: "text-rose-300" }[tone];
  return (
    <div className="card flex flex-col gap-1 p-4">
      <span className="flex items-center gap-1.5 text-xs text-slate-400">
        <Icon size={13} />
        {label}
      </span>
      <span className={`text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</span>
      {hint && <span className="text-xs text-slate-500">{hint}</span>}
    </div>
  );
}

/** Une carte titrée — l'unité de la page. */
export function Panel({
  title,
  icon: Icon,
  action,
  children,
  className = "",
}: {
  title: string;
  icon?: React.ElementType;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`card overflow-hidden ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-white/5 px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
          {Icon && <Icon size={15} className="text-slate-400" />}
          {title}
        </h2>
        {action}
      </header>
      {children}
    </section>
  );
}

/** L'affiche d'un titre de la bibliothèque, ou une icône quand il n'en a pas. */
export function Poster({ itemId, tag, kind, className = "h-14 w-10" }: { itemId: string | null; tag?: string | null; kind?: string; className?: string }) {
  if (!itemId) {
    return (
      <span className={`flex shrink-0 items-center justify-center rounded bg-white/5 text-slate-600 ${className}`}>
        {kind === "episode" ? <Tv size={14} /> : <Film size={14} />}
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element -- une vignette servie par notre propre route, déjà redimensionnée
  return <img src={`/api/jellyfin/image?itemId=${itemId}${tag ? `&tag=${tag}` : ""}`} alt="" loading="lazy" className={`shrink-0 rounded bg-white/5 object-cover ${className}`} />;
}

/** Une barre de progression fine : où en est quelqu'un d'un titre. */
export function Progress({ position, runtime }: { position: number | null; runtime: number | null }) {
  if (!position || !runtime) return null;
  const pct = Math.min(100, Math.max(0, (position / runtime) * 100));
  return (
    <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-white/10">
      <span className="block h-full rounded-full bg-accent-500" style={{ width: `${pct}%` }} />
    </span>
  );
}

/** Les incidents d'une séance en petites étiquettes — rien quand tout s'est bien passé. */
export function SeanceFlags({ s }: { s: Seance }) {
  const t = useT();
  const flags: { label: string; tone: string }[] = [];
  if (s.fallbacks) flags.push({ label: t("activity.flags.fallback", { n: s.fallbacks }), tone: "bg-rose-500/15 text-rose-300" });
  if (s.errors) flags.push({ label: t("activity.flags.error", { n: s.errors }), tone: "bg-rose-500/15 text-rose-300" });
  if (s.rebuilds) flags.push({ label: t("activity.flags.rebuild", { n: s.rebuilds }), tone: "bg-amber-500/15 text-amber-300" });
  if (s.stalls) flags.push({ label: t("activity.flags.stall", { n: s.stalls }), tone: "bg-amber-500/15 text-amber-300" });
  if (s.slowSeeks) flags.push({ label: t("activity.flags.slowSeek", { n: s.slowSeeks }), tone: "bg-amber-500/15 text-amber-300" });
  if (s.stop?.why === "lost") flags.push({ label: t("activity.flags.lost"), tone: "bg-slate-500/20 text-slate-300" });
  if (s.player === "serveur") flags.push({ label: t("activity.flags.server"), tone: "bg-violet-500/15 text-violet-300" });
  if (!flags.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map((f) => (
        <span key={f.label} className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${f.tone}`}>
          {f.label}
        </span>
      ))}
    </span>
  );
}

/** Une séance en une ligne, qui mène à sa chronologie. */
export function SeanceRow({ s, now, showUser = false }: { s: Seance; now: number; showUser?: boolean }) {
  const t = useT();
  const watched = s.stop?.watched;
  return (
    <ActivityLink
      to={{ kind: "seance", id: s.id }}
      className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-white/[0.03]"
    >
      <Poster itemId={s.itemId} kind={s.title.includes(" — S") ? "episode" : "movie"} className="h-12 w-8" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          {showUser && <span className="shrink-0 text-xs font-semibold text-accent-300">{s.user}</span>}
          <span className="truncate text-sm text-white">{s.title}</span>
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
          <span title={fullDate(s.start)}>{ago(s.start, now, t)}</span>
          {s.device && (
            <span className="inline-flex items-center gap-1">
              <MonitorSmartphone size={11} />
              {s.device}
            </span>
          )}
          {watched != null && <span>{t("activity.seance.watched", { d: hours(watched) })}</span>}
          {s.legacy && <span className="italic">{t("activity.seance.legacy")}</span>}
          <SeanceFlags s={s} />
        </span>
      </span>
      <ChevronRight size={15} className="shrink-0 text-slate-600 transition-transform group-hover:translate-x-0.5" />
    </ActivityLink>
  );
}

/** Une courbe en barres, sans bibliothèque : sept jours tiennent dans quelques `div`. */
export function DayBars({ days }: { days: { day: string; seances: number; problems: number }[] }) {
  const max = Math.max(1, ...days.map((d) => d.seances));
  return (
    <div className="flex h-28 items-end gap-2">
      {days.map((d) => (
        <div key={d.day} className="flex flex-1 flex-col items-center gap-1" title={`${d.day} · ${d.seances} · ${d.problems}`}>
          <span className="text-[10px] tabular-nums text-slate-500">{d.seances || ""}</span>
          <div className="relative w-full overflow-hidden rounded-t bg-accent-500/70" style={{ height: `${Math.max(2, (d.seances / max) * 80)}px` }}>
            {d.problems > 0 && (
              <div className="absolute inset-x-0 bottom-0 bg-amber-400/80" style={{ height: `${Math.min(100, (d.problems / Math.max(1, d.seances)) * 100)}%` }} />
            )}
          </div>
          <span className="text-[10px] text-slate-500">
            {new Date(d.day + "T12:00:00").toLocaleDateString([], { weekday: "short" })}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Du JSON lisible, repliable — pour le détail d'une ligne de journal. */
export function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="scrollbar-thin max-h-[60vh] overflow-auto rounded-lg bg-black/40 p-3 text-[11px] leading-relaxed text-slate-300">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/** Une trace (`steps`) : une étape par ligne, au lieu d'une chaîne de trois mille caractères. */
export function Steps({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const steps = text.split(" | ");
  const shown = open ? steps : steps.slice(-6);
  const t = useT();
  return (
    <div className="mt-2 rounded-lg bg-black/30 p-2 font-mono text-[11px] leading-relaxed text-slate-400">
      {steps.length > 6 && (
        <button type="button" onClick={() => setOpen((v) => !v)} className="mb-1 text-accent-300 hover:underline">
          {open ? t("activity.logs.fewerSteps") : t("activity.logs.allSteps", { n: steps.length })}
        </button>
      )}
      {shown.map((step, i) => (
        <div key={i} className="whitespace-pre-wrap break-words">
          {step.trim()}
        </div>
      ))}
    </div>
  );
}

/** Un signal d'alerte en tête d'une carte de compte. */
export function AlertChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium text-rose-300">
      <AlertTriangle size={10} />
      {label}
    </span>
  );
}

/** La couleur d'un type de ligne : le vert de ce qui commence, le rouge de ce qui casse. */
export function kindTone(kind: string, level?: unknown): string {
  if (level === "error" && !["client", "admin"].includes(kind)) return "bg-rose-500/15 text-rose-300";
  switch (kind) {
    case "start":
      return "bg-emerald-500/15 text-emerald-300";
    case "stop":
      return "bg-slate-500/20 text-slate-300";
    case "seek":
    case "audio":
      return "bg-sky-500/15 text-sky-300";
    case "stall":
    case "rebuild":
      return "bg-amber-500/15 text-amber-300";
    case "fallback":
    case "error":
    case "client":
      return "bg-rose-500/15 text-rose-300";
    case "admin":
    case "cast":
      return "bg-violet-500/15 text-violet-300";
    default:
      return "bg-white/10 text-slate-300";
  }
}

const numOf = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strOf = (v: unknown) => (typeof v === "string" && v ? v : null);

/**
 * Une ligne de journal dite en une phrase — « saut de 752 à 762 s, 6,7 s ». Écrit une fois, pour
 * la liste des journaux et pour la chronologie d'une séance.
 */
export function describeLine(line: Record<string, unknown>, t: T): string {
  switch (line.kind) {
    case "start":
      return t("activity.line.start", {
        at: clock(numOf(line.at)),
        path: strOf(line.path) ?? "?",
        opened: secs(numOf(line.openedInMs)),
        rebuild: numOf(line.rebuild) ? t("activity.line.rebuildN", { n: numOf(line.rebuild) ?? 0 }) : "",
      }).trim();
    case "seek":
      return t("activity.line.seek", {
        from: clock(numOf(line.from)),
        to: clock(numOf(line.to)),
        took: secs(numOf(line.tookMs)),
        buffered: line.buffered ? t("activity.line.buffered") : "",
      }).trim();
    case "audio":
      return t("activity.line.audio", {
        from: strOf(line.fromTrack) ?? String(line.from ?? "?"),
        to: strOf(line.toTrack) ?? String(line.to ?? "?"),
        took: secs(numOf(line.tookMs)),
        how: strOf(line.processing) ?? "",
      });
    case "stall":
      return t("activity.line.stall", { at: clock(numOf(line.position)), took: secs(numOf(line.stalledMs)) });
    case "rebuild":
      return t("activity.line.rebuild", { at: clock(numOf(line.at)), reason: strOf(line.reason) ?? "?" });
    case "fallback":
      return t("activity.line.fallback", { reason: strOf(line.reason) ?? "?" });
    case "stop":
      return t("activity.line.stop", {
        why: strOf(line.why) ?? "?",
        watched: hours(numOf(line.watched)),
        at: clock(numOf(line.at)),
      });
    case "error":
      return strOf(line.reason) ?? strOf(line.message) ?? t("activity.line.error");
    case "cast":
      return t("activity.line.cast");
    default:
      return strOf(line.message) ?? strOf(line.reason) ?? "";
  }
}

/** La pastille d'un type de ligne sur la chronologie — des classes écrites en entier, que Tailwind voit. */
export function kindDot(kind: string): string {
  switch (kind) {
    case "start":
      return "bg-emerald-400";
    case "stop":
      return "bg-slate-400";
    case "seek":
    case "audio":
      return "bg-sky-400";
    case "stall":
    case "rebuild":
      return "bg-amber-400";
    case "fallback":
    case "error":
      return "bg-rose-400";
    default:
      return "bg-violet-400";
  }
}
