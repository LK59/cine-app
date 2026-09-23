"use client";

import useSWR from "swr";
import { formatMinutes } from "@/lib/format";
import { useEffect, useState } from "react";
import { fetcher } from "@/lib/swr";
import { ImdbBadge } from "@/components/ImdbBadge";
import { QualityBadges } from "@/components/cinema/QualityBadges";
import { useT } from "@/components/TranslationProvider";
import { genreLabel } from "@/lib/top10Label";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import { CinemaLogo } from "@/components/cinema/CinemaLogo";

interface RadarrCastMember {
  tmdbId: number;
  name: string;
  character: string;
  photoUrl: string | null;
}

interface RadarrInfo {
  tmdb: { overview: string; cast: RadarrCastMember[] } | null;
  trailerKey: string | null;
}

/**
 * Le synopsis d'une bannière — film ou série, écrit une fois.
 *
 * Rien plutôt que de l'anglais. Le synopsis traduit vient de TMDB et met un instant à arriver ;
 * celui qui sert de repli vient de Radarr ou de Sonarr, qui ne traduisent pas — alors sous une
 * interface en français, l'accueil affichait un texte en anglais le temps que le bon arrive, puis
 * le remplaçait. Une ligne vide un court instant se remarque moins qu'une langue qui change sous
 * les yeux. Le repli ne sert qu'une fois la réponse arrivée *sans* texte traduit.
 *
 * La bannière des films avait appris tout cela ; celle des séries, sa copie, non — elle montrait
 * l'anglais de Sonarr puis sautait au français, et sans hauteur réservée toute la bannière
 * sautait avec. Relevé le 21/09/2026 : d'où ce composant, pour que les deux ne puissent plus
 * diverger.
 */
export function HeroOverview({
  info,
  fallback,
}: {
  /** La réponse de la route `info` — `undefined` tant qu'elle n'est pas arrivée. */
  info: { tmdb: { overview: string } | null } | undefined;
  fallback: string | null | undefined;
}) {
  return (
    <p /* Estompé et non tronqué par des points, comme la fiche : deux façons de couper le même
           texte dans la même application, c'était une de trop. Le minimum de hauteur reste —
           c'est lui qui empêche la mise en page de sauter quand le survol change de titre, et la
           classe ne fixe qu'un maximum. */
        className="clamp-fade-2 min-h-[2lh] max-w-xl text-sm text-white/90 drop-shadow-sm sm:text-base">
      {/* Le texte fond dans la place qu'on lui gardait, au lieu d'y surgir ; un autre titre, un
          autre nœud, et le fondu repart (23/09/2026). */}
      <HeroText text={info ? info.tmdb?.overview || fallback || "" : ""} />
    </p>
  );
}

/**
 * La ligne de distribution des deux bannières du bureau — hauteur réservée.
 *
 * Elle n'existait qu'une fois la réponse `info` arrivée, dans une colonne calée en bas : à chaque
 * changement de titre elle disparaissait, puis revenait deux cents millisecondes plus tard, et le
 * titre, les métadonnées et le synopsis descendaient d'une ligne avant de remonter (relevé le
 * 23/09/2026). La ligne reste donc toujours là, vide tant qu'il n'y a rien à dire. Partagée par
 * les films et les séries, comme `HeroOverview`, pour la même raison.
 */
/** Un texte de bannière qui fond à son arrivée — voir `HeroOverview` et `HeroCastLine`. */
function HeroText({ text }: { text: string }) {
  if (!text) return null;
  return (
    <span key={text} className="animate-fade-in">
      {text}
    </span>
  );
}

export function HeroCastLine({ info }: { info: { tmdb: { cast?: { name: string }[] } | null } | undefined }) {
  const cast = info?.tmdb?.cast ?? [];
  return (
    <p className="min-h-[1lh] max-w-xl truncate text-xs text-white/60">
      <HeroText text={cast.slice(0, 5).map((c) => c.name).join(", ")} />
    </p>
  );
}

