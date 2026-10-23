"use client";

/**
 * Les lignes que partagent les menus du lecteur : un choix coché, un groupe de l'apparence des
 * sous-titres, un décalage, le badge « Bêta ».
 */

import { Check } from "lucide-react";
import { useT } from "@/components/TranslationProvider";

/**
 * Un groupe de choix du sous-menu des sous-titres.
 *
 * Trois réglages qui se règlent tous de la même façon — un intitulé, quelques valeurs, celle qui
 * est retenue en couleur d'accent — et qui n'ont donc aucune raison d'être écrits trois fois.
 */
export function SubtitleStyleGroup<T extends string | number>({
  label,
  options,
  current,
  onPick,
}: {
  label: string;
  options: { value: T; label: string }[];
  current: T;
  onPick: (value: T) => void;
}) {
  return (
    <div className="border-b border-white/10 px-3 py-2 last:border-b-0">
      <p className="mb-1.5 text-[11px] uppercase tracking-wide text-white/40">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            onClick={() => onPick(option.value)}
            aria-pressed={current === option.value}
            className={`rounded-full px-2.5 py-1 text-xs ${
              current === option.value ? "bg-accent-600 text-ink" : "bg-white/10 text-white/70 hover:bg-white/20"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** « Bêta », le même badge que la diffusion Chromecast — à retirer quand le réglage aura fait ses preuves. */
export function DialogueBeta() {
  const t = useT();
  return (
    <span className="shrink-0 rounded-full border border-white/20 px-1.5 py-px text-[11px] font-semibold uppercase leading-4 tracking-wider text-white/70">
      {t("player.chromecast.beta")}
    </span>
  );
}

/**
 * Un décalage de sous-titres : l'intitulé, −0,5 s, la valeur, +0,5 s. Le même pour le principal et
 * pour le second (§87) — même pas, même place.
 */
export function OffsetRow({ label, seconds, onShift }: { label: string; seconds: number; onShift: (deltaSeconds: number) => void }) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 text-sm text-white">
      <span className="min-w-0">{label}</span>
      <div className="flex shrink-0 items-center gap-1">
        <button onClick={() => onShift(-0.5)} className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20">
          −0.5s
        </button>
        <span className="w-12 text-center tabular-nums text-xs text-white/70">
          {seconds > 0 ? "+" : ""}
          {seconds}s
        </span>
        <button onClick={() => onShift(0.5)} className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20">
          +0.5s
        </button>
      </div>
    </div>
  );
}

/**
 * L'option retenue d'un menu du lecteur : une coche, comme les menus d'iOS et de l'Apple TV
 * (13/10/2026). Elle était dite par la couleur d'accent sur un texte blanc ; l'accent devenu blanc
 * (§83), la piste choisie ne se distinguait plus des autres. La place est gardée sur chaque ligne
 * pour que les libellés restent alignés. `data-option-on` la désigne au menu, qui la fait
 * défiler dans son cadre à l'ouverture (`LiquidMenu`, LECTEUR-15).
 */
function OptionCheck({ on }: { on: boolean }) {
  return <Check size={16} strokeWidth={2.5} aria-hidden data-option-on={on ? "" : undefined} className={`mt-0.5 shrink-0 ${on ? "" : "invisible"}`} />;
}

/**
 * Une ligne de choix d'un menu du lecteur : sa coche, et le gras quand c'est l'option retenue. Écrite
 * une fois pour toutes les listes (pistes, minuterie, vitesse…) ; les chapitres alignent au centre,
 * pour leur vignette. Les `data-*` passent tels quels au bouton.
 */
export function MenuOption({
  on,
  onClick,
  align = "start",
  children,
  ...data
}: {
  on: boolean;
  onClick: () => void;
  align?: "start" | "center";
  children: React.ReactNode;
  [dataAttribute: `data-${string}`]: string | number;
}) {
  return (
    <button
      {...data}
      onClick={onClick}
      className={`flex w-full ${align === "center" ? "items-center" : "items-start"} gap-2 px-3 py-2 text-left text-sm text-white hover:bg-white/10${on ? " font-semibold" : ""}`}
    >
      <OptionCheck on={on} />
      {children}
    </button>
  );
}
