"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import type { HeroItem } from "@/app/api/dashboard/route";
import { ImdbBadge } from "@/components/ImdbBadge";
import { useT } from "@/components/TranslationProvider";

// Matches the fiche pages' own hero (radarr/[id], sonarr/[id]) — same full-bleed negative
// margins, same mask-fade + left-vignette treatment on the backdrop, same height formula — so
// the home hero doesn't look like a different, one-off component bolted onto the same app.
const BACKDROP_MASK =
  "linear-gradient(to bottom, rgba(0,0,0,0.97) 0%, rgba(0,0,0,0.82) 18%, rgba(0,0,0,0.50) 35%, rgba(0,0,0,0.18) 52%, rgba(0,0,0,0.04) 65%, rgba(0,0,0,0) 72%)";

const ROTATE_MS = 8000;

export function DashboardHero({ items }: { items: HeroItem[] }) {
  const t = useT();
  const [index, setIndex] = useState(0);

  // Reset to the first item whenever a fresh dashboard refresh actually replaces the pick
  // list — applied during render (not an effect) per React's guidance for adjusting state from
  // a prop change; an index into a stale/reordered list would otherwise silently point at the
  // wrong item.
  const [resetForItems, setResetForItems] = useState(items);
  if (items !== resetForItems) {
    setResetForItems(items);
    setIndex(0);
  }

  // Re-armed on every index change — whether that came from this same timer firing or from a
  // manual segment click below — so a manual jump always gets its own full ROTATE_MS, instead
  // of inheriting whatever was left on a timer that started at the previous item.
  useEffect(() => {
    if (items.length <= 1) return;
    const id = setTimeout(() => setIndex((i) => (i + 1) % items.length), ROTATE_MS);
    return () => clearTimeout(id);
  }, [items.length, index]);

  if (items.length === 0) return null;
  const item = items[index];

  return (
    <div className="relative -mx-4 -mt-4 mb-8 sm:-mx-6 sm:-mt-6 md:-mx-8 md:-mt-6">
      <div className="pointer-events-none absolute inset-x-0 top-0 aspect-video">
        {item.backdropUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={item.id}
            src={item.backdropUrl}
            alt=""
            className="h-full w-full object-cover object-top animate-fade-in"
            style={{ maskImage: BACKDROP_MASK, WebkitMaskImage: BACKDROP_MASK }}
          />
        )}
        <div className="absolute inset-0 bg-linear-to-r from-slate-950/70 via-slate-950/20 to-transparent" />
      </div>

      <div className="relative flex h-[46vw] min-h-[280px] max-h-[420px] flex-col justify-end gap-3 p-4 xl:max-h-[480px] sm:p-6 md:p-8">
        <Link href={item.href} className="max-w-lg">
          {item.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.logoUrl} alt={item.title} className="max-h-16 w-auto max-w-full object-contain drop-shadow-lg sm:max-h-24" />
          ) : (
            <h2 className="text-2xl font-bold leading-tight text-white drop-shadow-sm sm:text-3xl md:text-4xl">{item.title}</h2>
          )}
        </Link>

        <div className="flex items-center gap-2">
          {item.imdbRating && <ImdbBadge rating={item.imdbRating} size="sm" />}
        </div>

        {item.overview && (
          <p className="max-w-lg line-clamp-2 text-xs text-white/80 drop-shadow-sm sm:line-clamp-3 sm:text-sm">{item.overview}</p>
        )}

        <div className="flex items-center gap-2">
          <Link href={item.href} className="btn-primary">
            <Info size={16} /> {t('dashboard.heroMoreInfo')}
          </Link>
        </div>

        {items.length > 1 && (
          <div className="mt-1 flex max-w-xs gap-1">
            {items.map((it, i) => (
              <button
                key={it.id}
                onClick={() => setIndex(i)}
                aria-label={it.title}
                className="h-1 flex-1 overflow-hidden rounded-full bg-white/25"
              >
                {i < index && <div className="h-full w-full bg-white" />}
                {i === index && <div key={index} className="h-full animate-hero-fill bg-white" />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
