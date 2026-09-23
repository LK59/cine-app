"use client";

import { useState } from "react";
import { ImdbBadge } from "@/components/ImdbBadge";
import { useT } from "@/components/TranslationProvider";
import { genreLabel } from "@/lib/top10Label";
import type { CinemaSeries } from "@/app/api/cinema/series/route";
import { CinemaLogo } from "@/components/cinema/CinemaLogo";
import { HeroOverview, HeroCastLine } from "@/components/cinema/CinemaHero";
import { useHeroInfo } from "@/lib/useHeroInfo";

// Series-typed mirror of CinemaHero — see its own doc comment (text-only passive preview, the
// backdrop lives in CinemaClient's shared background). Its synopsis and cast come from the same
// light hero route as the movie banner (`useHeroInfo`).
export function CinemaSeriesHero({ item }: { item: CinemaSeries }) {
  const t = useT();
  // Le synopsis et la distribution, par la requête légère de la bannière — voir `useHeroInfo`.
  const info = useHeroInfo("series", item.tmdbId);

  const [logoErrored, setLogoErrored] = useState(false);
  const [resetForId, setResetForId] = useState(item.sonarrId);
  if (item.sonarrId !== resetForId) {
    setResetForId(item.sonarrId);
    setLogoErrored(false);
  }

  return (
    <div key={item.sonarrId} className="relative flex h-full max-w-2xl flex-col justify-end gap-3 px-8 pb-10 sm:px-12">
      {item.logoUrl && !logoErrored ? (
        <CinemaLogo src={item.logoUrl} alt={item.title} surface="hero" onError={() => setLogoErrored(true)} />
      ) : (
        <h1 className="text-3xl font-bold leading-tight text-white drop-shadow-lg sm:text-5xl font-display">{item.title}</h1>
      )}

      <div className="flex flex-wrap items-center gap-3 text-sm text-white/80">
        <span>{item.year}</span>
        {item.imdbRating && <ImdbBadge rating={item.imdbRating} size="sm" />}
        {item.genres.length > 0 && <span>{item.genres.slice(0, 3).map((g) => genreLabel(g, t)).join(" · ")}</span>}
      </div>

      {/* Le même synopsis que la bannière des films, par le même composant — voir HeroOverview. */}
      <HeroOverview info={info} fallback={item.overview} />

      <HeroCastLine info={info} />
    </div>
  );
}
