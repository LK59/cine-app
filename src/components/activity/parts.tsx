"use client";

// Les briques de la page d'activité de l'administrateur : présence, chiffres, séances.
//
// Les durées relatives (« il y a 3 min ») se calculent contre l'heure que le serveur a renvoyée
// avec les données, jamais contre `Date.now()` pendant le rendu : un rendu doit être pur, et deux
// affichages des mêmes données doivent dire la même chose.

import { parseTimeline } from "@/lib/playbackTimeline";
import { fmtSize } from "@/lib/format";
import { useState } from "react";
import { AlertTriangle, Check, ChevronRight, Film, MonitorSmartphone, Tv, X } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import type { Seance } from "@/lib/activity/seances";
import { isStartWhy } from "@/lib/serverPlayerLog";
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

/**
 * La langue de l'interface, et non celle du navigateur : un navigateur réglé en anglais écrivait
 * « Wed, Thu » et « Sep 17 » au milieu d'une page en français (relu le 06/10/2026). La racine de
 * la page porte la langue choisie (`<html lang>`, layout).
 */
export function uiLocale(): string | undefined {
  return typeof document !== "undefined" ? document.documentElement.lang || undefined : undefined;
}

/** La plus récente de plusieurs dates, ou `null`. */
export function latest(...ts: (number | null | undefined)[]): number | null {
  const known = ts.filter((x): x is number => typeof x === "number" && x > 0);
  return known.length ? Math.max(...known) : null;
}

/**
 * « 14 oct. 08:12 » ; avec `seconds`, « 14 oct. 08:12:50 ». L'année paraît quand ce n'est pas
 * l'année en cours : les journaux gardent des archives sur des mois, et « 3 janv. » sans année
 * se lisait comme le mois qui vient (14/10/2026). Les secondes, pour la vue Journaux : vingt lignes
 * d'une même minute — un saut, son `seek`, la `stall` qui suit — s'y suivaient sans ordre lisible.
 */