// Text only — the backdrop image/gradients (and, once focus dwells long enough, the trailer
// video that takes over from them — see CinemaTrailerBackdrop) live in CinemaClient now, as one
// continuous full-screen background layer shared with the rows pane beneath (see its own doc
// comment for why: keeping the image scoped to just this component's box was exactly what
// produced a hard seam where the hero "ended"). This is purely a passive preview pane — no
// buttons here on purpose (Netflix TV home: the top pane is just a live preview of whatever's
// focused, never actionable on its own). Opening CinemaMovieDetail (click/Enter on a card) is
// what surfaces Lecture/Bande-annonce/Vu/À voir. Cast still fetched here (not just in the detail
// overlay) since this pane already shows it, same lazy/debounced approach so fast arrow-key
// scrubbing across a row doesn't fire a request per card it passes through.
export function CinemaHero({
  item,
  onTrailerKeyChange,
}: {
  item: CinemaMovie;
  // Reports this item's trailer key up to CinemaClient, which owns the dwell-triggered video
  // backdrop and needs the same value this already fetches — a state-lifting callback rather
  // than a second parallel fetch there, so the two never have their own independently-debounced
  // (and therefore possibly briefly disagreeing) opinions about what the current trailer is.
  onTrailerKeyChange?: (key: string | null) => void;
}) {
  const t = useT();
  const [debouncedId, setDebouncedId] = useState(item.radarrId);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedId(item.radarrId), 200);
    return () => clearTimeout(timer);
  }, [item.radarrId]);
  // Sans la réponse d'avant : `keepPreviousData` est réglé pour toute l'application (SWRProvider),
  // et la bannière recevait le synopsis du titre précédent pendant que celui du nouveau arrivait —
  // il fondait à nouveau, puis était remplacé (23/09/2026). Rien, plutôt que le texte d'un autre.
  const { data: rawInfo } = useSWR<RadarrInfo>(`/api/radarr/movies/${debouncedId}/info`, fetcher, { keepPreviousData: false });
  // Guards against showing the PREVIOUS item's cast under the new title during the debounce
  // window — SWR still has that data cached from before debouncedId catches up.
  const info = debouncedId === item.radarrId ? rawInfo : undefined;

  useEffect(() => {
    onTrailerKeyChange?.(info?.trailerKey ?? null);
  }, [info?.trailerKey, onTrailerKeyChange]);

  // item.logoUrl now comes bulk-included in the /api/cinema/movies payload (same as
  // poster/backdrop already were) instead of a separate per-item fetch — known synchronously
  // the instant this renders, no debounce/timing dance needed at all, and CinemaClient's own
  // warm-up effect prefetches every logo image alongside the backdrops, so by the time focus
  // actually lands here the browser has usually already cached it. Just a plain onError
  // fallback to text, same pattern as any other image in this app.
  const [logoErrored, setLogoErrored] = useState(false);
  // Reset adjusted during render (not an effect), synchronously in the same render item.radarrId
  // changes — this is a single persistent component instance across focus changes, not
  // remounted per item, so stale error state would otherwise survive into the next title.
  const [resetForId, setResetForId] = useState(item.radarrId);
  if (item.radarrId !== resetForId) {
    setResetForId(item.radarrId);
    setLogoErrored(false);
  }

  return (
    <div key={item.radarrId} className="relative flex h-full max-w-2xl flex-col justify-end gap-3 px-8 pb-10 sm:px-12">
      {item.logoUrl && !logoErrored ? (
        <CinemaLogo src={item.logoUrl} alt={item.title} surface="hero" onError={() => setLogoErrored(true)} />
      ) : (
        <h1 className="text-3xl font-bold leading-tight text-white drop-shadow-lg sm:text-5xl font-display">{item.title}</h1>
      )}

      <div className="flex flex-wrap items-center gap-3 text-sm text-white/80">
        <span>{item.year}</span>
        {item.imdbRating && <ImdbBadge rating={item.imdbRating} size="sm" />}
        {/* La durée au survol, et non seulement dans la fiche : c'est elle qui décide si on lance
            le film ce soir, donc elle a sa place avant qu'on ouvre quoi que ce soit. */}
        {"runtimeMinutes" in item && formatMinutes(item.runtimeMinutes) && (
          <span>{formatMinutes(item.runtimeMinutes)}</span>
        )}
        <QualityBadges quality={item.quality} />
        {item.genres.length > 0 && <span>{item.genres.slice(0, 3).map((g) => genreLabel(g, t)).join(" · ")}</span>}
      </div>

      <HeroOverview info={info} fallback={item.overview} />

      <HeroCastLine info={info} />
    </div>
  );
}
