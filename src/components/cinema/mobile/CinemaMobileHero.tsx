"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Info, Play } from "lucide-react";
import { PosterImage } from "@/components/PosterImage";
import { CinemaLogo } from "@/components/cinema/CinemaLogo";
import { heroSignature, resolveHeroCarousel, upcomingImages, useDecodeAhead, useHeroOrder } from "@/lib/heroCarousel";
import { useCarouselDrag, carouselTransform, CAROUSEL_MS, CAROUSEL_TRANSITION } from "@/lib/useCarouselDrag";
import { useT } from "@/components/TranslationProvider";
import { genreLabel } from "@/lib/top10Label";
import { QualityBadges } from "@/components/cinema/QualityBadges";
import { formatContinueLabel, heroContinueFacts } from "@/lib/cinemaContinueLabel";
import { HeroContinueProgress } from "@/components/cinema/HeroContinueProgress";
import { useLiquidDelegation } from "@/lib/liquidGlass/useLiquidDelegation";
import { useArrivalFade } from "@/lib/useArrivalFade";
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
/** Les copies posées de chaque côté de la piste quand elle boucle. */
const LOOP_COPIES = 2;
const NO_TRANSITION = { transition: "none" } as const;
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
   * Seules l'affiche courante et ses voisines sont rendues. Du dernier titre au premier, ou d'un
   * toucher sur une barre éloignée, la piste glissait donc sur toute sa largeur en traversant des
   * cases vides, l'affiche visible démontée d'emblée (relevé le 23/09/2026). Le glissement reste
   * pour un cran — le geste, la rotation — ; au-delà, l'affiche est remplacée sur place.
   * Retenu pendant le rendu, et non dans un effet : c'est ce rendu-là qui pose la transformation.
   *
   * Un changement que personne n'a demandé ne glisse pas non plus (08/10/2026) : la liste qui
   * passe d'un titre à deux (la boucle apparaît, toutes les cases se décalent), ou un titre retiré
   * avant celui qu'on regarde (son index baisse, mais c'est toujours lui). La piste glissait d'un
   * cran alors que le titre à l'écran n'avait pas changé. On retient donc le titre, pas seulement
   * sa place.
   */
  const count = items.length;
  const currentKey = count > 0 ? heroKey(items[index]) : null;
  const [shown, setShown] = useState({ index, key: currentKey, count });
  const [jumped, setJumped] = useState(false);
  /**
   * La piste boucle (08/10/2026) : après le dernier titre vient le premier, en continuant dans le
   * même sens — elle glisse sur une copie du premier posée après le dernier, puis se raccorde sans
   * transition sur le vrai, ce que l'œil ne voit pas. Pareil à l'envers sur une copie du dernier.
   *
   * Le sens est dit par le geste (`intent`), pas deviné : à deux titres, passer du second au
   * premier est aussi bien un pas en arrière qu'un tour complet vers l'avant, et la supposition
   * faisait courir la piste deux cases à droite sur un simple balayage vers la droite. Seule la
   * rotation, qui ne va que vers l'avant, laisse le sens au défaut.
   */
  const loop = count > 1;
  const pad = loop ? LOOP_COPIES : 0;
  const [wrapping, setWrapping] = useState<null | "toFirst" | "toLast">(null);
  const [intent, setIntent] = useState<null | "forward" | "backward">(null);
  if (index !== shown.index || currentKey !== shown.key || count !== shown.count) {
    const last = count - 1;
    // Même titre ailleurs, ou une piste d'une autre longueur : rien n'a été demandé, on se pose.
    const reshaped = count !== shown.count || currentKey === shown.key;
    setShown({ index, key: currentKey, count });
    if (intent) setIntent(null);
    if (reshaped || wrapping) {
      // Pendant un raccord, la piste est sur une copie : un nouveau choix (une barre touchée) part
      // du vrai titre, posé sans glisser.
      if (wrapping) setWrapping(null);
      setJumped(true);
    } else {
      const toFirst = loop && shown.index === last && index === 0 && intent !== "backward";
      const toLast = loop && shown.index === 0 && index === last && intent === "backward";
      if (toFirst || toLast) {
        setWrapping(toFirst ? "toFirst" : "toLast");
        setJumped(false);
      } else {
        setJumped(Math.abs(index - shown.index) > 1);
      }
    }
  }
  /** Le raccord : sans transition, sur le vrai titre — la copie et lui sont identiques. */
  const settleWrap = useCallback(() => {
    setWrapping(null);
    setJumped(true);
  }, []);
  /**
   * Le raccord de fin de glissement attend que les affiches d'arrivée soient décodées.
   *
   * La copie et le vrai titre sont deux éléments distincts : au raccord, le vrai — et ses deux
   * voisines qui dépassent — prennent la place de la copie. Une image chargée mais pas encore
   * décodée s'y peignait noire une image ou deux : le clignotement relevé du dernier titre au
   * premier (08/10/2026). La copie restant identique à l'écran, attendre ne se voit pas ; un quart
   * de seconde au plus, pour qu'une image qui ne vient pas ne retienne pas la piste.
   */
  const wrappingRef = useRef(wrapping);
  useLayoutEffect(() => {
    wrappingRef.current = wrapping;
  }, [wrapping]);
  const settleWhenReady = useCallback(() => {
    const rest = trackRef.current ? [...trackRef.current.children].slice(Math.max(0, index + pad - 1), index + pad + 2) : [];
    const images = rest.flatMap((slot) => [...slot.querySelectorAll("img")]);
    const decoded = Promise.all(images.map((img) => (typeof img.decode === "function" ? img.decode().catch(() => undefined) : undefined)));
    const cap = new Promise((resolve) => setTimeout(resolve, 250));
    void Promise.race([decoded, cap]).then(() => {
      // Un geste a pu raccorder entre-temps (`onDragState`) : rien à refaire.
      if (wrappingRef.current) settleWrap();
    });
  }, [index, pad, settleWrap]);
  useEffect(() => {
    if (!wrapping) return;
    // Filet : `transitionend` raccorde d'habitude (voir la piste), mais une transition coupée en
    // route n'en émet pas.
    const id = setTimeout(settleWhenReady, CAROUSEL_MS + 30);
    return () => clearTimeout(id);
  }, [wrapping, settleWhenReady]);
  /** La position de la piste : décalée de `pad` crans par les copies posées avant le premier. */
  const trackPos = !loop ? index : wrapping === "toFirst" ? count + pad : wrapping === "toLast" ? pad - 1 : index + pad;
  /**
   * Deux copies de chaque côté, et non une : posée sur la copie du premier, la piste montrait un
   * bord vide là où la voisine de droite aurait dû dépasser — rien n'existait au-delà.
   */
  const slides = Array.from({ length: count + 2 * pad }, (_, i) => {
    const k = i - pad;
    const real = ((k % count) + count) % count;
    return { item: items[real], real, key: k < 0 || k >= count ? `copie${k}` : heroKey(items[real]) };
  });
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
   * Debout, l'affiche ne prend pas toute la largeur : entière, à peu près 86 % de l'écran, et ses
   * voisines dépassent sur les bords (08/10/2026) — elles disent d'un coup d'œil qu'il y a d'autres
   * titres à côté. Rogner l'affiche pour la raccourcir en perdait le haut ou le bas (refusé le
   * 07/10/2026). Couché, l'affiche est déjà à côté du texte : rien à montrer de plus.
   */
  const peek = !short;
  /**
   * Toucher l'affiche ouvre la fiche (08/10/2026), comme « Plus d'infos » — mais pas le relâchement
   * d'un balayage, que le navigateur livre aussi comme un clic : un geste qui vient de glisser ne
   * compte pas comme un toucher.
   */
  const draggedAt = useRef(0);
  const onDragState = useCallback(
    (moving: boolean) => {
      setDragging(moving);
      draggedAt.current = performance.now();
      // Un geste qui commence pendant le raccord d'une boucle : on se pose d'abord sur le vrai
      // titre. Sinon le minuteur du raccord tombait sous le doigt et remettait la piste à sa place
      // de repos — l'affiche sautait loin du doigt (08/10/2026).
      if (moving && wrapping) settleWrap();
    },
    [wrapping, settleWrap]
  );
  const openFromPoster = (e: React.MouseEvent, item: Item) => {
    if ((e.target as Element).closest("button")) return;
    if (performance.now() - draggedAt.current < 400) return;
    onOpen(item);
  };
  // Au-delà d'un bout, le geste rend -1 ou le nombre de titres (`loop`) : on revient sur le vrai.
  const onDragIndex = useCallback(
    (next: number) => {
      setIntent(next < index ? "backward" : "forward");
      setIndex(next < 0 ? count - 1 : next >= count ? 0 : next);
    },
    [count, index, setIndex]
  );
  const drag = useCarouselDrag({
    trackRef,
    count,
    index,
    position: trackPos,
    onIndexChange: onDragIndex,
    onDragStateChange: onDragState,
    peek,
    loop,
  });

  // Le geste liquide des deux boutons (DECISIONS.md §45) : posés dans un carrousel qu'on fait glisser
  // et une page qui défile, ils gonflent et rebondissent à l'appui, et rendent la main dès que le
  // doigt bouge (`data-liquid-pan="press"`).
  const sectionRef = useRef<HTMLElement>(null);
  useLiquidDelegation(sectionRef);
  // Le fondu d'arrivée, une fois : la bannière de l'autre onglet est cachée par `hidden`, et le
  // fondu rejouait à chaque retour — voir `useArrivalFade`.
  const fade = useArrivalFade();

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
        className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg bg-white px-3 py-2.5 text-sm font-semibold text-ink"
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
        // Le verre liquide : posé sur l'affiche, il a quelque chose à flouter.
        // Sur une ligne : l'affiche à 86 % le faisait passer sur deux sur un petit téléphone.
        className="nav-glass flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-2.5 text-sm font-medium text-white"
      >
        <Info size={16} />
        {t("cinema.moreInfo")}
      </button>
    </div>
    </>
    );
  };

  return (
    // Fond en remplaçant son squelette, au lieu de surgir (23/09/2026) — au montage seulement.
    <section ref={sectionRef} className={`${fade.arrived ? "" : "animate-fade-in "}px-4 pt-2`} onAnimationEnd={fade.onAnimationEnd}>
      {/* Une piste, et non une affiche remplacée : toutes les affiches sont côte à côte et la
          piste est décalée d'une largeur par titre. Pendant le geste elle porte en plus le
          décalage du doigt, sans transition — elle n'anime pas vers une cible, elle est là où le
          doigt l'a mise. Voir useCarouselDrag pour le relâchement. */}
      <div className={peek ? "-mx-4 overflow-hidden py-1" : "overflow-hidden rounded-2xl"} {...drag.handlers} style={drag.style}>
        <div
          ref={trackRef}
          className={peek ? "flex gap-3" : "flex"}
          style={{
            // La largeur d'une affiche quand les voisines se montrent : 86 %, de quoi les voir
            // dépasser de chaque côté sans rétrécir l'affiche.
            ...(peek ? { ["--carousel-slide" as string]: "86%" } : {}),
            transform: carouselTransform(trackPos, 0, peek),
            transition: jumped ? "none" : CAROUSEL_TRANSITION,
            // Promue une fois pour toutes, plutôt qu'à chaque geste : sans cela le navigateur
            // décide de promouvoir la piste au premier déplacement, ce qui veut dire re-tramer
            // une surface de plusieurs écrans de large au moment où le doigt attend une réponse.
            willChange: "transform",
          }}
          onTransitionEnd={(e) => {
            if (wrapping && e.target === e.currentTarget && e.propertyName === "transform") settleWhenReady();
          }}
        >
          {slides.map(({ item, real, key }, i) => (
            <div
              key={key}
              className={peek ? `hero-peek-slide shrink-0 ${i === trackPos ? "hero-peek-on" : ""}` : "w-full shrink-0"}
              // Les affiches ont leur propre transition (agrandie, éclaircie) : sans la couper pendant
              // un saut, l'affiche posée sur place repoussait de 45 % d'opacité à chaque raccord.
              style={jumped ? NO_TRANSITION : undefined}
              // Une voisine qui dépasse se choisit d'un toucher, sans actionner ses boutons — et
              // dans son sens : celle de gauche est un pas en arrière, même quand c'est la boucle.
              onClickCapture={
                peek && i !== trackPos
                  ? (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setIntent(i < trackPos ? "backward" : "forward");
                      setIndex(real);
                    }
                  : undefined
              }
            >
              {/* Seules l'affiche courante et ses deux voisines existent : les huit rendues
                  ensemble font une piste de huit écrans de large à tramer et à garder en
                  mémoire, plus huit logos. Trois suffisent — celle qu'on voit, celle d'où l'on
                  vient, celle où l'on va. */}
              {/* Celles de la position de repos aussi, pendant un raccord : la case d'arrivée était vide
                  jusqu'au raccord, et son affiche et son logo montaient à neuf à cet instant. */}
              {Math.abs(i - trackPos) > 1 && Math.abs(i - (index + pad)) > 1 ? null : short ? (
                <div className="flex cursor-pointer gap-4 rounded-2xl bg-surface/70 p-3 shadow-xl shadow-black/50" onClick={(e) => openFromPoster(e, item)}>
                  <div className="w-24 shrink-0 overflow-hidden rounded-lg">
                    <PosterImage src={heroPoster(item)} alt={item.title} subtle unoptimized priority={i === trackPos} eager sizes="120px" />
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
                <div className="relative cursor-pointer overflow-hidden rounded-2xl bg-surface shadow-xl shadow-black/50" onClick={(e) => openFromPoster(e, item)}>
                  <PosterImage src={heroPoster(item)} alt={item.title} subtle unoptimized priority={i === trackPos} eager sizes="100vw" />
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

      {/* Hors de la piste : les barres disent où l'on en est, elles ne défilent pas avec. */}
      {items.length > 1 && (
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