export function fullDate(ts: number | null | undefined, opts: { seconds?: boolean } = {}): string {
  if (!ts) return "—";
  const date = new Date(ts);
  const otherYear = date.getFullYear() !== new Date().getFullYear();
  return date.toLocaleString(uiLocale(), {
    day: "2-digit",
    month: "short",
    ...(otherYear && { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    ...(opts.seconds && { second: "2-digit" }),
    hour12: false,
  });
}

const STATE_STYLES = {
  playing: { dot: "bg-emerald-400", ring: "shadow-[0_0_0_3px_rgba(52,211,153,0.25)]", text: "text-success" },
  app: { dot: "bg-sky-400", ring: "shadow-[0_0_0_3px_rgba(56,189,248,0.2)]", text: "text-sky-300" },
  away: { dot: "bg-white/20", ring: "", text: "text-muted" },
} as const;

/** L'état en une pastille : en lecture, dans l'application, ou absent depuis… */
export function PresenceBadge({
  presence,
  nowPlaying,
  now,
  seenAt,
}: {
  presence: Presence;
  nowPlaying?: NowPlaying | null;
  now: number;
  /**
   * La dernière trace connue hors des signaux de présence — l'application ou le serveur média.
   * Les signaux vivent en mémoire et se perdent à chaque redémarrage : seuls les comptes passés
   * depuis le dernier avaient « Vu il y a… », tous les autres un « Absent » muet (06/10/2026).
   */
  seenAt?: number | null;
}) {
  const t = useT();
  const state = nowPlaying ? "playing" : presence.state;
  const style = STATE_STYLES[state];
  const label =
    state === "playing"
      ? t("activity.presence.playing")
      : state === "app"
        ? t("activity.presence.app")
        : presence.lastSeen || seenAt
          ? t("activity.presence.awaySince", { when: ago(Math.max(presence.lastSeen ?? 0, seenAt ?? 0), now, t) })
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
  const toneClass = { default: "text-white", good: "text-success", warn: "text-warning", bad: "text-danger" }[tone];
  return (
    <div className="card flex flex-col gap-1 p-4">
      <span className="flex items-center gap-1.5 text-xs text-muted">
        <Icon size={13} />
        {label}
      </span>
      <span className={`text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</span>
      {hint && <span className="text-xs text-subtle">{hint}</span>}
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
          {Icon && <Icon size={15} className="text-muted" />}
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
      <span className={`flex shrink-0 items-center justify-center rounded bg-white/5 text-subtle ${className}`}>
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
  if (s.fallbacks) flags.push({ label: t("activity.flags.fallback", { n: s.fallbacks }), tone: "bg-danger/15 text-danger" });
  if (s.errors) flags.push({ label: t("activity.flags.error", { n: s.errors }), tone: "bg-danger/15 text-danger" });
  if (s.rebuilds) flags.push({ label: t("activity.flags.rebuild", { n: s.rebuilds }), tone: "bg-warning/15 text-warning" });
  if (s.stalls) flags.push({ label: t("activity.flags.stall", { n: s.stalls }), tone: "bg-warning/15 text-warning" });
  if (s.slowSeeks) flags.push({ label: t("activity.flags.slowSeek", { n: s.slowSeeks }), tone: "bg-warning/15 text-warning" });
  if (s.slowLinks) flags.push({ label: t("activity.flags.slowLink", { n: s.slowLinks }), tone: "bg-warning/15 text-warning" });
  // Les relances du lecteur serveur : celles qui suivent une panne (échelle de repli) en ambre, les
  // gestes du spectateur (piste, « Réessayer ») en gris — l'une n'est pas l'autre (10/10/2026).
  const restarts = s.restarts ?? [];
  const failed = restarts.filter((r) => r.failure).length;
  if (failed) flags.push({ label: t("activity.flags.ladder", { n: failed }), tone: "bg-warning/15 text-warning" });
  if (restarts.length > failed) flags.push({ label: t("activity.flags.restart", { n: restarts.length - failed }), tone: "bg-white/5 text-muted" });
  // Une reprise qui rejouait une tentative déjà échouée (DECISIONS §67) : en observation, le
  // registre la compte sans l'empêcher — c'est ce chiffre qui dira s'il faut l'activer.
  if (s.stop?.identicalRetries) flags.push({ label: t("activity.flags.identicalRetry", { n: s.stop.identicalRetries }), tone: "bg-warning/15 text-warning" });
  if (s.stop?.why === "lost") flags.push({ label: t("activity.flags.lost"), tone: "bg-white/5 text-muted" });
  if (s.player === "serveur") flags.push({ label: t("activity.flags.server"), tone: "bg-violet-500/15 text-violet-300" });
  if (s.onTv) flags.push({ label: t("activity.flags.tv"), tone: "bg-violet-500/15 text-violet-300" });
  // Le téléviseur nommé quand ce n'est pas AirPlay (DECISIONS.md §64) — absent des séances d'avant.
  if (s.onTv && s.castTarget === "chromecast") flags.push({ label: t("activity.flags.chromecast"), tone: "bg-violet-500/15 text-violet-300" });
  if (s.serverRelay) flags.push({ label: t("activity.flags.serverRelay"), tone: "bg-white/5 text-muted" });
  if (!flags.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map((f) => (
        <span key={f.label} className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${f.tone}`}>
          {f.label}
        </span>
      ))}
    </span>
  );
}

/** Une séance en une ligne, qui mène à sa chronologie. */
export function SeanceRow({ s, now, showUser = false }: { s: Seance; now: number; showUser?: boolean }) {
  const t = useT();
  const watched = s.watched;
  return (
    <ActivityLink
      to={{ kind: "seance", id: s.id }}
      className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-white/[0.03]"
    >
      <Poster itemId={s.itemId} kind={s.title.includes(" — S") ? "episode" : "movie"} className="h-12 w-8" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          {showUser && <span className="shrink-0 text-xs font-semibold text-accent-400">{s.user}</span>}
          <span className="truncate text-sm text-white">{s.title}</span>
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
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
      <ChevronRight size={15} className="shrink-0 text-subtle transition-transform group-hover:translate-x-0.5" />
    </ActivityLink>
  );
}

/** Une courbe en barres, sans bibliothèque : sept jours tiennent dans quelques `div`. */
/**
 * Les barres de séances : sept jours, trente, ou tout l'historique par semaine ou par mois
 * (`bucket`). Au-delà de dix barres, l'étiquette ne se lit qu'une barre sur quelques-unes et le
 * nombre passe dans l'infobulle — trente nombres en haut se chevauchaient sur un téléphone.
 */
