"use client";

import { useState } from "react";

interface PosterImageProps {
  src: string | null | undefined;
  alt: string;
  className?: string;
  aspectRatio?: string;
}

export function PosterImage({ src, alt, className = "", aspectRatio = "aspect-[2/3]" }: PosterImageProps) {
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
      {!loaded && <div className="absolute inset-0 skeleton" />}
      <img
        src={src}
        alt={alt}
        className={`h-full w-full object-cover transition-opacity duration-500 ${loaded ? "opacity-100" : "opacity-0"}`}
        onLoad={() => setLoaded(true)}
        onError={() => setErrored(true)}
        loading="lazy"
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
          className={`h-full w-full object-cover object-top transition-opacity duration-700 ${loaded ? "opacity-100" : "opacity-0"}`}
          onLoad={() => setLoaded(true)}
          loading="eager"
        />
      )}
    </div>
  );
}
