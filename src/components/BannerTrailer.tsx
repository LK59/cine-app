"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  backdropUrl: string;
  trailerKey: string | null;
  enabled: boolean;
}

export function BannerTrailer({ backdropUrl, trailerKey, enabled }: Props) {
  const [videoReady, setVideoReady] = useState(false);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    setVideoReady(false);
    setVideoSrc(null);
    if (!enabled || !trailerKey) return;
    const t = setTimeout(() => setVideoSrc(`/api/trailer/${trailerKey}`), 2000);
    return () => clearTimeout(t);
  }, [enabled, trailerKey, backdropUrl]);

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={backdropUrl}
        alt=""
        className={[
          "h-full w-full object-cover object-top",
          "transition-opacity duration-[1200ms]",
          videoReady ? "opacity-0" : "opacity-100 animate-fade-in",
        ].join(" ")}
      />
      {videoSrc && (
        <video
          ref={videoRef}
          src={videoSrc}
          autoPlay
          muted
          loop
          playsInline
          onCanPlay={() => setVideoReady(true)}
          onError={() => setVideoSrc(null)}
          className={[
            "absolute inset-0 h-full w-full object-cover object-top",
            "transition-opacity duration-[1200ms]",
            videoReady ? "opacity-100" : "opacity-0",
          ].join(" ")}
        />
      )}
    </>
  );
}