export function DayBars({ days, bucket = "day" }: { days: { day: string; seances: number; problems: number }[]; bucket?: "day" | "week" | "month" }) {
  const max = Math.max(1, ...days.map((d) => d.seances));
  const dense = days.length > 10;
  const every = Math.ceil(days.length / 8);
  const label = (day: string) => {
    const date = new Date(day + "T12:00:00");
    if (bucket === "month") return date.toLocaleDateString(uiLocale(), { month: "short" });
    if (bucket === "week") return date.toLocaleDateString(uiLocale(), { day: "numeric", month: "short" });
    return dense ? String(date.getDate()) : date.toLocaleDateString(uiLocale(), { weekday: "short" });
  };
  return (
    <div className={`flex h-28 items-end ${dense ? "gap-0.5" : "gap-2"}`}>
      {days.map((d, i) => (
        <div key={d.day} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={`${d.day} · ${d.seances} · ${d.problems}`}>
          {!dense && <span className="text-[11px] tabular-nums text-subtle">{d.seances || ""}</span>}
          <div className="relative w-full overflow-hidden rounded-t bg-white/60" style={{ height: `${Math.max(2, (d.seances / max) * 80)}px` }}>
            {d.problems > 0 && (
              <div className="absolute inset-x-0 bottom-0 bg-warning/80" style={{ height: `${Math.min(100, (d.problems / Math.max(1, d.seances)) * 100)}%` }} />
            )}
          </div>
          <span className="whitespace-nowrap text-[11px] text-subtle">{!dense || (days.length - 1 - i) % every === 0 ? label(d.day) : "\u00a0"}</span>
        </div>
      ))}
    </div>
  );
}

