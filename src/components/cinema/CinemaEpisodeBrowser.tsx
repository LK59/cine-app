"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Play, Check } from "lucide-react";
import { PosterImage } from "@/components/PosterImage";
import { CinemaEpisodeProgress } from "@/components/cinema/CinemaEpisodeProgress";
import { formatDurationShort } from "@/lib/format";
import { useDelayedClose } from "@/lib/useDelayedClose";
import { useT } from "@/components/TranslationProvider";
import { usePlayback } from "@/components/PlaybackProvider";
import type { CinemaSeason, CinemaEpisode } from "@/app/api/cinema/series/[jellyfinId]/episodes/route";

// "Plus d'épisodes" — Netflix's own TV-app episode browser: seasons as a vertical list on the
// left, that season's episodes (thumbnail/title/duration/synopsis) on the right. Opened from
// CinemaSeriesDetail's menu, portaled to document.body for the same containing-block reason
// every other Cinema Mode fixed layer is (see CinemaClient's own doc comment) — and sits one
// z-index above it (48 vs 46) so it visually replaces the detail sheet rather than stacking
// under/beside it.
export function CinemaEpisodeBrowser({
  title,
  seasons,
  nextEpisodeId,
  onClose,
  onPlayEpisode,
}: {
  title: string;
  seasons: CinemaSeason[];
  // The series' own "Lire"/"Reprendre" target (CinemaSeriesDetail's nextEpisode) — badged here
  // too so it's obvious at a glance which episode picking "Plus d'épisodes" would have landed on
  // anyway, without having to cross-reference against the detail sheet underneath.
  nextEpisodeId?: string;
  onClose: () => void;
  onPlayEpisode: (episode: CinemaEpisode) => void;
}) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedSeason, setSelectedSeason] = useState(seasons[0]?.seasonNumber ?? 0);

  // Same debounce-before-crossfade pattern CinemaClient's own hero backdrop uses (see its doc
  // comment on "ghosting") — selectedSeason changes on every arrow-key press while scrubbing
  // through the season list (onFocus fires per row passed through), and the episode pane below
  // is keyed by season number to crossfade on a change; without debouncing, holding Up/Down would
  // restart that fade on every intermediate season instead of settling once on the one landed on.
  const [displayedSeason, setDisplayedSeason] = useState(selectedSeason);
  useEffect(() => {
    const timer = setTimeout(() => setDisplayedSeason(selectedSeason), 150);
    return () => clearTimeout(timer);
  }, [selectedSeason]);
  const episodes = seasons.find((s) => s.seasonNumber === displayedSeason)?.episodes ?? [];

  // "Going deeper" from the detail sheet — see the hook's own doc comment and globals.css's note
  // on slide-in-right/slide-out-right for why this gets a slide instead of every other Cinema
  // Mode overlay's plain fade: this is the one place a full screen genuinely replaces another
  // rather than layering on top of it.
  const { closing, requestClose } = useDelayedClose(onClose, 220);

  useEffect(() => {
    containerRef.current?.querySelector<HTMLButtonElement>('[data-episode-season="true"]')?.focus();
  }, []);

  // The episode pane is keyed by displayedSeason, so changing season unmounts every button in it
  // — including the focused one if focus was over there (hovering the season list with the mouse
  // while navigating episodes by keyboard does exactly that). Focus then falls to <body>, where
  // the key handler below matches neither list and arrow keys go dead until something is clicked.
  // Same "menu closed and took focus with it" class of bug as elsewhere in Cinema Mode; catching
  // it here keeps keyboard control alive through a mouse-driven season change.
  useEffect(() => {
    if (document.activeElement !== document.body) return;
    containerRef.current?.querySelector<HTMLButtonElement>('[data-episode-item="true"]')?.focus();
  }, [displayedSeason]);

  // Stays open under the player once an episode starts, so closing the player comes back to the
  // season you launched it from — and stands down from the keyboard while it's up there, or both
  // handlers would run on every arrow press (see CinemaMovieDetail's own note).
  const playback = usePlayback();
  const playerOwnsKeyboard = playback.mode === "full";

  // Left/Right move between the season list and the episode list; Up/Down cycle within
  // whichever one currently has focus — same roving-focus convention as the player's own
  // directional nav and CinemaMovieDetail's vertical menu.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (playerOwnsKeyboard) return;
      if (e.key === "Escape" || e.key === "Backspace") {
        e.preventDefault();
        requestClose();
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      const inSeasons = active?.getAttribute("data-episode-season") === "true";
      const inEpisodes = active?.getAttribute("data-episode-item") === "true";
      if (!inSeasons && !inEpisodes) return;

      if (e.key === "ArrowRight" && inSeasons) {
        e.preventDefault();
        containerRef.current?.querySelector<HTMLButtonElement>('[data-episode-item="true"]')?.focus();
        return;
      }
      if (e.key === "ArrowLeft" && inEpisodes) {
        e.preventDefault();
        containerRef.current?.querySelector<HTMLButtonElement>(`[data-episode-season="true"][data-season="${selectedSeason}"]`)?.focus();
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const selector = inSeasons ? '[data-episode-season="true"]' : '[data-episode-item="true"]';
        const items = Array.from(containerRef.current?.querySelectorAll<HTMLButtonElement>(selector) ?? []);
        const idx = items.indexOf(active as HTMLButtonElement);
        const next = e.key === "ArrowDown" ? items[Math.min(idx + 1, items.length - 1)] : items[Math.max(idx - 1, 0)];
        next?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose, selectedSeason, playerOwnsKeyboard]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={containerRef}
      className={`fixed inset-0 overflow-hidden bg-ink ${closing ? "animate-fade-out" : "animate-fade-in"}`}
      // Le rail du lecteur est posé sur le bord gauche de l'écran, au-dessus de cette fiche :
      // sans ce retrait, la colonne de texte et le bouton Retour passeraient dessous. La variable
      // vaut 0 partout ailleurs, donc rien ne bouge hors du lecteur.
      style={{ zIndex: 48, paddingLeft: "var(--player-rail, 0px)" }}
    >
      <button
        onClick={requestClose}
        className="btn btn-ghost fixed z-10 rounded-full bg-black/55 px-3 py-2"
        style={{ top: "max(1rem, env(safe-area-inset-top))", left: "calc(1rem + var(--player-rail, 0px))" }}
      >
        <ArrowLeft size={16} /> {t("cinema.back")}
      </button>

      {/* No position:fixed descendants here (the back button above is a sibling) — safe to
          transform, unlike the outer root (see globals.css's own note on this pitfall). */}
      <div className={`flex h-full pt-20 ${closing ? "animate-slide-out-right" : "animate-slide-in-right"}`}>
        <div className="scrollbar-thin w-56 shrink-0 overflow-y-auto border-r border-white/10 px-3 pb-8 sm:w-64">
          <p className="mb-3 truncate px-2 text-sm font-medium text-white/60">{title}</p>
          {seasons.map((season) => {
            const active = season.seasonNumber === selectedSeason;
            return (
              <button
                key={season.seasonNumber}
                data-episode-season="true"
                data-season={season.seasonNumber}
                onFocus={() => setSelectedSeason(season.seasonNumber)}
                onMouseEnter={() => setSelectedSeason(season.seasonNumber)}
                className={`mb-1 flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-none ${
                  active ? "bg-accent-600/25 text-white ring-1 ring-accent-500/50" : "text-white/80 hover:bg-white/10"
                }`}
              >
                {season.seasonNumber === 0 ? t("cinema.specials") : t("cinema.season", { n: season.seasonNumber })}
              </button>
            );
          })}
        </div>

        <div className="scrollbar-thin flex-1 overflow-y-auto px-6 pb-16 pt-1 sm:px-10">
          {/* Keyed by the debounced season, not the live one — remounting (and re-fading) this
              on every intermediate season while scrubbing would be exactly the "ghosting" bug
              CinemaClient's own hero backdrop hit; see displayedSeason's own doc comment above. */}
          <div key={displayedSeason} className="mx-auto flex max-w-3xl animate-fade-in flex-col gap-2">
            {episodes.map((ep) => (
              <button
                key={ep.jellyfinItemId}
                data-episode-item="true"
                onClick={() => onPlayEpisode(ep)}
                className="flex items-start gap-4 rounded-lg p-3 text-left transition-colors hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none"
              >
                <div className="relative w-40 shrink-0 sm:w-48">
                  <PosterImage src={ep.thumbnailUrl} alt={ep.title} aspectRatio="aspect-video" unoptimized subtle />
                  <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-opacity hover:bg-black/30 hover:opacity-100">
                    <Play size={28} className="text-white drop-shadow-lg" fill="currentColor" />
                  </span>
                  {ep.watched && (
                    <span className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-accent-500/90">
                      <Check size={12} className="text-white" />
                    </span>
                  )}
                  <CinemaEpisodeProgress resumeTicks={ep.resumeTicks} runtimeTicks={ep.runtimeTicks} watched={ep.watched} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium text-white">
                      {ep.episodeNumber}. {ep.title}
                    </span>
                    {ep.jellyfinItemId === nextEpisodeId && (
                      <span className="shrink-0 rounded-full bg-accent-600/25 px-2 py-0.5 text-xs font-medium text-accent-300 ring-1 ring-accent-500/40">
                        {t("cinema.nextUpBadge")}
                      </span>
                    )}
                    {/* A started episode says what's LEFT, not how long it is — the number you
                        actually want before pressing play. Untouched ones keep the runtime. */}
                    {ep.resumeTicks && ep.runtimeTicks && !ep.watched ? (
                      <span className="shrink-0 text-xs text-accent-300">
                        {t("cinema.timeRemaining", { time: formatDurationShort(ep.runtimeTicks - ep.resumeTicks) })}
                      </span>
                    ) : (
                      ep.runtimeMinutes && <span className="shrink-0 text-xs text-white/50">{ep.runtimeMinutes} min</span>
                    )}
                  </div>
                  {ep.overview && <p className="mt-1 line-clamp-2 text-xs text-white/60">{ep.overview}</p>}
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
