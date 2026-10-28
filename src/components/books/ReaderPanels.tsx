"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import {
  FONTS,
  FONT_SIZE_RANGE,
  FONT_STACKS,
  LINE_HEIGHT_RANGE,
  LAYOUTS,
  MARGINS,
  THEMES,
  THEME_COLORS,
  TURNS,
  zoomedFontSize,
  type ReaderPrefs,
} from "@/lib/books/readerPrefs";
import type { FoliateTocItem } from "@/lib/books/foliate/view";
import { insetVar } from "@/lib/books/readerFrame";

type Colors = { bg: string; fg: string; link: string; dark: boolean };

/**
 * Les panneaux du lecteur de livres (DECISIONS.md §127) : la table des matières et les signets, la
 * recherche dans le texte, les réglages.
 * Sur téléphone, une feuille qui monte du bas et laisse voir la page au-dessus ; sur un grand écran,
 * un panneau sur le côté. Chaque réglage s'applique à la page derrière, aussitôt : on règle en lisant.
 */
function PanelFrame({ colors, title, onClose, children, side }: { colors: Colors; title: string; onClose: () => void; children: React.ReactNode; side: "left" | "right" }) {
  const t = useT();
  return (
    <div
      className={`absolute inset-x-0 bottom-0 z-20 flex max-h-[62%] flex-col rounded-t-2xl border shadow-2xl shadow-black/40 backdrop-blur-2xl animate-fade-in-up sm:inset-y-3 sm:bottom-3 sm:max-h-none sm:w-[23rem] sm:rounded-2xl sm:animate-fade-in-side ${side === "left" ? "sm:left-3 sm:right-auto" : "sm:left-auto sm:right-3"}`}
      style={{
        // Presque opaque : le texte du livre ne doit pas se lire à travers les réglages ; la page reste
        // visible au-dessus, où l'on voit chaque changement.
        background: colors.dark ? "rgb(24 24 27 / 0.97)" : "rgb(252 251 249 / 0.97)",
        color: colors.fg,
        borderColor: colors.dark ? "rgb(255 255 255 / 0.08)" : "rgb(0 0 0 / 0.08)",
        paddingBottom: insetVar("bottom"),
      }}
      role="dialog"
      aria-label={title}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* La poignée d'une feuille, sur téléphone. */}
      <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full sm:hidden" style={{ background: colors.fg, opacity: 0.25 }} aria-hidden />
      <div className="flex shrink-0 items-center justify-between px-5 pb-2 pt-3">
        <h2 className="font-display text-lg font-semibold">{title}</h2>
        <button type="button" onClick={onClose} aria-label={t("books.close")} className="flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-black/10">
          <X size={18} aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">{children}</div>
    </div>
  );
}

export interface ReaderBookmark {
  cfi: string;
  fraction: number;
  chapter: string;
  excerpt: string;
}

/**
 * La table des matières et les signets, deux onglets d'un même panneau : on y cherche un endroit du
 * livre, qu'il vienne de l'auteur ou de soi.
 */
