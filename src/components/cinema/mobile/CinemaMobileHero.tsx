"use client";

import { memo, useEffect, useRef, useState } from "react";
import { Info, Play } from "lucide-react";
import { PosterImage } from "@/components/PosterImage";
import { CinemaLogo } from "@/components/cinema/CinemaLogo";
import { heroSignature, resolveHeroCarousel, upcomingImages, useDecodeAhead, useHeroOrder } from "@/lib/heroCarousel";
import { useCarouselDrag, carouselTransform, CAROUSEL_TRANSITION } from "@/lib/useCarouselDrag";
import { useT } from "@/components/TranslationProvider";
import { genreLabel } from "@/lib/top10Label";
import { QualityBadges } from "@/components/cinema/QualityBadges";
import { formatContinueLabel, heroContinueFacts } from "@/lib/cinemaContinueLabel";
import { HeroContinueProgress } from "@/components/cinema/HeroContinueProgress";
import { useLiquidDelegation } from "@/lib/liquidGlass/useLiquidDelegation";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import type { CinemaSeries } from "@/app/api/cinema/series/route";

type Item = CinemaMovie | CinemaSeries;

/**
 * La bannière du téléphone, avec son propre index.
 *
 * Elle vivait dans l'écran d'accueil, dont elle partageait l'état : changer de titre — au doigt
 * comme à la rotation — redessinait donc tout, ses six rangées et leurs affiches comprises. Ça se
 * voyait au relâchement, où ce travail tombait sur les premières images de l'animation.
 *
 * L'index est ici, et le composant est mémoïsé : un changement de titre ne redessine que la
 * bannière — trois affiches et une rangée de barres.
 */
/**
 * L'affiche de la bannière : sans texte quand on a un logo à poser dessus.
 *
 * La bannière du téléphone superpose notre propre logo à l'affiche. Quand celle-ci porte déjà le
 * titre peint dedans — ce qui est le cas de la plupart des séries — le nom apparaissait deux fois,
 * une fois dans l'image et une fois écrit par nous juste en dessous.
 *
 * Sans logo, en revanche, l'affiche est la seule chose qui nomme le titre : on garde alors celle
 * qui le porte. Et si TMDB n'a pas de version sans texte, l'affiche ordinaire fait l'affaire.
 */
function heroPoster(item: { posterUrl: string | null; posterTextlessUrl?: string | null; logoUrl: string | null }): string | null {
  return item.logoUrl ? item.posterTextlessUrl ?? item.posterUrl : item.posterUrl;
}

// Hors du composant : stables, pour que la bannière ne relance rien à chaque rendu.
const heroKey = (item: Item) => ("radarrId" in item ? `f${item.radarrId}` : `s${item.sonarrId}`);
/** Ce que cette bannière affiche d'un titre : son affiche et son logo, décodés d'avance. */
const heroImages = (item: Item) => [heroPoster(item), item.logoUrl];

