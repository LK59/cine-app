"use client";

/* eslint-disable @next/next/no-img-element -- des `<img>` nus, voulus : la lueur se découpe sur le logo
   par un masque qui lit la même adresse, le fond est une taille du CDN de TMDB choisie ici
   (`introBackdropSrc`), et l'optimiseur de Next le redemanderait à sa façon, après l'appui. */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import {
  PLAYBACK_INTRO,
  finishIntro,
  introFinished,
  introSnapshot,
  keepIntroSnapshot,
  introBackdropSrc,
  introBlur,
  introVeil,
  type PlaybackIntroArt,
  type PlaybackIntroSettings,
} from "@/lib/playbackIntro";

/**
 * Où en est la lecture, vu de l'ouverture :
 * - `waiting` : pas encore d'image, rien d'anormal — l'ouverture paraît passé le seuil ;
 * - `picture` : la première image est là — fondu enchaîné vers le film, puis plus rien ;
 * - `gone` : une erreur, la connexion perdue, le mini-lecteur… — disparue à l'instant, et l'écran
 *   qui a quelque chose à dire se montre tel qu'avant.
 */
export type IntroPhase = "waiting" | "picture" | "gone";

interface Shown {
  art: PlaybackIntroArt | null;
  name: string;
  caption: string[];
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/**
 * L'ouverture de la lecture — DECISIONS.md §60, réglages et règles dans `src/lib/playbackIntro.ts`.
 *
 * Un calque posé par-dessus l'élément vidéo, qui ne touche à rien de la lecture : il ne retarde ni
 * l'ouverture du fichier ni la première image, et ne prend aucun appui hors de sa croix — le toucher,
 * Échap et le geste de retour vont où ils allaient. Seules l'opacité et la transformation s'animent,
 * ce que le compositeur joue sans le fil principal (qui, à l'ouverture, remultiplexe).
 *
 * `startedAt` vient de l'horloge partagée (`startIntroClock`) : un lecteur qui prend la relève avant la
 * première image reprend l'ouverture au point exact où l'autre en était.
 *
 * Deux temps (10/10/2026). Dès le montage — l'appui —, une **couverture** : le visuel du film sous son
 * voile, immobile, sans logo ni légende, pour que le lecteur vide ne se montre jamais. Puis :
 * - la première image arrive avant le seuil (`imageShown`) : la couverture s'efface sur elle en fondu,
 *   et l'ouverture animée ne paraît jamais. C'est le cas des reprises lues depuis l'appareil, ouvertes
 *   en 34 à 115 ms ce jour-là : l'ouverture, partie à 300 ms parce que l'horloge n'avançait pas encore,
 *   se posait *sur* une image déjà là, puis s'effaçait un instant plus tard ;
 * - rien à 300 ms : l'ouverture animée part de cette même couverture — même image, même voile, même
 *   échelle —, et s'efface comme avant, quand l'hôte passe en `picture`.
 * Une image à l'écran n'est jamais recouverte : passé `imageShown`, l'ouverture ne peut plus partir.
 */
export function PlaybackIntro({
  phase,
  startedAt,
  clockKey,
  art,
  fallbackName,
  caption,
  note = null,
  settings = PLAYBACK_INTRO,
  reduced: reducedProp,
  imageShown = false,
  onShow,
  onClose,
  closeLabel,
  className = "absolute inset-0",
  style,
}: {
  phase: IntroPhase;
  /**
   * La première image est à l'écran — fût-elle figée, l'horloge pas encore partie. Avant que
   * l'ouverture animée ait paru, c'est elle qui retire la couverture ; après, l'hôte garde la main
   * (`phase`), avec ses propres règles de fin (`src/lib/introEnd.ts`).
   */
  imageShown?: boolean;
  /** L'ouverture animée vient de paraître (la couverture seule ne compte pas). */
  onShow?: () => void;
  startedAt: number;
  /** La clé de l'horloge partagée : ce qui a été montré y est gardé pour le lecteur qui prend la relève. */
  clockKey?: string;
  art: PlaybackIntroArt | null;
  /** Le titre de la séance, écrit quand rien d'autre n'est connu. */
  fallbackName: string;
  caption: string[];
  /** Un mot sous la ligne de chargement, quand l'attente devient longue. */
  note?: string | null;
  settings?: PlaybackIntroSettings;
  /** Forcé par le banc ; sinon la préférence « Réduire les animations » de l'appareil. */
  reduced?: boolean;
  onClose?: () => void;
  closeLabel?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const { thresholdMs, zoom, logoMs, sweep, background, brightness } = settings;
  const [reducedPref] = useState(prefersReducedMotion);
  const reduced = reducedProp ?? reducedPref;

  // Ce qui sera montré, figé au moment où l'ouverture paraît : un logo arrivé un instant plus tard
  // avec la description du fichier remplacerait le titre écrit en plein milieu de son apparition.
  const latest = useRef<Shown>({ art, name: fallbackName, caption });
  useEffect(() => {
    latest.current = { art, name: fallbackName, caption };
  }, [art, fallbackName, caption]);
  // Une image déjà là au montage, ou une ouverture déjà close — le mini-lecteur rendu au plein écran,
  // un relais après la première image : rien, pas même la couverture. Recouvrir une image, c'est
  // précisément ce que cette règle interdit.
  const [done, setDone] = useState(() => imageShown || (clockKey ? introFinished(clockKey) : false));
  // `shown` : l'ouverture animée a paru, figée sur ce qu'elle montre. Déjà passé le seuil au montage,
  // c'est un relais (le lecteur serveur après le natif) — elle est là d'emblée, au point où elle en était.
  const [shown, setShown] = useState<Shown | null>(() =>
    !done && phase === "waiting" && Date.now() - startedAt >= thresholdMs
      ? ((clockKey ? introSnapshot<Shown>(clockKey) : undefined) ?? { art, name: fallbackName, caption })
      : null
  );
  const started = shown !== null;
  const onShowRef = useRef(onShow);
  useEffect(() => {
    onShowRef.current = onShow;
  }, [onShow]);
  useEffect(() => {
    if (started) onShowRef.current?.();
  }, [started]);

  // Le seuil : sous lui, la première image arrive avant qu'une ouverture animée ait un sens, et seule
  // la couverture aura paru. Une image arrivée entre-temps l'annule pour de bon.
  useEffect(() => {
    if (phase !== "waiting" || started || imageShown || done) return;
    const id = window.setTimeout(() => {
      if (clockKey) keepIntroSnapshot(clockKey, latest.current);
      setShown(latest.current);
    }, Math.max(0, startedAt + thresholdMs - Date.now()));
    return () => window.clearTimeout(id);
  }, [phase, started, imageShown, done, startedAt, thresholdMs, clockKey]);

  const backdropRef = useRef<HTMLDivElement>(null);
  const bgImgRef = useRef<HTMLImageElement>(null);
  const logoRef = useRef<HTMLDivElement>(null);
  const sweepRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  // La couverture est là dès le montage ; l'ouverture animée s'y ajoute (`started`).
  const visible = !done && phase !== "gone";
  // Avant le seuil, la couverture montre ce que l'hôte sait à cet instant ; ensuite, ce qui a été figé.
  const display: Shown = shown ?? { art, name: fallbackName, caption };
  // Un logo qui ne se charge pas (hors ligne, adresse périmée) laissait l'icône d'image cassée au
  // milieu de l'écran, avec son texte de remplacement : le titre écrit prend sa place.
  const [logoFailed, setLogoFailed] = useState(false);
  const logo = logoFailed ? null : (display.art?.logoUrl ?? null);
  const bgSrc = introBackdropSrc(display.art?.backdropUrl, background);
  const blur = introBlur(background);

  // L'ouverture : le fond qui avance, le logo qui paraît, une lueur. Jouée une fois, depuis le point
  // où elle en est — zéro d'ordinaire, plus pour un relais.
  useLayoutEffect(() => {
    if (!visible || !started) return;
    const offset = Math.max(0, Date.now() - (startedAt + thresholdMs));
    const animations: Animation[] = [];
    const at = (a: Animation | undefined) => {
      if (!a) return;
      a.currentTime = offset;
      animations.push(a);
    };
    if (!reduced) {
      // Avance lente et continue : la durée d'un chargement n'est pas connue d'avance, on part donc
      // sur six secondes, coupées par le fondu dès que l'image est là.
      at(backdropRef.current?.animate?.([{ transform: `scale(${zoom})` }, { transform: "scale(1)" }], {
        duration: 6000, easing: "cubic-bezier(0.25, 0.6, 0.3, 1)", fill: "both",
      }));
    }
    at(logoRef.current?.animate?.(
      reduced
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [{ opacity: 0, transform: "scale(0.96)" }, { opacity: 1, transform: "scale(1)" }],
      { duration: reduced ? 200 : logoMs, delay: reduced ? 0 : 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "both" }
    ));
    // La légende et la ligne de chargement : absentes de la couverture, elles arrivent avec le logo.
    at(detailsRef.current?.animate?.([{ opacity: 0 }, { opacity: 1 }], {
      duration: reduced ? 200 : 300, delay: reduced ? 0 : 200, easing: "ease-out", fill: "both",
    }));
    if (sweep && !reduced && logo) {
      at(sweepRef.current?.animate?.([{ transform: "translateX(-120%)" }, { transform: "translateX(120%)" }], {
        duration: 1100, delay: 200 + logoMs * 0.6, easing: "cubic-bezier(0.45, 0, 0.25, 1)", fill: "both",
      }));
    }
    return () => {
      for (const a of animations) a.cancel();
    };
    // Une fois, à l'apparition : la suite (le fondu) a son propre effet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, started]);

  // Le fond de la couverture. Déjà décodé — le cas courant, demandé dès l'appui (`preloadIntroArt`) —,
  // il est là à la première image dessinée, sans fondu : un fondu laisserait voir le voile seul, puis
  // l'image. Sinon le voile attend seul, et l'image le rejoint en 250 ms (600 si elle a tardé). Dans
  // un relais, il est là tout de suite. Un échec laisse le voile — jamais le lecteur vide.
  useLayoutEffect(() => {
    const img = bgImgRef.current;
    if (!visible || !img || !bgSrc) return;
    const continuing = Date.now() - (startedAt + thresholdMs) > 150;
    if (continuing || (img.complete && img.naturalWidth > 0)) {
      img.style.opacity = "1";
      return;
    }
    let cancelled = false;
    let fade: Animation | undefined;
    const t0 = performance.now();
    const decoded = typeof img.decode === "function" ? img.decode() : Promise.resolve();
    void decoded.then(
      () => {
        if (cancelled) return;
        if (typeof img.animate !== "function") {
          img.style.opacity = "1";
          return;
        }
        fade = img.animate([{ opacity: 0 }, { opacity: 1 }], { duration: performance.now() - t0 < 150 ? 250 : 600, easing: "ease-out", fill: "both" });
      },
      () => undefined
    );
    return () => {
      cancelled = true;
      fade?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, bgSrc]);

  // La fin. L'ouverture animée parue : à `picture`, fondu enchaîné de 400 ms, le logo s'éloigne un
  // peu. La couverture seule : dès la première image, même figée — le film « sort » de son visuel en
  // 280 ms, en décélérant —, et l'ouverture est close pour cette lecture : un lecteur qui prendrait la
  // relève ne recouvrirait pas l'image. Puis le calque se retire.
  const fading = visible && (started ? phase === "picture" : imageShown || phase === "picture");
  useLayoutEffect(() => {
    if (!fading) return;
    const d = reduced ? 200 : started ? 400 : 280;
    if (!started && clockKey) finishIntro(clockKey);
    rootRef.current?.animate?.([{ opacity: 1 }, { opacity: 0 }], {
      duration: d, easing: started ? "ease-out" : "cubic-bezier(0.22, 1, 0.36, 1)", fill: "both",
    });
    if (started && !reduced) logoRef.current?.animate?.([{ transform: "scale(1)" }, { transform: "scale(1.06)" }], { duration: d, easing: "ease-out", fill: "forwards", composite: "replace" });
    // Retiré au bout du fondu, par une minuterie et non par la fin de l'animation : un navigateur sans
    // `animate` (ou une animation annulée) ne doit pas laisser le calque posé sur le film.
    const id = window.setTimeout(() => setDone(true), d);
    return () => window.clearTimeout(id);
  }, [fading, started, reduced, clockKey]);

  if (!visible) return null;
  const name = display.art?.name ?? display.name;

  return (
    <div
      ref={rootRef}
      className={`overflow-hidden bg-black ${className}`}
      style={{ pointerEvents: "none", ...style }}
      data-playback-intro={started ? "intro" : "cover"}
    >
      {/* À l'échelle de départ du zoom dès la couverture : l'ouverture animée part de là, sans saut. */}
      <div ref={backdropRef} className="absolute inset-0" style={{ willChange: "transform", transform: reduced ? undefined : `scale(${zoom})` }}>
        {bgSrc && (
          // Le filtre éventuel (banc seulement) est posé sur l'image, qui ne bouge pas ; seul son
          // conteneur avance. Floutée, elle est agrandie de 8 % pour que son bord adouci ne se voie pas.
          <img
            ref={bgImgRef}
            src={bgSrc}
            alt=""
            decoding="async"
            className="h-full w-full object-cover"
            style={{ opacity: 0, filter: blur ? `blur(${blur}px)` : undefined, transform: blur ? "scale(1.08)" : undefined }}
          />
        )}
      </div>
      {/* Le voile : le bord de l'écran s'assombrit, le logo se lit au centre. */}
      <div className="absolute inset-0" style={{ background: introVeil(background, brightness) }} />
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8">
        <div ref={logoRef} className="relative" style={{ opacity: 0 }}>
          {logo ? (
            <>
              <img src={logo} alt={name} onError={() => setLogoFailed(true)} className="block max-h-[22vh] max-w-[min(60vw,32rem)] object-contain" />
              {/* La lueur : une bande claire découpée à la forme du logo par un masque — pas un filtre. */}
              {sweep && !reduced && (
                <div
                  className="pointer-events-none absolute inset-0 overflow-hidden"
                  style={{
                    WebkitMaskImage: `url("${logo}")`, maskImage: `url("${logo}")`,
                    WebkitMaskSize: "contain", maskSize: "contain",
                    WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat",
                    WebkitMaskPosition: "center", maskPosition: "center",
                  } as CSSProperties}
                >
                  <div
                    ref={sweepRef}
                    className="absolute inset-y-0 w-1/2"
                    style={{ left: "25%", transform: "translateX(-120%)", background: "linear-gradient(100deg, transparent, rgba(255,255,255,0.85), transparent)" }}
                  />
                </div>
              )}
            </>
          ) : (
            <h1 className="text-center text-4xl font-bold text-white sm:text-6xl font-display">{name}</h1>
          )}
        </div>
        {started && (
          <div ref={detailsRef} className="flex flex-col items-center gap-4" style={{ opacity: 0 }}>
            {display.caption.map((line) => (
              <p key={line} className="text-center text-sm font-medium text-muted sm:text-base">
                {line}
              </p>
            ))}
            {/* La ligne de chargement : une lueur qui passe, à la place de la roue. */}
            <div className="relative h-[2px] w-28 overflow-hidden rounded-full bg-white/15">
              <div className={`absolute inset-y-0 w-1/2 rounded-full bg-gradient-to-r from-transparent via-white/90 to-transparent ${reduced ? "" : "playback-intro-line"}`} />
            </div>
            {note && <p className="text-xs text-subtle">{note}</p>}
          </div>
        )}
      </div>
      {onClose && (
        // La seule chose qui prenne un appui : à l'ouverture, les commandes du lecteur natif ne sont
        // pas encore là, et la croix doit l'être.
        <button
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          className="player-pill absolute flex h-10 w-10 items-center justify-center rounded-full text-white"
          style={{ pointerEvents: "auto", top: "max(1rem, env(safe-area-inset-top))", left: "max(1rem, env(safe-area-inset-left))" }}
        >
          <X size={18} />
        </button>
      )}
    </div>
  );
}
