"use client";

import { useState } from "react";

/**
 * The film's own title treatment, with the typography as a fallback.
 *
 * Cinema mode has shown these since it existed — a logo is the title as its own designers drew
 * it, and no font can compete with that. The detail pages set the same title in a display face
 * beside a poster whose logo they were not asking for.
 *
 * Falls back on its own, twice over: when the server has no logo, and when the image fails to
 * load. What comes back is the heading that was there before, unchanged.
 */
export function TitleLogo({
  logoUrl,
  title,
  year,
  className = "",
  logoClassName = "",
}: {
  logoUrl: string | null | undefined;
  title: string;
  year?: number | null;
  className?: string;
  logoClassName?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (logoUrl && !failed) {
    return (
      <div className={className}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logoUrl}
          alt={title}
          onError={() => setFailed(true)}
          className={`w-auto max-w-full object-contain object-left drop-shadow-lg ${logoClassName}`}
        />
        {year != null && <span className="sr-only">{` (${year})`}</span>}
      </div>
    );
  }

  return (
    <h1 className={`font-display font-bold leading-tight text-white drop-shadow-sm ${className}`}>
      {title}
      {year != null && <span className="ml-2 text-base font-normal text-white/60 md:text-lg">({year})</span>}
    </h1>
  );
}
