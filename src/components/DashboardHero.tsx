"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { HeroItem } from "@/app/api/dashboard/route";
import { ImdbBadge } from "@/components/ImdbBadge";
import { useT } from "@/components/TranslationProvider";

// Matches the fiche pages' own hero (radarr/[id], sonarr/[id]) — same full-bleed negative
// margins, same mask-fade + left-vignette treatment on the backdrop, same height formula — so
// the home hero doesn't look like a different, one-off component bolted onto the same app.
const BACKDROP_MASK =
  "linear-gradient(to bottom, rgba(0,0,0,0.97) 0%, rgba(0,0,0,0.82) 18%, rgba(0,0,0,0.50) 35%, rgba(0,0,0,0.18) 52%, rgba(0,0,0,0.04) 65%, rgba(0,0,0,0) 72%)";

const ROTATE_MS = 8000;
const HERO_INDEX_KEY = "cine:hero-index";

export function DashboardHero({ items }: { items: HeroItem[] }) {
  const t = useT();
  // The dashboard payload polls on an interval (see INTERVALS.FAST in DashboardClient) — every
  // poll hands this a brand new `items` array even when the actual picks haven't changed, so
  // resetting on array IDENTITY (the previous approach) snapped the hero back to index 0 every
  // few seconds, not just on navigation. A content signature — which item ids are actually
  // showing — only changes when the picks themselves genuinely change.
  const itemsKey = items.map((it) => `${it.mediaType}:${it.id}`).join(",");

  // Persisted across a full remount too (leaving the dashboard and coming back, a fresh page
  // load in the same tab) — sessionStorage rather than localStorage: this is "where was I in
  // the rotation", not a durable cross-device preference worth keeping forever.
  const [index, setIndex] = useState(() => {
    try {
      const raw = sessionStorage.getItem(HERO_INDEX_KEY);
      if (!raw) return 0;
      const parsed = JSON.parse(raw) as { key: string; index: number };
      return parsed.key === itemsKey ? parsed.index : 0;
    } catch {
      return 0;
    }
  });

  // Reset to the first item only when the picks THEMSELVES actually changed (see itemsKey
  // above) — applied during render, not an effect, per React's guidance for adjusting state
  // from a prop change.
  const [resetForKey, setResetForKey] = useState(itemsKey);
  if (itemsKey !== resetForKey) {
    setResetForKey(itemsKey);
    setIndex(0);
  }

  useEffect(() => {
    try {
      sessionStorage.setItem(HERO_INDEX_KEY, JSON.stringify({ key: itemsKey, index }));
    } catch {
      // Storage unavailable — the rotation just won't survive a remount this time.
    }
  }, [itemsKey, index]);

  // Pre-warms the browser's cache with every backdrop/logo up front — otherwise the very first
  // time a given pick's segment is reached (auto-advance or a manual click), its image visibly
  // loads in after the segment already switched. Re-runs only when the actual picks change
  // (itemsKey), not on every poll — already-cached URLs make this a fast no-op anyway, but no
  // reason to even try again every few seconds.
  useEffect(() => {
    for (const it of items) {
      if (it.backdropUrl) Object.assign(new Image(), { src: it.backdropUrl });
      if (it.logoUrl) Object.assign(new Image(), { src: it.logoUrl });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey]);

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
            <h2 className="text-2xl font-bold leading-tight text-white drop-shadow-sm sm:text-3xl md:text-4xl font-display">{item.title}</h2>
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
            {t('common.viewSheet')} <ChevronRight size={16} />
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
