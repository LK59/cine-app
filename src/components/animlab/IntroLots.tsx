"use client";

/* eslint-disable @next/next/no-img-element -- des `<img>` nus, voulus : le FLIP lit la place exacte de
   l'image, la lueur se découpe sur le logo par un masque, et les visuels sont déjà des tailles du CDN de
   TMDB — l'optimiseur de Next n'apporterait rien à ce banc d'essai. */

import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { ArrowLeft, Bookmark, Check, Play, Plus, RotateCcw, Video, X } from "lucide-react";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import { ImdbBadge } from "@/components/ImdbBadge";
import { CinemaLogo } from "@/components/cinema/CinemaLogo";
import { QualityBadges } from "@/components/cinema/QualityBadges";
import { CinemaTagline } from "@/components/cinema/CinemaDetailExtras";
import { BELOW_SECTION_CLASS, CAST_CLASS, CAST_SHOWN, COLUMN_GAP, COLUMN_STYLE, CinemaOverview, HORIZONTAL_VEIL, MENU_STYLE, SECTION_CLASS, VERTICAL_VEIL } from "@/components/cinema/CinemaDetailLayout";
import { MENU_BADGE, MENU_ROW, MENU_ROW_INACTIVE } from "@/components/cinema/detailMenu";
import { useT } from "@/components/TranslationProvider";
import { formatMinutes } from "@/lib/format";
import { genreLabel } from "@/lib/top10Label";
import { tmdbResize } from "@/lib/images";
import {
  CONTENT_OUT_MS,
  DIM,
  GHOST_FADE_MS,
  GHOST_SNAP_AT,
  HANDOVER_MS,
  HOME_SCALE,
  IDENTITY,
  PLAIN_OUT_DROP,
  PLAIN_OUT_MS,
  REVEAL_AT,
  REVEAL_MS,
  appleCloseMotion,
  appleOpenMotion,
  appleResponse,
  clamp,
  coverTf,
  criticalSpring,
  fixedMotion,
  lerp,
  lerpBox,
  lerpCorners,
  lerpTf,
  morphTracks,
  releaseVelocity,
  sampleMotion,
  smooth,
  timeAt,
  travelOf,
  uniformCorners,
  type Box,
  type Corners,
  type FixedEase,
  type MorphEngine,
  type Motion,
  type MotionProfile,
  type Pose,
} from "@/lib/sheetMorph/motion";
import { afterTwoFrames, clockNow, detectProfile, opacityNow, place, posterStyle, promote, scaleOf, startTogether, swallowStrayClick, translateYOf } from "@/lib/sheetMorph/dom";
import { PlaybackIntro } from "@/components/player/PlaybackIntro";
import { INTRO_BACKGROUNDS, PLAYBACK_INTRO, introBackdropSrc, type IntroBackground } from "@/lib/playbackIntro";
import { phoneSheetCorner } from "@/lib/sheetMotion";
import { NOT_THE_HANDLE, useSwipeToDismiss } from "@/lib/useSwipeToDismiss";
import { useTap } from "@/lib/useTap";

/**
 * Deux prototypes de la page « Tests animations » (10/10/2026), à juger sur l'iPhone et le Mac avant
 * d'en brancher quoi que ce soit : le lancement de la lecture, et l'ouverture d'une fiche.
 *
 * Rien ici ne touche au vrai lecteur ni aux vraies fiches. Comme le reste de la page, les textes sont
 * des notes en français, hors dictionnaires. Seules l'opacité et la transformation s'animent — ce
 * que le compositeur joue seul, sans le fil principal ; la découpe (`clip-path`), qui ne s'y joue
 * pas, n'anime plus que l'ancien moteur de l'ouverture de fiche, gardé pour comparer (sixième passe).
 *
 * Deuxième passe (10/10/2026), d'après les retours sur la première :
 * - G : « le flou basse résolution se voit » — le fond est maintenant un vrai visuel (1 280 px, ou
 *   l'original sur un grand écran dense), net ou adouci par un filtre posé sur une image *immobile*
 *   (seul son conteneur bouge). Le bogue de Safari du 09/10 tenait à un calque filtré dans une fiche
 *   qui défile, recouverte puis découverte : rien de tel ici, et l'ancien fond reste pour comparer.
 * - H : « mes fiches n'ont pas d'affiche mais une bannière et un logo » — les fiches simulées
 *   reprennent la mise en page des vraies (bureau : visuel plein écran, voiles, colonne ; téléphone :
 *   carte sous la barre d'état, bannière 16:9, logo qui chevauche), et c'est la carte touchée qui
 *   devient ce visuel.
 */

/* ─── Réglages partagés ─────────────────────────────────────────────────────── */

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-full text-xs font-medium uppercase tracking-wide text-subtle sm:w-40">{label}</span>
      {children}
    </div>
  );
}

function Chip({ on, onClick, children }: { on?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} className={`chip ${on ? "chip-on" : ""}`} onClick={onClick}>
      {children}
    </button>
  );
}

function Slider({ label, min, max, step, value, set }: { label: string; min: number; max: number; step: number; value: number; set: (v: number) => void }) {
  return (
    <label className="block text-xs text-muted">
      {label}
      <input type="range" className="mt-1 block w-full accent-accent-500" min={min} max={max} step={step} value={value} onChange={(e) => set(Number(e.target.value))} />
    </label>
  );
}

function prefersReduced(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Les titres du catalogue qui ont de quoi être montrés : visuel, affiche, et logo s'il existe. */
function usableTitles(movies: readonly CinemaMovie[]): { withLogo: CinemaMovie[]; withoutLogo: CinemaMovie | null } {
  const seen = new Set<number>();
  const withLogo: CinemaMovie[] = [];
  let withoutLogo: CinemaMovie | null = null;
  for (const m of movies) {
    if (seen.has(m.radarrId) || !m.backdropUrl || !m.posterUrl) continue;
    seen.add(m.radarrId);
    if (m.logoUrl) {
      if (withLogo.length < 12) withLogo.push(m);
    } else if (!withoutLogo) withoutLogo = m;
    if (withLogo.length >= 12 && withoutLogo) break;
  }
  return { withLogo, withoutLogo };
}

/* ─── Lot G : lancement de la lecture ──────────────────────────────────────── */

/*
 * En production depuis le 10/10/2026 (DECISIONS.md §60) : ce banc rend le composant du vrai lecteur,
 * `PlaybackIntro`, avec ses curseurs en plus. Les valeurs par défaut sont celles qui partent en
 * production (`PLAYBACK_INTRO`) — régler ici, c'est régler ce que voient les spectateurs une fois
 * reportées dans `src/lib/playbackIntro.ts`.
 */

type Caption = "none" | "episode" | "resume";

export function PlayerIntroLot({ movies }: { movies: readonly CinemaMovie[] }) {
  const { withLogo, withoutLogo } = useMemo(() => usableTitles(movies), [movies]);
  const choices = useMemo(() => (withoutLogo ? [...withLogo.slice(0, 6), withoutLogo] : withLogo.slice(0, 6)), [withLogo, withoutLogo]);
  const [pick, setPick] = useState(0);
  const [delay, setDelay] = useState(2000);
  const [threshold, setThreshold] = useState(PLAYBACK_INTRO.thresholdMs);
  const [zoom, setZoom] = useState(PLAYBACK_INTRO.zoom);
  const [logoMs, setLogoMs] = useState(PLAYBACK_INTRO.logoMs);
  const [sweep, setSweep] = useState(PLAYBACK_INTRO.sweep);
  const [caption, setCaption] = useState<Caption>("episode");
  const [reduced, setReduced] = useState(prefersReduced);
  const [bg, setBg] = useState<IntroBackground>(PLAYBACK_INTRO.background);
  const [brightness, setBrightness] = useState(PLAYBACK_INTRO.brightness);
  const [run, setRun] = useState(0);
  const title = choices.length > 0 ? choices[Math.min(pick, choices.length - 1)] : null;

  // Le fond demandé d'avance, dès qu'il est choisi : à « Lancer », il est d'ordinaire déjà en cache.
  useEffect(() => {
    if (!title?.backdropUrl) return;
    const img = new Image();
    img.src = introBackdropSrc(title.backdropUrl, bg);
  }, [title, bg]);

  return (
    <section className="space-y-4 rounded-2xl border border-white/8 bg-white/[0.03] p-4">
      <p className="text-sm text-muted">
        {"Ce qu'on verrait entre l'appui sur « Lire » et la première image : le visuel du film qui avance lentement, son logo qui apparaît avec une lueur, une ligne de chargement, puis un fondu enchaîné vers la « vidéo » (ici le visuel net). « Fond » compare la qualité du visuel : 1 280 px (l'original sur un grand écran dense), net ou adouci, et l'ancien 300 px agrandi. « Délai simulé » joue le temps que met le vrai lecteur ; sous le seuil de passage direct, il n'y a pas d'ouverture du tout."}
      </p>
      <Row label="Titre">
        {choices.length === 0 && <span className="text-sm text-subtle">Chargement du catalogue…</span>}
        {choices.map((m, i) => (
          <Chip key={m.radarrId} on={i === pick} onClick={() => setPick(i)}>
            {m.title}
            {!m.logoUrl ? " (sans logo)" : ""}
          </Chip>
        ))}
      </Row>
      <Row label="Fond">
        {INTRO_BACKGROUNDS.map((m) => (
          <Chip key={m.id} on={bg === m.id} onClick={() => setBg(m.id)}>
            {m.label}
          </Chip>
        ))}
      </Row>
      <Row label="Délai simulé">
        {[200, 1000, 2000, 4000].map((ms) => (
          <Chip key={ms} on={delay === ms} onClick={() => setDelay(ms)}>
            {(ms / 1000).toLocaleString("fr-FR")} s
          </Chip>
        ))}
      </Row>
      <div className="grid gap-3 sm:grid-cols-2">
        <Slider label={`Délai sur mesure ${(delay / 1000).toFixed(1)} s`} min={0} max={8000} step={100} value={delay} set={setDelay} />
        <Slider label={`Seuil de passage direct ${threshold} ms`} min={0} max={1000} step={50} value={threshold} set={setThreshold} />
        <Slider label={`Zoom du fond ${zoom.toFixed(2)} → 1,00`} min={1} max={1.2} step={0.01} value={zoom} set={setZoom} />
        <Slider label={`Apparition du logo ${logoMs} ms`} min={200} max={1500} step={50} value={logoMs} set={setLogoMs} />
        <Slider
          label={`Luminosité du fond ${brightness > 0 ? "+" : ""}${brightness} %${brightness === 0 ? " (voile d'origine)" : ""}`}
          min={-30} max={40} step={5} value={brightness} set={setBrightness}
        />
      </div>
      <Row label="Légende">
        <Chip on={caption === "none"} onClick={() => setCaption("none")}>Aucune</Chip>
        <Chip on={caption === "episode"} onClick={() => setCaption("episode")}>Épisode</Chip>
        <Chip on={caption === "resume"} onClick={() => setCaption("resume")}>Reprise</Chip>
      </Row>
      <Row label="Options">
        <Chip on={sweep} onClick={() => setSweep(!sweep)}>Lueur sur le logo</Chip>
        <Chip on={reduced} onClick={() => setReduced(!reduced)}>« Réduire les animations »</Chip>
      </Row>
      <button type="button" className="btn-primary inline-flex items-center gap-2" disabled={!title} onClick={() => setRun((n) => n + 1)}>
        <Play size={16} /> Lancer
      </button>
      {run > 0 &&
        title &&
        createPortal(
          <IntroStage
            key={run}
            title={title}
            delay={delay}
            threshold={threshold}
            zoom={zoom}
            logoMs={logoMs}
            sweep={sweep}
            caption={caption}
            reduced={reduced}
            bg={bg}
            brightness={brightness}
            onReplay={() => setRun((n) => n + 1)}
            onClose={() => setRun(0)}
          />,
          document.body,
        )}
    </section>
  );
}

function captionLines(caption: Caption): string[] {
  if (caption === "episode") return ["S1 · É3 · Le Fil de l'histoire"];
  if (caption === "resume") return ["Reprise à 1 h 12"];
  return [];
}

function IntroStage({
  title, delay, threshold, zoom, logoMs, sweep, caption, reduced, bg, brightness, onReplay, onClose,
}: {
  title: CinemaMovie;
  delay: number;
  threshold: number;
  zoom: number;
  logoMs: number;
  sweep: boolean;
  caption: Caption;
  reduced: boolean;
  bg: IntroBackground;
  brightness: number;
  onReplay: () => void;
  onClose: () => void;
}) {
  // Le « délai simulé » tient lieu du vrai lecteur : la première image arrive au bout de lui.
  const [startedAt] = useState(() => Date.now());
  const [pictured, setPictured] = useState(false);
  const direct = delay < threshold;
  const videoRef = useRef<HTMLDivElement>(null);
  const full = tmdbResize(title.backdropUrl, "w1280") ?? title.backdropUrl ?? "";

  useEffect(() => {
    const id = window.setTimeout(() => setPictured(true), delay);
    return () => window.clearTimeout(id);
  }, [delay]);

  // La « vidéo » paraît comme celle du lecteur natif : en fondu, sous l'ouverture qui s'efface.
  useLayoutEffect(() => {
    if (!pictured) return;
    videoRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: direct ? 160 : reduced ? 200 : 400, easing: "ease-out", fill: "both" });
  }, [pictured, direct, reduced]);

  return (
    <div className="fixed inset-0 z-[100] overflow-hidden bg-black" style={{ pointerEvents: "none" }}>
      <div ref={videoRef} className="absolute inset-0" style={{ opacity: 0 }}>
        <img src={full} alt="" className="h-full w-full object-cover" />
        <div className="absolute bottom-4 left-5 text-xs font-medium text-white/70">{direct ? "Passage direct (sous le seuil)" : "Première image"}</div>
      </div>

      <PlaybackIntro
        phase={pictured ? "picture" : "waiting"}
        startedAt={startedAt}
        art={{ name: title.title, backdropUrl: title.backdropUrl, logoUrl: title.logoUrl }}
        fallbackName={title.title}
        caption={captionLines(caption)}
        settings={{ thresholdMs: threshold, zoom, logoMs, sweep, background: bg, brightness }}
        reduced={reduced}
      />

      <div className="absolute left-4 top-4 flex gap-2" style={{ pointerEvents: "auto" }}>
        <button type="button" onClick={onClose} aria-label="Fermer" className="nav-glass flex h-10 w-10 items-center justify-center rounded-full text-white">
          <X size={18} />
        </button>
        <button type="button" onClick={onReplay} className="nav-glass flex h-10 items-center gap-2 rounded-full px-4 text-sm text-white">
          <RotateCcw size={16} /> Rejouer
        </button>
      </div>
    </div>
  );
}

