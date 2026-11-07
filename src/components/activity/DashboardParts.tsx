"use client";

// Les pièces du tableau de bord de l'Activité (07/11/2026) : chiffres clés, courbes, répartitions.
// Sans bibliothèque de graphiques — quelques `div` suffisent, et le panneau reste léger.
//
// Les couleurs des catégories (les chemins de lecture) sont les quatre premières teintes sombres de la
// palette de référence, vérifiées sur le fond du panneau (#17171b) : bande de luminosité, chroma,
// séparation pour les trois daltonismes (ΔE ≥ 8,4), contraste ≥ 3:1. Chaque couleur va avec son nom
// et son chiffre : jamais la couleur seule. Les courbes à une série restent dans l'encre du panneau.

import { useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Clapperboard, Clock, Flag, Gauge, Hourglass } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { Poster, hours, secs, uiLocale } from "@/components/activity/parts";
import type { PeriodStats, PeriodTotals } from "@/lib/activity/dashboard";
import type { WeekSignals } from "@/lib/activity/accounts";

export const PATH_COLORS = { natif: "#3987e5", serveur: "#d95926", tv: "#199e70", horsLigne: "#c98500" } as const;

/** Un chiffre clé : grand, son nom, une ligne d'explication. */
export function Kpi({
  label,
  value,
  hint,
  delta,
  tone = "default",
  icon: Icon,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  /** L'écart avec la période d'avant : son texte, et s'il va dans le bon sens (`null` : neutre). */
  delta?: { text: string; good: boolean | null } | null;
  tone?: "default" | "good" | "warn" | "bad";
  icon?: React.ElementType;
}) {
  const toneClass = { default: "text-white", good: "text-success", warn: "text-warning", bad: "text-danger" }[tone];
  return (
    <div className="card flex min-w-0 flex-col gap-1 p-4">
      {/* L'écart sur la ligne du nom, à droite : à côté du chiffre il le faisait passer sur deux lignes
          dans les tuiles étroites d'un téléphone (« 141 h / 58 », revue du 08/11/2026). */}
      <span className="flex items-center justify-between gap-2 text-xs">
        <span className="flex min-w-0 items-center gap-1.5 truncate text-muted">
          {Icon && <Icon size={13} className="shrink-0" />}
          {label}
        </span>
        {delta && (
          <span className={`shrink-0 font-medium tabular-nums ${delta.good === null ? "text-subtle" : delta.good ? "text-success" : "text-warning"}`}>{delta.text}</span>
        )}
      </span>
      <span className={`whitespace-nowrap text-3xl font-semibold tracking-tight tabular-nums ${toneClass}`}>{value}</span>
      {hint && <span className="line-clamp-2 text-xs text-subtle">{hint}</span>}
    </div>
  );
}

