"use client";

import { useEffect, useRef, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { loadYoutubeIframeApi, type YTPlayer } from "@/lib/loadYoutubeIframeApi";
import { useT } from "@/components/TranslationProvider";

const DWELL_MS = 3000;
// A settle window AFTER the real "now playing" event fires, not instead of it — YouTube's own
// startup title/channel card can still be visible for a while even once playback has genuinely
// started; onStateChange alone wasn't enough of a signal by itself. Combined with the top-crop
// below (belt and suspenders): even if a sliver of that overlay is still fading out somewhere in
// the frame, it's now cropped away rather than depending purely on timing.
const SETTLE_MS = 1500;
// Crops this many pixels off the video's own top edge — YouTube's title/channel overlay is a
// roughly fixed-height band regardless of how large the video itself is scaled, so a fixed pixel
// offset tracks it more reliably than a percentage would.
const TOP_CROP_PX = 64;

// Radial vignette — transparent through the middle-right (where the video should read clearly),
// darkening toward the true edges into the app's own slate-950, so it dissolves into the
// surrounding background rather than being cut off by a hard rectangle. Off-center toward the
// right/upper area on purpose: the title/synopsis text sits bottom-left, so that's where this
// should already be darkest.
const VIGNETTE = "radial-gradient(ellipse 80% 75% at 64% 36%, transparent 35%, transparent 52%, rgba(2,6,23,0.6) 78%, rgb(2,6,23) 100%)";

// Netflix's own browse-hero behavior: once focus has rested on a title for DWELL_MS, its trailer
// takes over the persistent backdrop banner itself — same role, same full-screen footprint
// CinemaClient's still-image backdrop already has (own vignette here instead of that image's own
// vertical mask, which was tuned for a still photo fading into the rows pane below, not a video
// meant to stay bold across most of the frame) — rather than a separate box floating on top of
// the UI. Rendered as a sibling layered directly over that still image (later in DOM order, no
// z-index needed — see CinemaClient's own note on that convention); the image never unmounts
// underneath it, so it's always there as the fallback until (and unless) this actually becomes
// visible. Shared by CinemaHero's and CinemaSeriesHero's tabs via CinemaClient, which owns the
// debounced hero item this is keyed on — the logic here has nothing movie/series-specific in it,
// just a trailer key and something to key the dwell timer on.
export function CinemaTrailerBackdrop({
  itemKey,
  trailerKey,
}: {
  itemKey: string | number;
  trailerKey: string | null | undefined;
}) {
  const t = useT();
  const mountRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const [dwelled, setDwelled] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);

  // Resets synchronously during render (not in an effect — this project's react-hooks/
  // set-state-in-effect rule) on every title change, even before the debounce that gates
  // `trailerKey` itself settles: arrowing across a row must never leave a stale dwelled/playing/
  // unmuted state, or a previous title's player instance, bleeding into the next one.
  const [resetForKey, setResetForKey] = useState(itemKey);
  if (itemKey !== resetForKey) {
    setResetForKey(itemKey);
    setDwelled(false);
    setPlaying(false);
    setMuted(true);
  }

  useEffect(() => {
    if (!trailerKey) return;
    const timer = setTimeout(() => setDwelled(true), DWELL_MS);
    return () => clearTimeout(timer);
  }, [itemKey, trailerKey]);

  // Creates a real YT.Player once dwelled — not a raw <iframe src=...>. Two things this buys
  // over a plain embed: an actual onStateChange event to key the reveal off of (see SETTLE_MS's
  // own note — a fixed timer had to guess long enough to probably outlast YouTube's own startup
  // overlay, and still sometimes didn't), and mute()/unMute() calls that don't require reloading
  // the player (a raw iframe would need its src rewritten, restarting playback from 0).
  useEffect(() => {
    if (!dwelled || !trailerKey || !mountRef.current) return;
    let cancelled = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    loadYoutubeIframeApi().then((YT) => {
      if (cancelled || !mountRef.current) return;
      playerRef.current = new YT.Player(mountRef.current, {
        videoId: trailerKey,
        playerVars: {
          autoplay: 1,
          mute: 1,
          controls: 0,
          loop: 1,
          playlist: trailerKey,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          disablekb: 1,
          fs: 0,
          iv_load_policy: 3,
        },
        events: {
          // YT.Player replaces the mount div with its own <iframe>, sized via width/height
          // above — those are just placeholder numbers; the "cover" sizing that actually makes
          // it fill this component's box regardless of aspect ratio is applied here instead,
          // directly on the real iframe element (object-fit doesn't apply to iframes, so this is
          // the standard trick: oversize it via vw/vh and center/crop with overflow-hidden on
          // the parent). The extra upward shift (+ matching height buffer, so the bottom still
          // reaches the container's own bottom edge post-shift) crops the very top strip off —
          // where YouTube's own title/channel overlay renders — physically out of view, rather
          // than relying on SETTLE_MS alone to outlast it.
          onReady: (e) => {
            const iframe = e.target.getIframe();
            Object.assign(iframe.style, {
              position: "absolute",
              top: "0",
              left: "50%",
              width: "177.78vh", // 16:9 of the viewport's own height
              height: "56.25vw", // 16:9 of the viewport's own width
              minWidth: "100%",
              minHeight: `calc(100% + ${TOP_CROP_PX}px)`,
              transform: `translate(-50%, -${TOP_CROP_PX}px)`,
              pointerEvents: "none",
            });
          },
          onStateChange: (e) => {
            if (e.data === YT.PlayerState.PLAYING) {
              settleTimer = setTimeout(() => setPlaying(true), SETTLE_MS);
            }
          },
        },
      });
    });

    return () => {
      cancelled = true;
      if (settleTimer) clearTimeout(settleTimer);
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, [dwelled, trailerKey, itemKey]);

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    if (next) playerRef.current?.mute();
    else playerRef.current?.unMute();
  }

  if (!trailerKey || !dwelled) return null;

  return (
    <div
      className={`absolute inset-0 h-full w-full overflow-hidden transition-opacity duration-700 ${playing ? "opacity-100" : "opacity-0"}`}
    >
      <div ref={mountRef} className="pointer-events-none absolute inset-0" />

      {/* The vignette IS the "fondu qui fait disparaître les bords" — a single radial falloff
          rather than the previous stack of rectangular gradients, which read as a flat haze over
          the whole video instead of a clean edge treatment. CinemaClient's own sibling gradients
          (left-side text legibility, bottom fade into the rows pane) still apply on top of this,
          same as they already do for the still-image backdrop. */}
      <div className="pointer-events-none absolute inset-0" style={{ background: VIGNETTE }} />

      {/* Mouse-only, deliberately not part of the TV-remote grid nav chain (same reasoning as
          the back button / shortcuts guide floating outside it) — a discreet corner affordance,
          not a focusable stop along the browse flow. */}
      <button
        type="button"
        onClick={toggleMute}
        aria-label={muted ? t("cinema.unmutePreview") : t("cinema.mutePreview")}
        className="pointer-events-auto absolute right-4 top-20 flex h-8 w-8 items-center justify-center rounded-full bg-black/40 text-white/70 backdrop-blur-xs transition-colors hover:bg-black/60 hover:text-white"
        style={{ top: "max(5rem, calc(env(safe-area-inset-top) + 4rem))" }}
      >
        {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
      </button>
    </div>
  );
}