/* ─── Lot H : ouverture de fiche ───────────────────────────────────────────── */

type Ease = FixedEase;
type Layout = "auto" | "desktop" | "phone";
/*
 * Le FLIP, ou un fondu sous « Réduire les animations ». Les View Transitions ont été retirées à la
 * quatrième passe (10/10/2026) : à l'ouverture, le navigateur photographie la fiche avant que son
 * visuel soit décodé — une boîte vide qui grandit, le contenu posé d'un coup, « l'ouverture ne
 * marche pas, seulement la fermeture » —, les arrondis ne s'y animent pas, et rien ne permet d'y
 * reprendre un glissement du doigt là où il s'arrête. Le FLIP fait tout cela, partout.
 */
type Mode = "flip" | "fade";
/** Une place dans la scène, en pixels depuis son coin haut gauche. */

/**
 * Ce que la fiche doit savoir de la carte touchée pour en partir, et pour y revenir. `outside` : un
 * titre hors bibliothèque, ouvert dans la variante de la fiche découverte (« Demander » au lieu de
 * « Lire »), comme PlayerDiscoverSheet.
 */
type Opening = {
  title: CinemaMovie;
  key: string;
  poster: string;
  radius: number;
  mode: Mode;
  outside?: boolean;
  /**
   * Ouverte pendant qu'une autre fiche se refermait (huitième passe) : l'assombrissement et le recul
   * de l'accueil où cette fermeture les avait laissés — la nouvelle les reprend de là, sans éclair.
   */
  dimFrom?: number;
  homeFrom?: number;
};
type OpenTitle = (o: Omit<Opening, "mode" | "dimFrom" | "homeFrom">) => void;
/**
 * Ce que la scène peut demander à une fiche qui se referme (huitième passe) : s'effacer tout de suite
 * pour laisser la place à une autre ouverture (en rendant où en étaient l'assombrissement et
 * l'accueil), ou — pour une fiche de titre dont on retouche l'affiche — se rouvrir d'où elle en est.
 * `reverse` répond faux quand il est trop tard (le relais final a commencé).
 */
type SheetHandle = { interrupt: () => { dim: number; home: number }; reverse?: () => boolean; key?: string };
type Register = (key: string) => (el: HTMLElement | null) => void;
/**
 * Une entrée de la pile des fiches (cinquième passe) : une fiche de titre, ou celle d'une personne.
 * La pile se lit comme la vraie : chaque fiche couvre celle d'en dessous sans la remplacer, et seule
 * celle du dessus écoute (« a screen on its way out has no opinion »).
 */
type Entry = { id: number; kind: "title"; opening: Opening } | { id: number; kind: "person"; name: string };

// Les largeurs des vraies cartes : `CARD_WIDTH` de CinemaClient, `POSTER_WIDTH` de CinemaMobileClient,
// et celle des affiches de CinemaCollectionRow dans une fiche.
const CARD_WIDTH = "w-24 sm:w-28 md:w-32 lg:w-36";
const PHONE_POSTER_WIDTH = "w-28 sm:w-32";
const SHEET_POSTER_WIDTH = "w-24 sm:w-28 md:w-32";
/*
 * Le contenu de la fiche (cinquième passe) : d'un seul bloc par défaut — opacité et 8 px de montée,
 * en 160 ms depuis la huitième passe (220 avant) —, lancé à 60 % du trajet pour arriver avec la bannière. La cascade d'avant (logo, puis
 * infos, puis « Lire », puis le synopsis) se lisait « une chose après l'autre, pas tout à fait
 * fluide » sur l'iPhone. Elle reste en option, resserrée : 15 ms par ligne, 150 ms en tout au plus.
 */
const CASCADE_STEP_MS = 15;
const CASCADE_TOTAL_MS = 150;
// Le téléphone simulé quand la disposition « Téléphone » est demandée sur un grand écran.
const PHONE_FRAME = { w: 390, h: 844, statusBar: 47 };

/* ─── Le mouvement (sixième passe, 10/10/2026) ────────────────────────────────
 *
 * « Légèrement moins fluide que le reste de l'app ou de l'iPhone. » Deux causes, corrigées ici :
 *
 * 1. Le fil principal menait une partie du trajet. La découpe (`clip-path`) qui faisait grandir la
 *    carte ne s'anime sur le compositeur ni dans WebKit ni dans Chromium : chaque image passait par
 *    le fil principal, pendant que les images, elles, glissaient sur le compositeur — et la fermeture
 *    démarrait au moment même où React redessinait la fiche. Une fenêtre qui retarde d'une image sur
 *    son contenu, c'est exactement « un peu moins fluide » sans qu'on sache dire où. Le trajet est
 *    maintenant une fenêtre transformée (translation et échelle non uniforme, `overflow: hidden`),
 *    dont le contenu est contre-transformé image clé par image clé : transformations et opacités
 *    seulement, échantillonnées une fois au départ (≥ 60 images clés interpolées linéairement — ce
 *    que tout compositeur joue), calques promus avant le départ, départ commun deux images après le
 *    montage et le décodage des images. L'ancien moteur reste à comparer.
 * 2. Le rythme n'était pas celui d'iOS. Par défaut, celui d'UIKit et de SwiftUI : un ressort amorti
 *    critique (aucun rebond) dont la réponse suit la distance parcourue, rapportée à la diagonale de
 *    l'écran — 0,22 s pour un petit trajet, 0,34 s pour l'écran entier depuis la huitième passe
 *    (0,32 → 0,5 avant), 20 % plus vif sur un ordinateur (macOS l'est plus qu'iOS) — et une
 *    fermeture au même ressort, 0,7 fois plus vive.
 *    La durée n'est plus une consigne : c'est le temps qu'il met à se poser à 0,5 px près, affiché
 *    dans la maquette pour chaque appui. Une fermeture reprend la vitesse de ce qui l'a lancée :
 *    celle du doigt qui lâche la fiche, ou celle de l'ouverture qu'elle interrompt.
 */

/*
 * Le moteur du trajet, son rythme et ses outils sont ceux des vraies fiches depuis leur passage en
 * production (DECISIONS.md §61, `src/lib/sheetMorph/`) : ce qui est réglé ici est ce qui tourne là-bas.
 * La maquette ne garde que ce qui n'est qu'à elle — sa scène simulée, l'ancien moteur (`clip`) et les
 * durées fixes, pour comparer.
 */
/** Le rythme : le ressort d'iOS selon la distance, ou des durées fixes sur une courbe choisie. */
type PaceMode = "apple" | "fixed";
type Engine = MorphEngine;
type Profile = MotionProfile;
type Pace = { mode: PaceMode; ease: Ease; openMs: number; closeMs: number; engine: Engine; profile: Profile };

/** `v0` : une fermeture retournée en ouverture garde sa vitesse (négative : elle allait encore vers l'affiche). */
function openMotion(pace: Pace, from: Box, to: Box, stage: { W: number; H: number }, v0 = 0): Motion {
  return pace.mode === "fixed" ? fixedMotion(pace.ease, pace.openMs) : appleOpenMotion(from, to, stage, pace.profile, v0);
}

function closeMotion(pace: Pace, from: Box, to: Box, stage: { W: number; H: number }, v0: number): Motion {
  return pace.mode === "fixed" ? fixedMotion(pace.ease, pace.closeMs) : appleCloseMotion(from, to, stage, pace.profile, v0);
}

/** Les fonctions pures du mouvement, pour les tests : le ressort, sa réponse selon l'appareil, la vitesse du doigt. */
export const sheetMotionForTests = { criticalSpring, appleResponse, openMotion, closeMotion, releaseVelocity, sampleMotion, timeAt, REVEAL_AT };

// Les fiches d'une personne : une montée simple, sans trajet ni ressort à régler.
const PERSON_RISE = { duration: 300, easing: "cubic-bezier(0.32, 0.72, 0, 1)" };

/**
 * Une affiche de la maquette, servie au relâchement du doigt comme les cartes de la vraie appli
 * (`useTap`, neuvième passe).
 *
 * Servie au `click`, une affiche retouchée juste après une fermeture demandait parfois deux appuis
 * sur iPhone, et une affiche d'une fiche déjà ouverte puis refermée semblait « en recharge » une
 * seconde ou deux : iOS garde le premier `click` quand il croit que l'appui a révélé du contenu ou
 * qu'il arrête un élan de défilement — deux choses qu'une fermeture en vol provoque. Le relâchement,
 * lui, arrive toujours. Le `click` reste là pour le clavier et la souris.
 */
function MockPoster({ k, register, hidden, onOpen, className, children }: {
  k: string;
  register: Register;
  hidden: boolean;
  onOpen: () => void;
  className: string;
  children: ReactNode;
}) {
  const tap = useTap(onOpen);
  return (
    <button ref={register(k)} type="button" {...tap} className={className} style={posterStyle(hidden)}>
      {children}
    </button>
  );
}

function boxIn(el: Element, root: DOMRect): Box {
  const r = el.getBoundingClientRect();
  return { x: r.left - root.left, y: r.top - root.top, w: r.width, h: r.height };
}

/**
 * L'affiche d'origine est-elle encore à l'écran ? Au moins la moitié de sa surface dans la scène et
 * dans chaque conteneur qui défile autour d'elle (`data-alab-scroll` : la fiche, sa rangée) — une
 * affiche sortie de sa rangée ou de la fiche défilée ne reçoit pas de trajet de retour.
 */
function sourceOnScreen(src: HTMLElement, root: HTMLElement): boolean {
  const r = src.getBoundingClientRect();
  const area = r.width * r.height;
  if (area <= 0) return false;
  let box = { l: r.left, t: r.top, r: r.right, b: r.bottom };
  const clip = (c: DOMRect) => {
    box = { l: Math.max(box.l, c.left), t: Math.max(box.t, c.top), r: Math.min(box.r, c.right), b: Math.min(box.b, c.bottom) };
  };
  clip(root.getBoundingClientRect());
  for (let el = src.parentElement?.closest<HTMLElement>("[data-alab-scroll]"); el; el = el.parentElement?.closest<HTMLElement>("[data-alab-scroll]") ?? null) {
    clip(el.getBoundingClientRect());
  }
  return Math.max(0, box.r - box.l) * Math.max(0, box.b - box.t) >= area / 2;
}

const PROFILE_LABEL: Record<Profile, string> = { phone: "Téléphone", ipad: "iPad", desktop: "Ordinateur" };