/** Du JSON lisible, repliable — pour le détail d'une ligne de journal. */
export function JsonBlock({ value }: { value: unknown }) {
  return (
    // Replié à la largeur : un agent utilisateur ou une raison de 240 caractères faisaient défiler
    // le bloc de côté, et sur un iPhone on ne lisait que le début de chaque ligne (14/10/2026).
    <pre className="scrollbar-thin max-h-[60vh] overflow-y-auto whitespace-pre-wrap rounded-lg bg-black/40 p-3 text-[11px] leading-relaxed text-muted [overflow-wrap:anywhere]">
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
    <div className="mt-2 rounded-lg bg-black/30 p-2 font-mono text-[11px] leading-relaxed text-muted">
      {steps.length > 6 && (
        <button type="button" onClick={() => setOpen((v) => !v)} className="mb-1 text-accent-400 hover:underline">
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

/**
 * La chronologie des deux dernières minutes d'une ligne (`timeline`, `playbackTimeline.ts`, §77) :
 * un échantillon toutes les 5 s — l'instant, la position du film, le débit reçu, le tampon devant,
 * la réserve en mémoire, l'état. Le plus récent en bas : c'est là que la panne arrive.
 */
export function TimelineTable({ text }: { text: string }) {
  const t = useT();
  const samples = parseTimeline(text);
  if (!samples.length) return null;
  const cell = (v: number | null, digits = 1) => (v === null ? "—" : v.toFixed(digits));
  return (
    <div className="mt-2 overflow-x-auto rounded-lg bg-black/30 p-2">
      <p className="mb-1 text-[11px] text-subtle">{t("activity.seance.ring.title")}</p>
      <table className="w-full font-mono text-[11px] text-muted">
        <thead className="text-subtle">
          <tr>
            <th className="pr-3 text-left font-normal">{t("activity.seance.ring.wall")}</th>
            <th className="pr-3 text-left font-normal">{t("activity.seance.ring.pos")}</th>
            <th className="pr-3 text-right font-normal">{t("activity.seance.ring.recv")}</th>
            <th className="pr-3 text-right font-normal">{t("activity.seance.ring.ahead")}</th>
            <th className="pr-3 text-right font-normal">{t("activity.seance.ring.reserve")}</th>
            <th className="text-left font-normal">{t("activity.seance.ring.state")}</th>
          </tr>
        </thead>
        <tbody>
          {samples.map((s, i) => (
            <tr key={i} className={s.state === "A" ? "text-warning" : undefined}>
              <td className="pr-3">+{clock(s.wall / 1000)}</td>
              <td className="pr-3">{clock(s.pos)}</td>
              <td className="pr-3 text-right">{cell(s.recvMbps)}</td>
              <td className="pr-3 text-right">{cell(s.aheadS)}</td>
              <td className="pr-3 text-right">{cell(s.reserveMB, 0)}</td>
              <td>{t(`activity.seance.ring.states.${s.state}`)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Un signal d'alerte en tête d'une carte de compte. */
export function AlertChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-danger/15 px-1.5 py-0.5 text-[11px] font-medium text-danger">
      <AlertTriangle size={10} />
      {label}
    </span>
  );
}

/** La couleur d'un type de ligne : le vert de ce qui commence, le rouge de ce qui casse. */
export function kindTone(kind: string, level?: unknown, event?: unknown): string {
  if (level === "error" && !["client", "admin"].includes(kind)) return "bg-danger/15 text-danger";
  // Une réserve qui échoue est un incident ; ses autres lignes ne sont que des relevés.
  if (kind === "reserve" && event === "erreur") return "bg-warning/15 text-warning";
  switch (kind) {
    case "start":
      return "bg-success/15 text-success";
    case "stop":
      return "bg-white/5 text-muted";
    case "seek":
    case "audio":
      return "bg-sky-500/15 text-sky-300";
    case "stall":
    case "rebuild":
    // Une coupure réseau en pleine lecture : le lecteur s'en remet le plus souvent, mais c'est ce
    // qu'on cherche d'abord dans un journal (14/10/2026).
    case "network":
      return "bg-warning/15 text-warning";
    case "fallback":
    case "error":
    case "client":
    // Un mot de passe refusé, un jeton refusé par le serveur média : ce qu'on cherche dans les connexions.
    case "login-failed":
    case "token-refused":
      return "bg-danger/15 text-danger";
    case "admin":
    case "cast":
      return "bg-violet-500/15 text-violet-300";
    default:
      return "bg-white/10 text-muted";
  }
}

const numOf = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strOf = (v: unknown) => (typeof v === "string" && v ? v : null);

/** Les parties présentes, jointes par « · » — une ligne qui n'a pas un champ n'a pas son morceau. */
const join = (...parts: (string | null | false | undefined)[]) => parts.filter((p): p is string => typeof p === "string" && p.trim() !== "").join(" · ");

/** 52 294 761 ms → « 15 h » ; au-delà de deux jours, en jours. Pour un âge, pas une attente. */
function age(ms: number | null, t: T): string | null {
  if (ms == null) return null;
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return `${Math.round(ms / 1000)} s`;
  if (minutes < 60) return `${minutes} min`;
  const h = Math.round(minutes / 60);
  return h < 48 ? `${h} h` : t("activity.line.days", { n: Math.round(h / 24) });
}

/** 114.7 → « 115 Mo » ; sous 10, une décimale. */
function mb(v: number | null, t: T): string | null {
  if (v == null) return null;
  return t("activity.line.mb", { n: v < 10 ? v.toFixed(1) : String(Math.round(v)) });
}

/** Une valeur de journal écrite en français, dite dans la langue de l'écran quand on la connaît. */
function known(t: T, prefix: string, map: Record<string, string>, value: unknown): string | null {
  const v = strOf(value);
  if (!v) return null;
  return map[v] ? t(`${prefix}.${map[v]}`) : v;
}

const OPENED_FROM = { appareil: "device", "mémoire": "memory", mixte: "mixed", "réseau": "network" };
const LINK_VERDICT = { suffisante: "enough", "trop lente": "slow", inconnue: "unknown" };
const STOP_WHY = { close: "close", next: "next", page: "page", unmount: "unmount", lost: "lost" };
const NEWS_EVENT = { "fenêtre": "window", "voir-plus": "more", page: "page" };

/**
 * Le bilan d'une séance (`stop`) : pourquoi, combien regardé, où — puis, seulement s'ils disent
 * quelque chose, les attentes, les sauts, le verdict du lien, la version allégée et la réserve.
 * Une lecture sans histoire garde sa ligne courte ; le détail reste dans le JSON.
 */
function describeStop(line: Record<string, unknown>, t: T): string {
  const restarts = numOf(line.restarts) ?? 0;
  const waits = numOf(line.waits) ?? 0;
  const seeks = numOf(line.seeks) ?? 0;
  const verdict = strOf(line["diag.linkVerdict"]);
  const lighter = numOf(line.lighterMbps);
  const choice = strOf(line.slowChoice);
  const reserve = numOf(line["diag.reserveNetMB"]);
  const bursts = numOf(line["diag.reserveBursts"]) ?? 0;
  return join(
    t("activity.line.stop", {
      why: known(t, "activity.line.stopWhy", STOP_WHY, line.why) ?? "?",
      watched: hours(numOf(line.watched)),
      at: clock(numOf(line.at)),
    }),
    restarts > 0 && t("activity.line.restarts", { n: restarts }),
    waits > 0 && t("activity.line.waits", { n: waits, longest: secs(numOf(line.longestWaitMs)) }),
    seeks > 0 && t("activity.line.seeks", { n: seeks }),
    // « inconnue » ne dit rien (trop peu de réception pour juger) : on ne l'écrit pas.
    verdict && verdict !== "inconnue" && t("activity.line.link", { verdict: known(t, "activity.line.linkVerdict", LINK_VERDICT, verdict) ?? verdict }),
    (lighter != null || line.quality === "auto") && (lighter != null ? t("activity.line.lighterMbps", { mbps: lighter }) : t("activity.line.lighter")),
    choice && choice !== "aucun" && t("activity.line.slowChoice", { choice }),
    reserve != null && reserve > 0 && t("activity.line.reserveSum", { mb: mb(reserve, t) ?? "", n: bursts })
  );
}

/** La ligne d'ouverture du cinéma (`startup.log`, §86) : d'où, en combien de temps, ce qu'on a corrigé. */
function describeStartup(line: Record<string, unknown>, t: T): string {
  const hidden = numOf(line.hiddenAtMs);
  const fromCache = line.resumeFromCache === true;
  const resume = numOf(line.resumeNetworkMs);
  const added = numOf(line.resumeAdded);
  const progressed = numOf(line.resumeProgressed) ?? 0;
  const titles = numOf(line.resumeTitles);
  const kept = mb(numOf(line.resumeMB), t);
  return join(
    line.cacheUsed === true ? t("activity.line.startup.cache", { age: age(numOf(line.cacheAgeMs), t) ?? "?" }) : t("activity.line.startup.noCache"),
    line.cacheUsed === true && numOf(line.cacheMs) != null && t("activity.line.startup.catalogue", { s: secs(numOf(line.cacheMs)) }),
    numOf(line.networkMs) != null && t("activity.line.startup.network", { s: secs(numOf(line.networkMs)) }),
    resume != null && t(fromCache ? "activity.line.startup.resumeFromDevice" : "activity.line.startup.resume", { s: secs(resume) }),
    added != null &&
      t("activity.line.startup.fixed", { added, removed: numOf(line.resumeRemoved) ?? 0, moved: numOf(line.resumeMoved) ?? 0 }) +
        (progressed > 0 ? ` ${t("activity.line.startup.progressed", { n: progressed })}` : ""),
    kept && (titles != null ? t("activity.line.startup.storedTitles", { mb: kept, n: titles }) : t("activity.line.startup.stored", { mb: kept })),
    hidden != null && t("activity.line.startup.hidden", { s: secs(hidden) })
  );
}

/** Une ligne du journal des sous-titres générés (`subtitle-gen.log`) — reconnue à son `job`. */
function describeSubtitleJob(line: Record<string, unknown>, t: T): string {
  const kind = strOf(line.kind) ?? "?";
  const label = (key: string, vars?: Record<string, string | number>) => t(`activity.line.subgen.${key}`, vars);
  switch (kind) {
    case "start":
      return join(label("start"), strOf(line.target), strOf(line.model));
    case "first":
      return label("first", { s: secs(numOf(line.clickToFirstMs) ?? numOf(line.ms)) });
    case "seek":
      return label("seek", { from: clock(numOf(line.from)), to: clock(numOf(line.to)) });
    case "seekFirst":
      return label("seekFirst", { s: secs(numOf(line.seekToFirstMs)) });
    case "source":
      return join(label("source"), strOf(line.language), strOf(line.verdict));
    case "batch":
      return label("batch", { n: numOf(line.batches) ?? 0, lines: numOf(line.count) ?? 0 });
    case "retry":
      return join(label("retry", { n: numOf(line.attempt) ?? 0 }), strOf(line.cause), numOf(line.count) != null && label("lines", { n: numOf(line.count) ?? 0 }));
    case "present":
      return join(label("present"), strOf(line.state));
    case "kept":
      return join(label("kept"), strOf(line.why));
    case "done":
      return join(
        label("done"),
        strOf(line.target),
        numOf(line.total) != null && label("lines", { n: numOf(line.total) ?? 0 }),
        numOf(line.durationMs) != null && clock((numOf(line.durationMs) ?? 0) / 1000),
        numOf(line.cost) != null && `$${numOf(line.cost)}`
      );
    default:
      // Un événement que ce résumé ne connaît pas encore : son nom, son état, sa langue.
      return join(kind, strOf(line.state) ?? strOf(line.status), strOf(line.target) ?? strOf(line.language), strOf(line.reason) ?? strOf(line.message));
  }
}

/** Une notification envoyée : son texte, puis à combien de comptes et ce qu'il en est advenu. */
function describeNotification(line: Record<string, unknown>, t: T): string {
  const recipients = (line.recipients as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  const sum = (k: string) => recipients.reduce((acc, r) => acc + (numOf(r[k]) ?? 0), 0);
  const muted = recipients.filter((r) => r.muted === true).length;
  return join(
    strOf(line.body),
    t("activity.line.notif.recipients", { n: recipients.length }),
    t("activity.line.notif.sent", { n: sum("sent") }),
    sum("failed") > 0 && t("activity.line.notif.failed", { n: sum("failed") }),
    sum("removed") > 0 && t("activity.line.notif.removed", { n: sum("removed") }),
    muted > 0 && t("activity.line.notif.muted", { n: muted })
  );
}

const DOWNLOAD_EVENTS = new Set(["requested", "started", "ready", "failed", "fetched", "cancelled", "removed", "expired", "deleted", "evicted"]);
const COPY_STATES = new Set(["new", "ready", "preparing", "retried"]);

/** Une taille de fichier dans la langue de l'écran — « 1,2 Go », « 1.2 GB ». */
export function size(bytes: number | null | undefined): string | null {
  return bytes != null && bytes > 0 ? fmtSize(bytes, uiLocale() ?? "fr") : null;
}

/**
 * Une ligne de téléchargement (`server.log`) : hors ligne (`scope: "offline"`, `offline/events.ts`)
 * ou fichier d'origine (`scope: "download"`, `logDownload`). Le geste, le titre, la qualité, puis ce
 * qui le précise — la version déjà prête sur le serveur, le temps de préparation et sa vitesse, la
 * raison d'un échec. Une ligne qui concerne une version et non un compte nomme ceux qui l'attendaient.
 */
export function describeDownload(line: Record<string, unknown>, t: T): string {
  const title = strOf(line.title) ?? strOf(line.itemId) ?? "?";
  if (line.scope === "download") return join(t("activity.downloads.event.download"), title, size(numOf(line.sizeBytes)));
  const event = strOf(line.event);
  const quality = line.quality === "standard" || line.quality === "high" ? t(`activity.downloads.quality.${line.quality}`) : null;
  const accounts = Array.isArray(line.accounts) ? (line.accounts as unknown[]).filter((u): u is string => typeof u === "string") : [];
  // Le compte qui agit est déjà dans sa colonne ; ceux qu'une version concerne, seulement s'il n'y en a pas.
  const forWho = !strOf(line.user) && accounts.length > 0 && t("activity.downloads.forAccounts", { who: accounts.join(", ") });
  const head = event && DOWNLOAD_EVENTS.has(event) ? t(`activity.downloads.event.${event}`) : (strOf(line.message) ?? "?");
  switch (event) {
    case "requested":
      return join(head, title, quality, strOf(line.copy) && COPY_STATES.has(line.copy as string) && t(`activity.downloads.copy.${line.copy}`));
    case "ready": {
      const took = numOf(line.durationMs);
      const speed = numOf(line.speed);
      return join(head, title, quality, size(numOf(line.bytes)), took != null && t("activity.downloads.took", { d: hours(took / 1000) }), speed != null && `×${speed}`, forWho);
    }
    case "failed":
      return join(head, title, quality, strOf(line.reason), forWho);
    case "cancelled":
      return join(head, title, quality, line.stopped === true && t("activity.downloads.stopped"));
    case "fetched":
    case "removed":
      return join(head, title, quality, size(numOf(line.bytes)));
    default:
      return join(head, title, quality, forWho);
  }
}

/**
 * Une ligne de journal dite en une phrase — « saut de 752 à 762 s, 6,7 s ». Écrit une fois, pour
 * la liste des journaux, la chronologie d'une séance et les journaux figés d'un signalement : tous
 * les journaux passent ici (lecteur, serveur, connexions, notifications, ouvertures, sous-titres
 * générés). Deux journaux partagent des noms de type (`start`, `seek` : lecteur et sous-titres
 * générés) — une ligne de sous-titres se reconnaît à son `job`, une notification à ses `recipients`.
 */
export function describeLine(line: Record<string, unknown>, t: T): string {
  if (line.scope === "offline" || line.scope === "download") return describeDownload(line, t);
  if (strOf(line.job)) return describeSubtitleJob(line, t);
  if (Array.isArray(line.recipients)) return describeNotification(line, t);
  switch (line.kind) {
    case "start": {
      // Le lecteur serveur dit pourquoi il (re)négocie depuis le 10/10/2026 — ouverture, piste,
      // échelon de l'échelle de repli et l'erreur qui l'a provoqué.
      if (line.player === "serveur" && isStartWhy(line.why)) {
        return t("activity.line.serverStart", {
          why: t(`activity.line.serverWhy.${line.why}`, { n: numOf(line.rung) ?? 0 }),
          at: clock(numOf(line.at)),
          extra: strOf(line.trigger) ? `· ${strOf(line.trigger)}` : "",
        }).trim();
      }
      const base = t("activity.line.start", {
        at: clock(numOf(line.at)),
        path: strOf(line.path) ?? "?",
        opened: secs(numOf(line.openedInMs)),
        rebuild: numOf(line.rebuild) ? t("activity.line.rebuildN", { n: numOf(line.rebuild) ?? 0 }) : "",
      }).trim();
      return join(base, known(t, "activity.line.openedFrom", OPENED_FROM, line.openedFrom));
    }
    case "opening":
      return join(
        t("activity.line.opening", { path: strOf(line.path) ?? "?" }),
        numOf(line.firstMoveMs) != null && t("activity.line.firstPicture", { s: secs(numOf(line.firstMoveMs)) }),
        known(t, "activity.line.openedFrom", OPENED_FROM, line.openedFrom)
      );
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
    case "network":
      return t("activity.line.network", { at: clock(numOf(line.at)), reason: strOf(line.reason) ?? "?" });
    case "fallback":
      return t("activity.line.fallback", { reason: strOf(line.reason) ?? "?" });
    case "stop":
      return describeStop(line, t);
    case "error":
      return strOf(line.reason) ?? strOf(line.message) ?? t("activity.line.error");
    case "cast":
      return t("activity.line.cast");
    // La seule pause écrite : celle de la minuterie de veille (`sleepTimer.ts`).
    case "pause":
      return t("activity.line.sleep", { mode: strOf(line.sleepTimer) ?? "?", at: clock(numOf(line.at)) });
    case "reserve":
      // Seules l'erreur et l'arrêt décidé par la réserve s'écrivent encore (§84).
      if (line.event === "erreur") {
        return join(t("activity.line.reserveError", { message: strOf(line.message) ?? "?" }), numOf(line.failures) != null && t("activity.line.reserveRetry", { n: numOf(line.failures) ?? 0, s: numOf(line.backoffS) ?? 0 }));
      }
      if (line.event === "arrêt") {
        const net = numOf(line.netMB) ?? numOf(line.networkMB);
        const bursts = numOf(line.bursts) ?? 0;
        return join(t("activity.line.reserveStop", { why: strOf(line.why) ?? "?" }), net != null && net > 0 && mb(net, t), bursts > 0 && t("activity.line.bursts", { n: bursts }));
      }
      return join(t("activity.line.reserve"), strOf(line.event));
    case "fluidite":
      return join(
        t("activity.line.fluidity", { probe: strOf(line.probe) ?? "?" }),
        t("activity.line.frames", { n: numOf(line.frames) ?? 0, long: numOf(line.longFrames) ?? 0 }),
        t("activity.line.worst", { worst: secs(numOf(line.worstMs)), p95: secs(numOf(line.p95Ms)) })
      );
    case "subtitle-gen":
      return join(t("activity.line.subtitleGen", { event: strOf(line.event) ?? "?" }), strOf(line.target), numOf(line.ms) != null && secs(numOf(line.ms)));
    // Les connexions (`auth.log`) : l'appareil et l'adresse, et pour un refus sa raison.
    case "login":
      // Le rôle seulement quand il compte : « admin » ; un compte ordinaire n'a rien à dire de plus.
      return join(t("activity.line.auth.login"), line.role === "admin" && "admin", strOf(line.device), strOf(line.ip));
    case "login-failed":
      return join(t("activity.line.auth.loginFailed"), strOf(line.reason), strOf(line.device), strOf(line.ip));
    case "logout":
      return join(t("activity.line.auth.logout"), strOf(line.device), strOf(line.ip));
    case "token-refused":
      return t("activity.line.auth.tokenRefused");
    case "expired":
      return t("activity.line.auth.expired", { n: numOf(line.count) ?? 0 });
    case "others-closed":
      return t("activity.line.auth.othersClosed", { n: numOf(line.count) ?? 0 });
    case "closed-by-admin":
      return t("activity.line.auth.closedByAdmin", { n: numOf(line.count) ?? 0, by: strOf(line.by) ?? "?" });
    case "devices-pruned":
      return t("activity.line.auth.devicesPruned", { n: numOf(line.count) ?? 0 });
    case "password-changed":
      return join(t("activity.line.auth.passwordChanged", { n: numOf(line.closedSessions) ?? 0 }), strOf(line.ip));
    // Le passage d'adresse (DECISIONS.md §119).
    case "passage-requested":
      return join(t("activity.line.auth.passageRequested", { to: strOf(line.to) ?? "?" }), strOf(line.device), strOf(line.ip));
    case "passage-received":
      return join(t("activity.line.auth.passageReceived"), strOf(line.device), strOf(line.ip));
    case "passage-refused":
      return join(t("activity.line.auth.passageRefused"), strOf(line.device), strOf(line.ip));
    case "passage-blocked":
      return join(t("activity.line.auth.passageBlocked"), strOf(line.device), strOf(line.ip));
    case "new-account-tags":
      return t("activity.line.auth.newAccountTags", { tags: Array.isArray(line.tags) ? line.tags.join(", ") : "?" });
    // Le journal des ouvertures (`startup.log`).
    case "ouverture":
      return describeStartup(line, t);
    case "télécommande":
      return join(
        t("activity.line.remote.keys", { n: Array.isArray(line.keys) ? line.keys.length : 0 }),
        t("activity.line.remote.pointer", { n: numOf(line.pointerMoves) ?? 0 }),
        numOf(line.wheels) ? t("activity.line.remote.wheels", { n: numOf(line.wheels) ?? 0 }) : null,
        strOf(line.viewport)
      );
    case "nouveautés":
      return join(
        known(t, "activity.line.news", NEWS_EVENT, line.event),
        numOf(line.shownMs) != null && t("activity.line.newsShown", { s: secs(numOf(line.shownMs)) }),
        strOf(line.closedBy) && t("activity.line.newsClosed", { by: strOf(line.closedBy) ?? "" })
      );
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
      return "bg-white/40";
    case "seek":
    case "audio":
      return "bg-sky-400";
    case "stall":
    case "rebuild":
    case "network":
      return "bg-amber-400";
    case "fallback":
    case "error":
      return "bg-rose-400";
    default:
      return "bg-violet-400";
  }
}

/** Un « oui / non » sans fenêtre : le bouton demande confirmation à lui-même, le temps d'un clic. */
export function ConfirmButton({ label, confirm, onConfirm, danger = false }: { label: string; confirm: string; onConfirm: () => Promise<void>; danger?: boolean }) {
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
    <button type="button" onClick={() => setArmed(true)} className={`btn-ghost px-2.5 py-1 text-xs ${danger ? "text-danger" : ""}`}>
      {label}
    </button>
  );
}