export function ReaderTocPanel({
  toc,
  currentHref,
  colors,
  onPick,
  onClose,
  bookmarks,
  onPickBookmark,
  onRemoveBookmark,
  initialTab = "toc",
}: {
  toc: FoliateTocItem[];
  currentHref: string | null;
  colors: Colors;
  onPick: (href: string) => void;
  onClose: () => void;
  bookmarks: ReaderBookmark[];
  onPickBookmark: (cfi: string) => void;
  onRemoveBookmark: (cfi: string) => void;
  initialTab?: "toc" | "bookmarks";
}) {
  const t = useT();
  const [tab, setTab] = useState<"toc" | "bookmarks">(initialTab);
  const rows: { item: FoliateTocItem; depth: number }[] = [];
  const walk = (items: FoliateTocItem[] | null | undefined, depth: number) => {
    for (const item of items ?? []) {
      rows.push({ item, depth });
      walk(item.subitems, depth + 1);
    }
  };
  walk(toc, 0);
  const tabs = [
    { id: "toc" as const, label: t("books.reader.contents") },
    { id: "bookmarks" as const, label: bookmarks.length > 0 ? `${t("books.reader.bookmarks")} · ${bookmarks.length}` : t("books.reader.bookmarks") },
  ];
  return (
    <PanelFrame colors={colors} title={tab === "toc" ? t("books.reader.contents") : t("books.reader.bookmarks")} onClose={onClose} side="left">
      <div role="tablist" className="mb-3 flex gap-1 rounded-full p-1" style={{ background: colors.dark ? "rgb(255 255 255 / 0.08)" : "rgb(0 0 0 / 0.06)" }}>
        {tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={tab === x.id}
            onClick={() => setTab(x.id)}
            className="h-8 flex-1 rounded-full text-sm font-medium transition-colors"
            style={tab === x.id ? { background: colors.fg, color: colors.bg } : undefined}
          >
            {x.label}
          </button>
        ))}
      </div>
      {tab === "toc" ? (
        <>
          {rows.length === 0 && <p className="py-6 text-center text-sm opacity-60">{t("books.reader.noContents")}</p>}
          <ul className="-mx-2">
            {rows.map(({ item, depth }, i) => {
              const current = !!item.href && item.href === currentHref;
              return (
                <li key={`${i}:${item.href ?? ""}`}>
                  <button
                    type="button"
                    disabled={!item.href}
                    onClick={() => item.href && onPick(item.href)}
                    className="w-full rounded-lg px-2 py-2.5 text-left text-[15px] leading-snug transition-colors hover:bg-black/5 disabled:opacity-50"
                    style={{ paddingLeft: `${0.5 + depth * 1}rem`, fontWeight: current ? 600 : 400, background: current ? (colors.dark ? "rgb(255 255 255 / 0.08)" : "rgb(0 0 0 / 0.06)") : undefined }}
                    aria-current={current ? "location" : undefined}
                  >
                    {item.label?.trim() || "—"}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <>
          {bookmarks.length === 0 && <p className="py-6 text-center text-sm leading-relaxed opacity-60">{t("books.reader.noBookmarks")}</p>}
          <ul className="-mx-2" data-reader-bookmarks>
            {bookmarks.map((b) => (
              <li key={b.cfi} className="flex items-start gap-1">
                <button type="button" onClick={() => onPickBookmark(b.cfi)} className="min-w-0 flex-1 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-black/5">
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{b.chapter || "—"}</span>
                    <span className="shrink-0 text-xs tabular-nums opacity-60">{t("books.reader.percent", { pct: Math.round(b.fraction * 100) })}</span>
                  </span>
                  {b.excerpt && <span className="mt-0.5 line-clamp-2 block text-sm leading-snug opacity-70">{b.excerpt}</span>}
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveBookmark(b.cfi)}
                  aria-label={t("books.reader.removeBookmark")}
                  className="mt-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full opacity-60 transition-opacity hover:opacity-100"
                >
                  <X size={15} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </PanelFrame>
  );
}

export interface SearchGroup {
  label: string;
  items: { cfi: string; pre: string; match: string; post: string }[];
}

/**
 * La recherche dans le texte du livre. Les résultats arrivent chapitre par chapitre, avec leur
 * contexte ; l'avancement est dit tant que la recherche parcourt le livre, et elle s'arrête d'un geste.
 */
export function ReaderSearchPanel({
  colors,
  query,
  onQuery,
  groups,
  progress,
  onPick,
  onStop,
  onClose,
}: {
  colors: Colors;
  query: string;
  onQuery: (q: string) => void;
  groups: SearchGroup[];
  /** De 0 à 1 pendant la recherche ; `null` quand elle est finie ou arrêtée. */
  progress: number | null;
  onPick: (cfi: string) => void;
  onStop: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const count = groups.reduce((n, g) => n + g.items.length, 0);
  return (
    <PanelFrame colors={colors} title={t("books.reader.search")} onClose={onClose} side="right">
      <input
        type="search"
        // Le champ prend le clavier dès l'ouverture : on ouvre ce panneau pour taper.
        autoFocus
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && query) {
            e.stopPropagation();
            onQuery("");
          }
        }}
        placeholder={t("books.reader.searchPlaceholder")}
        aria-label={t("books.reader.search")}
        className="h-11 w-full rounded-xl px-4 text-[15px] outline-none"
        style={{ background: colors.dark ? "rgb(255 255 255 / 0.08)" : "rgb(0 0 0 / 0.06)", color: colors.fg }}
      />
      <div className="mt-2 flex h-6 items-center justify-between text-xs opacity-70" aria-live="polite">
        <span>
          {progress !== null
            ? t("books.reader.searching", { pct: Math.round(progress * 100) })
            : query.trim().length >= 2
              ? count === 0
                ? t("books.reader.searchNone")
                : t("books.reader.searchCount", { n: count })
              : ""}
        </span>
        {progress !== null && (
          <button type="button" onClick={onStop} className="rounded-full px-2 py-0.5 font-medium underline-offset-2 hover:underline">
            {t("books.reader.searchStop")}
          </button>
        )}
      </div>
      <div data-reader-search-results>
        {groups.map((g, gi) => (
          <section key={`${gi}:${g.label}`} className="mt-3">
            <h3 className="mb-1 truncate text-xs font-semibold uppercase tracking-wide opacity-60">{g.label || "—"}</h3>
            <ul className="-mx-2">
              {g.items.map((r) => (
                <li key={r.cfi}>
                  <button type="button" onClick={() => onPick(r.cfi)} className="w-full rounded-lg px-2 py-2 text-left text-sm leading-snug transition-colors hover:bg-black/5">
                    <span className="opacity-70">{r.pre}</span>
                    <mark className="rounded-sm px-0.5 font-semibold" style={{ background: colors.dark ? "rgb(250 204 21 / 0.35)" : "rgb(250 204 21 / 0.55)", color: "inherit" }}>
                      {r.match}
                    </mark>
                    <span className="opacity-70">{r.post}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </PanelFrame>
  );
}

/** Un groupe de choix en pilules — le choix fait est plein. */
function Choices<T extends string>({ value, options, label, render, onPick, colors }: { value: T; options: readonly T[]; label: string; render: (v: T) => React.ReactNode; onPick: (v: T) => void; colors: Colors }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((option) => {
        const on = option === value;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onPick(option)}
            className="rounded-full border px-3.5 py-1.5 text-sm transition-colors"
            style={{
              background: on ? colors.fg : "transparent",
              color: on ? colors.bg : colors.fg,
              borderColor: on ? colors.fg : colors.dark ? "rgb(255 255 255 / 0.18)" : "rgb(0 0 0 / 0.15)",
            }}
          >
            {render(option)}
          </button>
        );
      })}
    </div>
  );
}

function Row({ label, children, value }: { label: string; children: React.ReactNode; value?: string }) {
  return (
    <div className="py-3">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide opacity-60">{label}</p>
        {value && <p className="text-xs tabular-nums opacity-60">{value}</p>}
      </div>
      {children}
    </div>
  );
}

function Slider({ value, min, max, step, onChange, label, colors, left, right }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; label: string; colors: Colors; left?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      {left}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-6 flex-1 cursor-pointer"
        style={{ accentColor: colors.fg }}
      />
      {right}
    </div>
  );
}

function Switch({ on, onChange, label, colors }: { on: boolean; onChange: (v: boolean) => void; label: string; colors: Colors }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} className="flex w-full items-center justify-between py-2.5 text-[15px]">
      <span>{label}</span>
      <span className="relative h-6 w-11 rounded-full transition-colors" style={{ background: on ? colors.fg : colors.dark ? "rgb(255 255 255 / 0.2)" : "rgb(0 0 0 / 0.15)" }}>
        <span className="absolute top-0.5 h-5 w-5 rounded-full shadow transition-[left]" style={{ left: on ? "1.375rem" : "0.125rem", background: on ? colors.bg : "#fff" }} />
      </span>
    </button>
  );
}

export function ReaderSettingsPanel({ prefs, colors, onChange, onClose }: { prefs: ReaderPrefs; colors: Colors; onChange: (patch: Partial<ReaderPrefs>) => void; onClose: () => void }) {
  const t = useT();
  return (
    <PanelFrame colors={colors} title={t("books.reader.settings")} onClose={onClose} side="right">
      {/* La taille d'abord, comme dans Livres d'Apple : un petit « A », un grand « A », un pas par
          appui — le même pas et les mêmes bornes que le curseur dessous, le clavier et le pincement. */}
      <Row label={t("books.reader.fontSize")} value={`${prefs.fontSize} %`}>
        <div className="flex items-stretch gap-2">
          <button
            type="button"
            onClick={() => onChange({ fontSize: zoomedFontSize(prefs.fontSize - FONT_SIZE_RANGE.step, 1) })}
            disabled={prefs.fontSize <= FONT_SIZE_RANGE.min}
            aria-label={t("books.reader.smaller")}
            className="flex h-12 flex-1 items-center justify-center rounded-xl text-base transition-transform active:scale-95 disabled:opacity-35"
            style={{ background: colors.dark ? "rgb(255 255 255 / 0.08)" : "rgb(0 0 0 / 0.06)" }}
          >
            A
          </button>
          <button
            type="button"
            onClick={() => onChange({ fontSize: zoomedFontSize(prefs.fontSize + FONT_SIZE_RANGE.step, 1) })}
            disabled={prefs.fontSize >= FONT_SIZE_RANGE.max}
            aria-label={t("books.reader.larger")}
            className="flex h-12 flex-1 items-center justify-center rounded-xl text-2xl transition-transform active:scale-95 disabled:opacity-35"
            style={{ background: colors.dark ? "rgb(255 255 255 / 0.08)" : "rgb(0 0 0 / 0.06)" }}
          >
            A
          </button>
        </div>
        <div className="mt-3">
          <Slider value={prefs.fontSize} {...FONT_SIZE_RANGE} onChange={(fontSize) => onChange({ fontSize })} label={t("books.reader.fontSize")} colors={colors} />
        </div>
        <p className="mt-1.5 text-xs opacity-60">{t("books.reader.zoomHint")}</p>
      </Row>

      <Row label={t("books.reader.theme")}>
        <div role="radiogroup" aria-label={t("books.reader.theme")} className="flex justify-between gap-2">
          {THEMES.map((theme) => {
            const on = prefs.theme === theme;
            const swatch = theme === "auto" ? null : THEME_COLORS[theme];
            return (
              <button key={theme} type="button" role="radio" aria-checked={on} onClick={() => onChange({ theme })} className="flex flex-1 flex-col items-center gap-1.5">
                <span
                  className="flex h-11 w-11 items-center justify-center rounded-full border-2 font-display text-sm font-semibold transition-transform"
                  style={{
                    background: swatch ? swatch.bg : "linear-gradient(135deg, #fbfbf9 50%, #1c1c1f 50%)",
                    color: swatch ? swatch.fg : "#888",
                    borderColor: on ? colors.fg : colors.dark ? "rgb(255 255 255 / 0.15)" : "rgb(0 0 0 / 0.12)",
                    transform: on ? "scale(1.06)" : "none",
                  }}
                >
                  {swatch ? "Aa" : ""}
                </span>
                <span className="text-xs" style={{ opacity: on ? 1 : 0.65 }}>
                  {t(`books.reader.themes.${theme}`)}
                </span>
              </button>
            );
          })}
        </div>
      </Row>

      <Row label={t("books.reader.font")}>
        <Choices
          value={prefs.font}
          options={FONTS}
          label={t("books.reader.font")}
          colors={colors}
          onPick={(font) => onChange({ font })}
          render={(font) => <span style={{ fontFamily: font === "book" ? undefined : FONT_STACKS[font] }}>{t(`books.reader.fonts.${font}`)}</span>}
        />
      </Row>

      <Row label={t("books.reader.lineHeight")} value={prefs.lineHeight.toFixed(2)}>
        <Slider value={prefs.lineHeight} {...LINE_HEIGHT_RANGE} onChange={(lineHeight) => onChange({ lineHeight })} label={t("books.reader.lineHeight")} colors={colors} />
      </Row>

      <Row label={t("books.reader.margins")}>
        <Choices value={prefs.margin} options={MARGINS} label={t("books.reader.margins")} colors={colors} onPick={(margin) => onChange({ margin })} render={(m) => t(`books.reader.marginSizes.${m}`)} />
      </Row>

      <Row label={t("books.reader.layout")}>
        <Choices value={prefs.layout} options={LAYOUTS} label={t("books.reader.layout")} colors={colors} onPick={(layout) => onChange({ layout })} render={(v) => t(`books.reader.layouts.${v}`)} />
      </Row>

      <Row label={t("books.reader.turn")}>
        <Choices value={prefs.turn} options={TURNS} label={t("books.reader.turn")} colors={colors} onPick={(turn) => onChange({ turn })} render={(v) => t(`books.reader.turns.${v}`)} />
      </Row>

      <div className="py-1">
        <Switch on={prefs.justify} onChange={(justify) => onChange({ justify })} label={t("books.reader.justify")} colors={colors} />
        <Switch on={prefs.tapTurns} onChange={(tapTurns) => onChange({ tapTurns })} label={t("books.reader.tapTurns")} colors={colors} />
      </div>

      <Row label={t("books.reader.brightness")} value={`${Math.round(prefs.brightness * 100)} %`}>
        <Slider value={prefs.brightness} min={0.4} max={1} step={0.05} onChange={(brightness) => onChange({ brightness })} label={t("books.reader.brightness")} colors={colors} />
      </Row>
      <Row label={t("books.reader.warmth")} value={`${Math.round(prefs.warmth * 100)} %`}>
        <Slider value={prefs.warmth} min={0} max={1} step={0.05} onChange={(warmth) => onChange({ warmth })} label={t("books.reader.warmth")} colors={colors} />
      </Row>
    </PanelFrame>
  );
}