export const CinemaMobileHero = memo(function CinemaMobileHero({
  items: official,
  paused,
  offscreen = false,
  short,
  onPlay,
  onOpen,
  resumeFor,
  generation,
  continueStyle = false,
}: {
  items: Item[];
  /** La rotation s'arrête quand une fiche ou la recherche est ouverte par-dessus. */
  paused: boolean;
  /**
   * La bannière n'est plus à l'écran — l'autre onglet, un panneau, le lecteur plein écran : elle
   * reprend l'ordre officiel et revient au début. Voir `heroOffscreen` et `useHeroCarousel`.
   */
  offscreen?: boolean;
  /** Écran couché : l'affiche passe à côté du texte au lieu d'être derrière. */
  short: boolean;
  onPlay: (item: Item) => void;
  onOpen: (item: Item) => void;
  /**
   * Où en est ce titre, quand il a été commencé.
   *
   * Rendu par l'appelant plutôt que cherché ici : c'est l'écran d'accueil qui tient déjà la liste
   * de reprise, pour sa propre rangée. La bannière annonçait « Lire » sur un film vu à moitié —
   * le plus gros bouton de l'écran était le seul à ne pas savoir où il emmenait.
   */
  resumeFor?: (item: Item) => {
    positionTicks: number;
    runtimeTicks: number | null;
    /** Une série dont un épisode attend (bannière À suivre, DECISIONS.md §52) : « À suivre S1 · É3 ». */
    seasonNumber?: number | null;
    episodeNumber?: number | null;
  } | null;
  /** La sorte de liste montrée — « À la une » ou Reprendre / À suivre (DECISIONS.md §52) ; voir `useHeroOrder`. */
  generation?: string;
  /**
   * La bannière Reprendre / À suivre (DECISIONS.md §52) : un bouton court avec la barre et ce qui
   * reste au-dessus, une affiche moins haute, et des vignettes à la place des tirets.
   */
  continueStyle?: boolean;
}) {
  const t = useT();
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  // L'ordre de cette session, réconcilié avec les données fraîches : le titre à l'écran y reste,
  // une nouveauté vient au passage suivant — la même règle que le bureau (`useHeroOrder`).
  const [orderIndex, setIndex, order] = useHeroOrder(heroSignature(official.map(heroKey)), paused || dragging, offscreen, generation);
  // Les titres déjà montrés, pour retrouver celui à l'écran s'il vient de sortir de la liste : le
  // bureau a le catalogue entier sous la main, pas cette bannière. Tenu pendant le rendu, comme
  // l'état dérivé plus bas.
  const [seen, setSeen] = useState(() => new Map(official.map((item) => [heroKey(item), item])));
  if (official.some((item) => seen.get(heroKey(item)) !== item)) {
    setSeen(new Map([...seen, ...official.map((item) => [heroKey(item), item] as const)]));
  }
  const { items, index } = resolveHeroCarousel(order, orderIndex, official, heroKey, (key) => seen.get(key));
  useDecodeAhead(upcomingImages(items, index, heroImages));

  /**
   * Un saut de plus d'un cran se fait sans glisser.
   *
   * Seules l'affiche courante et ses deux voisines sont rendues. Du dernier titre au premier, ou
   * d'un toucher sur une barre éloignée, la piste glissait donc sur toute sa largeur en traversant
   * des cases vides, l'affiche visible démontée d'emblée (relevé le 23/09/2026). Le glissement
   * reste pour un cran — le geste, la rotation — ; au-delà, l'affiche est remplacée sur place.
   * Retenu pendant le rendu, et non dans un effet : c'est ce rendu-là qui pose la transformation.
   */
  const [shownIndex, setShownIndex] = useState(index);
  const [jumped, setJumped] = useState(false);
  if (index !== shownIndex) {
    setShownIndex(index);
    setJumped(Math.abs(index - shownIndex) > 1);
  }
  // La transition revient une image après le saut, et non au cran suivant : rendue dans le même
  // rendu que la nouvelle position, elle n'aurait rien à interpoler et ce cran se ferait d'un coup
  // lui aussi (voir la note sur les deux images dans useCarouselDrag).
  useEffect(() => {
    if (!jumped) return;
    const frame = requestAnimationFrame(() => setJumped(false));
    return () => cancelAnimationFrame(frame);
  }, [jumped]);

  /**
   * La barre de progression suit le minuteur, pauses comprises.
   *
   * Seul le minuteur s'arrêtait : la barre continuait de se remplir derrière une fiche ou la
   * recherche, et au retour elle était pleine alors que le titre ne changeait que huit secondes
   * plus tard. Elle se fige avec lui, et repart de zéro quand il repart pour un intervalle entier.
   */
  // Hors de l'écran aussi : le minuteur de `useHeroOrder` s'y arrête, la barre doit le suivre.
  const running = !(paused || dragging || offscreen);
  const [runs, setRuns] = useState(0);
  const [wasRunning, setWasRunning] = useState(running);
  if (running !== wasRunning) {
    setWasRunning(running);
    if (running) setRuns((n) => n + 1);
  }
  /**
   * La bannière des reprises, debout : l'affiche entière mais moins large, centrée, et les voisines
   * qui dépassent de part et d'autre (07/10/2026). Rogner l'affiche pour la raccourcir en perdait le
   * haut ou le bas ; la rétrécir la garde entière, laisse la place aux vignettes, et dit d'un coup
   * d'œil qu'il y a d'autres titres à côté.
   */
  const peek = continueStyle && !short;
  const drag = useCarouselDrag({
    trackRef,
    count: items.length,
    index,
    onIndexChange: setIndex,
    onDragStateChange: setDragging,
    peek,
  });

  // Le geste liquide des deux boutons (DECISIONS.md §45) : posés dans un carrousel qu'on fait glisser
  // et une page qui défile, ils gonflent et rebondissent à l'appui, et rendent la main dès que le
  // doigt bouge (`data-liquid-pan="press"`).
  const sectionRef = useRef<HTMLElement>(null);
  useLiquidDelegation(sectionRef);

  if (items.length === 0) return null;

  const actions = (item: Item) => {
    const resume = resumeFor?.(item) ?? null;
    // Bannière Reprendre / À suivre : le geste seul sur le bouton, le reste au-dessus — le bouton
    // long repoussait « Plus d'infos » hors de la carte (07/10/2026). Ailleurs, la formule d'origine.
    const facts = continueStyle
      ? resume
        ? heroContinueFacts(t, resume.positionTicks, resume.runtimeTicks, resume.seasonNumber, resume.episodeNumber)
        : { label: t("common.play"), caption: null, progress: null }
      : null;
    return (
    <>
    {facts && (facts.caption || facts.progress !== null) && (
      <div className="mb-3">
        <HeroContinueProgress caption={facts.caption} progress={facts.progress} centered={!short} />
      </div>
    )}
    <div className="flex gap-2">
      <button
        type="button"
        onClick={() => onPlay(item)}
        data-liquid-pan="press"
        className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-white px-3 py-2.5 text-sm font-semibold text-ink"
      >
        <Play size={16} fill="currentColor" />
        {/* La même formule que les fiches et les rangées : « Reprendre — 40 min restantes ». Un
            libellé propre à la bannière aurait été un troisième vocabulaire pour un même geste. */}
        <span className="truncate">
          {facts ? facts.label : resume ? formatContinueLabel(t, resume.positionTicks, resume.runtimeTicks, resume.seasonNumber, resume.episodeNumber) : t("common.play")}
        </span>
      </button>
      <button
        type="button"
        onClick={() => onOpen(item)}
        data-liquid-pan="press"
        aria-label={t("cinema.moreInfo")}
        // Le verre liquide : posé sur l'affiche, il a quelque chose à flouter. Sur l'affiche
        // rétrécie des reprises, un rond : « Plus d'infos » en toutes lettres y passait sur deux
        // lignes à côté du bouton de lecture.
        className={`nav-glass flex items-center justify-center gap-2 text-sm font-medium text-white ${peek ? "w-11 shrink-0 rounded-full" : "flex-1 rounded-lg px-3 py-2.5"}`}
      >
        <Info size={peek ? 18 : 16} />
        {!peek && t("cinema.moreInfo")}
      </button>
    </div>
    </>
    );
  };

  return (
    // Fond en remplaçant son squelette, au lieu de surgir (23/09/2026) — au montage seulement.
    <section ref={sectionRef} className="animate-fade-in px-4 pt-2">
      {/* Une piste, et non une affiche remplacée : toutes les affiches sont côte à côte et la
          piste est décalée d'une largeur par titre. Pendant le geste elle porte en plus le
          décalage du doigt, sans transition — elle n'anime pas vers une cible, elle est là où le
          doigt l'a mise. Voir useCarouselDrag pour le relâchement. */}
      <div className={peek ? "-mx-4 overflow-hidden py-1" : "overflow-hidden rounded-2xl"} {...drag.handlers} style={drag.style}>
        <div
          ref={trackRef}
          className={peek ? "flex gap-3" : "flex"}
          style={{
            // La largeur d'une affiche quand les voisines se montrent : à peu près 38 % de la hauteur
            // de l'écran — l'affiche, en 2/3, en fait alors 57 % —, bornée pour qu'un petit
            // téléphone garde une affiche lisible et qu'un grand laisse dépasser les voisines.
            ...(peek ? { ["--carousel-slide" as string]: "clamp(64%, 38svh, 80%)" } : {}),
            transform: carouselTransform(index, 0, peek),
            transition: jumped ? "none" : CAROUSEL_TRANSITION,
            // Promue une fois pour toutes, plutôt qu'à chaque geste : sans cela le navigateur
            // décide de promouvoir la piste au premier déplacement, ce qui veut dire re-tramer
            // une surface de plusieurs écrans de large au moment où le doigt attend une réponse.
            willChange: "transform",
          }}
        >
          {items.map((item, i) => (
            <div
              key={"radarrId" in item ? `f${item.radarrId}` : `s${item.sonarrId}`}
              className={peek ? `hero-peek-slide shrink-0 ${i === index ? "hero-peek-on" : ""}` : "w-full shrink-0"}
              // Une voisine qui dépasse se choisit d'un toucher, sans actionner ses boutons.
              onClickCapture={
                peek && i !== index
                  ? (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setIndex(i);
                    }
                  : undefined
              }
            >
              {/* Seules l'affiche courante et ses deux voisines existent : les huit rendues
                  ensemble font une piste de huit écrans de large à tramer et à garder en
                  mémoire, plus huit logos. Trois suffisent — celle qu'on voit, celle d'où l'on
                  vient, celle où l'on va. */}
              {Math.abs(i - index) > 1 ? null : short ? (
                <div className="flex gap-4 rounded-2xl bg-surface/70 p-3 shadow-xl shadow-black/50">
                  <div className="w-24 shrink-0 overflow-hidden rounded-lg">
                    <PosterImage src={heroPoster(item)} alt={item.title} subtle unoptimized priority={i === index} sizes="120px" />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col justify-center">
                    {item.logoUrl ? (
                      <CinemaLogo
                        src={item.logoUrl}
                        alt={item.title}
                        surface="phone"
                        className="mb-2 self-start"
                        fallback={<h1 className="mb-2 truncate text-xl font-bold text-white drop-shadow-lg">{item.title}</h1>}
                      />
                    ) : (
                      <h1 className="mb-2 truncate text-xl font-bold text-white drop-shadow-lg">{item.title}</h1>
                    )}
                    {/* Une rangée, et c'est tout le correctif.
                        Les pastilles étaient posées seules dans cette colonne flex : chacune s'y
                        étirait sur toute la largeur et elles s'empilaient l'une sous l'autre,
                        deux longs rectangles bordés là où il fallait deux étiquettes. Signalé le
                        19/09/2026, visible seulement en paysage — c'est la seule branche qui les
                        portait. Elles rejoignent les genres sur la même ligne, comme sur la
                        bannière du bureau. */}
                    <div className="mb-3 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted">
                      <QualityBadges quality={"quality" in item ? item.quality : undefined} />
                      {item.genres.length > 0 && (
                        <span className="truncate">{item.genres.slice(0, 3).map((g) => genreLabel(g, t)).join(" · ")}</span>
                      )}
                    </div>
                    {actions(item)}
                  </div>
                </div>
              ) : (
                <div className="relative overflow-hidden rounded-2xl bg-surface shadow-xl shadow-black/50">
                  <PosterImage src={heroPoster(item)} alt={item.title} subtle unoptimized priority={i === index} sizes="100vw" />
                  <div className="absolute inset-x-0 bottom-0 bg-linear-to-t from-ink via-ink/70 to-transparent p-4 pt-16">
                    {item.logoUrl ? (
                      <CinemaLogo
                        src={item.logoUrl}
                        alt={item.title}
                        surface="phone"
                        className="mx-auto mb-2"
                        fallback={
                          <h1 className="mb-2 text-center text-2xl font-bold text-white drop-shadow-lg font-display">{item.title}</h1>
                        }
                      />
                    ) : (
                      <h1 className="mb-2 text-center text-2xl font-bold text-white drop-shadow-lg font-display">{item.title}</h1>
                    )}
                    {item.genres.length > 0 && (
                      <p className="mb-3 text-center text-xs text-muted">{item.genres.slice(0, 3).map((g) => genreLabel(g, t)).join(" · ")}</p>
                    )}
                    {actions(item)}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* La bannière Reprendre / À suivre : des vignettes plutôt que des tirets. On y voit tout ce
          qu'elle tient d'un coup, et un toucher y mène — le sommaire que la rangée sous la
          bannière est au bureau, sans montrer deux fois les mêmes titres (07/10/2026). La vignette
          d'une reprise porte sa progression ; celle d'un complément « À la une » n'en a pas. Le
          fil sous la vignette active compte jusqu'au passage suivant, comme les tirets. */}
      {continueStyle && items.length > 1 && (
        <div className="scrollbar-none -mx-4 mt-2 overflow-x-auto px-4 py-1.5">
          <div className="mx-auto flex w-max gap-2">
            {items.map((item, i) => {
              const resume = resumeFor?.(item) ?? null;
              const watched = resume?.runtimeTicks && resume.positionTicks > 0 ? Math.min(1, resume.positionTicks / resume.runtimeTicks) : null;
              const active = i === index;
              return (
                <button
                  key={heroKey(item)}
                  type="button"
                  onClick={() => setIndex(i)}
                  aria-label={item.title}
                  aria-current={active}
                  className={`hero-thumb flex w-11 shrink-0 flex-col gap-1 ${active ? "hero-thumb-on" : ""}`}
                >
                  <span className="relative block overflow-hidden rounded-lg ring-1 ring-white/15">
                    <PosterImage src={item.posterUrl} alt="" subtle unoptimized sizes="48px" />
                    {watched !== null && (
                      <span className="absolute inset-x-0 bottom-0 h-0.5 bg-black/60">
                        <span className="block h-full bg-accent-500" style={{ width: `${Math.round(watched * 100)}%` }} />
                      </span>
                    )}
                  </span>
                  <span className="block h-0.5 overflow-hidden rounded-full bg-white/15">
                    {active && (
                      <span
                        key={`${index}:${runs}`}
                        className="block h-full animate-hero-fill bg-white"
                        style={{ animationPlayState: running ? "running" : "paused" }}
                      />
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Hors de la piste : les barres disent où l'on en est, elles ne défilent pas avec. */}
      {!continueStyle && items.length > 1 && (
        <div className="mx-auto mt-3 flex max-w-xs gap-1">
          {items.map((item, i) => (
            <button
              key={"radarrId" in item ? `f${item.radarrId}` : `s${item.sonarrId}`}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={item.title}
              aria-current={i === index}
              className="h-1 flex-1 overflow-hidden rounded-full bg-white/25"
            >
              {i < index && <div className="h-full w-full bg-white" />}
              {i === index && (
                <div
                  key={`${index}:${runs}`}
                  className="h-full animate-hero-fill bg-white"
                  style={{ animationPlayState: running ? "running" : "paused" }}
                />
              )}
            </button>
          ))}
        </div>
      )}
    </section>
  );
});
