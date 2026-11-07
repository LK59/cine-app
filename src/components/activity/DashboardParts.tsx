"use client";

// Les pièces du tableau de bord de l'Activité (07/11/2026) : chiffres clés, courbes, répartitions.
// Sans bibliothèque de graphiques — quelques `div` suffisent, et le panneau reste léger.
//
// Les couleurs des catégories (les chemins de lecture) sont les quatre premières teintes sombres de la
// palette de référence, vérifiées sur le fond du panneau (#17171b) : bande de luminosité, chroma,
// séparation pour les trois daltonismes (ΔE ≥ 8,4), contraste ≥ 3:1. Chaque couleur va avec son nom
// et son chiffre : jamais la couleur seule. Les courbes à une série restent dans l'encre du panneau.

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { Poster, hours, uiLocale } from "@/components/activity/parts";

export const PATH_COLORS = { natif: "#3987e5", serveur: "#d95926", tv: "#199e70", horsLigne: "#c98500" } as const;

/** Un chiffre clé : grand, son nom, une ligne d'explication. */
export function Kpi({
  label,
  value,
  hint,
  tone = "default",
  icon: Icon,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "default" | "good" | "warn" | "bad";
  icon?: React.ElementType;
}) {
  const toneClass = { default: "text-white", good: "text-success", warn: "text-warning", bad: "text-danger" }[tone];
  return (
    <div className="card flex min-w-0 flex-col gap-1 p-4">
      <span className="flex items-center gap-1.5 truncate text-xs text-muted">
        {Icon && <Icon size={13} className="shrink-0" />}
        {label}
      </span>
      <span className={`text-3xl font-semibold tracking-tight tabular-nums ${toneClass}`}>{value}</span>
      {hint && <span className="truncate text-xs text-subtle">{hint}</span>}
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
}

/**
 * Des barres verticales, une série : la valeur survolée (ou touchée) s'écrit au-dessus, une ligne
 * qui ne cache rien. Chaque barre est un bouton — clavier et lecteur d'écran lisent la même ligne.
 */
export function Bars({ points, height = 120, empty }: { points: SeriesPoint[]; height?: number; empty: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(0, ...points.map((p) => p.value));
  if (max === 0) return <p className="py-8 text-center text-sm text-subtle">{empty}</p>;
  const shown = hover === null ? null : points[hover];
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
            onClick={() => setHover(i)}
            className="group relative flex h-full min-w-0 flex-1 items-end justify-center outline-none"
          >
            <span
              className={`block w-full max-w-[22px] rounded-t-[4px] transition-colors ${hover === i ? "bg-white" : "bg-white/45 group-focus-visible:bg-white"}`}
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
export function StackBar({ parts, empty }: { parts: { key: string; label: string; value: number; color: string }[]; empty: string }) {
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
      <ul className="grid grid-cols-2 gap-x-4 gap-y-2">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center gap-2 text-sm">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: p.color }} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-muted">{p.label}</span>
            <span className="tabular-nums text-white">{p.value}</span>
            <span className="w-10 text-right text-xs tabular-nums text-subtle">{Math.round((p.value / total) * 100)} %</span>
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
  rows: { key: string; label: React.ReactNode; value: number; valueLabel: string; note?: React.ReactNode; onOpen?: () => void; leading?: React.ReactNode }[];
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
              <button type="button" onClick={r.onOpen} className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-white/[0.03]">
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
export function TitleRank({ titles, empty }: { titles: { title: string; itemId: string | null; episode: boolean; seances: number; watchedSeconds: number }[]; empty: string }) {
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