export function SheetOpenLot({ movies }: { movies: readonly CinemaMovie[] }) {
  const { withLogo } = useMemo(() => usableTitles(movies), [movies]);
  // Sixième passe : le rythme d'iOS par défaut — un ressort amorti critique selon la distance.
  const [paceMode, setPaceMode] = useState<PaceMode>("apple");
  const [ease, setEase] = useState<Ease>("spring");
  // Les durées fixes, pour comparer : la fermeture plus vive que l'ouverture, comme partout.
  const [openMs, setOpenMs] = useState(220);
  const [closeMs, setCloseMs] = useState(180);
  const [engine, setEngine] = useState<Engine>("transform");
  const [profileChoice, setProfileChoice] = useState<"auto" | Profile>("auto");
  const [detected] = useState(detectProfile);
  // D'un seul bloc par défaut (cinquième passe) ; la cascade, resserrée, reste à comparer.
  const [stagger, setStagger] = useState(false);
  const [layout, setLayout] = useState<Layout>("auto");
  const [reduced, setReduced] = useState(prefersReduced);
  const [staged, setStaged] = useState(false);
  const profile = profileChoice === "auto" ? detected : profileChoice;
  const pace = useMemo<Pace>(() => ({ mode: paceMode, ease, openMs, closeMs, engine, profile }), [paceMode, ease, openMs, closeMs, engine, profile]);

  return (
    <section className="space-y-4 rounded-2xl border border-white/8 bg-white/[0.03] p-4">
      <p className="text-sm text-muted">
        {"Une maquette de l'accueil et des vraies fiches — visuel et logo, pas d'affiche. Au bureau, l'affiche touchée s'agrandit jusqu'à l'écran entier en devenant le visuel du film ; au téléphone, elle devient la bannière 16:9 pendant que la carte monte du bas. Le contenu arrive d'un seul bloc avec la bannière. Dans la fiche, « Dans la même saga » ouvre une fiche par-dessus (la dernière affiche est hors bibliothèque : variante « Demander »), et un nom de la distribution ouvre la fiche de la personne — d'où l'on peut rouvrir un film, à n'importe quelle profondeur. Fermer (Retour, la croix, Échap, ou la fiche tirée vers le bas au doigt) ne ferme que la fiche du dessus, et revient dans l'affiche d'où elle est partie si elle est encore à l'écran."}
      </p>
      <Row label="Rythme">
        <Chip on={paceMode === "apple"} onClick={() => setPaceMode("apple")}>Apple — ressort selon la distance</Chip>
        <Chip on={paceMode === "fixed"} onClick={() => setPaceMode("fixed")}>Durée fixe</Chip>
      </Row>
      <p className="text-xs leading-5 text-subtle">
        {paceMode === "apple"
          ? "Par défaut, le ressort d'UIKit et de SwiftUI : amorti critique (aucun rebond), l'essentiel du trajet dans les premiers 40 %. Sa réponse suit la distance parcourue, rapportée à la diagonale de l'écran — 0,22 s pour un petit trajet, 0,34 s pour l'écran entier —, 20 % plus vive sur un ordinateur ; la fermeture prend le même ressort, 0,7 fois plus vif, et repart à la vitesse du doigt qui lâche la fiche ou de l'ouverture qu'elle interrompt. Comme sur iOS, une fermeture n'empêche rien : l'accueil répond dès qu'elle commence, une autre affiche s'ouvre aussitôt, et toucher l'affiche vers laquelle la fiche revient la rouvre d'où elle en est. La durée affichée dans la maquette est le temps réel pour se poser à 0,5 px près."
          : "Une durée imposée sur l'une des trois courbes : la même pour tous les trajets, et sans reprise de vitesse."}
      </p>
      {paceMode === "fixed" && (
        <>
          <Row label="Courbe">
            <Chip on={ease === "spring"} onClick={() => setEase("spring")}>Ressort Apple</Chip>
            <Chip on={ease === "emphasized"} onClick={() => setEase("emphasized")}>Accentuée</Chip>
            <Chip on={ease === "easeOut"} onClick={() => setEase("easeOut")}>Décélération douce</Chip>
          </Row>
          <p className="text-xs leading-5 text-subtle">
            {"Ressort Apple : un ressort physique (amortissement 0,86, dépassement d'environ 1 %), étiré sur la durée choisie. Accentuée : la décélération « emphasized » de Material 3, cubic-bezier(0.2, 0, 0, 1) — départ très vif, longue arrivée lente. Décélération douce : ease-out cubique, cubic-bezier(0.33, 1, 0.68, 1) — départ plus tranquille. Toutes trois freinent à l'arrivée : sur un trajet court elles se ressemblent ; au ralenti, la différence se voit au départ."}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Slider label={`Ouverture ${openMs} ms`} min={150} max={600} step={10} value={openMs} set={setOpenMs} />
            <Slider label={`Fermeture ${closeMs} ms`} min={120} max={500} step={10} value={closeMs} set={setCloseMs} />
          </div>
        </>
      )}
      <Row label="Profil">
        <Chip on={profileChoice === "auto"} onClick={() => setProfileChoice("auto")}>Auto (détecté : {PROFILE_LABEL[detected]})</Chip>
        <Chip on={profileChoice === "phone"} onClick={() => setProfileChoice("phone")}>Téléphone (tactile)</Chip>
        <Chip on={profileChoice === "ipad"} onClick={() => setProfileChoice("ipad")}>iPad</Chip>
        <Chip on={profileChoice === "desktop"} onClick={() => setProfileChoice("desktop")}>Ordinateur</Chip>
      </Row>
      <p className="text-xs leading-5 text-subtle">
        {"Le profil règle le ressort et les gestes, la disposition suit l'écran comme dans la vraie app. Téléphone et iPad : le ressort d'iOS, la fiche se tire vers le bas au doigt (au bureau, l'iPad la tire par sa poignée du haut, comme la vraie fiche large sur tablette). Ordinateur : 20 % plus vif, pas de geste — Retour, la croix ou Échap refont le chemin ; ouverte au clavier (Entrée sur une affiche), la fiche rend le focus à son affiche en se fermant."}
      </p>
      <Row label="Moteur">
        <Chip on={engine === "transform"} onClick={() => setEngine("transform")}>Transform (compositeur)</Chip>
        <Chip on={engine === "clip"} onClick={() => setEngine("clip")}>clip-path (ancien)</Chip>
      </Row>
      <Row label="Disposition">
        <Chip on={layout === "auto"} onClick={() => setLayout("auto")}>Selon l&apos;écran</Chip>
        <Chip on={layout === "desktop"} onClick={() => setLayout("desktop")}>Bureau</Chip>
        <Chip on={layout === "phone"} onClick={() => setLayout("phone")}>Téléphone</Chip>
      </Row>
      <Row label="Options">
        <Chip on={stagger} onClick={() => setStagger(!stagger)}>Cascade du contenu</Chip>
        <Chip on={reduced} onClick={() => setReduced(!reduced)}>« Réduire les animations »</Chip>
      </Row>
      <button type="button" className="btn-primary inline-flex items-center gap-2" disabled={withLogo.length === 0} onClick={() => setStaged(true)}>
        <Play size={16} /> {withLogo.length === 0 ? "Chargement du catalogue…" : "Ouvrir la maquette"}
      </button>
      {staged &&
        createPortal(
          <SheetStage
            titles={withLogo}
            pace={pace}
            profileAuto={profileChoice === "auto"}
            stagger={stagger}
            layout={layout}
            reduced={reduced}
            onExit={() => setStaged(false)}
          />,
          document.body,
        )}
    </section>
  );
}

/** La ligne de la maquette qui dit le profil et ce qu'ont réellement duré le dernier aller et le dernier retour. */
function readoutText(pace: Pace, auto: boolean, last: { open?: Motion; close?: Motion }, compact = false): string {
  // Dans la pilule du téléphone, sans le détail de la courbe : deux lignes au plus.
  const how = (m: Motion) => (compact ? "" : ` (${m.label})`);
  const parts = [`${compact ? "" : "Profil : "}${PROFILE_LABEL[pace.profile]}${auto ? " (détecté)" : ""}`];
  if (last.open) parts.push(`ouverture ${Math.round(last.open.duration)} ms${how(last.open)}`);
  if (last.close) parts.push(`fermeture ${Math.round(last.close.duration)} ms${how(last.close)}`);
  return parts.join(" · ");
}

/** Ce que chaque fiche de la pile reçoit de la scène. */
type SheetCommon = {
  depth: number;
  /** Une fiche au-dessus d'elle : rendue, assombrie, inerte — sans touche ni pointeur. */
  covered: boolean;
  phone: boolean;
  framed: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
  sources: RefObject<Map<string, HTMLElement>>;
  pace: Pace;
  /** Écrit dans la maquette ce qu'a duré un trajet — à son arrivée, jamais pendant. */
  report: (kind: "open" | "close", motion: Motion) => void;
  /** La clé de l'affiche d'où part la fiche au-dessus, cachée le temps qu'elle soit ouverte. */
  hiddenKey: string | null;
  register: Register;
  /** Les titres de ses rangées (saga, filmographie). */
  related: CinemaMovie[];
  onOpenTitle: OpenTitle;
  onOpenPerson: (name: string) => void;
  /**
   * La fermeture commence. Depuis la huitième passe, elle n'empêche plus rien : la fiche cesse de
   * compter dans la pile (celle d'en dessous redevient celle du dessus, l'accueil répond), et son
   * calque finit son retour par-dessus, sans pointeur.
   */
  onCloseStart: () => void;
  /** Une fermeture retournée en ouverture : la fiche compte de nouveau. */
  onReopen: () => void;
  onClosed: () => void;
  /** Ce que la scène peut demander à la fiche pendant sa fermeture — voir `SheetHandle`. */
  bindHandle: (handle: SheetHandle | null) => void;
};

function SheetStage({
  titles, pace, profileAuto, stagger, layout, reduced, onExit,
}: {
  titles: CinemaMovie[];
  pace: Pace;
  profileAuto: boolean;
  stagger: boolean;
  layout: Layout;
  reduced: boolean;
  onExit: () => void;
}) {
  // Lu une fois, à l'ouverture de la maquette : la disposition ne change pas sous les yeux.
  const [narrow] = useState(() => window.innerWidth < 768);
  const phone = layout === "phone" || (layout === "auto" && narrow);
  // Un téléphone demandé sur un grand écran se dessine dans un cadre à sa taille.
  const framed = phone && !narrow;
  const rootRef = useRef<HTMLDivElement>(null);
  const sources = useRef(new Map<string, HTMLElement>());
  const [stack, setStack] = useState<Entry[]>([]);
  const nextId = useRef(1);
  /*
   * Les fiches qui se referment. Jusqu'à la septième passe, un appui pendant l'une d'elles n'ouvrait
   * rien, le temps que le retour se pose — « je ne peux pas ouvrir une autre fiche tant que
   * l'animation n'est pas finie » (Louis, 10/10/2026). Comme sur iOS, une fermeture n'est plus
   * qu'un calque qui finit son chemin : elle ne couvre plus rien, et une ouverture la coupe.
   */
  const [closing, setClosing] = useState<ReadonlySet<number>>(() => new Set());
  const handles = useRef(new Map<number, SheetHandle>());
  // La ligne des durées : écrite directement dans le DOM à l'arrivée d'un trajet, sans rendu de
  // React — rien ne doit redessiner la scène pendant ou juste après un mouvement.
  const readoutRef = useRef<HTMLSpanElement>(null);
  const lastMotion = useRef<{ open?: Motion; close?: Motion }>({});
  const report = (kind: "open" | "close", motion: Motion) => {
    lastMotion.current[kind] = motion;
    if (readoutRef.current) readoutRef.current.textContent = readoutText(pace, profileAuto, lastMotion.current, phone);
  };
  // `phone` aussi : la ligne change d'élément avec la disposition (pilule ou coin), et le nouveau
  // naît vide.
  useLayoutEffect(() => {
    if (readoutRef.current) readoutRef.current.textContent = readoutText(pace, profileAuto, lastMotion.current, phone);
  }, [pace, profileAuto, phone]);

  // Les visuels demandés dès l'ouverture de la maquette : sans eux, le calque du trajet grandissait
  // sur un visuel pas encore arrivé, et l'affiche s'effaçait sur du vide.
  useEffect(() => {
    for (const m of titles) {
      if (!m.backdropUrl) continue;
      const img = new Image();
      img.src = m.backdropUrl;
    }
  }, [titles]);

  const register: Register = (key) => (el) => {
    if (el) sources.current.set(key, el);
    else sources.current.delete(key);
  };

  // La pile telle qu'elle compte : sans les fiches qui se referment.
  const live = stack.filter((e) => !closing.has(e.id));

  /**
   * Avant une ouverture, les fermetures en cours. Celle qui revient vers l'affiche touchée se rouvre
   * d'où elle en est (même instance, même vitesse) ; les autres s'effacent tout de suite, et la
   * nouvelle fiche reprend leur assombrissement là où il en était. `reopened` : une fiche a été
   * rouverte — il n'y a alors rien d'autre à ouvrir.
   */
  const settleClosings = (key: string | null): { reopened: boolean; dim?: number; home?: number } => {
    let dim: number | undefined;
    let home: number | undefined;
    let reopened = false;
    for (const e of stack) {
      if (!closing.has(e.id)) continue;
      const h = handles.current.get(e.id);
      if (!h) continue;
      if (!reopened && key !== null && h.key === key && h.reverse?.()) {
        reopened = true;
        continue;
      }
      const left = h.interrupt();
      dim = Math.max(dim ?? 0, left.dim);
      home = home === undefined ? left.home : Math.min(home, left.home);
    }
    return { reopened, dim, home };
  };

  const openTitle: OpenTitle = (o) => {
    const top = live[live.length - 1];
    // Une affiche qui est le titre même de la fiche du dessus ne la rouvre pas par-dessus elle.
    if (top?.kind === "title" && top.opening.title.radarrId === o.title.radarrId && !!top.opening.outside === !!o.outside) return;
    const left = settleClosings(o.key);
    if (left.reopened) return;
    const el = sources.current.get(o.key);
    const entry: Entry = {
      id: nextId.current++,
      kind: "title",
      opening: { ...o, mode: reduced || !el ? "fade" : "flip", dimFrom: left.dim, homeFrom: left.home },
    };
    setStack((s) => [...s, entry]);
  };
  const openPerson = (name: string) => {
    settleClosings(null);
    const entry: Entry = { id: nextId.current++, kind: "person", name };
    setStack((s) => [...s, entry]);
  };
  const closeStart = (id: number) => setClosing((c) => new Set(c).add(id));
  const reopen = (id: number) =>
    setClosing((c) => {
      const n = new Set(c);
      n.delete(id);
      return n;
    });
  // Appelée par une fiche une fois sa sortie jouée (ou coupée) : elle seule quitte la pile, par son identité.
  const closed = (id: number) => {
    handles.current.delete(id);
    setClosing((c) => {
      if (!c.has(id)) return c;
      const n = new Set(c);
      n.delete(id);
      return n;
    });
    setStack((s) => s.filter((e) => e.id !== id));
  };

  const keyOf = (e: Entry | undefined) => (e?.kind === "title" ? e.opening.key : null);
  // Une fiche couverte : quelqu'un au-dessus d'elle compte encore — une fiche qui se referme ne couvre plus rien.
  const coveredAt = (i: number) => stack.slice(i + 1).some((e) => !closing.has(e.id));
  /**
   * L'affiche cachée d'un niveau (−1 : l'accueil) : celle de la fiche ouverte depuis lui qui compte,
   * sinon celle de la fiche qui y revient. Le parent d'une fiche est la dernière fiche vivante sous
   * elle — une fermeture et l'ouverture qui la coupe partent du même niveau. Passer de l'une à
   * l'autre rend aussitôt la première affiche visible : c'est ce que veut la coupure.
   */
  const hiddenAt = (level: number): string | null => {
    let lastLive = -1;
    let hidden: string | null = null;
    let liveChild = false;
    stack.forEach((e, j) => {
      if (lastLive === level && !liveChild) {
        const k = keyOf(e);
        if (!closing.has(e.id)) {
          liveChild = true;
          hidden = k;
        } else if (k !== null) hidden = k;
      }
      if (!closing.has(e.id)) lastLive = j;
    });
    return hidden;
  };
  const empty = stack.length === 0;
  useEffect(() => {
    if (!empty) return; // Échap ferme d'abord la fiche du dessus, qui l'écoute elle-même
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [empty, onExit]);

  /** Les titres d'une fiche : les autres du catalogue, décalés selon la profondeur pour varier. */
  const relatedFor = (exclude: number | null, depth: number) => {
    const others = titles.filter((m) => m.radarrId !== exclude);
    const shift = others.length ? (depth * 2) % others.length : 0;
    return others.slice(shift).concat(others.slice(0, shift)).slice(0, 7);
  };

  const content = (
    <>
      {phone ? (
        <PhoneHome titles={titles} framed={framed} hiddenKey={hiddenAt(-1)} register={register} onOpen={openTitle} />
      ) : (
        <DesktopHome titles={titles} hiddenKey={hiddenAt(-1)} register={register} onOpen={openTitle} />
      )}
      {/* En haut à droite, la pilule tombait sur la croix de la fiche du téléphone : elle descend
          au milieu du bas, là où ni l'accueil ni la fiche simulés n'ont de commande. Pleine et non
          en verre (sixième passe) : un `backdrop-filter` au-dessus d'un calque qui bouge se
          recalcule à chaque image. */}
      {/* Au téléphone, la ligne des mesures loge dans la pilule, en seconde ligne (septième passe) :
          posée au-dessus, elle tombait sur le synopsis de la fiche. Au bureau, le coin bas gauche
          est libre — ni l'accueil ni la fiche n'y ont rien. */}
      <button
        type="button"
        onClick={onExit}
        className={`absolute z-30 flex flex-col items-center rounded-2xl bg-zinc-900/90 px-3 py-2 text-xs text-white ring-1 ring-white/15 ${phone ? "left-1/2 max-w-[calc(100%-2rem)] -translate-x-1/2" : "right-4"}`}
        style={phone ? { bottom: framed ? 20 : "max(1rem, env(safe-area-inset-bottom))" } : { top: "max(1rem, env(safe-area-inset-top))" }}
      >
        <span className="flex items-center gap-2">
          <X size={14} /> Quitter la maquette
        </span>
        {phone && <span ref={readoutRef} data-alab-readout aria-live="polite" className="mt-0.5 block text-center text-[10px] leading-[14px] text-white/65 empty:hidden" />}
      </button>
      {!phone && (
        <span
          ref={readoutRef}
          data-alab-readout
          aria-live="polite"
          className="pointer-events-none absolute bottom-4 left-4 z-30 max-w-[calc(100%-2rem)] rounded-md bg-black/70 px-2 py-1 text-[11px] leading-4 text-white/85"
        />
      )}
      {stack.map((e, i) => {
        const common: SheetCommon = {
          depth: i,
          covered: coveredAt(i),
          phone,
          framed,
          rootRef,
          sources,
          pace,
          report,
          hiddenKey: hiddenAt(i),
          register,
          related: relatedFor(e.kind === "title" ? e.opening.title.radarrId : null, i + 1),
          onOpenTitle: openTitle,
          onOpenPerson: openPerson,
          onCloseStart: () => closeStart(e.id),
          onReopen: () => reopen(e.id),
          onClosed: () => closed(e.id),
          bindHandle: (h) => {
            if (h) handles.current.set(e.id, h);
            else handles.current.delete(e.id);
          },
        };
        // La clé est l'entrée et non le titre : un même film peut revenir plus haut dans la pile,
        // et une autre fiche est une autre instance (règle 1 du cycle de vie des fiches).
        return e.kind === "title" ? (
          <MockSheet key={e.id} entryId={e.id} opening={e.opening} stagger={stagger} {...common} />
        ) : (
          <MockPersonSheet key={e.id} entryId={e.id} name={e.name} reduced={reduced} {...common} />
        );
      })}
    </>
  );

  // Une fenêtre modale, déclarée comme telle (neuvième passe) : le panneau qui porte la page Tests
  // animations écoute Échap en capture sur la fenêtre, avant tout le monde, et ne s'efface que devant
  // un `aria-modal` (`PlayerPanelFrame`). Sans lui, Échap fermait la fiche *et* quittait la page —
  // deux écoutes pour une touche, la règle 2 du cycle de vie des fiches.
  return (
    <div role="dialog" aria-modal="true" aria-label="Maquette de l'ouverture des fiches" className="fixed inset-0 z-[100] bg-black">
      {framed ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6">
          <div
            ref={rootRef}
            className="relative overflow-hidden rounded-[2.75rem] bg-ink ring-[6px] ring-zinc-800"
            style={{ width: PHONE_FRAME.w, height: `min(${PHONE_FRAME.h}px, calc(100dvh - 5rem))` }}
          >
            {content}
          </div>
          <p className="text-xs text-subtle">Téléphone simulé, {PHONE_FRAME.w} px de large — sur un vrai téléphone, la maquette prend l&apos;écran.</p>
        </div>
      ) : (
        <div ref={rootRef} className="absolute inset-0 overflow-hidden bg-ink">
          {content}
        </div>
      )}
    </div>
  );
}

