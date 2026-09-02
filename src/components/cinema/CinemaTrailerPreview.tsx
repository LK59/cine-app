"use client";

import { useEffect, useRef, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { useT } from "@/components/TranslationProvider";

const DWELL_MS = 3000;
// YouTube's own embed briefly shows its title/control-bar overlay right as a video starts,
// regardless of controls=0 — not something the URL params can fully suppress. Mounting the
// iframe invisible and only revealing it after that overlay has had time to auto-hide on its own
// is the reliable fix; a shorter buffer here just meant the flash was still visible sometimes.
const REVEAL_BUFFER_MS = 1200;

// Netflix-style "hold focus long enough and it plays" — a muted, looping YouTube embed filling
// roughly a third of the screen, inset flush against the hero's top-right corner once focus has
// rested on one title for DWELL_MS, and gone the instant focus moves on (no exit animation needed
// — see the doc comment where this is used). This is meant to read as part of the AMBIENT
// BACKGROUND, not a floating video card sitting on top of the UI — no border, shadow, or rounded
// corners; it's flush with the screen's own top/right edges, and its left/bottom edges dissolve
// into the app's background color over a wide gradient rather than cutting off sharply. Purely
// additive: the persistent backdrop wash behind it (CinemaClient's own ambient layer) is
// completely untouched, this just sits on top of a corner of it. Shared by CinemaHero and
// CinemaSeriesHero — the logic here has nothing movie/series-specific in it, just a trailer key
// and something to key the dwell timer on.
//
// Hidden below `lg` on purpose, not shrunk further — this app's text column tops out at max-w-2xl
// (672px) and needs real room to breathe; below that breakpoint there just isn't space for a
// second focal point without either one fighting the other, so the feature quietly doesn't show
// rather than cramping in.
export function CinemaTrailerPreview({
  itemKey,
  trailerKey,
}: {
  itemKey: string | number;
  trailerKey: string | null | undefined;
}) {
  const t = useT();
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [muted, setMuted] = useState(true);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Resets synchronously during render (not in an effect — this project's react-hooks/
  // set-state-in-effect rule, "adjusting state when a prop changes") on every title change, even
  // before the debounce that gates `trailerKey` itself settles: arrowing across a row must never
  // leave a stale mounted/visible/unmuted state from a previous card bleeding into the next one.
  const [resetForKey, setResetForKey] = useState(itemKey);
  if (itemKey !== resetForKey) {
    setResetForKey(itemKey);
    setMounted(false);
    setVisible(false);
    setMuted(true);
  }

  useEffect(() => {
    if (!trailerKey) return;
    const timer = setTimeout(() => setMounted(true), DWELL_MS);
    return () => clearTimeout(timer);
  }, [itemKey, trailerKey]);

  useEffect(() => {
    if (!mounted) return;
    const timer = setTimeout(() => setVisible(true), REVEAL_BUFFER_MS);
    return () => clearTimeout(timer);
  }, [mounted]);

  // The embed's own mute state lives in the iframe's player, not in this component — toggling it
  // without reloading the iframe (which would restart playback from 0) means talking to the
  // YouTube IFrame Player API via postMessage, which only listens once `enablejsapi=1` is on the
  // src below.
  function toggleMute() {
    const next = !muted;
    setMuted(next);
    iframeRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func: next ? "mute" : "unMute", args: [] }),
      "*"
    );
  }

  if (!trailerKey || !mounted) return null;

  return (
    <div
      className={`pointer-events-none absolute right-0 top-0 hidden h-full w-1/3 overflow-hidden transition-opacity duration-700 lg:block ${visible ? "opacity-100" : "opacity-0"}`}
    >
      <iframe
        ref={iframeRef}
        src={`https://www.youtube-nocookie.com/embed/${trailerKey}?autoplay=1&mute=1&controls=0&loop=1&playlist=${trailerKey}&modestbranding=1&rel=0&playsinline=1&disablekb=1&enablejsapi=1`}
        title={t("cinema.trailer")}
        allow="autoplay; encrypted-media"
        className="absolute right-0 top-0 aspect-video w-full"
      />
      {/* Dissolves the video into the app's own background rather than cutting it off with a
          hard rectangle — a light uniform wash over the whole thing plus two wide gradients
          weighted toward the left/bottom (where it needs to blend with the title/synopsis text
          and the rows below), not a CSS mask: this app already leans on plain layered gradient
          overlays everywhere else (CinemaMovieDetail's backdrop, CinemaClient's own ambient
          wash), and a two-edge mask would need mask-composite, whose WebKit-prefixed keywords
          don't line up with the standard ones — not worth the cross-browser fragility here. */}
      <div className="absolute inset-0 bg-slate-950/20" />
      <div className="absolute inset-y-0 left-0 w-3/4 bg-linear-to-r from-slate-950 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-3/4 bg-linear-to-t from-slate-950 to-transparent" />

      {/* Mouse-only, deliberately not part of the TV-remote grid nav chain (same reasoning as
          the back button / shortcuts guide floating outside it) — a discreet corner affordance,
          not a focusable stop along the browse flow. pointer-events reintroduced just for this
          button since the container above turns them off (the video itself must never intercept
          clicks meant for whatever's visually behind/around it). */}
      <button
        type="button"
        onClick={toggleMute}
        aria-label={muted ? t("cinema.unmutePreview") : t("cinema.mutePreview")}
        className="pointer-events-auto absolute bottom-3 right-3 flex h-7 w-7 items-center justify-center rounded-full bg-black/40 text-white/70 backdrop-blur-xs transition-colors hover:bg-black/60 hover:text-white"
      >
        {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
      </button>
    </div>
  );
}
