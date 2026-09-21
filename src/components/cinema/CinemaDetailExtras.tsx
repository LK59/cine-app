"use client";

import { ArrowDown } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { formatMinutes } from "@/lib/format";

/**
 * Trois détails légers, repris de la gestion le 21/09/2026 — et écrits une fois pour toutes les
 * fiches (film, série, téléphone, découverte), parce que ce sont exactement les petites décisions
 * qui dérivent quand chaque écran les écrit à sa façon. Louis voulait des détails « très légers,
 * nécessaires et discrets » : une ligne, un mot, un pourcentage — rien qui fasse une section.
 */

/**
 * L'accroche du film (« In space no one can hear you scream »), sous les métadonnées.
 *
 * Elle était déjà dans la charge de chaque fiche et n'était jamais montrée. En italique et
 * atténuée : elle donne le ton sans rien disputer au synopsis juste en dessous.
 */
export function CinemaTagline({ text, className = "" }: { text: string | null | undefined; className?: string }) {
  if (!text?.trim()) return null;
  return <p className={`text-sm italic leading-snug text-white/55 ${className}`}>{text.trim()}</p>;
}

/**
 * La durée telle qu'on la dit : celle du film, ou celle d'un épisode pour une série
 * (« 45min/ép. ») — la question qu'on se pose avant de commencer une série n'est pas sa durée
 * totale, c'est ce qu'engage un épisode.
 */
export function useRuntimeLabel() {
  const t = useT();
  return (minutes: number | null | undefined, perEpisode: boolean): string | null => {
    const time = formatMinutes(minutes);
    if (!time) return null;
    return perEpisode ? t("cinema.perEpisode", { time }) : time;
  };
}

/**
 * « Arrive · 63 % » — un titre ou un épisode demandé, en train de se télécharger.
 *
 * Un pourcentage entier, arrondi vers le bas : « 100 % » n'est dit qu'une fois vraiment fini, ce
 * qui n'arrive jamais ici puisqu'un fichier importé quitte la file.
 */
export function downloadPercent(progress: number): number {
  return Math.min(99, Math.max(0, Math.floor(progress * 100)));
}

export function CinemaDownloading({ progress, className = "" }: { progress: number; className?: string }) {
  const t = useT();
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium tabular-nums text-accent-300 ${className}`}>
      <ArrowDown size={12} className="shrink-0" />
      {t("cinema.downloading", { pct: downloadPercent(progress) })}
    </span>
  );
}

/** Tant que quelque chose arrive, la fiche se relit toute seule ; sinon, jamais. */
export const DOWNLOAD_REFRESH_MS = 15_000;
