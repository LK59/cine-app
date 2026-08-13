"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { PlayCircle } from "lucide-react";
import { formatResumeTicks } from "@/lib/format";
import { useT } from "@/components/TranslationProvider";

const PlayerModal = dynamic(() => import("@/components/PlayerModal").then((m) => m.PlayerModal), { ssr: false });

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
   *  "pill": small rounded button with label (cards, lists) · "icon": icon-only, no label. */
  variant?: "primary" | "pill" | "icon";
  /** Overrides the default Lire/Reprendre text — for the series-level button,
   *  which needs episode context, e.g. "Reprendre EP3 S2 - 23min05". */
  label?: string;
  /** For series: resolves the episode after the given itemId, if any — powers
   *  the credits-time "next up" prompt and its in-place auto-advance. */
  getNextEpisode?: (currentItemId: string) => { itemId: string; title: string } | null;
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
}: PlayButtonProps) {
  // The item currently open in the player — starts null (closed), and can be
  // swapped to a different item in place when the player auto-advances.
  const [playing, setPlaying] = useState<{ itemId: string; title: string; resumeAt?: number } | null>(null);
  const t = useT();

  const hasResume = !!resumeTicks && resumeTicks > 0;
  const label = labelOverride ?? (hasResume ? `${t('common.resume')} - ${formatResumeTicks(resumeTicks!)}` : t('common.play'));
  const initialResumeAt = hasResume ? resumeTicks! / 10_000_000 : undefined;
  const progressPct =
    hasResume && runtimeTicks && runtimeTicks > 0 ? Math.min(100, (resumeTicks! / runtimeTicks) * 100) : null;

  const defaultClass =
    variant === "icon"
      ? "rounded-full bg-accent-600/80 p-1.5 text-white hover:bg-accent-600"
      : variant === "primary"
        ? "btn-primary relative overflow-hidden"
        : "flex items-center gap-1.5 rounded-lg bg-accent-600/80 px-3 py-1.5 text-xs text-white backdrop-blur-xs hover:bg-accent-600";

  return (
    <>
      <button
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setPlaying({ itemId, title, resumeAt: initialResumeAt });
        }}
        className={className ?? defaultClass}
        title={label}
      >
        {variant === "primary" && progressPct !== null && (
          <span className="absolute inset-y-0 left-0 bg-white/25" style={{ width: `${progressPct}%` }} />
        )}
        <span className="relative z-10 inline-flex items-center gap-1.5">
          <PlayCircle size={iconSize} />
          {variant !== "icon" && label}
        </span>
      </button>
      {playing && (
        <PlayerModal
          itemId={playing.itemId}
          title={playing.title}
          resumeAt={playing.resumeAt}
          nextEpisode={getNextEpisode?.(playing.itemId) ?? null}
          onAdvance={(next) => setPlaying({ itemId: next.itemId, title: next.title })}
          onClose={() => setPlaying(null)}
        />
      )}
    </>
  );
}