/** Une rangée de choix exclusifs, en pilules. */
export function Segmented<V extends string>({ value, options, onChange, label }: { value: V; options: { value: V; label: string }[]; onChange: (v: V) => void; label: string }) {
  return (
    <div className="inline-flex rounded-full bg-white/5 p-0.5" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${o.value === value ? "bg-white text-black" : "text-muted hover:text-white"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export interface SeriesPoint {
  key: string;
  /** L'étiquette sous la barre (peut être vide), et la ligne affichée au survol. */
  label: string;
  detail: string;
  value: number;
  /** Une marque d'alerte sur la barre — de vrais incidents ce jour-là. */
  flagged?: boolean;
  /** Un trait vertical derrière la barre, avec son nom — une version arrivée ce jour-là. */
  mark?: string;
}

/**
 * Des barres verticales, une série : la valeur survolée (ou touchée) s'écrit au-dessus, une ligne
 * qui ne cache rien. Chaque barre est un bouton — clavier et lecteur d'écran lisent la même ligne.
 */
export function Bars({
  points,
  height = 120,
  empty,
  selected,
  onSelect,
}: {
  points: SeriesPoint[];
  height?: number;
  empty: string;
  /** La barre choisie (filtre du fil), mise en avant. */
  selected?: string | null;
  /** Toucher une barre la choisit ; la toucher de nouveau la relâche. */
  onSelect?: (key: string | null) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(0, ...points.map((p) => p.value));
  if (max === 0) return <p className="py-8 text-center text-sm text-subtle">{empty}</p>;
  const shown = hover === null ? (points.find((p) => p.key === selected) ?? null) : points[hover];
  return (
    <div>
      <p className="mb-2 h-4 truncate text-xs text-muted" aria-live="polite">
        {shown ? shown.detail : " "}
      </p>
      <div className="flex items-end gap-[2px]" style={{ height }} onPointerLeave={() => setHover(null)}>
        {points.map((p, i) => (
          <button
            key={p.key}
            type="button"
            aria-label={p.detail}
            onPointerEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            onClick={() => {
              setHover(i);
              onSelect?.(selected === p.key ? null : p.key);
            }}
            aria-pressed={onSelect ? selected === p.key : undefined}
            className="group relative flex h-full min-w-0 flex-1 items-end justify-center outline-none"
          >
            {p.mark && <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/15" title={p.mark} aria-hidden />}
            <span
              className={`relative block w-full max-w-[22px] rounded-t-[4px] transition-colors ${
                selected === p.key || hover === i ? "bg-white" : selected ? "bg-white/20 group-focus-visible:bg-white" : "bg-white/45 group-focus-visible:bg-white"
              }`}
              style={{ height: `${p.value > 0 ? Math.max(3, (p.value / max) * 100) : 0}%` }}
            />
            {p.flagged && <span className="absolute -bottom-2.5 h-1.5 w-1.5 rounded-full bg-danger" aria-hidden />}
          </button>
        ))}
      </div>
      {/* Chaque étiquette centrée sous sa barre et libre de déborder : une colonne fait dix pixels
          sur un téléphone, « 12 » y était coupé en « 1. ». */}
      <div className="mt-3 flex h-4 gap-[2px]">
        {points.map((p) => (
          <span key={p.key} className="relative min-w-0 flex-1">
            {p.label && <span className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-[11px] tabular-nums text-subtle">{p.label}</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Une barre découpée en parts, chacune avec son nom, son chiffre et sa part dans la légende. */
export function StackBar({
  parts,
  empty,
  selected,
  onSelect,
  format = String,
  columns = 2,
}: {
  parts: { key: string; label: string; value: number; color: string }[];
  empty: string;
  selected?: string | null;
  onSelect?: (key: string | null) => void;
  /** Comment écrire une valeur dans la légende (une unité, par exemple). */
  format?: (value: number) => string;
  /** Une colonne quand les noms sont longs : sur téléphone, deux colonnes les coupaient. */
  columns?: 1 | 2;
}) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  if (!total) return <p className="py-6 text-center text-sm text-subtle">{empty}</p>;
  const visible = parts.filter((p) => p.value > 0);
  return (
    <div className="space-y-4">
      <div className="flex h-3 gap-[2px] overflow-hidden rounded-full">
        {visible.map((p) => (
          <span key={p.key} title={`${p.label} · ${p.value}`} style={{ flexGrow: p.value, background: p.color }} className="h-full min-w-[3px]" />
        ))}
      </div>
      <ul className={`grid gap-x-4 gap-y-2 ${columns === 1 ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2"}`}>
        {parts.map((p) => (
          <li key={p.key}>
            <button
              type="button"
              disabled={!onSelect || !p.value}
              aria-pressed={selected === p.key}
              onClick={() => onSelect?.(selected === p.key ? null : p.key)}
              className={`flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-sm transition-colors enabled:hover:bg-white/[0.04] ${selected === p.key ? "bg-white/[0.07]" : ""}`}
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: p.color }} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-muted">{p.label}</span>
              <span className="tabular-nums text-white">{format(p.value)}</span>
              <span className="w-10 text-right text-xs tabular-nums text-subtle">{Math.round((p.value / total) * 100)} %</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Une liste classée en barres horizontales. Une ligne peut mener ailleurs (`onOpen`) : la fiche d'un
 * compte, par exemple.
 */
export function RankList({
  rows,
  empty,
}: {
  rows: { key: string; label: React.ReactNode; value: number; valueLabel: string; note?: React.ReactNode; onOpen?: () => void; leading?: React.ReactNode; selected?: boolean }[];
  empty: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="px-4 py-6 text-sm text-subtle">{empty}</p>;
  return (
    <ul className="divide-y divide-white/5">
      {rows.map((r) => {
        const body = (
          <>
            {r.leading}
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-3">
                <span className="truncate text-sm text-white">{r.label}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted">{r.valueLabel}</span>
              </span>
              <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-white/5">
                <span className="block h-full rounded-full bg-white/50" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
              </span>
              {r.note && <span className="mt-1 block truncate text-[11px] text-subtle">{r.note}</span>}
            </span>
            {r.onOpen && <ChevronRight size={14} className="shrink-0 text-subtle" />}
          </>
        );
        return (
          <li key={r.key}>
            {r.onOpen ? (
              <button
                type="button"
                onClick={r.onOpen}
                aria-pressed={r.selected}
                className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-white/[0.03] ${r.selected ? "bg-white/[0.06]" : ""}`}
              >
                {body}
              </button>
            ) : (
              <div className="flex items-center gap-3 px-4 py-2.5">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Les titres les plus regardés, avec leur affiche. */
export function TitleRank({
  titles,
  empty,
  selected,
  onSelect,
}: {
  titles: { title: string; itemId: string | null; episode: boolean; seances: number; watchedSeconds: number }[];
  empty: string;
  selected?: string | null;
  onSelect?: (title: string | null) => void;
}) {
  const t = useT();
  return (
    <RankList
      empty={empty}
      rows={titles.map((x) => ({
        key: x.title,
        label: x.title,
        value: x.watchedSeconds || x.seances,
        valueLabel: hours(x.watchedSeconds),
        note: t("activity.dash.seancesN", { n: x.seances }),
        leading: <Poster itemId={x.itemId} kind={x.episode ? "episode" : "movie"} className="h-12 w-8" />,
        selected: selected === x.title,
        onOpen: onSelect ? () => onSelect(selected === x.title ? null : x.title) : undefined,
      }))}
    />
  );
}

/**
 * Une section repliable : fermée, une ligne et son résumé ; ouverte, son contenu. L'état est gardé
 * pour la durée de l'onglet — on retrouve ouvert ce qu'on avait ouvert.
 */
export function Fold({ id, title, icon: Icon, summary, children }: { id: string; title: string; icon?: React.ElementType; summary?: React.ReactNode; children: React.ReactNode }) {
  const storageKey = `cine:activity-fold:${id}`;
  const [open, setOpen] = useState(() => {
    try {
      return window.sessionStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      window.sessionStorage.setItem(storageKey, next ? "1" : "0");
    } catch {
      /* sans stockage, l'état vit le temps de l'écran */
    }
  };
  return (
    <section className="card overflow-hidden">
      <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.03]">
        {Icon && <Icon size={15} className="shrink-0 text-muted" />}
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-white">{title}</span>
          {summary && !open && <span className="mt-0.5 block truncate text-xs text-subtle">{summary}</span>}
        </span>
        <ChevronDown size={16} className={`shrink-0 text-subtle transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div className="border-t border-white/5">{children}</div>}
    </section>
  );
}

/** « 12 nov. » dans la langue de l'écran. */
export function shortDay(day: string): string {
  return new Date(day + "T12:00:00").toLocaleDateString(uiLocale(), { day: "numeric", month: "short" });
}

export function handledSum(h: PeriodStats["handled"]): number {
  return h.recovered + h.network + h.slowLinks + h.planned + h.background;
}

export function pct(part: number, total: number): string {
  return total ? `${Math.round((part / total) * 100)} %` : "—";
}

/**
 * L'écart avec la période d'avant, dit court : « +12 », « +4 pts », « −0,3 s ». `better` : quand la
 * hausse est bonne (`true`), mauvaise (`false`), ou ni l'un ni l'autre (`null`, le volume).
 */
function deltaOf(now: number | null, before: number | null, kind: "count" | "points" | "ms" | "hours", better: boolean | null): { text: string; good: boolean | null } | null {
  if (now === null || before === null) return null;
  const diff = now - before;
  const sign = diff > 0 ? "+" : diff < 0 ? "−" : "±";
  const abs = Math.abs(diff);
  let text: string;
  if (kind === "points") {
    if (Math.round(abs) === 0) return null;
    text = `${sign}${Math.round(abs)} pts`;
  } else if (kind === "ms") {
    if (abs < 50) return null;
    text = `${sign}${secs(abs)}`;
  } else if (kind === "hours") {
    if (abs < 60) return null;
    text = `${sign}${hours(abs)}`;
  } else {
    if (abs === 0) return null;
    text = `${sign}${abs}`;
  }
  return { text, good: better === null ? null : diff > 0 === better };
}

/** Les chiffres clés de la période, et leur écart avec la période d'avant. « Tout » vient de l'historique gardé. */
export function KpiRow({
  stats,
  prev,
  all,
  sinceVersion,
  single = false,
}: {
  stats: PeriodStats | null;
  prev: PeriodTotals | null;
  all: WeekSignals | null;
  /** Le taux sans accroc depuis une version — sous le chiffre, à la place du simple compte. */
  sinceVersion?: { version: string; seances: number; clean: number } | null;
  /** La fiche d'un compte : « 1 spectateur » n'y dit rien. */
  single?: boolean;
}) {
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
  const prevShare = prev && prev.seances ? prev.clean / prev.seances : null;
  const openSplit =
    stats.openDeviceMs !== null && stats.openNetworkMs !== null
      ? t("activity.dash.kpi.openSplit", { device: secs(stats.openDeviceMs), network: secs(stats.openNetworkMs) })
      : stats.openP90Ms !== null
        ? t("activity.dash.kpi.openHint", { d: secs(stats.openP90Ms) })
        : undefined;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <Kpi icon={Clapperboard} label={t("activity.dash.kpi.seances")} value={stats.seances} hint={single ? undefined : t("activity.week.viewers", { n: stats.viewers })} delta={deltaOf(stats.seances, prev?.seances ?? null, "count", null)} />
      <Kpi icon={Clock} label={t("activity.dash.kpi.watched")} value={hours(stats.watchedSeconds)} delta={deltaOf(stats.watchedSeconds, prev?.watchedSeconds ?? null, "hours", null)} />
      <Kpi
        icon={CheckCircle2}
        label={t("activity.dash.kpi.clean")}
        value={pct(stats.clean, stats.seances)}
        hint={
          sinceVersion
            ? t("activity.dash.kpi.sinceVersion", { v: sinceVersion.version, p: pct(sinceVersion.clean, sinceVersion.seances) })
            : t("activity.dash.kpi.cleanHint", { n: stats.clean, total: stats.seances })
        }
        delta={stats.seances ? deltaOf(cleanShare * 100, prevShare === null ? null : prevShare * 100, "points", true) : null}
        // Vert dès 90 %, neutre au-dessus de 75 %, ambre en dessous — jamais rouge : une séance gênée
        // n'est pas une panne de l'application (le détail est dans « À gérer »).
        tone={!stats.seances ? "default" : cleanShare >= 0.9 ? "good" : cleanShare >= 0.75 ? "default" : "warn"}
      />
      <Kpi
        icon={Gauge}
        label={t("activity.dash.kpi.open")}
        value={stats.openMedianMs !== null ? secs(stats.openMedianMs) : "—"}
        hint={openSplit}
        delta={deltaOf(stats.openMedianMs, prev?.openMedianMs ?? null, "ms", false)}
      />
      <Kpi icon={Hourglass} label={t("activity.dash.kpi.waits")} value={stats.waits} hint={t("activity.week.waitsHint", { d: secs(stats.waitedMs) })} delta={deltaOf(stats.waits, prev?.waits ?? null, "count", false)} />
      {/* « Menées au bout » plutôt que « gérés seuls » (07/11/2026) : ce qui a été géré se lit sous « À gérer ». */}
      <Kpi
        icon={Flag}
        label={t("activity.dash.kpi.finished")}
        value={pct(stats.completion.finished, stats.completion.closed)}
        hint={t("activity.dash.kpi.cleanHint", { n: stats.completion.finished, total: stats.completion.closed })}
        delta={
          stats.completion.closed && prev?.completion?.closed
            ? deltaOf((stats.completion.finished / stats.completion.closed) * 100, (prev.completion.finished / prev.completion.closed) * 100, "points", true)
            : null
        }
      />
    </div>
  );
}
