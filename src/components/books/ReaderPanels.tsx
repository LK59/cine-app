"use client";

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
  type ReaderPrefs,
} from "@/lib/books/readerPrefs";
import type { FoliateTocItem } from "@/lib/books/foliate/view";

type Colors = { bg: string; fg: string; link: string; dark: boolean };

/**
 * Les deux panneaux du lecteur de livres (DECISIONS.md §127) : la table des matières et les réglages.
 * Sur téléphone, une feuille qui monte du bas et laisse voir la page au-dessus ; sur un grand écran,
 * un panneau sur le côté. Chaque réglage s'applique à la page derrière, aussitôt : on règle en lisant.
 */
function PanelFrame({ colors, title, onClose, children, side }: { colors: Colors; title: string; onClose: () => void; children: React.ReactNode; side: "left" | "right" }) {
  const t = useT();
  return (
    <div
      className={`absolute inset-x-0 bottom-0 z-20 flex max-h-[62%] flex-col rounded-t-2xl border shadow-2xl shadow-black/40 backdrop-blur-2xl animate-fade-in-up sm:inset-y-3 sm:bottom-3 sm:max-h-none sm:w-[23rem] sm:rounded-2xl sm:animate-fade-in-side ${side === "left" ? "sm:left-3 sm:right-auto" : "sm:left-auto sm:right-3"}`}
      style={{
        background: colors.dark ? "rgb(24 24 27 / 0.9)" : "rgb(255 255 255 / 0.9)",
        color: colors.fg,
        borderColor: colors.dark ? "rgb(255 255 255 / 0.08)" : "rgb(0 0 0 / 0.08)",
        paddingBottom: "env(safe-area-inset-bottom)",
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

export function ReaderTocPanel({
  toc,
  currentHref,
  colors,
  onPick,
  onClose,
}: {
  toc: FoliateTocItem[];
  currentHref: string | null;
  colors: Colors;
  onPick: (href: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const rows: { item: FoliateTocItem; depth: number }[] = [];
  const walk = (items: FoliateTocItem[] | null | undefined, depth: number) => {
    for (const item of items ?? []) {
      rows.push({ item, depth });
      walk(item.subitems, depth + 1);
    }
  };
  walk(toc, 0);
  return (
    <PanelFrame colors={colors} title={t("books.reader.contents")} onClose={onClose} side="left">
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

      <Row label={t("books.reader.fontSize")} value={`${prefs.fontSize} %`}>
        <Slider
          value={prefs.fontSize}
          {...FONT_SIZE_RANGE}
          onChange={(fontSize) => onChange({ fontSize })}
          label={t("books.reader.fontSize")}
          colors={colors}
          left={<span className="w-4 text-center text-xs">A</span>}
          right={<span className="w-4 text-center text-xl">A</span>}
        />
        <p className="mt-1.5 text-xs opacity-60">{t("books.reader.zoomHint")}</p>
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
