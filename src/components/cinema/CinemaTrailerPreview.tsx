"use client";

import { useEffect, useRef, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { useT } from "@/components/TranslationProvider";

const DWELL_MS = 3000;

// Netflix-style "hold focus long enough and it plays" — a muted, looping YouTube embed inset in
// the hero's top-right corner once focus has rested on one title for DWELL_MS, and gone the
// instant focus moves on (no exit animation needed — see the doc comment where this is used).
// Purely additive: the persistent ambient backdrop behind it is untouched, this just sits on top
// of a corner of it. Shared by CinemaHero and CinemaSeriesHero — the logic here has nothing
// movie/series-specific in it, just a trailer key and something to key the dwell timer on.
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
  const [ready, setReady] = useState(false);
  const [muted, setMuted] = useState(true);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Resets synchronously during render (not in an effect — this project's react-hooks/
  // set-state-in-effect rule, "adjusting state when a prop changes") on every title change, even
  // before the debounce that gates `trailerKey` itself settles: arrowing across a row must never
  // leave a stale "ready" flag or unmuted state from a previous card bleeding into the next one.
  const [resetForKey, setResetForKey] = useState(itemKey);
  if (itemKey !== resetForKey) {
    setResetForKey(itemKey);
    setReady(false);
    setMuted(true);
  }

  useEffect(() => {
    if (!trailerKey) return;
    const timer = setTimeout(() => setReady(true), DWELL_MS);
    return () => clearTimeout(timer);
  }, [itemKey, trailerKey]);

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

  if (!trailerKey || !ready) return null;

  return (
    <div className="absolute right-0 top-0 hidden aspect-video animate-fade-in overflow-hidden rounded-lg shadow-2xl ring-1 ring-white/10 lg:block lg:w-72 xl:w-80 2xl:w-96">
      <iframe
        ref={iframeRef}
        src={`https://www.youtube-nocookie.com/embed/${trailerKey}?autoplay=1&mute=1&controls=0&loop=1&playlist=${trailerKey}&modestbranding=1&rel=0&playsinline=1&enablejsapi=1`}
        title={t("cinema.trailer")}
        allow="autoplay; encrypted-media"
        className="pointer-events-none absolute inset-0 h-full w-full"
      />
      {/* Blends the video's left/bottom edges toward the app's own slate-950 rather than cutting
          it off with a hard rectangle — same layered-gradient technique CinemaMovieDetail and
          CinemaClient's own ambient backdrop already use, not a CSS mask (this app already leans
          on plain gradient overlays everywhere else; a two-edge mask would need mask-composite,
          whose WebKit-prefixed keywords don't line up with the standard ones — not worth the
          cross-browser fragility for a two-line gradient that already reads the same). */}
      <div className="pointer-events-none absolute inset-y-0 left-0 w-1/2 bg-linear-to-r from-slate-950 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-linear-to-t from-slate-950 to-transparent" />

      {/* Mouse-only, deliberately not part of the TV-remote grid nav chain (same reasoning as
          the back button / shortcuts guide floating outside it) — a discreet corner affordance,
          not a focusable stop along the browse flow. */}
      <button
        type="button"
        onClick={toggleMute}
        aria-label={muted ? t("cinema.unmutePreview") : t("cinema.mutePreview")}
        className="absolute bottom-2 right-2 flex h-6 w-6 items-center justify-center rounded-full bg-black/50 text-white/80 backdrop-blur-xs transition-colors hover:bg-black/70 hover:text-white"
      >
        {muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
      </button>
    </div>
  );
}
