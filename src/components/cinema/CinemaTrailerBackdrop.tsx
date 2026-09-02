"use client";

import { useEffect, useRef, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { loadYoutubeIframeApi, type YTPlayer } from "@/lib/loadYoutubeIframeApi";
import { BACKDROP_MASK } from "@/lib/cinemaBackdropMask";
import { useT } from "@/components/TranslationProvider";

const DWELL_MS = 3000;
// A small settle window AFTER the real "now playing" event fires, not instead of it — YouTube's
// own startup title/channel card can still be fading out for a beat even once playback has
// genuinely started. Short here on purpose: unlike the previous blind fixed-delay approach (which
// had to guess long enough to *probably* cover the whole startup sequence, control flash and all),
// this only has to cover the tail end of an already-confirmed "it's playing" state.
const SETTLE_MS = 600;

// Netflix's own browse-hero behavior: once focus has rested on a title for DWELL_MS, its trailer
// takes over the persistent backdrop banner itself — same role, same mask, same full-screen
// treatment CinemaClient's still-image backdrop already uses — rather than a separate box
// floating on top of the UI. Rendered as a sibling layered directly over that still image (later
// in DOM order, no z-index needed — see CinemaClient's own note on that convention); the image
// never unmounts underneath it, so it's always there as the fallback until (and unless) this
// actually becomes visible. Shared by CinemaHero's and CinemaSeriesHero's tabs via CinemaClient,
// which owns the debounced hero item this is keyed on — the logic here has nothing
// movie/series-specific in it, just a trailer key and something to key the dwell timer on.
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
          // the parent).
          onReady: (e) => {
            const iframe = e.target.getIframe();
            Object.assign(iframe.style, {
              position: "absolute",
              top: "0",
              left: "50%",
              width: "177.78vh", // 16:9 of the viewport's own height
              height: "56.25vw", // 16:9 of the viewport's own width
              minWidth: "100%",
              minHeight: "100%",
              transform: "translateX(-50%)",
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
      style={{ maskImage: BACKDROP_MASK, WebkitMaskImage: BACKDROP_MASK }}
    >
      <div ref={mountRef} className="pointer-events-none absolute inset-0" />

      {/* Same legibility treatment the still-image backdrop already gets from CinemaClient's own
          sibling gradient divs (side darkening for the text column, bottom fade into the rows
          pane) — this only needs its OWN top-level dark wash on top of the video so it doesn't
          read as "too crisp/too much motion" next to those, mirroring what "fondu/assombri sur
          les côtés" asked for. */}
      <div className="pointer-events-none absolute inset-0 bg-slate-950/25" />

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
