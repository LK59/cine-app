"use client";

import { formatMinutes } from "@/lib/format";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ImdbBadge } from "@/components/ImdbBadge";
import { QualityBadges } from "@/components/cinema/QualityBadges";
import { useT } from "@/components/TranslationProvider";
import { genreLabel } from "@/lib/top10Label";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import { CinemaLogo } from "@/components/cinema/CinemaLogo";
import { sentencesThatFit } from "@/lib/heroSynopsis";
import { useHeroInfo } from "@/lib/useHeroInfo";

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
  const text = info ? info.tmdb?.overview || fallback || "" : "";

  /**
   * Les phrases entières qui tiennent dans les deux lignes — voir `sentencesThatFit`.
   *
   * La place se mesure à l'écran, pas en caractères : elle dépend de la largeur de la fenêtre et
   * de la police. Une sonde invisible, de la largeur du paragraphe et de sa police, reçoit chaque
   * candidat ; ce qui dépasse deux lignes ne tient pas. `null` : même la première phrase déborde,
   * et le texte entier s'affiche avec un fondu en bout de seconde ligne (`clamp-fade-end-2`).
   */
  const boxRef = useRef<HTMLParagraphElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const [fitted, setFitted] = useState<{ source: string; shown: string | null } | null>(null);
  const measure = useCallback(() => {
    const box = boxRef.current;
    const probe = probeRef.current;
    if (!box || !probe) return;
    const lineHeight = parseFloat(getComputedStyle(box).lineHeight);
    // Rien de mesurable (pas encore en page) : le texte entier, sans rien trancher.
    if (!Number.isFinite(lineHeight) || lineHeight <= 0 || box.clientWidth === 0) {
      setFitted({ source: text, shown: text });
      return;
    }
    const fits = (candidate: string) => {
      probe.textContent = candidate;
      return probe.offsetHeight <= lineHeight * 2 + 1;
    };
    const shown = sentencesThatFit(text, fits);
    probe.textContent = "";
    setFitted({ source: text, shown });
  }, [text]);
  // Avant le premier dessin : le texte arrive déjà arrêté sur sa phrase, jamais entier puis coupé.
  useLayoutEffect(measure, [measure]);
  // Et de nouveau quand la largeur change : deux lignes ne contiennent plus les mêmes phrases.
  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    let width = box.clientWidth;
    const observer = new ResizeObserver(() => {
      if (box.clientWidth === width) return;
      width = box.clientWidth;
      measure();
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [measure]);

  const known = fitted?.source === text ? fitted : null;
  const overflowing = known !== null && known.shown === null;
  const shown = known?.shown ?? text;

  return (
    <p
      ref={boxRef}
      data-hero-overview
      /* Deux lignes au plus, et leur hauteur réservée : c'est ce qui empêche la mise en page de
         sauter quand le survol change de titre. Arrêté sur une phrase entière, le texte n'a
         besoin d'aucune marque ; le fondu n'est qu'un repli, vers la droite et jamais vers le bas
         — l'ancien fondu vertical se lisait comme une ombre sous le texte (23/09/2026). */
      className={`relative min-h-[2lh] max-w-xl text-sm text-white/90 drop-shadow-sm sm:text-base ${
        overflowing ? "clamp-fade-end-2" : "max-h-[2lh] overflow-hidden"
      }`}
    >
      {/* Le texte fond dans la place qu'on lui gardait, au lieu d'y surgir ; un autre titre, un
          autre nœud, et le fondu repart (23/09/2026). */}
      <HeroText text={overflowing ? text : shown} />
      <span ref={probeRef} aria-hidden data-hero-probe className="pointer-events-none invisible absolute inset-x-0 top-0" />
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
export function CinemaHero({ item }: { item: CinemaMovie }) {
  const t = useT();
  // Le synopsis et la distribution, par la requête légère de la bannière — voir `useHeroInfo`.
  // (La bande-annonce que la bannière remontait autrefois au fond vidéo n'a plus d'écouteur : le
  // fond vidéo a été retiré du grand écran.)
  const info = useHeroInfo("movie", item.tmdbId);

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
