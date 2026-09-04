"use client";

import { PlayCircle, RotateCcw } from "lucide-react";
import { formatResumeTicks } from "@/lib/format";
import { useT } from "@/components/TranslationProvider";
import { usePlayerEnabled } from "@/lib/usePlayerEnabled";
import { usePlayback } from "@/components/PlaybackProvider";

interface PlayButtonProps {
  itemId: string;
  title: string;
  /** UserData.PlaybackPositionTicks — omit or 0 for "Lire", any positive value shows "Reprendre - Xmin". */
  resumeTicks?: number;
  /** RunTimeTicks — combined with resumeTicks to draw the in-button progress fill (variant="primary" only). */
  runtimeTicks?: number;
  className?: string;
  iconSize?: number;
  /** "primary": solid button, progress fill inside when resuming (movie/series sheets) ·
   *  "pill": small rounded button with label (cards, lists) · "icon": icon-only, no label ·
   *  "row": full-width menu row with a circular icon badge (Cinema Mode's detail overlay). */
  variant?: "primary" | "pill" | "icon" | "row";
  /** Overrides the default Lire/Reprendre text — for the series-level button,
   *  which needs episode context, e.g. "Reprendre EP3 S2 - 23min05". */
  label?: string;
  /** For series: resolves the episode after the given itemId, if any — powers
   *  the credits-time "next up" prompt and its in-place auto-advance. */
  getNextEpisode?: (currentItemId: string) => { itemId: string; title: string } | null;
  /**
   * Repartir du début plutôt que de reprendre.
   *
   * Rendu par ce composant et non par un bouton à part, pour la même raison que le reste : la
   * position de reprise, l'accès au lecteur et le comportement du clic sont décidés ici une
   * fois. Le bouton ne s'affiche que là où il a un sens — c'est-à-dire quand il y a bien une
   * reprise à écarter.
   */
  restart?: boolean;
}

// Single source of truth for the Lire/Reprendre label + resume behavior, used
// everywhere a play button appears (movie sheets, episode rows, dashboard,
// recent-activity cards) so wording and behavior never drift between pages.
export function PlayButton({
  itemId,
  title,
  resumeTicks,
  runtimeTicks,
  className,
  iconSize = 14,
  variant = "pill",
  label: labelOverride,
  getNextEpisode,
  restart = false,
}: PlayButtonProps) {
  const playback = usePlayback();
  const t = useT();
  const playerEnabled = usePlayerEnabled();

  if (!playerEnabled) return null;

  const hasResume = !!resumeTicks && resumeTicks > 0;
  // Un bouton « recommencer » sans reprise en cours ne recommencerait rien.
  if (restart && !hasResume) return null;

  const label = labelOverride ?? (
    restart ? t('common.restart') : hasResume ? `${t('common.resume')} - ${formatResumeTicks(resumeTicks!)}` : t('common.play')
  );
  const initialResumeAt = restart ? 0 : hasResume ? resumeTicks! / 10_000_000 : undefined;
  const progressPct =
    !restart && hasResume && runtimeTicks && runtimeTicks > 0 ? Math.min(100, (resumeTicks! / runtimeTicks) * 100) : null;
  const Icon = restart ? RotateCcw : PlayCircle;

  const defaultClass =
    variant === "icon"
      ? "rounded-full bg-accent-600/80 p-1.5 text-white hover:bg-accent-600"
      : variant === "primary"
        ? "btn-primary relative overflow-hidden"
        : variant === "row"
          ? "flex w-full items-center gap-3 rounded-lg px-4 py-2.5 text-left text-white transition-colors hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none"
          : "flex items-center gap-1.5 rounded-lg bg-accent-600/80 px-3 py-1.5 text-xs text-white backdrop-blur-xs hover:bg-accent-600";

  return (
    <button
      data-detail-menu={variant === "row" ? "" : undefined}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        playback.play({ itemId, title, resumeAt: initialResumeAt, getNextEpisode });
      }}
      className={className ?? defaultClass}
      title={label}
    >
      {variant === "primary" && progressPct !== null && (
        <span className="absolute inset-y-0 left-0 bg-white/25" style={{ width: `${progressPct}%` }} />
      )}
      {variant === "row" ? (
        <>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10">
            <Icon size={iconSize} />
          </span>
          <span className="text-sm font-medium">{label}</span>
        </>
      ) : (
        <span className="relative z-10 inline-flex items-center gap-1.5">
          <Icon size={iconSize} />
          {variant !== "icon" && label}
        </span>
      )}
    </button>
  );
}
