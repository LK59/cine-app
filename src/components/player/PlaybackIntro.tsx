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
 * - `waiting` : le film ne joue pas encore, rien d'anormal — l'ouverture est là ;
 * - `picture` : le film bouge (règles de `src/lib/introEnd.ts`) — fondu enchaîné vers lui, puis plus rien ;
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
 * Entière dès le montage — l'appui —, sans seuil (10/10/2026, soir) : le visuel sous son voile, déjà
 * en mouvement, le logo (ou le titre écrit) qui paraît en 250 ms, la ligne de chargement et la légende
 * avec lui. Pendant quelques heures, sous 300 ms, seule une couverture immobile paraissait — le visuel
 * sans logo —, et sur les départs les plus rapides (reprises lues depuis l'appareil, 25 à 115 ms) elle
 * se lisait comme une image figée (Louis, iPhone, 8.31.2). Un logo posé en 250 ms donne au départ le
 * plus bref l'air voulu ; la lueur ne passe qu'une fois le logo posé, et pas du tout si le film part
 * avant.
 *
 * La fin ne change pas : quand le film *bouge* (`phase` → `picture`, la règle de l'hôte : l'horloge
 * partie, ou la lecture automatique refusée), un seul fondu de 280 ms, en décélérant, sur une image qui
 * joue déjà. Une image décodée qui ne part pas en `COVER_HOLD_MS` est un vrai blocage : l'ouverture
 * s'efface quand même, pour que l'attente se voie. Une image à l'écran n'est jamais recouverte : une
 * ouverture close, ou une image déjà là au montage, ne dessine rien.
 */
/**
 * Combien de temps l'ouverture tient sur une image décodée qui ne joue pas encore. Au-delà, ce n'est
 * plus le démarrage de Safari (quelques centaines de millisecondes, une poussée à 100 puis à 400 ms
 * pour un départ du début) mais une attente réelle, que l'interface du lecteur doit montrer.
 */
export const COVER_HOLD_MS = 1200;

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
  onCoverChange,
  onClose,
  closeLabel,
  className = "absolute inset-0",
  style,
}: {
  phase: IntroPhase;
  /**
   * La première image est décodée — fût-elle figée, l'horloge pas encore partie. Déjà vraie au
   * montage, rien ne paraît (une image ne se recouvre pas). Ensuite, l'ouverture tient jusqu'à
   * `phase` → `picture` (le film qui bouge, règles de `src/lib/introEnd.ts`), ou `COVER_HOLD_MS` au plus.
   */
  imageShown?: boolean;
  /** L'ouverture vient de paraître. */
  onShow?: () => void;
  /**
   * Le calque couvre-t-il le lecteur, avant son fondu de sortie ? L'hôte s'en sert pour taire ses
   * propres attentes (la roue des commandes) tant qu'il est là.
   */
  onCoverChange?: (covering: boolean) => void;
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
  const { zoom, logoMs, sweep, background, brightness } = settings;
  const [reducedPref] = useState(prefersReducedMotion);
  const reduced = reducedProp ?? reducedPref;

  // Une image déjà là au montage, ou une ouverture déjà close — le mini-lecteur rendu au plein écran,
  // un relais après la première image : rien. Recouvrir une image, c'est précisément ce que cette
  // règle interdit.
  const [done, setDone] = useState(() => imageShown || (clockKey ? introFinished(clockKey) : false));
  // Ce qui est montré, figé dès l'appui : un logo arrivé un instant plus tard avec la description du
  // fichier remplacerait le titre écrit en plein milieu de son apparition. Un relais (le lecteur serveur
  // après le natif) reprend ce que l'autre montrait, gardé avec l'horloge partagée.
  const [shown] = useState<Shown>(() => (clockKey ? introSnapshot<Shown>(clockKey) : undefined) ?? { art, name: fallbackName, caption });
  useEffect(() => {
    if (clockKey && !done) keepIntroSnapshot(clockKey, shown);
    // Une fois, au montage : c'est l'instant où l'ouverture paraît.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onShowRef = useRef(onShow);
  useEffect(() => {
    onShowRef.current = onShow;
  }, [onShow]);

  const backdropRef = useRef<HTMLDivElement>(null);
  const bgImgRef = useRef<HTMLImageElement>(null);
  const logoRef = useRef<HTMLDivElement>(null);
  const sweepRef = useRef<HTMLDivElement>(null);
  const sweepAnimRef = useRef<Animation | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const visible = !done && phase !== "gone";
  useEffect(() => {
    if (visible) onShowRef.current?.();
    // À l'apparition seulement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const display = shown;
  // Un logo qui ne se charge pas (hors ligne, adresse périmée) laissait l'icône d'image cassée au
  // milieu de l'écran, avec son texte de remplacement : le titre écrit prend sa place.
  const [logoFailed, setLogoFailed] = useState(false);
  const logo = logoFailed ? null : (display.art?.logoUrl ?? null);
  const bgSrc = introBackdropSrc(display.art?.backdropUrl, background);
  const blur = introBlur(background);

  // L'ouverture : le fond qui avance, le logo qui paraît, une lueur. Jouée une fois, depuis le point
  // où elle en est — l'appui d'ordinaire, plus loin pour un relais.
  useLayoutEffect(() => {
    if (!visible) return;
    const offset = Math.max(0, Date.now() - startedAt);
    const animations: Animation[] = [];
    const at = (a: Animation | undefined) => {
      if (!a) return undefined;
      a.currentTime = offset;
      animations.push(a);
      return a;
    };
    if (!reduced) {
      // Avance lente et continue, déjà en marche à la première image dessinée : la durée d'un
      // chargement n'est pas connue d'avance, on part donc sur six secondes, coupées par le fondu.
      at(backdropRef.current?.animate?.([{ transform: `scale(${zoom})` }, { transform: "scale(1)" }], {
        duration: 6000, easing: "cubic-bezier(0.25, 0.6, 0.3, 1)", fill: "both",
      }));
    }
    // Le logo dès l'appui, sans délai, et la ligne de chargement avec lui : posés en `logoMs`.
    at(logoRef.current?.animate?.(
      reduced
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [{ opacity: 0, transform: "scale(0.96)" }, { opacity: 1, transform: "scale(1)" }],
      { duration: reduced ? 200 : logoMs, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "both" }
    ));
    at(detailsRef.current?.animate?.([{ opacity: 0 }, { opacity: 1 }], {
      duration: reduced ? 200 : logoMs, easing: "ease-out", fill: "both",
    }));
    // La lueur, une fois le logo posé seulement — un logo qui brille en apparaissant se lit mal.
    if (sweep && !reduced && logo) {
      sweepAnimRef.current = at(sweepRef.current?.animate?.([{ transform: "translateX(-120%)" }, { transform: "translateX(120%)" }], {
        duration: 1100, delay: logoMs, easing: "cubic-bezier(0.45, 0, 0.25, 1)", fill: "both",
      })) ?? null;
    }
    return () => {
      for (const a of animations) a.cancel();
      sweepAnimRef.current = null;
    };
    // Une fois, à l'apparition : la suite (le fondu) a son propre effet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Le fond. Déjà décodé — le cas courant, demandé dès l'appui (`preloadIntroArt`) —, il est là à la
  // première image dessinée, sans fondu : un fondu laisserait voir le voile seul, puis l'image. Sinon
  // le voile attend seul, et l'image le rejoint en 250 ms (600 si elle a tardé). Dans un relais, il est
  // là tout de suite. Un échec laisse le voile — jamais le lecteur vide.
  useLayoutEffect(() => {
    const img = bgImgRef.current;
    if (!visible || !img || !bgSrc) return;
    const continuing = Date.now() - startedAt > 150;
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

  // Jusqu'au film qui bouge (`picture`), jamais un fondu sur une image figée — sauf une image décodée
  // qui ne part pas en `COVER_HOLD_MS`, un vrai blocage qui doit se voir.
  const [coverExpired, setCoverExpired] = useState(false);
  useEffect(() => {
    if (!visible || !imageShown || phase !== "waiting") return;
    const id = window.setTimeout(() => setCoverExpired(true), COVER_HOLD_MS);
    return () => window.clearTimeout(id);
  }, [visible, imageShown, phase]);

  // La fin : au film qui bouge, il « sort » de l'ouverture en un seul fondu de 280 ms, en décélérant,
  // déjà en mouvement — et l'ouverture est close pour cette lecture : un lecteur qui prendrait la
  // relève ne recouvrirait pas l'image. Puis le calque se retire.
  const fading = visible && (phase === "picture" || coverExpired);
  const covering = visible && !fading;
  const onCoverChangeRef = useRef(onCoverChange);
  useEffect(() => {
    onCoverChangeRef.current = onCoverChange;
  }, [onCoverChange]);
  useEffect(() => {
    onCoverChangeRef.current?.(covering);
  }, [covering]);
  // Démonté (erreur, mini-lecteur, fin du fondu) : plus rien ne couvre.
  useEffect(() => () => onCoverChangeRef.current?.(false), []);
  useLayoutEffect(() => {
    if (!fading) return;
    const d = reduced ? 200 : 280;
    if (clockKey) finishIntro(clockKey);
    // Le film parti avant que la lueur ait commencé : elle ne passera pas sur un logo qui s'efface.
    const sweepAnim = sweepAnimRef.current;
    if (sweepAnim && Date.now() - startedAt < logoMs) sweepAnim.cancel();
    rootRef.current?.animate?.([{ opacity: 1 }, { opacity: 0 }], {
      duration: d, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "both",
    });
    // Retiré au bout du fondu, par une minuterie et non par la fin de l'animation : un navigateur sans
    // `animate` (ou une animation annulée) ne doit pas laisser le calque posé sur le film.
    const id = window.setTimeout(() => setDone(true), d);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fading, reduced, clockKey]);

  if (!visible) return null;
  const name = display.art?.name ?? display.name;

  return (
    <div
      ref={rootRef}
      className={`overflow-hidden bg-black ${className}`}
      style={{ pointerEvents: "none", ...style }}
      data-playback-intro="intro"
    >
      {/* À l'échelle de départ du zoom dès le premier rendu : l'avance part de là, sans saut. */}
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
        <div ref={detailsRef} className="flex flex-col items-center gap-4" style={{ opacity: 0 }} data-playback-intro-details="">
          {display.caption.map((line) => (
            <p key={line} className="text-center text-sm font-medium text-muted sm:text-base">
              {line}
            </p>
          ))}
          {/* La ligne de chargement : une lueur qui passe, à la place de la roue. */}
          <div className="relative h-[2px] w-28 overflow-hidden rounded-full bg-white/15" data-playback-intro-line="">
            <div className={`absolute inset-y-0 w-1/2 rounded-full bg-gradient-to-r from-transparent via-white/90 to-transparent ${reduced ? "" : "playback-intro-line"}`} />
          </div>
          {note && <p className="text-xs text-subtle">{note}</p>}
        </div>
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