/* L'accueil simulé : de quoi partir. Ce n'est pas lui qu'on juge — seulement les cartes, à leur vraie
   taille et à leurs vrais arrondis, puisque c'est d'elles que part le mouvement. */

type HomeProps = {
  titles: CinemaMovie[];
  hiddenKey: string | null;
  register: Register;
  onOpen: OpenTitle;
};

function DesktopHome({ titles, hiddenKey, register, onOpen }: HomeProps) {
  const hero = titles[0];
  const rows = [
    { name: "Récemment ajoutés", items: titles },
    { name: "Ma liste", items: [...titles].reverse() },
  ];
  return (
    <div data-alab-home data-alab-scroll className="scrollbar-thin absolute inset-0 overflow-y-auto bg-ink pb-10">
      {hero && (
        <div className="relative h-[58%] min-h-80 w-full overflow-hidden">
          <img src={tmdbResize(hero.backdropUrl, "w1280") ?? ""} alt="" className="absolute inset-0 h-full w-full object-cover" />
          <div className="absolute inset-0" style={{ background: VERTICAL_VEIL }} />
          <div className="absolute inset-0" style={{ background: HORIZONTAL_VEIL }} />
          <div className="absolute bottom-6 left-8 flex flex-col gap-3 sm:left-16" style={{ width: "min(36rem, 50vw)" }}>
            {hero.logoUrl && <CinemaLogo src={hero.logoUrl} alt={hero.title} surface="hero" className="object-left" />}
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
              <MetaLine title={hero} />
            </div>
          </div>
        </div>
      )}
      {rows.map((row, r) => (
        <section key={row.name} className="px-8 pt-3 sm:px-16">
          <h2 className="text-lg font-semibold text-white font-display">{row.name}</h2>
          <div data-alab-scroll className="scrollbar-none -mx-3 flex gap-3 overflow-x-auto px-3 py-3">
            {row.items.map((m) => {
              const key = `bureau-${r}-${m.radarrId}`;
              return (
                <MockPoster
                  key={key}
                  k={key}
                  register={register}
                  hidden={hiddenKey === key}
                  onOpen={() => onOpen({ title: m, key, poster: m.posterUrl ?? "", radius: 8 })}
                  // La carte de CinemaCard, survol compris.
                  className={`${CARD_WIDTH} relative shrink-0 overflow-hidden rounded-lg shadow-lg shadow-black/40 transition-[transform,box-shadow] duration-200 hover:z-10 hover:scale-105 hover:shadow-xl hover:shadow-black/60`}
                >
                  <img src={m.posterUrl ?? ""} alt={m.title} className="block aspect-[2/3] w-full object-cover" />
                </MockPoster>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function PhoneHome({ titles, framed, hiddenKey, register, onOpen }: HomeProps & { framed: boolean }) {
  // La bannière du téléphone : l'affiche sans titre à 86 % de la largeur, ses voisines devinées de
  // part et d'autre (`hero-peek-slide`, les classes de la vraie).
  const slides = titles.length >= 3 ? [titles[1], titles[0], titles[2]] : [];
  const rows = [
    { name: "Récemment ajoutés", items: titles.slice(3).concat(titles.slice(0, 3)) },
    { name: "Ma liste", items: [...titles].reverse() },
  ];
  return (
    <div
      data-alab-home
      data-alab-scroll
      className="scrollbar-none absolute inset-0 overflow-y-auto overflow-x-hidden bg-ink pb-24"
      style={{ paddingTop: framed ? PHONE_FRAME.statusBar : "env(safe-area-inset-top, 0px)" }}
    >
      <div className="flex h-12 items-center px-4 text-lg font-semibold text-white font-display">Accueil</div>
      {slides.length > 0 && (
        <div className="overflow-hidden pb-3">
          <div className="flex w-full" style={{ transform: "translateX(-79%)", ["--carousel-slide" as string]: "86%" } as CSSProperties}>
            {slides.map((m, i) => {
              const key = `banniere-${m.radarrId}`;
              const on = i === 1;
              const poster = m.posterTextlessUrl ?? m.posterUrl ?? "";
              const face = (
                <>
                  <img src={poster} alt="" className="block aspect-[2/3] w-full object-cover" />
                  {m.logoUrl && (
                    <div className="absolute inset-x-0 bottom-0 flex justify-center bg-linear-to-t from-black/70 to-transparent px-6 pb-6 pt-20">
                      <CinemaLogo src={m.logoUrl} alt={m.title} surface="phone" className="object-center" />
                    </div>
                  )}
                </>
              );
              const faceClass = "relative block w-full overflow-hidden rounded-2xl bg-surface text-left shadow-xl shadow-black/50";
              return (
                <div key={key} className={`hero-peek-slide shrink-0 px-1.5 ${on ? "hero-peek-on" : ""}`}>
                  {on ? (
                    <MockPoster k={key} register={register} hidden={hiddenKey === key} onOpen={() => onOpen({ title: m, key, poster, radius: 16 })} className={faceClass}>
                      {face}
                    </MockPoster>
                  ) : (
                    <button type="button" tabIndex={-1} className={faceClass}>
                      {face}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {rows.map((row, r) => (
        <section key={row.name} className="pt-3">
          <h2 className="px-4 text-base font-semibold text-white font-display">{row.name}</h2>
          <div data-alab-scroll className="scrollbar-none flex gap-2 overflow-x-auto px-4 py-2">
            {row.items.map((m) => {
              const key = `rangee-${r}-${m.radarrId}`;
              return (
                <MockPoster
                  key={key}
                  k={key}
                  register={register}
                  hidden={hiddenKey === key}
                  onOpen={() => onOpen({ title: m, key, poster: m.posterUrl ?? "", radius: 8 })}
                  className={`${PHONE_POSTER_WIDTH} relative shrink-0 overflow-hidden rounded-lg bg-surface`}
                >
                  <img src={m.posterUrl ?? ""} alt={m.title} className="block aspect-[2/3] w-full object-cover" />
                </MockPoster>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * Une rangée d'affiches dans une fiche — « Dans la même saga », ou la filmographie d'une personne —,
 * à l'image de CinemaCollectionRow : mêmes largeurs, même pastille « Pas encore là » pour un titre
 * hors bibliothèque. `markLastOutside` : la dernière affiche ouvre la variante découverte.
 */
function SheetPosterRow({
  label, items, entryId, phone, hiddenKey, register, onOpen, markLastOutside,
}: {
  label: string;
  items: CinemaMovie[];
  entryId: number;
  phone: boolean;
  hiddenKey: string | null;
  register: Register;
  onOpen: OpenTitle;
  markLastOutside: boolean;
}) {
  const t = useT();
  if (items.length === 0) return null;
  return (
    <section className="w-full">
      <h2 className={phone ? "mb-1 text-base font-semibold text-white font-display" : "mb-1 text-sm font-medium text-muted"}>{label}</h2>
      <div data-alab-scroll className={`scrollbar-none flex overflow-x-auto overflow-y-hidden py-3 ${phone ? "-mx-4 gap-2 px-4" : "gap-3"}`}>
        {items.map((m, i) => {
          const outside = markLastOutside && i === items.length - 1;
          // Unique dans toute la pile : l'entrée, le titre, et la variante.
          const key = `fiche-${entryId}-${m.radarrId}${outside ? "-hors" : ""}`;
          return (
            <MockPoster
              key={key}
              k={key}
              register={register}
              hidden={hiddenKey === key}
              onOpen={() => onOpen({ title: m, key, poster: m.posterUrl ?? "", radius: 8, outside })}
              className={`${phone ? PHONE_POSTER_WIDTH : SHEET_POSTER_WIDTH} relative shrink-0 overflow-hidden rounded-lg bg-surface shadow-lg shadow-black/40`}
            >
              <img src={m.posterUrl ?? ""} alt={m.title} className="block aspect-[2/3] w-full object-cover" />
              {outside && (
                <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-accent-400 ring-1 ring-accent-400/40">
                  {t("player.notInLibrary")}
                </span>
              )}
            </MockPoster>
          );
        })}
      </div>
    </section>
  );
}

/** La ligne d'infos des deux fiches : année, note, durée, qualité, genres — dans l'ordre des vraies. */
function MetaLine({ title, truncateGenres = false }: { title: CinemaMovie; truncateGenres?: boolean }) {
  const t = useT();
  const runtime = formatMinutes(title.runtimeMinutes);
  return (
    <>
      <span>{title.year}</span>
      {title.imdbRating && <ImdbBadge rating={title.imdbRating} size="sm" />}
      {runtime && <span>{runtime}</span>}
      <QualityBadges quality={title.quality} />
      {title.genres.length > 0 && (
        <span className={truncateGenres ? "truncate" : undefined}>{title.genres.slice(0, 3).map((g) => genreLabel(g, t)).join(" · ")}</span>
      )}
    </>
  );
}

/** Les noms de la distribution qu'une fiche propose d'ouvrir : trois au plus, un nom d'exemple sinon. */
function castOf(title: CinemaMovie): string[] {
  const names = title.castNames?.filter(Boolean).slice(0, CAST_SHOWN) ?? [];
  return names.length > 0 ? names : ["Distribution (exemple)"];
}

/**
 * Le contenu de la fiche qui paraît : d'un bloc (le même départ, la même durée pour toutes les
 * lignes — un seul mouvement), ou en cascade resserrée. Partagé par la fiche de titre et celle d'une
 * personne.
 */
function revealContent(items: HTMLElement[], at: number, cascade: boolean, play: (el: Element, f: Keyframe[], o: KeyframeAnimationOptions) => void) {
  const step = cascade && items.length > 1 ? Math.min(CASCADE_STEP_MS, CASCADE_TOTAL_MS / (items.length - 1)) : 0;
  items.forEach((el, i) =>
    play(el, [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], {
      duration: REVEAL_MS, delay: at + i * step, easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    }),
  );
}

/**
 * Le contenu qui s'efface à la fermeture, depuis l'opacité où il en est.
 *
 * Cinquième passe : partir de `opacity: 1` en dur faisait *reparaître* une ligne pas encore révélée
 * — fermée vite, la fiche montrait un instant son synopsis, voire « Lire », après la fermeture,
 * « comme en clignotant ». Lues avant d'annuler les animations d'ouverture, les opacités disent où
 * chaque ligne en était ; annulées dans la même tâche, rien ne se peint entre les deux.
 */
function fadeContentOut(els: HTMLElement[], snapshot: Map<HTMLElement, number>, duration: number) {
  for (const el of els) {
    const from = snapshot.get(el) ?? 1;
    el.animate([{ opacity: from }, { opacity: 0 }], { duration: from > 0 ? duration : 1, easing: "ease-in", fill: "both" });
  }
}

/**
 * La fiche simulée, à l'image de CinemaMovieDetail (bureau) et de CinemaMobileDetail (téléphone) :
 * mêmes constantes de mise en page, même logo, mêmes classes — à comparer à une capture.
 *
 * Le mouvement, en FLIP : un calque à part (`frameRef`) porte le visuel et l'affiche, découpé
 * (`clip-path`) de la place de la carte à celle du visuel de la fiche ; dedans, l'affiche grandit en
 * s'effaçant pendant que le visuel, réduit d'abord à la taille de la carte, retrouve la sienne. Le
 * vrai visuel de la fiche, caché le temps du trajet, prend le relais à l'arrivée — c'est lui qui
 * défile ensuite. Rien d'autre ne bouge que la transformation, l'opacité et la découpe, et tout est
 * mesuré une fois au départ.
 *
 * Troisième passe (10/10/2026) : voiles du visuel dans le calque découpé, échelle uniforme, fondu
 * court et décalé, accueil assombri derrière la fiche.
 *
 * Quatrième passe (10/10/2026) : 250 ms, fondu étiré à la fermeture et relais sous la vraie carte
 * (`HANDOVER_MS`), bannière qui se tire vers le bas comme dans la vraie fiche (`useSwipeToDismiss`,
 * même poignée, mêmes coins), fermeture qui part de là où le doigt l'a laissée.
 *
 * Cinquième passe (10/10/2026), d'après l'iPhone :
 * - Fermer vite ne fait plus clignoter le contenu : toute animation, tout minuteur de l'ouverture
 *   est annulé au premier instant de la fermeture, et chaque rappel de l'ouverture vérifie qu'aucune
 *   fermeture n'a commencé (`closingRef`). Le trajet de retour part de là où en est l'aller — la
 *   découpe, les échelles et les opacités lues au même instant.
 * - Le contenu arrive d'un seul bloc (`revealContent`).
 * - Fiches en cascade : sa rangée « Dans la même saga » et sa distribution ouvrent des fiches
 *   par-dessus. Couverte, elle reste rendue, assombrie par la suivante, inerte. Fermée, la fiche du
 *   dessus revient dans l'affiche d'où elle est partie si celle-ci est encore à l'écran
 *   (`sourceOnScreen`) ; sinon elle descend en s'effaçant.
 */
/**
 * Un aller en cours ou fini : de quoi reprendre son point et sa vitesse si une fermeture l'interrompt.
 * `span` : la longueur du trajet de l'aller en pixels — une progression de `v` par seconde déplace
 * la fenêtre de `v·span` pixels par seconde, quel que soit le point de départ (l'affiche, ou une
 * fermeture retournée en chemin).
 */
type Run = { motion: Motion; poseAt: (q: number) => Pose; startedAt: number | null; span: number };

/**
 * Une fermeture en vol (huitième passe) : de quoi la retourner en ouverture d'où elle en est, ou
 * savoir à quel point de son retour elle est quand une autre ouverture la coupe. `handover` : le
 * relais final a commencé (la vraie carte est revenue dessous) — trop tard pour la retourner.
 */
type CloseRun = {
  motion: Motion;
  poseAt: (r: number) => Pose;
  startedAt: number;
  stage: { W: number; H: number };
  target: Box;
  source: Box;
  start: Box;
  handover: boolean;
};

/**
 * Pose la fenêtre du trajet pour un moteur : sur la boîte de base (transform), ou sur toute la scène
 * (clip). Son contenu fait la taille de la scène, en coordonnées de la scène.
 */
function prepareFrame(frame: HTMLElement, inner: HTMLElement, stage: { W: number; H: number }, base: Box, engine: Engine) {
  place(frame, engine === "transform" ? base : { x: 0, y: 0, w: stage.W, h: stage.H });
  Object.assign(inner.style, { width: `${stage.W}px`, height: `${stage.H}px`, transform: "" });
}

function MockSheet({
  entryId, opening, stagger, depth, covered, phone, framed, rootRef, sources, pace, report, hiddenKey, register, related,
  onOpenTitle, onOpenPerson, onCloseStart, onReopen, onClosed, bindHandle,
}: SheetCommon & { entryId: number; opening: Opening; stagger: boolean }) {
  const t = useT();
  const { title, mode, outside } = opening;
  const sheetRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // La fenêtre du trajet, et dedans le calque contre-transformé qui porte les deux images.
  const frameRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  // Le visuel du trajet et ses voiles, dans une seule enveloppe : une échelle, une opacité.
  const morphBackdropRef = useRef<HTMLDivElement>(null);
  const morphBackdropImgRef = useRef<HTMLImageElement>(null);
  const morphPosterRef = useRef<HTMLImageElement>(null);
  const imageRef = useRef<HTMLDivElement>(null);
  const photoRef = useRef<HTMLImageElement>(null);
  const dimRef = useRef<HTMLDivElement>(null);
  // Où rendre le focus au clavier : le bouton de fermeture de la fiche, à l'arrivée.
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closingRef = useRef(false);
  const aliveRef = useRef(true);
  const openTimersRef = useRef<number[]>([]);
  // Toutes les animations de l'ouverture, pour que la fermeture les arrête d'un coup.
  const openAnimsRef = useRef<Animation[]>([]);
  const runRef = useRef<Run | null>(null);
  const unpromoteRef = useRef<(() => void) | null>(null);
  // Les derniers mouvements du doigt sur la poignée : la vitesse au relâché lance le ressort du retour.
  const movesRef = useRef<{ t: number; y: number }[]>([]);
  // Le flou localisé du bas de la fiche du bureau (`backdrop-blur`) et le verre de la croix du
  // téléphone ne sont posés qu'une fois le visuel arrivé : un filtre ne voyage pas avec un calque
  // qui bouge, ni au-dessus de lui.
  const [settled, setSettled] = useState(mode === "fade");
  // Où le doigt a laissé la fiche quand la fermeture a commencé (0 pour la croix ou Échap) :
  // gelé là, pour que le décalage du geste, que `useSwipeToDismiss` pousse ensuite jusqu'au bas de
  // l'écran, ne fasse pas sauter la fiche sous le trajet de retour. Une fermeture retournée en
  // ouverture le gèle à 0 jusqu'au prochain geste : le geste, lui, est resté au bas de l'écran.
  const [frozenOffset, setFrozenOffset] = useState<number | null>(null);
  const [closing, setClosing] = useState(false);
  const heldAfterReverseRef = useRef(false);
  // La fermeture en vol (huitième passe) : ses animations et minuteurs — une autre ouverture la
  // coupe, un appui sur son affiche la retourne —, et où en est son retour.
  const closeAnimsRef = useRef<Animation[]>([]);
  const ghostAnimsRef = useRef<Animation[]>([]);
  const closeTimersRef = useRef<number[]>([]);
  const closeRunRef = useRef<CloseRun | null>(null);
  // Sans visuel, l'affiche en tient lieu (chasse aux bogues de la sixième passe) : une `<img src="">`
  // grandissait vide jusqu'à l'écran entier.
  const backdrop = title.backdropUrl || title.posterUrl || opening.poster || "";
  const imageCorners: Corners = phone ? [16, 16, 0, 0] : [0, 0, 0, 0];
  const sourceCorners = uniformCorners(opening.radius);
  // Seule la première fiche fait reculer l'accueil ; celles du dessus passent devant une fiche.
  const scalesHome = !phone && depth === 0;
  // Au doigt, la fiche large se tire par sa poignée, comme la vraie sur tablette (`useSheetGrip`).
  const grip = !phone && pace.profile !== "desktop";

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      // Quitter la page au milieu d'un trajet : plus rien ne doit appeler la scène démontée.
      aliveRef.current = false;
    };
  }, []);

  /** Toutes les places du trajet, lues d'un coup : la scène, la carte touchée, le visuel de la fiche, la carte du téléphone. */
  const measure = () => {
    const root = rootRef.current;
    const image = imageRef.current;
    const src = sources.current.get(opening.key);
    if (!root || !image || !src) return null;
    const r = root.getBoundingClientRect();
    const card = cardRef.current ? boxIn(cardRef.current, r) : null;
    return { W: r.width, H: r.height, source: boxIn(src, r), target: boxIn(image, r), cardDrop: card ? r.height - card.y : 0 };
  };

  const parts = () => {
    const sheet = sheetRef.current;
    return {
      items: sheet ? Array.from(sheet.querySelectorAll<HTMLElement>("[data-alab-stagger]")) : [],
      fades: sheet ? Array.from(sheet.querySelectorAll<HTMLElement>("[data-alab-fade]")) : [],
    };
  };

  /**
   * Le visuel de la fiche et ses voiles, cachés le temps du trajet : c'est la copie du calque du
   * trajet qui se montre. Les voiles sont repérés par `data-alab-veil`.
   */
  const showSheetImage = (visible: boolean) => {
    const v = visible ? "" : "hidden";
    if (photoRef.current) photoRef.current.style.visibility = v;
    imageRef.current?.querySelectorAll<HTMLElement>("[data-alab-veil]").forEach((el) => (el.style.visibility = v));
  };

  /** L'accueil, que le bureau fait reculer d'un rien derrière la première fiche. */
  const home = () => rootRef.current?.querySelector<HTMLElement>("[data-alab-home]") ?? null;

  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    const anims = openAnimsRef.current;
    const timers = openTimersRef.current;
    let cancelled = false;
    // Créées en pause, à leur première image : la fiche se dessine aussitôt à son point de départ,
    // et tout part ensemble quand les images sont décodées (`startTogether`).
    const play = (el: Element | null | undefined, frames: Keyframe[], opts: KeyframeAnimationOptions) => {
      const a = el?.animate(frames, { fill: "both", ...opts });
      if (!a) return;
      (a as Partial<Animation>).pause?.();
      anims.push(a);
    };
    // Un rappel de l'ouverture ne s'exécute que tant qu'aucune fermeture n'a commencé.
    const later = (fn: () => void, ms: number) =>
      timers.push(
        window.setTimeout(() => {
          if (!closingRef.current && !cancelled) fn();
        }, ms),
      );
    const cleanup = () => {
      cancelled = true;
      for (const a of anims.splice(0)) a.cancel();
      for (const id of timers.splice(0)) window.clearTimeout(id);
      unpromoteRef.current?.();
      unpromoteRef.current = null;
    };
    if (mode === "fade") {
      // « Réduire les animations » : un fondu simple, rien qui se déplace.
      play(sheet, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
      play(cardRef.current, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
      play(dimRef.current, [{ opacity: 0 }, { opacity: DIM }], { duration: 200, easing: "ease-out" });
      startTogether(anims);
      return cleanup;
    }
    const m = measure();
    if (!m) return cleanup;
    const stage = { W: m.W, H: m.H };
    const motion = openMotion(pace, m.source, m.target, stage);
    const d = motion.duration;
    const from: Pose = { box: m.source, corners: sourceCorners, bd: coverTf(m.target, m.source), poster: IDENTITY, bdOpacity: 0, posterOpacity: 1 };
    const to: Pose = { box: m.target, corners: imageCorners, bd: IDENTITY, poster: coverTf(m.source, m.target), bdOpacity: 1, posterOpacity: 0 };
    const poseAt = (q: number): Pose => ({
      box: lerpBox(from.box, to.box, q),
      corners: lerpCorners(from.corners, to.corners, q),
      bd: lerpTf(from.bd, to.bd, q),
      poster: lerpTf(from.poster, to.poster, q),
      bdOpacity: smooth(0.1, 0.7, q),
      posterOpacity: 1 - smooth(0, 0.6, q),
    });
    const samples = sampleMotion(motion);
    const run: Run = { motion, poseAt, startedAt: null, span: travelOf(m.source, m.target) };
    runRef.current = run;
    const linear = { duration: d, easing: "linear" };
    // Ce qui est derrière s'éteint au rythme du trajet : la fiche passe devant, elle ne remplace rien.
    // Ouverte en coupant une fermeture : l'assombrissement repart d'où celle-ci l'avait laissé.
    const dimFrom = opening.dimFrom ?? 0;
    play(dimRef.current, samples.map(({ offset, q }) => ({ offset, opacity: lerp(dimFrom, DIM, clamp(q, 0, 1)) })), linear);
    const { items, fades } = parts();
    // Le contenu part quand l'image est en place pour l'œil (`REVEAL_AT`) et se pose avec elle, d'un bloc.
    revealContent(items, timeAt(samples, d, REVEAL_AT), stagger, play);
    const fadeAt = timeAt(samples, d, 0.3);
    fades.forEach((el) => play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: Math.max(160, timeAt(samples, d, 0.95) - fadeAt), delay: fadeAt, easing: "ease-out" }));
    // Sans remplissage à la fin : la montée finie, c'est le style de la carte qui reprend sa
    // transformation — celle du doigt quand on tire la fiche.
    play(cardRef.current, samples.map(({ offset, q }) => ({ offset, transform: `translateY(${(m.cardDrop * (1 - q)).toFixed(2)}px)` })), { ...linear, fill: "backwards" });

    const frame = frameRef.current;
    const inner = innerRef.current;
    const bd = morphBackdropRef.current;
    const poster = morphPosterRef.current;
    const h = scalesHome ? home() : null;
    if (mode === "flip" && frame && inner && bd && poster && photoRef.current) {
      prepareFrame(frame, inner, stage, m.target, pace.engine);
      place(bd, m.target);
      place(poster, m.source);
      frame.style.display = "";
      showSheetImage(false);
      const tracks = morphTracks(poseAt, samples, m.target, stage, pace.engine);
      play(frame, tracks.win, linear);
      if (pace.engine === "transform") {
        play(frame, tracks.radius, linear);
        play(inner, tracks.inner, linear);
      }
      play(bd, tracks.bd, linear);
      play(poster, tracks.poster, linear);
      // Au bureau, l'accueil recule d'un rien : la profondeur, sans rien déplacer qui se lise.
      const homeFrom = opening.homeFrom ?? 1;
      if (h) play(h, samples.map(({ offset, q }) => ({ offset, transform: `scale(${lerp(homeFrom, HOME_SCALE, clamp(q, 0, 1)).toFixed(5)})` })), linear);
    }
    unpromoteRef.current = promote([frame, inner, bd, poster, cardRef.current, dimRef.current, h, ...items]);

    // Le départ : les deux images décodées (au plus 150 ms d'attente — elles sont demandées dès
    // l'ouverture de la maquette), puis deux images de plus, et tout part sur la même.
    const decoded = Promise.all([poster, morphBackdropImgRef.current].map((img) => img?.decode?.().catch(() => undefined)));
    void Promise.race([decoded, new Promise((ok) => window.setTimeout(ok, 150))]).then(() =>
      afterTwoFrames(() => {
        if (cancelled || closingRef.current) return;
        run.startedAt = startTogether(anims);
        later(() => {
          if (frame) frame.style.display = "none";
          showSheetImage(true);
          unpromoteRef.current?.();
          unpromoteRef.current = null;
          report("open", motion);
          // Au clavier, le focus entre dans la fiche ; il reviendra à l'affiche à la fermeture.
          closeButtonRef.current?.focus({ preventScroll: true });
        }, d);
        later(() => setSettled(true), d + 40);
      }),
    );
    return cleanup;
    // Une fois, à l'ouverture : les réglages ne changent pas pendant qu'une fiche est ouverte, et
    // `measure` / `parts` ne lisent que des refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, phone, pace, stagger]);

  /** Arrête la fermeture en vol : ses animations (le calque du retour à part) et ses minuteurs. */
  const stopClose = (ghost: "cancel" | "freeze") => {
    for (const a of closeAnimsRef.current.splice(0)) a.cancel();
    for (const a of ghostAnimsRef.current.splice(0)) {
      if (ghost === "cancel") a.cancel();
      else (a as Partial<Animation>).pause?.();
    }
    for (const id of closeTimersRef.current.splice(0)) window.clearTimeout(id);
  };

  /** Le focus revient à l'affiche — seulement s'il était dans la fiche (ou nulle part) : un appui ailleurs le garde. */
  const focusSource = (src: HTMLElement | undefined) => {
    if (!src) return;
    const active = document.activeElement;
    if (!active || active === document.body || sheetRef.current?.contains(active)) src.focus({ preventScroll: true });
  };

  const requestClose = () => {
    if (closingRef.current || covered) return;
    closingRef.current = true;
    onCloseStart();
    const sheet = sheetRef.current;
    const frame = frameRef.current;
    const inner = innerRef.current;
    const bd = morphBackdropRef.current;
    const poster = morphPosterRef.current;
    const card = cardRef.current;
    const dim = dimRef.current;
    const h = scalesHome ? home() : null;
    const { items, fades } = parts();
    const src = sources.current.get(opening.key);

    // 1. Tout lire d'où on en est, *avant* d'arrêter l'ouverture : le doigt, la montée de la carte,
    //    le point et la vitesse de l'aller (calculés, pas relus dans les styles), chaque opacité.
    const off = sheet ? translateYOf(getComputedStyle(sheet).transform) : 0;
    const cardFrom = card ? translateYOf(getComputedStyle(card).transform) : off;
    const midOpen = !!frame && frame.style.display !== "none";
    const run = runRef.current;
    const elapsed = run?.startedAt != null ? clockNow() - run.startedAt : 0;
    const qNow = run && midOpen ? (run.startedAt == null ? 0 : run.motion.q(elapsed)) : 1;
    const vNow = run && midOpen && run.startedAt != null ? run.motion.v(elapsed) : 0;
    const dimNow = opacityNow(dim);
    const homeNow = h ? (run && midOpen ? scaleOf(h) : HOME_SCALE) : 1;
    const fingerVy = releaseVelocity(movesRef.current);
    movesRef.current = [];
    const snapshot = new Map<HTMLElement, number>();
    for (const el of [...items, ...fades]) snapshot.set(el, opacityNow(el));

    // 2. L'ouverture s'arrête net : plus rien d'elle ne peut révéler une ligne ou basculer un calque.
    for (const a of openAnimsRef.current.splice(0)) a.cancel();
    for (const id of openTimersRef.current.splice(0)) window.clearTimeout(id);
    unpromoteRef.current?.();
    unpromoteRef.current = null;
    heldAfterReverseRef.current = false;
    setSettled(false);
    setClosing(true);
    setFrozenOffset(off);
    // Le focus quitte la fiche, inerte dès maintenant, pour l'affiche d'où elle était partie : au
    // clavier, Entrée la rouvre aussitôt, pendant le retour (huitième passe). Cachée par l'opacité
    // et non plus la visibilité, elle peut le recevoir.
    focusSource(src);

    // 3. Le contenu s'efface depuis où il en est ; rien ne se rejoue à l'envers.
    fadeContentOut(items, snapshot, CONTENT_OUT_MS);
    fadeContentOut(fades, snapshot, CONTENT_OUT_MS * 2);

    const anim = (el: Element | null | undefined, frames: Keyframe[], opts: KeyframeAnimationOptions, ghost = false) => {
      const a = el?.animate(frames, opts);
      if (a) (ghost ? ghostAnimsRef : closeAnimsRef).current.push(a);
      return a;
    };
    const wait = (fn: () => void, ms: number) => closeTimersRef.current.push(window.setTimeout(fn, ms));
    const done = () => {
      closeRunRef.current = null;
      if (aliveRef.current) onClosed();
    };
    if (mode === "fade") {
      anim(sheet, [{ opacity: opacityNow(sheet) }, { opacity: 0 }], { duration: 180, easing: "ease-in", fill: "both" });
      anim(card, [{ opacity: opacityNow(card) }, { opacity: 0 }], { duration: 180, easing: "ease-in", fill: "both" });
      anim(dim, [{ opacity: dimNow }, { opacity: 0 }], { duration: 180, easing: "ease-in", fill: "both" });
      wait(done, 180);
      return;
    }

    // L'accueil a repris sa taille avant la mesure (son animation vient d'être annulée) : la carte
    // d'arrivée se lit à sa vraie place, pas à celle de l'accueil reculé. Remesuré ici et non repris
    // de l'ouverture : la fiche a pu défiler, l'écran tourner.
    const m = measure();
    const root = rootRef.current;
    const handBack = () => {
      if (!src) return;
      src.style.opacity = "";
      focusSource(src);
    };

    // L'affiche d'origine n'est plus à l'écran (la rangée a défilé, la fiche du dessous aussi) : pas
    // de trajet vers un endroit qu'on ne voit pas — la fiche descend un peu en s'effaçant.
    if (!m || !frame || !inner || !bd || !poster || !src || !root || !sourceOnScreen(src, root)) {
      if (frame) frame.style.display = "none";
      showSheetImage(true);
      const out = { duration: PLAIN_OUT_MS, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "both" as const };
      anim(sheet, [{ opacity: 1, transform: `translateY(${off}px)` }, { opacity: 0, transform: `translateY(${off + PLAIN_OUT_DROP}px)` }], out);
      anim(card, [{ opacity: 1, transform: `translateY(${cardFrom}px)` }, { opacity: 0, transform: `translateY(${cardFrom + PLAIN_OUT_DROP}px)` }], out);
      anim(dim, [{ opacity: dimNow }, { opacity: 0 }], out);
      if (h && homeNow !== 1) anim(h, [{ transform: `scale(${homeNow})` }, { transform: "none" }], { duration: PLAIN_OUT_MS, easing: "cubic-bezier(0.2, 0, 0, 1)" });
      wait(() => {
        handBack();
        done();
      }, PLAIN_OUT_MS);
      return;
    }

    // D'où part le retour : le point de l'aller interrompu, ou la bannière à sa place — tirée vers le
    // bas, avec les coins arrondis que le geste lui a donnés.
    const c = phone ? phoneSheetCorner(off) : 0;
    const cur: Pose =
      run && midOpen
        ? run.poseAt(qNow)
        : { box: m.target, corners: phone ? [c, c, 0, 0] : imageCorners, bd: IDENTITY, poster: coverTf(m.source, m.target), bdOpacity: 1, posterOpacity: 0 };
    const toPose: Pose = { box: m.source, corners: sourceCorners, bd: coverTf(m.target, m.source), poster: IDENTITY, bdOpacity: 0, posterOpacity: 1 };
    // La vitesse de départ, en progression du retour par seconde. Un aller interrompu avançait de
    // `v·span` pixels par seconde vers la fiche ; le retour, long de `travelOf(cur, carte)`, part donc
    // à −v·span / longueur : il continue un instant vers la fiche avant de revenir, comme le fait
    // iOS. Lâchée au doigt, la vitesse verticale du doigt projetée sur le chemin du retour.
    let v0 = 0;
    if (run && midOpen) {
      const back = travelOf(cur.box, toPose.box);
      v0 = back > 4 ? (-vNow * run.span) / back : 0;
    } else if (fingerVy !== 0) {
      const dx = toPose.box.x + toPose.box.w / 2 - (cur.box.x + cur.box.w / 2);
      const dy = toPose.box.y + toPose.box.h / 2 - (cur.box.y + cur.box.h / 2);
      const len2 = dx * dx + dy * dy;
      if (len2 > 1) v0 = (fingerVy * dy) / len2;
    }
    const stage = { W: m.W, H: m.H };
    const motion = closeMotion(pace, cur.box, toPose.box, stage, v0);
    const d = motion.duration;
    const poseAt = (r: number): Pose => ({
      box: lerpBox(cur.box, toPose.box, r),
      corners: lerpCorners(cur.corners, toPose.corners, r),
      bd: lerpTf(cur.bd, toPose.bd, r),
      poster: lerpTf(cur.poster, toPose.poster, r),
      posterOpacity: lerp(cur.posterOpacity, 1, smooth(0.15, 0.8, r)),
      bdOpacity: cur.bdOpacity * (1 - smooth(0.25, 0.9, r)),
    });
    const samples = sampleMotion(motion);
    prepareFrame(frame, inner, stage, m.target, pace.engine);
    place(bd, m.target);
    place(poster, m.source);
    frame.style.display = "";
    frame.style.opacity = "";
    showSheetImage(false);
    const linear = { duration: d, easing: "linear", fill: "both" as const };
    const tracks = morphTracks(poseAt, samples, m.target, stage, pace.engine);
    // Le calque du retour à part (`ghost`) : une ouverture qui coupe cette fermeture le fige là où il
    // en est et l'efface, au lieu de le renvoyer d'un coup à la taille de la bannière.
    const back = anim(frame, tracks.win, linear, true);
    if (pace.engine === "transform") {
      anim(frame, tracks.radius, linear, true);
      anim(inner, tracks.inner, linear, true);
    }
    anim(bd, tracks.bd, linear, true);
    anim(poster, tracks.poster, linear, true);
    // La carte part d'où elle en est (le doigt, ou sa montée interrompue), et finit sous l'écran.
    anim(card, samples.map(({ offset, q }) => ({ offset, transform: `translateY(${lerp(cardFrom, off + m.cardDrop, q).toFixed(2)}px)` })), linear);
    anim(dim, samples.map(({ offset, q }) => ({ offset, opacity: dimNow * (1 - clamp(q, 0, 1)) })), linear);
    // Sans remplissage : à la fin, l'accueil retrouve simplement son état.
    if (h && homeNow !== 1) anim(h, samples.map(({ offset, q }) => ({ offset, transform: `scale(${lerp(homeNow, 1, clamp(q, 0, 1)).toFixed(5)})` })), { duration: d, easing: "linear" });
    const unpromote = promote([frame, inner, bd, poster, card, dim, h]);
    closeRunRef.current = { motion, poseAt, startedAt: clockNow(), stage, target: m.target, source: m.source, start: cur.box, handover: false };
    // Le relais : la vraie carte reparaît dessous, et le calque, maintenant superposé à elle, s'efface.
    const finish = () => {
      unpromote();
      if (closeRunRef.current) closeRunRef.current.handover = true;
      handBack();
      report("close", motion);
      const fade = anim(frame, [{ opacity: 1 }, { opacity: 0 }], { duration: HANDOVER_MS, easing: "ease-out", fill: "both" }, true);
      if (fade) fade.onfinish = done;
      else done();
    };
    if (back) back.onfinish = finish;
    else finish();
  };

  /**
   * Une autre ouverture coupe cette fermeture (huitième passe). Le calque du retour est figé où il en
   * est et s'efface en `GHOST_FADE_MS` — ou disparaît d'un coup s'il était presque arrivé —, la vraie
   * carte reparaît dessous à l'instant, et tout le reste de la fiche s'éteint : son assombrissement,
   * rendu à la scène, est repris par la nouvelle fiche à la même valeur.
   */
  const interruptedRef = useRef(false);
  const interrupt = () => {
    const dim = dimRef.current;
    const h = scalesHome ? home() : null;
    // Déjà coupée (son calque s'efface encore) : plus rien à rendre ni à éteindre.
    if (interruptedRef.current) return { dim: 0, home: h ? scaleOf(h) : 1 };
    interruptedRef.current = true;
    const left = { dim: opacityNow(dim), home: h ? scaleOf(h) : 1 };
    const run = closeRunRef.current;
    const r = run ? (run.handover ? 1 : run.motion.q(clockNow() - run.startedAt)) : 1;
    stopClose("freeze");
    closeRunRef.current = null;
    const src = sources.current.get(opening.key);
    if (src) src.style.opacity = "";
    for (const el of [dim, cardRef.current, sheetRef.current]) if (el) el.style.opacity = "0";
    const frame = frameRef.current;
    const done = () => {
      if (aliveRef.current) onClosed();
    };
    if (!frame || frame.style.display === "none" || r >= GHOST_SNAP_AT) {
      if (frame) frame.style.display = "none";
      done();
    } else {
      frame.animate([{ opacity: opacityNow(frame) }, { opacity: 0 }], { duration: GHOST_FADE_MS, easing: "ease-out", fill: "both" });
      window.setTimeout(done, GHOST_FADE_MS);
    }
    return left;
  };

  /**
   * L'affiche vers laquelle la fiche revient est touchée de nouveau (huitième passe) : la fermeture se
   * retourne en ouverture, d'où elle en est et à sa vitesse — comme une vue d'iOS qu'on rattrape —,
   * au lieu de repartir de la carte. Faux quand il est trop tard : le relais final a commencé, la vraie
   * carte est déjà revenue dessous ; la scène ouvre alors une fiche neuve.
   */
  const reverse = (): boolean => {
    const run = closeRunRef.current;
    const frame = frameRef.current;
    const inner = innerRef.current;
    const bd = morphBackdropRef.current;
    const poster = morphPosterRef.current;
    if (!run || run.handover || mode === "fade" || !frame || !inner || !bd || !poster) return false;
    const card = cardRef.current;
    const dim = dimRef.current;
    const h = scalesHome ? home() : null;
    // Lu avant d'arrêter quoi que ce soit, comme à la fermeture.
    const t = clockNow() - run.startedAt;
    const r = run.motion.q(t);
    const vr = run.motion.v(t);
    const cardNow = card ? translateYOf(getComputedStyle(card).transform) : 0;
    const dimNow = opacityNow(dim);
    const homeNow = h ? scaleOf(h) : 1;
    stopClose("cancel");
    closeRunRef.current = null;
    closingRef.current = false;
    setClosing(false);
    // Tenue à 0 jusqu'au prochain geste : `useSwipeToDismiss` a laissé son décalage au bas de l'écran.
    setFrozenOffset(0);
    heldAfterReverseRef.current = true;
    onReopen();

    const P = run.poseAt(r);
    const T: Pose = { box: run.target, corners: imageCorners, bd: IDENTITY, poster: coverTf(run.source, run.target), bdOpacity: 1, posterOpacity: 0 };
    // Le retour avançait de `vr·longueur` pixels par seconde vers la carte ; l'aller repart de P à
    // contre-sens, à −vr·longueur / (P → fiche).
    const ahead = travelOf(P.box, T.box);
    const v0 = ahead > 4 ? (-vr * travelOf(run.start, run.source)) / ahead : 0;
    const motion = openMotion(pace, P.box, T.box, run.stage, v0);
    const d = motion.duration;
    const poseAt = (q: number): Pose => ({
      box: lerpBox(P.box, T.box, q),
      corners: lerpCorners(P.corners, T.corners, q),
      bd: lerpTf(P.bd, T.bd, q),
      poster: lerpTf(P.poster, T.poster, q),
      bdOpacity: lerp(P.bdOpacity, 1, smooth(0, 0.6, q)),
      posterOpacity: P.posterOpacity * (1 - smooth(0, 0.5, q)),
    });
    const samples = sampleMotion(motion);
    const linear = { duration: d, easing: "linear", fill: "both" as const };
    const anims = openAnimsRef.current;
    const go = (el: Element | null | undefined, frames: Keyframe[], opts: KeyframeAnimationOptions) => {
      const a = el?.animate(frames, opts);
      if (a) anims.push(a);
    };
    frame.style.display = "";
    frame.style.opacity = "";
    const tracks = morphTracks(poseAt, samples, run.target, run.stage, pace.engine);
    go(frame, tracks.win, linear);
    if (pace.engine === "transform") {
      go(frame, tracks.radius, linear);
      go(inner, tracks.inner, linear);
    }
    go(bd, tracks.bd, linear);
    go(poster, tracks.poster, linear);
    go(card, samples.map(({ offset, q }) => ({ offset, transform: `translateY(${lerp(cardNow, 0, q).toFixed(2)}px)` })), { ...linear, fill: "backwards" });
    go(dim, samples.map(({ offset, q }) => ({ offset, opacity: lerp(dimNow, DIM, clamp(q, 0, 1)) })), linear);
    if (h) go(h, samples.map(({ offset, q }) => ({ offset, transform: `scale(${lerp(homeNow, HOME_SCALE, clamp(q, 0, 1)).toFixed(5)})` })), linear);
    // Le contenu, qui s'effaçait, revient avec l'image comme à une ouverture.
    const { items, fades } = parts();
    for (const el of [...items, ...fades]) for (const a of el.getAnimations?.() ?? []) a.cancel();
    revealContent(items, timeAt(samples, d, REVEAL_AT), stagger, (el, f, o) => go(el, f, { fill: "both", ...o }));
    fades.forEach((el) => go(el, [{ opacity: 0 }, { opacity: 1 }], { duration: Math.max(120, timeAt(samples, d, 0.95)), easing: "ease-out", fill: "both" }));
    unpromoteRef.current = promote([frame, inner, bd, poster, card, dim, h]);
    runRef.current = { motion, poseAt, startedAt: clockNow(), span: ahead };
    const timers = openTimersRef.current;
    timers.push(
      window.setTimeout(() => {
        if (closingRef.current || !aliveRef.current) return;
        frame.style.display = "none";
        showSheetImage(true);
        unpromoteRef.current?.();
        unpromoteRef.current = null;
        report("open", motion);
        closeButtonRef.current?.focus({ preventScroll: true });
      }, d),
      window.setTimeout(() => {
        if (!closingRef.current && aliveRef.current) setSettled(true);
      }, d + 40),
    );
    return true;
  };

  // Ce que la scène peut demander à la fiche pendant sa fermeture, tenu à jour à chaque rendu.
  useEffect(() => {
    bindHandle({ interrupt, reverse, key: opening.key });
    return () => bindHandle(null);
  });

  // Le geste de la vraie fiche du téléphone, à l'identique : la bannière pour poignée, la croix
  // tenue hors de la poignée. Couverte, la fiche ne le reçoit pas. Les mouvements du doigt sont
  // notés au passage, pour lancer le retour à sa vitesse.
  const swipe = useSwipeToDismiss(requestClose);
  const note = (e: ReactPointerEvent) => {
    const list = movesRef.current;
    list.push({ t: e.timeStamp, y: e.clientY });
    if (list.length > 12) list.shift();
  };
  const handle = {
    onPointerDown: (e: ReactPointerEvent) => {
      movesRef.current = [];
      note(e);
      swipe.handlers.onPointerDown(e);
    },
    onPointerMove: (e: ReactPointerEvent) => {
      note(e);
      // Retournée en ouverture après un geste : la fiche était tenue à 0 ; le doigt la reprend.
      if (heldAfterReverseRef.current) {
        heldAfterReverseRef.current = false;
        setFrozenOffset(null);
      }
      swipe.handlers.onPointerMove(e);
    },
    onPointerUp: (e: ReactPointerEvent) => {
      note(e);
      const wasClosing = closingRef.current;
      swipe.handlers.onPointerUp(e);
      // Fermée par ce relâchement : la fiche n'a déjà plus de pointeur, le `click` qui le suit irait à
      // ce qu'il y a dessous (neuvième passe).
      if (!wasClosing && closingRef.current) swallowStrayClick();
    },
    onPointerCancel: swipe.handlers.onPointerCancel,
  };
  const dragOffset = frozenOffset ?? (swipe.touched ? swipe.offset : 0);
  const dragStyle = (base: CSSProperties): CSSProperties => ({
    ...base,
    transform: dragOffset ? `translateY(${dragOffset}px)` : undefined,
    // Pendant le geste, la fiche est là où est le doigt ; relâchée en deçà du seuil, elle revient
    // par la transition de la vraie (280 ms) ; en fermeture, ce sont les images clés qui mènent.
    transition: swipe.dragging || closing ? "none" : "transform 280ms cubic-bezier(0.32, 0.72, 0, 1), border-radius 200ms ease-out",
    borderTopLeftRadius: phoneSheetCorner(dragOffset),
    borderTopRightRadius: phoneSheetCorner(dragOffset),
  });

  // Échap pour la fiche du dessus seulement : deux fiches à l'écoute reculaient de deux sur une touche.
  useEffect(() => {
    if (covered || closing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Une fiche couverte ou qui part : ni pointeur ni focus (« a screen on its way out has no opinion »).
  const quiet = covered || closing;
  const saga = (
    <SheetPosterRow
      label="Dans la même saga"
      items={related}
      entryId={entryId}
      phone={phone}
      hiddenKey={hiddenKey}
      register={register}
      onOpen={onOpenTitle}
      markLastOutside
    />
  );
  const castButtons = castOf(title).map((name) => (
    <button
      key={name}
      type="button"
      onClick={() => onOpenPerson(name)}
      className="rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-white/20"
    >
      {name}
    </button>
  ));

  // Le calque du trajet : sous le contenu de la fiche, au-dessus de ce qu'elle couvre. Caché hors
  // du FLIP. Une fenêtre (transformée, ou découpée avec l'ancien moteur) et, dedans, un calque à la
  // taille de la scène, contre-transformé : les deux images y gardent leurs proportions. Le visuel
  // y emporte une copie de ses voiles, qui grandit avec lui.
  const frame = (
    <div ref={frameRef} aria-hidden="true" className="pointer-events-none absolute left-0 top-0 overflow-hidden bg-ink" style={{ display: "none", transformOrigin: "0 0" }}>
      <div ref={innerRef} className="absolute left-0 top-0" style={{ transformOrigin: "0 0" }}>
      <div ref={morphBackdropRef} className="absolute overflow-hidden" style={{ transformOrigin: "0 0", opacity: 0 }}>
        <img ref={morphBackdropImgRef} src={backdrop} alt="" className="absolute inset-0 h-full w-full object-cover" />
        {phone ? (
          <div className="absolute inset-0 bg-linear-to-t from-ink via-ink/20 to-transparent" />
        ) : (
          <>
            <div className="absolute inset-0" style={{ background: VERTICAL_VEIL }} />
            <div className="absolute inset-0" style={{ background: HORIZONTAL_VEIL }} />
          </>
        )}
      </div>
      <img ref={morphPosterRef} src={opening.poster} alt="" className="absolute max-w-none object-cover" style={{ transformOrigin: "0 0" }} />
      </div>
    </div>
  );
  // Ce que la fiche couvre, éteint derrière elle, sous tout le reste.
  const dim = <div ref={dimRef} aria-hidden="true" className="pointer-events-none absolute inset-0 bg-ink" style={{ opacity: 0 }} />;

  if (!phone) {
    return (
      <>
        {dim}
        {frame}
        <div
          ref={sheetRef}
          data-alab-sheet={entryId}
          inert={quiet}
          className="absolute inset-0 overflow-hidden"
          style={{
            pointerEvents: quiet ? "none" : undefined,
            transform: grip && dragOffset ? `translateY(${dragOffset}px)` : undefined,
            transition: swipe.dragging || closing ? "none" : "transform 280ms cubic-bezier(0.32, 0.72, 0, 1)",
          }}
        >
          {/* La poignée de la fiche large au doigt (iPad), comme `useSheetGrip` : une bande au-dessus du
              défilement, sous le bouton Retour. À la souris, rien : tirer une fiche n'y veut rien dire. */}
          {grip && !covered && (
            <div {...handle} aria-hidden className="absolute inset-x-0 top-0 z-[5] flex h-16 items-center justify-center" style={{ touchAction: "none" }}>
              <div className="mt-2 h-1 w-10 rounded-full bg-white/35" />
            </div>
          )}
          {/* Le visuel plein écran et ce qui le voile, comme CinemaMovieDetail : le flou localisé du
              bas, puis les deux voiles à étapes de CinemaDetailLayout. */}
          <div ref={imageRef} className="absolute inset-0">
            <img ref={photoRef} src={backdrop} alt="" className="absolute inset-0 h-full w-full object-cover" />
            {settled && (
              <div
                className="absolute inset-x-0 bottom-0 animate-fade-in backdrop-blur-md"
                style={{ height: "45%", maskImage: "linear-gradient(to bottom, transparent 0%, black 60%)", WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 60%)" }}
              />
            )}
            <div data-alab-fade data-alab-veil className="absolute inset-0" style={{ background: VERTICAL_VEIL }} />
            <div data-alab-fade data-alab-veil className="absolute inset-0" style={{ background: HORIZONTAL_VEIL }} />
          </div>
          <button
            ref={closeButtonRef}
            data-alab-fade
            type="button"
            onClick={requestClose}
            className="btn btn-ghost absolute z-10 rounded-full bg-black/55 px-3 py-2 float-edge"
            style={{ top: "max(1rem, env(safe-area-inset-top))", left: "1rem" }}
          >
            <ArrowLeft size={16} /> {t("cinema.back")}
          </button>
          <div data-alab-scroll className="scrollbar-thin relative h-full overflow-y-auto">
            <div className={SECTION_CLASS}>
              <div style={COLUMN_STYLE} className={`flex flex-col ${COLUMN_GAP} px-8 sm:px-16`}>
                <div data-alab-stagger className="flex flex-col">
                  {title.logoUrl ? (
                    <CinemaLogo src={title.logoUrl} alt={title.title} surface="sheet" className="mb-1" />
                  ) : (
                    <h1 className="text-2xl font-bold leading-tight text-white drop-shadow-lg sm:text-4xl font-display">{title.title}</h1>
                  )}
                </div>
                <div data-alab-stagger className="flex flex-wrap items-center gap-3 text-sm text-muted">
                  <MetaLine title={title} />
                </div>
                {title.tagline?.trim() && (
                  <div data-alab-stagger>
                    <CinemaTagline text={title.tagline} />
                  </div>
                )}
                {title.overview && (
                  <div data-alab-stagger>
                    <CinemaOverview text={title.overview} readMore={t("cinema.readMore")} maxLines={5} onOpen={() => {}} />
                  </div>
                )}
                <div data-alab-stagger className="flex flex-wrap items-center gap-1.5">
                  <span className={CAST_CLASS}>{t("cinema.cast")}</span>
                  {castButtons}
                </div>
                <div className="mt-2 flex flex-col gap-1" style={MENU_STYLE}>
                  {outside ? (
                    <>
                      <MenuRow icon={<Plus size={14} />} label={t("player.discover.request")} />
                      <MenuRow icon={<Bookmark size={14} />} label={t("player.discover.addToList")} />
                      <MenuRow icon={<Check size={14} />} label={t("player.discover.markWatched")} />
                    </>
                  ) : (
                    <>
                      <MenuRow icon={<Play size={14} fill="currentColor" />} label={t("common.play")} />
                      {title.trailerKey && <MenuRow icon={<Video size={14} />} label={t("cinema.trailer")} />}
                      <MenuRow icon={<Check size={14} />} label={t("cinema.markWatched")} />
                      <MenuRow icon={<Plus size={14} />} label={t("watchlist.statuses.toWatch")} />
                    </>
                  )}
                </div>
              </div>
            </div>
            {/* Septième passe : la saga dans la colonne la faisait grandir, et la première page — calée
                en bas (`justify-end`) — poussait le logo sous le bouton Retour (y ≈ 30 sur un écran de
                900 px). La vraie fiche met ses rangées du dessous dans une seconde section, avec sa
                réserve en haut (`BELOW_SECTION_CLASS`) : la maquette fait pareil, et la colonne garde
                la place qu'elle a dans la vraie. */}
            <div data-alab-stagger className={BELOW_SECTION_CLASS}>
              {saga}
            </div>
          </div>
        </div>
      </>
    );
  }

  // La carte du téléphone commence sous la barre d'état (`phone-sheet-frame`) ; dans le cadre
  // simulé, sous la barre d'état dessinée.
  const top = framed ? `${PHONE_FRAME.statusBar + 8}px` : "calc(env(safe-area-inset-top, 0px) + 0.5rem)";
  return (
    <>
      {dim}
      {/* Le fond de la carte, à part : il monte du bas pendant que la bannière se forme au-dessus. */}
      <div
        ref={cardRef}
        className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-ink ring-1 ring-white/10"
        // Sans pointeur pendant sa fermeture : elle descend encore, l'accueil dessous répond déjà.
        style={dragStyle({ top, pointerEvents: closing ? "none" : undefined, boxShadow: dragOffset > 0 ? "0 -18px 50px rgba(0,0,0,0.55)" : undefined })}
      />
      {frame}
      <div
        ref={sheetRef}
        data-alab-sheet={entryId}
        data-alab-scroll
        inert={quiet}
        className="scrollbar-none absolute inset-x-0 bottom-0 overflow-y-auto overscroll-contain rounded-t-2xl"
        style={dragStyle({ top, pointerEvents: quiet ? "none" : undefined })}
      >
        {/* La poignée, comme dans CinemaMobileDetail : la bannière seule, `touch-action: none` pour
            que le navigateur n'en fasse pas un défilement ; le reste de la fiche défile. */}
        <div
          className="relative aspect-video w-full"
          {...(covered ? {} : handle)}
          style={{ touchAction: "none", maxHeight: framed ? PHONE_FRAME.h * 0.52 : "52svh" }}
        >
          <div ref={imageRef} className="absolute inset-0">
            <img ref={photoRef} src={backdrop} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
            <div data-alab-fade data-alab-veil className="absolute inset-0 bg-linear-to-t from-ink via-ink/20 to-transparent" />
            <button
              ref={closeButtonRef}
              data-alab-fade
              type="button"
              {...NOT_THE_HANDLE}
              onClick={requestClose}
              aria-label="Fermer la fiche"
              // Le verre seulement une fois la fiche posée : un `backdrop-filter` au-dessus du trajet
              // se recalculerait à chaque image.
              className={`${settled ? "nav-glass" : "bg-black/50"} absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full text-white`}
            >
              <X size={18} />
            </button>
          </div>
        </div>
        {/* Chaque ligne repérée pour l'option « Cascade » ; par défaut toutes partent ensemble, d'un
            bloc, avec la bannière. */}
        <div className="relative -mt-6 px-4 pb-16">
          <div data-alab-stagger>
            {title.logoUrl ? (
              <CinemaLogo src={title.logoUrl} alt={title.title} surface="phone" shadow={false} className="mb-3 object-left" />
            ) : (
              <h1 className="mb-3 text-2xl font-bold leading-tight text-white font-display">{title.title}</h1>
            )}
          </div>
          <div data-alab-stagger className="mb-4 flex flex-wrap items-center gap-2 text-sm text-muted">
            <MetaLine title={title} truncateGenres />
          </div>
          <div data-alab-stagger>
            {outside ? (
              <>
                <button type="button" className="mb-2 flex w-full items-center justify-center gap-2 rounded-lg bg-white px-4 py-3 text-base font-semibold text-ink">
                  <Plus size={18} />
                  {t("player.discover.request")}
                </button>
                <button type="button" className="mb-4 flex w-full items-center justify-center gap-2 rounded-lg bg-white/10 px-4 py-3 text-sm font-medium text-white">
                  <Bookmark size={16} />
                  {t("player.discover.addToList")}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="mb-2 flex w-full items-center justify-center gap-2 rounded-lg bg-white px-4 py-3 text-base font-semibold text-ink">
                  <Play size={18} fill="currentColor" />
                  {t("common.play")}
                </button>
                {title.trailerKey && (
                  <button type="button" className="mb-4 flex w-full items-center justify-center gap-2 rounded-lg bg-white/10 px-4 py-3 text-sm font-medium text-white">
                    <Video size={16} />
                    {t("cinema.trailer")}
                  </button>
                )}
              </>
            )}
          </div>
          {(title.tagline?.trim() || title.overview) && (
            <div data-alab-stagger>
              {title.tagline?.trim() && <CinemaTagline text={title.tagline} className="mb-1.5" />}
              {title.overview && <p className="mb-3 text-sm leading-6 text-white">{title.overview}</p>}
            </div>
          )}
          <div data-alab-stagger className="mb-4 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted">{t("cinema.cast")}</span>
            {castButtons}
          </div>
          {!outside && (
            <div data-alab-stagger className="mb-6 flex items-start gap-8">
              <span className="flex w-16 flex-col items-center gap-1.5">
                <Plus size={22} className="text-white" />
                <span className="text-center text-xs leading-tight text-muted">{t("watchlist.statuses.toWatch")}</span>
              </span>
              <span className="flex w-16 flex-col items-center gap-1.5">
                <Check size={22} className="text-white" />
                <span className="text-center text-xs leading-tight text-muted">{t("cinema.markWatched")}</span>
              </span>
            </div>
          )}
          <div data-alab-stagger>{saga}</div>
        </div>
      </div>
    </>
  );
}

/**
 * La fiche d'une personne, ouverte depuis la distribution d'une fiche : photo, nom, filmographie —
 * à l'image de PlayerPersonSheet, réduite à ce qui sert le mouvement. Elle arrive par une montée
 * fondue et non par un trajet : il n'y a pas d'affiche qui devienne une bannière. Sa filmographie
 * ouvre des fiches de titre par-dessus elle, comme la saga d'une fiche.
 */
function MockPersonSheet({
  entryId, name, reduced, covered, phone, framed, hiddenKey, register, related, onOpenTitle, onCloseStart, onClosed, bindHandle,
}: SheetCommon & { entryId: number; name: string; reduced: boolean }) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const dimRef = useRef<HTMLDivElement>(null);
  const openAnimsRef = useRef<Animation[]>([]);
  const closingRef = useRef(false);
  const aliveRef = useRef(true);
  const [frozenOffset, setFrozenOffset] = useState<number | null>(null);
  const [settled, setSettled] = useState(false);
  const closing = frozenOffset !== null;
  const rise = reduced ? 0 : 24;
  // Sa sortie, qu'une autre ouverture peut couper (huitième passe).
  const closeAnimsRef = useRef<Animation[]>([]);
  const closeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    const anims = openAnimsRef.current;
    const opts = reduced ? { duration: 200, easing: "ease-out" } : PERSON_RISE;
    const a = panelRef.current?.animate([{ opacity: 0, transform: `translateY(${rise}px)` }, { opacity: 1, transform: "none" }], { ...opts, fill: "backwards" });
    const b = dimRef.current?.animate([{ opacity: 0 }, { opacity: DIM }], { duration: opts.duration, easing: "ease-out", fill: "both" });
    if (a) anims.push(a);
    if (b) anims.push(b);
    const timer = window.setTimeout(() => {
      if (!closingRef.current) setSettled(true);
    }, opts.duration + 40);
    return () => {
      window.clearTimeout(timer);
      for (const x of anims.splice(0)) x.cancel();
    };
  }, [reduced, rise]);

  const requestClose = () => {
    if (closingRef.current || covered) return;
    closingRef.current = true;
    onCloseStart();
    const panel = panelRef.current;
    const off = panel ? translateYOf(getComputedStyle(panel).transform) : 0;
    const from = { opacity: opacityNow(panel), dim: opacityNow(dimRef.current) };
    for (const a of openAnimsRef.current.splice(0)) a.cancel();
    setFrozenOffset(off);
    setSettled(false);
    const out = { duration: 180, easing: "ease-in", fill: "both" as const };
    for (const a of [
      panel?.animate([{ opacity: from.opacity, transform: `translateY(${off}px)` }, { opacity: 0, transform: `translateY(${off + rise}px)` }], out),
      dimRef.current?.animate([{ opacity: from.dim }, { opacity: 0 }], out),
    ]) {
      if (a) closeAnimsRef.current.push(a);
    }
    closeTimerRef.current = window.setTimeout(() => {
      if (aliveRef.current) onClosed();
    }, 180);
  };

  // Coupée par une autre ouverture : elle s'éteint d'un coup, son assombrissement rendu à la scène.
  const interrupt = () => {
    const left = { dim: opacityNow(dimRef.current), home: 1 };
    for (const a of closeAnimsRef.current.splice(0)) a.cancel();
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    for (const el of [panelRef.current, dimRef.current]) if (el) el.style.opacity = "0";
    if (aliveRef.current) onClosed();
    return left;
  };
  useEffect(() => {
    bindHandle({ interrupt });
    return () => bindHandle(null);
  });

  const swipe = useSwipeToDismiss(requestClose);
  const dragOffset = frozenOffset ?? (phone && swipe.touched ? swipe.offset : 0);

  useEffect(() => {
    if (covered || closing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const quiet = covered || closing;
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const body = (
    <>
      <div className="mb-4 flex items-center gap-4">
        <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full bg-white/10 text-2xl font-semibold text-white ring-1 ring-white/15">
          {initials || "?"}
        </div>
        <h1 className="text-2xl font-bold leading-tight text-white font-display">{name}</h1>
      </div>
      <SheetPosterRow
        label={t("player.person.filmography")}
        items={related}
        entryId={entryId}
        phone={phone}
        hiddenKey={hiddenKey}
        register={register}
        onOpen={onOpenTitle}
        markLastOutside={false}
      />
    </>
  );
  const dim = <div ref={dimRef} aria-hidden="true" className="pointer-events-none absolute inset-0 bg-ink" style={{ opacity: 0 }} />;

  if (!phone) {
    return (
      <>
        {dim}
        <div
          ref={panelRef}
          data-alab-sheet={entryId}
          data-alab-scroll
          inert={quiet}
          className="scrollbar-thin absolute inset-0 overflow-y-auto bg-ink/95"
          style={{ pointerEvents: quiet ? "none" : undefined }}
        >
          <button
            type="button"
            onClick={requestClose}
            className="btn btn-ghost absolute z-10 rounded-full bg-black/55 px-3 py-2 float-edge"
            style={{ top: "max(1rem, env(safe-area-inset-top))", left: "1rem" }}
          >
            <ArrowLeft size={16} /> {t("cinema.back")}
          </button>
          <div className="px-8 pt-24 sm:px-16" style={COLUMN_STYLE}>
            {body}
          </div>
        </div>
      </>
    );
  }

  const top = framed ? `${PHONE_FRAME.statusBar + 8}px` : "calc(env(safe-area-inset-top, 0px) + 0.5rem)";
  return (
    <>
      {dim}
      <div
        ref={panelRef}
        data-alab-sheet={entryId}
        data-alab-scroll
        inert={quiet}
        className="scrollbar-none absolute inset-x-0 bottom-0 overflow-y-auto overscroll-contain rounded-t-2xl bg-ink ring-1 ring-white/10"
        style={{
          top,
          pointerEvents: quiet ? "none" : undefined,
          transform: dragOffset ? `translateY(${dragOffset}px)` : undefined,
          transition: swipe.dragging || closing ? "none" : "transform 280ms cubic-bezier(0.32, 0.72, 0, 1)",
          borderTopLeftRadius: phoneSheetCorner(dragOffset),
          borderTopRightRadius: phoneSheetCorner(dragOffset),
        }}
      >
        {/* La poignée : le haut de la carte, comme la bannière d'une fiche de titre. */}
        <div
          className="relative h-14 w-full"
          {...(covered
            ? {}
            : {
                ...swipe.handlers,
                // Même garde que la fiche d'un titre : le `click` d'un relâchement qui ferme est avalé.
                onPointerUp: (e: ReactPointerEvent) => {
                  const wasClosing = closingRef.current;
                  swipe.handlers.onPointerUp(e);
                  if (!wasClosing && closingRef.current) swallowStrayClick();
                },
              })}
          style={{ touchAction: "none" }}
        >
          <div className="absolute left-1/2 top-2 h-1 w-9 -translate-x-1/2 rounded-full bg-white/25" />
          <button
            type="button"
            {...NOT_THE_HANDLE}
            onClick={requestClose}
            aria-label="Fermer la fiche"
            className={`${settled ? "nav-glass" : "bg-black/50"} absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full text-white`}
          >
            <X size={18} />
          </button>
        </div>
        <div className="px-4 pb-16">{body}</div>
      </div>
    </>
  );
}

/** Une ligne du menu de la fiche du bureau : `MENU_ROW` et sa pastille, comme PlayButton en `variant="row"`. */
function MenuRow({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <button data-alab-stagger type="button" className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}>
      <span className={MENU_BADGE}>{icon}</span>
      <span className="text-sm font-medium">{label}</span>
    </button>
  );
}
