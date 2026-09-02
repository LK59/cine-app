"use client";

import { useState } from "react";
import Image from "next/image";

interface PosterImageProps {
  src: string | null | undefined;
  alt: string;
  className?: string;
  aspectRatio?: string;
  // Next's image optimizer proxies local images through an internal request that
  // doesn't forward cookies, so auth-gated routes (e.g. /api/jellyfin/image) 404/400
  // there. Skip optimization for those and let the browser fetch it directly.
  unoptimized?: boolean;
  // A calm static placeholder instead of the shared shimmer animation — opt-in, default
  // behavior everywhere else unchanged. Cinema Mode's rows can have a dozen+ small cards
  // loading at once; that many shimmers moving in sync reads as busy at that scale, where a
  // single flat tone doesn't.
  subtle?: boolean;
}

export function PosterImage({
  src,
  alt,
  className = "",
  aspectRatio = "aspect-2/3",
  unoptimized = false,
  subtle = false,
}: PosterImageProps) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  if (!src || errored) {
    return (
      <div className={`${aspectRatio} ${className} flex items-center justify-center bg-slate-800/60`}>
        <div className="text-slate-600 text-xs text-center px-2">No image</div>
      </div>
    );
  }

  return (
    <div className={`${aspectRatio} ${className} relative overflow-hidden`}>
      {!loaded && <div className={`absolute inset-0 ${subtle ? "bg-slate-800/50" : "skeleton"}`} />}
      <Image
        src={src}
        alt={alt}
        fill
        unoptimized={unoptimized}
        sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw"
        className={`object-cover transition-opacity duration-500 ${loaded ? "opacity-100" : "opacity-0"}`}
        onLoad={() => setLoaded(true)}
        onError={() => setErrored(true)}
      />
    </div>
  );
}

interface BackdropImageProps {
  src: string | null | undefined;
  alt?: string;
  className?: string;
}

export function BackdropImage({ src, alt = "", className = "" }: BackdropImageProps) {
  const [loaded, setLoaded] = useState(false);

  return (
    <div className={`relative overflow-hidden ${className}`}>
      {!loaded && src && <div className="absolute inset-0 skeleton" />}
      {src && (
        <img
          src={src}
          alt={alt}
          {...({ fetchpriority: "high" } as Record<string, string>)}
          className={`h-full w-full object-cover object-top transition-opacity duration-700 ${loaded ? "opacity-100" : "opacity-0"}`}
          onLoad={() => setLoaded(true)}
          loading="eager"
        />
      )}
    </div>
  );
}
