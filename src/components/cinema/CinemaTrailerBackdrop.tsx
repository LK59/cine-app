"use client";

import { useEffect, useRef, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { loadYoutubeIframeApi, type YTPlayer } from "@/lib/loadYoutubeIframeApi";
import { useT } from "@/components/TranslationProvider";

// This is now a PRE-WARM delay, not a "how long before you see anything" one: the player is
// created (and starts playing, invisibly) this early so that the REVEAL_AT_SECONDS countdown
// below is already running while the user is still looking at the still backdrop. Kept short
// for that reason — the visible reveal is gated on playback position, not on this.
const DWELL_MS = 500;
// The reveal is gated on the video being genuinely this many seconds in — NOT on the "playing"
// state event, and not on a fixed delay after it. YouTube's own startup overlay (title/channel
// card, and the centre prev/play/next controls) is drawn by the embed itself and can't be
// removed: the iframe is cross-origin, so no CSS or JS of ours can reach inside it, and no
// player param disables it. It does fade on its own after ~3s of playback though, so the one
// reliable way to never show it is to keep the whole backdrop hidden until playback is already
// past that point. Polling getCurrentTime() rather than trusting a timer also means buffering
// stalls can't slip the overlay into view — and it doubles as the loop handler: when the video
// loops back to 0, this drops below the threshold again, hiding the backdrop for exactly as
// long as the overlay reappears on the restart.
const REVEAL_AT_SECONDS = 4;
// ...and, on top of the position check, playback has to have been advancing *smoothly* for this
// long. The position alone isn't enough after an interruption: the browser suspends media in
// background tabs (nothing we can opt out of), so coming back to the tab restarts playback with
// the overlay redrawn even though the position is long past REVEAL_AT_SECONDS. Requiring a
// stretch of uninterrupted progress covers every one of those cases with a single rule — first
// start, loop restart, tab return, or a mid-playback buffering stall — instead of a separate
// fixed grace period per case.
const STEADY_PLAYBACK_MS = 2500;
// Crops this many pixels off the video's own top edge — YouTube's title/channel overlay is a
// roughly fixed-height band regardless of how large the video itself is scaled, so a fixed pixel
// offset tracks it more reliably than a percentage would.
const TOP_CROP_PX = 64;

// Radial vignette — transparent through the middle-right (where the video should read clearly),
// darkening toward the true edges into the app's own slate-950, so it dissolves into the
// surrounding background rather than being cut off by a hard rectangle. Off-center toward the
// right/upper area on purpose: the title/synopsis text sits bottom-left, so that's where this
// should already be darkest.
// Le même noir que le fond de l'app, écrit ici en rgb() parce qu'un dégradé ne prend pas de
// classe. Il valait 2,6,23 — l'ancien noir bleu — ce qui faisait une vignette qui virait au bleu
// sur un fond qui, lui, ne le fait plus.
const VIGNETTE = "radial-gradient(ellipse 80% 75% at 64% 36%, transparent 35%, transparent 52%, rgba(10,10,12,0.6) 78%, rgb(10,10,12) 100%)";

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
  // Last playback position seen by the poll, and when the current uninterrupted stretch of
  // forward progress started (0 = not currently progressing smoothly).
  const lastPositionRef = useRef(-1);
  const steadySinceRef = useRef(0);
  const [dwelled, setDwelled] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  // Skips the fade for hides that must not be seen at all (see the visibilitychange effect).
  const [instantHide, setInstantHide] = useState(false);

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
    setInstantHide(false);
  }

  // The position/steady-progress refs belong to whichever player is current — carried into the
  // next title they'd have the poll compare a fresh player's position against the previous one's,
  // which can read as smooth progress by coincidence and reveal a beat early. Reset in an effect
  // rather than in the render-time block above: writing refs during render is what this project's
  // react-hooks/refs rule forbids.
  useEffect(() => {
    lastPositionRef.current = -1;
    steadySinceRef.current = 0;
  }, [itemKey]);

  // Drives the reveal off actual elapsed playback (see REVEAL_AT_SECONDS' own note). Runs both
  // ways on purpose — dropping back below the threshold (a loop restart) re-hides the backdrop,
  // covering the overlay's reappearance without any separate loop handling.
  useEffect(() => {
    if (!dwelled) return;
    const poll = setInterval(() => {
      const player = playerRef.current;
      if (!player) return;
      let position: number;
      try {
        position = player.getCurrentTime();
      } catch {
        return; // player not ready yet (or already torn down) — next tick will do
      }

      const previous = lastPositionRef.current;
      lastPositionRef.current = position;
      // Forward, but not by more than a poll interval's worth of slack — a jump backwards is the
      // loop restarting, a jump forwards or a frozen position is a stall/seek. Either way the
      // overlay comes back, so the steady stretch starts over.
      const progressedSmoothly = position > previous && position - previous < 1;
      if (!progressedSmoothly) steadySinceRef.current = 0;
      else if (steadySinceRef.current === 0) steadySinceRef.current = Date.now();

      const steadyFor = steadySinceRef.current === 0 ? 0 : Date.now() - steadySinceRef.current;
      const reveal = position >= REVEAL_AT_SECONDS && steadyFor >= STEADY_PLAYBACK_MS;
      // Back to a normal fade for the way in — instantHide only ever applies to the hide itself.
      if (reveal) setInstantHide(false);
      setPlaying(reveal);
    }, 250);
    return () => clearInterval(poll);
  }, [dwelled, itemKey]);

  // Tab switches, both ways. Three things have to happen here, and missing any one of them was
  // what made coming back to the tab look so bad (a flash of the overlay, then a fade down to the
  // still banner, then a fade back up into another overlay):
  //  1. Hide WITHOUT the usual fade. A hidden tab isn't rendered, so a fade started on the way
  //     out never actually runs — the browser picks it up on the way back in, replaying it in
  //     full view over the very frames we're trying to hide.
  //  2. Hide from the visibilitychange event rather than the next poll tick, which can be up to
  //     250ms later — long enough to show the redrawn overlay on return.
  //  3. Rewind to 0 on the way back. The overlay is drawn relative to playback *starting*, so
  //     letting it resume mid-video would show it again at a position already past
  //     REVEAL_AT_SECONDS, i.e. with nothing left to gate on. Restarting means the same
  //     position + steady-progress rules that cover the first play cover this too.
  useEffect(() => {
    function onVisibilityChange() {
      steadySinceRef.current = 0;
      lastPositionRef.current = -1;
      setInstantHide(true);
      setPlaying(false);
      if (document.visibilityState === "visible") {
        try {
          playerRef.current?.seekTo(0);
        } catch {
          /* player gone or not ready — the poll's own rules still hold it hidden */
        }
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    if (!trailerKey) return;
    // A video that starts playing on its own, unprompted, is exactly what "reduce motion" is
    // asking not to happen — the still backdrop stays instead. Read per-effect rather than once
    // at module load so a mid-session OS/browser change is picked up on the next focus.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
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
        },
      });
    });

    return () => {
      cancelled = true;
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
      className={`absolute inset-0 h-full w-full overflow-hidden transition-opacity ${instantHide ? "duration-0" : "duration-700"} ${playing ? "opacity-100" : "opacity-0"}`}
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
          not a focusable stop along the browse flow.
          z-20 because this lives inside CinemaClient's BACKGROUND layer, which comes before the
          hero/rows content wrapper in DOM order — that wrapper spans the whole screen and, even
          though it's transparent there, would otherwise win the paint-order tie and swallow every
          click aimed at this button (the same bug the detail sheet's own back button hit). */}
      <button
        type="button"
        onClick={toggleMute}
        aria-label={muted ? t("cinema.unmutePreview") : t("cinema.mutePreview")}
        className="pointer-events-auto absolute right-4 top-20 z-20 flex h-8 w-8 items-center justify-center rounded-full bg-black/40 text-white/70 backdrop-blur-xs transition-colors hover:bg-black/60 hover:text-white"
        style={{ top: "max(5rem, calc(env(safe-area-inset-top) + 4rem))" }}
      >
        {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
      </button>
    </div>
  );
}
