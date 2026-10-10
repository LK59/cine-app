"use client";

/* eslint-disable @next/next/no-img-element -- des `<img>` nus, voulus : le FLIP lit la place exacte de
   l'image, la lueur se découpe sur le logo par un masque, et les visuels sont déjà des tailles du CDN de
   TMDB — l'optimiseur de Next n'apporterait rien à ce banc d'essai. */

import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { ArrowLeft, Bookmark, Check, Play, Plus, RotateCcw, Video, X } from "lucide-react";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import { ImdbBadge } from "@/components/ImdbBadge";
import { CinemaLogo } from "@/components/cinema/CinemaLogo";
import { QualityBadges } from "@/components/cinema/QualityBadges";
import { CinemaTagline } from "@/components/cinema/CinemaDetailExtras";
import { CAST_CLASS, CAST_SHOWN, COLUMN_GAP, COLUMN_STYLE, CinemaOverview, HORIZONTAL_VEIL, MENU_STYLE, SECTION_CLASS, VERTICAL_VEIL } from "@/components/cinema/CinemaDetailLayout";
import { MENU_BADGE, MENU_ROW, MENU_ROW_INACTIVE } from "@/components/cinema/detailMenu";
import { useT } from "@/components/TranslationProvider";
import { formatMinutes } from "@/lib/format";
import { genreLabel } from "@/lib/top10Label";
import { tmdbResize } from "@/lib/images";
import { toSpring } from "@/lib/liquidGlass/liquid";
import { simulateSpring } from "@/lib/liquidGlass/spring";
import { PlaybackIntro } from "@/components/player/PlaybackIntro";
import { INTRO_BACKGROUNDS, PLAYBACK_INTRO, introBackdropSrc, type IntroBackground } from "@/lib/playbackIntro";
import { phoneSheetCorner } from "@/lib/sheetMotion";
import { NOT_THE_HANDLE, useSwipeToDismiss } from "@/lib/useSwipeToDismiss";

/**
 * Deux prototypes de la page « Tests animations » (10/10/2026), à juger sur l'iPhone et le Mac avant
 * d'en brancher quoi que ce soit : le lancement de la lecture, et l'ouverture d'une fiche.
 *
 * Rien ici ne touche au vrai lecteur ni aux vraies fiches. Comme le reste de la page, les textes sont
 * des notes en français, hors dictionnaires. Seules l'opacité, la transformation et la découpe
 * (`clip-path`) s'animent — ce que le compositeur joue seul, sans le fil principal.
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

/**
 * Un ressort en courbe `linear()` : la même trajectoire que les menus du lecteur, mais rendue au
 * navigateur comme une courbe d'accélération — utilisable par `element.animate()` comme par les
 * View Transitions, qui ne prennent pas d'images clés. Repli en courbe de Bézier là où `linear()`
 * n'existe pas.
 */
function springEasing(response: number, ratio: number): { easing: string; duration: number } {
  const samples = simulateSpring(0, 1, toSpring(response, ratio));
  const end = samples[samples.length - 1].t;
  const supported = typeof CSS !== "undefined" && CSS.supports?.("transition-timing-function: linear(0, 1)");
  if (!supported || end <= 0) return { easing: "cubic-bezier(0.32, 0.72, 0, 1)", duration: Math.max(200, end * 1000) };
  const step = Math.max(1, Math.floor(samples.length / 48));
  const points = samples
    .filter((_, i) => i % step === 0 || i === samples.length - 1)
    .map((s) => `${s.x.toFixed(4)} ${((s.t / end) * 100).toFixed(2)}%`);
  return { easing: `linear(${points.join(", ")})`, duration: end * 1000 };
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

type Ease = "spring" | "emphasized" | "easeOut";
type Layout = "auto" | "desktop" | "phone";
/*
 * Le FLIP, ou un fondu sous « Réduire les animations ». Les View Transitions ont été retirées à la
 * quatrième passe (10/10/2026) : à l'ouverture, le navigateur photographie la fiche avant que son
 * visuel soit décodé — une boîte vide qui grandit, le contenu posé d'un coup, « l'ouverture ne
 * marche pas, seulement la fermeture » —, les arrondis ne s'y animent pas, et rien ne permet d'y
 * reprendre un glissement du doigt là où il s'arrête. Le FLIP fait tout cela, partout.
 */
type Mode = "flip" | "fade";
type Timing = { easing: string; duration: number };
/** Une place dans la scène, en pixels depuis son coin haut gauche. */
type Box = { x: number; y: number; w: number; h: number };

/**
 * Ce que la fiche doit savoir de la carte touchée pour en partir, et pour y revenir. `outside` : un
 * titre hors bibliothèque, ouvert dans la variante de la fiche découverte (« Demander » au lieu de
 * « Lire »), comme PlayerDiscoverSheet.
 */
type Opening = { title: CinemaMovie; key: string; poster: string; radius: number; mode: Mode; outside?: boolean };
type OpenTitle = (o: Omit<Opening, "mode">) => void;
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
 * en 220 ms —, lancé à 60 % du trajet pour arriver avec la bannière. La cascade d'avant (logo, puis
 * infos, puis « Lire », puis le synopsis) se lisait « une chose après l'autre, pas tout à fait
 * fluide » sur l'iPhone. Elle reste en option, resserrée : 15 ms par ligne, 150 ms en tout au plus.
 */
const REVEAL_MS = 220;
const REVEAL_AT = 0.6;
const CASCADE_STEP_MS = 15;
const CASCADE_TOTAL_MS = 150;
// L'effacement du contenu à la fermeture, depuis l'opacité où il en est.
const CONTENT_OUT_MS = 100;
// L'assombrissement de ce qui est derrière la fiche, et le recul de l'accueil du bureau.
const DIM = 0.6;
const HOME_SCALE = 0.98;
/*
 * Le fondu affiche → visuel, en images clés sur toute la durée (courbe linéaire, adoucie par
 * segment) : l'affiche s'efface sur le premier tiers, le visuel paraît de 10 à 50 %. Un fondu de
 * moitié chacun laissait les deux se mêler longtemps.
 *
 * La fermeture n'est plus l'exact inverse (quatrième passe) : l'affiche ne revenait que sur le
 * dernier tiers, et la bannière « redevenait l'affiche » d'un coup. Les deux fondus s'étirent
 * maintenant sur presque tout le retour et se chevauchent — l'affiche paraît de 25 à 85 %, la
 * bannière et ses voiles s'effacent de 35 à 95 %. Ils partent de l'opacité où en est chacun : une
 * fermeture pendant l'ouverture repart de là, sans saut.
 */
const POSTER_OUT: Keyframe[] = [{ opacity: 1, easing: "ease-in" }, { opacity: 0, offset: 0.35 }, { opacity: 0 }];
const BACKDROP_IN: Keyframe[] = [{ opacity: 0 }, { opacity: 0, offset: 0.1, easing: "ease-out" }, { opacity: 1, offset: 0.5 }, { opacity: 1 }];
const posterIn = (from: number): Keyframe[] => [{ opacity: from }, { opacity: from, offset: 0.25, easing: "ease-in-out" }, { opacity: 1, offset: 0.85 }, { opacity: 1 }];
const backdropOut = (from: number): Keyframe[] => [{ opacity: from }, { opacity: from, offset: 0.35, easing: "ease-in-out" }, { opacity: 0, offset: 0.95 }, { opacity: 0 }];
// Le relais final de la fermeture : la vraie carte reparaît sous le calque du trajet, qui s'efface
// par-dessus en ce temps-là — plus de bascule de visibilité qui se voie (le logo de la grande
// bannière du téléphone, absent de l'affiche du trajet, surgissait d'un coup).
const HANDOVER_MS = 120;
// La sortie sans trajet, quand l'affiche d'où la fiche était partie n'est plus à l'écran : la fiche
// descend un peu en s'effaçant.
const PLAIN_OUT_MS = 220;
const PLAIN_OUT_DROP = 48;
// Le téléphone simulé quand la disposition « Téléphone » est demandée sur un grand écran.
const PHONE_FRAME = { w: 390, h: 844, statusBar: 47 };

/**
 * La durée réelle d'un ressort de réponse 1 s à cet amortissement : elle croît en proportion de la
 * réponse, si bien qu'une division suffit pour qu'un ressort dure ce qu'on demande. Avant, la
 * réponse *était* la durée demandée, et le ressort mettait ~1,27 fois plus à se poser — 250 ms
 * demandées en jouaient 320.
 */
let springPerSecond = 0;
function easingFor(ease: Ease, duration: number): Timing {
  if (ease === "spring") {
    if (!springPerSecond) springPerSecond = springEasing(1, 0.86).duration / 1000 || 1;
    return springEasing(Math.max(0.1, duration / 1000 / springPerSecond), 0.86);
  }
  if (ease === "emphasized") return { easing: "cubic-bezier(0.2, 0, 0, 1)", duration };
  return { easing: "cubic-bezier(0.33, 1, 0.68, 1)", duration };
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

/** La découpe qui ne laisse voir que `b` d'un calque de `W` × `H` — animable d'une place à l'autre. */
function insetClip(b: Box, W: number, H: number, radius: string): string {
  return `inset(${b.y}px ${W - b.x - b.w}px ${H - b.y - b.h}px ${b.x}px round ${radius})`;
}

/** La transformation (origine en haut à gauche) qui fait couvrir `into` à un élément posé sur `at`, proportions gardées. */
function coverTransform(at: Box, into: Box): string {
  const s = Math.max(into.w / Math.max(1, at.w), into.h / Math.max(1, at.h));
  const tx = into.x + into.w / 2 - (s * at.w) / 2 - at.x;
  const ty = into.y + into.h / 2 - (s * at.h) / 2 - at.y;
  return `translate(${tx}px, ${ty}px) scale(${s})`;
}

/** Le décalage vertical d'une transformation calculée (`matrix(…)`, `matrix3d(…)`) ou écrite (`translateY(…)`). */
function translateYOf(transform: string): number {
  const m = /^matrix(3d)?\((.+)\)$/.exec(transform);
  if (m) {
    const v = m[2].split(",").map(Number);
    return (m[1] ? v[13] : v[5]) || 0;
  }
  const y = /translateY\((-?[\d.]+)px\)/.exec(transform);
  return y ? Number(y[1]) : 0;
}

/** L'opacité où en est un élément, animations comprises — 1 quand le navigateur n'en dit rien (jsdom). */
function opacityNow(el: Element | null): number {
  if (!el) return 1;
  const v = parseFloat(getComputedStyle(el).opacity);
  return Number.isFinite(v) ? v : 1;
}

function place(el: HTMLElement, b: Box) {
  Object.assign(el.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
}

export function SheetOpenLot({ movies }: { movies: readonly CinemaMovie[] }) {
  const { withLogo } = useMemo(() => usableTitles(movies), [movies]);
  // 250 ms (quatrième passe) : à 520 ms, « joli, mais il faut absolument plus rapide ».
  const [duration, setDuration] = useState(250);
  const [ease, setEase] = useState<Ease>("spring");
  // D'un seul bloc par défaut (cinquième passe) ; la cascade, resserrée, reste à comparer.
  const [stagger, setStagger] = useState(false);
  const [layout, setLayout] = useState<Layout>("auto");
  const [reduced, setReduced] = useState(prefersReduced);
  const [staged, setStaged] = useState(false);
  const timing = useMemo(() => easingFor(ease, duration), [ease, duration]);

  return (
    <section className="space-y-4 rounded-2xl border border-white/8 bg-white/[0.03] p-4">
      <p className="text-sm text-muted">
        {"Une maquette de l'accueil et des vraies fiches — visuel et logo, pas d'affiche. Au bureau, l'affiche touchée s'agrandit jusqu'à l'écran entier en devenant le visuel du film ; au téléphone, elle devient la bannière 16:9 pendant que la carte monte du bas. Le contenu arrive d'un seul bloc avec la bannière. Dans la fiche, « Dans la même saga » ouvre une fiche par-dessus (la dernière affiche est hors bibliothèque : variante « Demander »), et un nom de la distribution ouvre la fiche de la personne — d'où l'on peut rouvrir un film, à n'importe quelle profondeur. Fermer (Retour, la croix, Échap, ou la bannière tirée vers le bas au téléphone) ne ferme que la fiche du dessus, et revient dans l'affiche d'où elle est partie si elle est encore à l'écran."}
      </p>
      <Row label="Courbe">
        <Chip on={ease === "spring"} onClick={() => setEase("spring")}>Ressort Apple</Chip>
        <Chip on={ease === "emphasized"} onClick={() => setEase("emphasized")}>Accentuée</Chip>
        <Chip on={ease === "easeOut"} onClick={() => setEase("easeOut")}>Décélération douce</Chip>
      </Row>
      <p className="text-xs leading-5 text-subtle">
        {"Ressort Apple : un ressort physique (réponse ≈ la durée, amortissement 0,86, dépassement d'environ 1 %), rendu en courbe CSS linear(). Accentuée : la décélération « emphasized » de Material 3, cubic-bezier(0.2, 0, 0, 1) — départ très vif, longue arrivée lente. Décélération douce : ease-out cubique, cubic-bezier(0.33, 1, 0.68, 1) — départ plus tranquille. Toutes trois freinent à l'arrivée : sur un trajet court elles se ressemblent ; au ralenti, la différence se voit au départ."}
      </p>
      <Row label="Disposition">
        <Chip on={layout === "auto"} onClick={() => setLayout("auto")}>Selon l&apos;écran</Chip>
        <Chip on={layout === "desktop"} onClick={() => setLayout("desktop")}>Bureau</Chip>
        <Chip on={layout === "phone"} onClick={() => setLayout("phone")}>Téléphone</Chip>
      </Row>
      <Row label="Options">
        <Chip on={stagger} onClick={() => setStagger(!stagger)}>Cascade du contenu</Chip>
        <Chip on={reduced} onClick={() => setReduced(!reduced)}>« Réduire les animations »</Chip>
      </Row>
      <Slider label={`Durée ${duration} ms${ease === "spring" ? ` (ressort : ${Math.round(timing.duration)} ms réels)` : ""}`} min={150} max={1000} step={25} value={duration} set={setDuration} />
      <button type="button" className="btn-primary inline-flex items-center gap-2" disabled={withLogo.length === 0} onClick={() => setStaged(true)}>
        <Play size={16} /> {withLogo.length === 0 ? "Chargement du catalogue…" : "Ouvrir la maquette"}
      </button>
      {staged &&
        createPortal(
          <SheetStage titles={withLogo} timing={timing} stagger={stagger} layout={layout} reduced={reduced} onExit={() => setStaged(false)} />,
          document.body,
        )}
    </section>
  );
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
  timing: Timing;
  /** La clé de l'affiche d'où part la fiche au-dessus, cachée le temps qu'elle soit ouverte. */
  hiddenKey: string | null;
  register: Register;
  /** Les titres de ses rangées (saga, filmographie). */
  related: CinemaMovie[];
  onOpenTitle: OpenTitle;
  onOpenPerson: (name: string) => void;
  /** La fermeture commence : la scène n'ouvre plus rien tant qu'elle n'est pas finie. */
  onCloseStart: () => void;
  onClosed: () => void;
};

function SheetStage({
  titles, timing, stagger, layout, reduced, onExit,
}: {
  titles: CinemaMovie[];
  timing: Timing;
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
  // Fermetures en cours : un appui pendant l'une d'elles n'ouvre rien. La fiche qui part n'a plus
  // d'avis, et une fiche ouverte au même instant se serait glissée sous son retour.
  const closingCount = useRef(0);

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

  const openTitle: OpenTitle = (o) => {
    if (closingCount.current > 0) return;
    const top = stack[stack.length - 1];
    // Une affiche qui est le titre même de la fiche du dessus ne la rouvre pas par-dessus elle.
    if (top?.kind === "title" && top.opening.title.radarrId === o.title.radarrId && !!top.opening.outside === !!o.outside) return;
    const el = sources.current.get(o.key);
    const entry: Entry = { id: nextId.current++, kind: "title", opening: { ...o, mode: reduced || !el ? "fade" : "flip" } };
    setStack((s) => [...s, entry]);
  };
  const openPerson = (name: string) => {
    if (closingCount.current > 0) return;
    const entry: Entry = { id: nextId.current++, kind: "person", name };
    setStack((s) => [...s, entry]);
  };
  const closeStart = () => {
    closingCount.current += 1;
  };
  // Appelée par une fiche une fois sa sortie jouée : elle seule quitte la pile, par son identité.
  const closed = (id: number) => {
    closingCount.current = Math.max(0, closingCount.current - 1);
    setStack((s) => s.filter((e) => e.id !== id));
  };

  const keyOf = (e: Entry | undefined) => (e?.kind === "title" ? e.opening.key : null);
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
        <PhoneHome titles={titles} framed={framed} hiddenKey={keyOf(stack[0])} register={register} onOpen={openTitle} />
      ) : (
        <DesktopHome titles={titles} hiddenKey={keyOf(stack[0])} register={register} onOpen={openTitle} />
      )}
      {/* En haut à droite, la pilule tombait sur la croix de la fiche du téléphone : elle descend
          au milieu du bas, là où ni l'accueil ni la fiche simulés n'ont de commande. */}
      <button
        type="button"
        onClick={onExit}
        className={`nav-glass absolute z-30 flex h-9 items-center gap-2 rounded-full px-3 text-xs text-white ${phone ? "left-1/2 -translate-x-1/2" : "right-4"}`}
        style={phone ? { bottom: framed ? 20 : "max(1rem, env(safe-area-inset-bottom))" } : { top: "max(1rem, env(safe-area-inset-top))" }}
      >
        <X size={14} /> Quitter la maquette
      </button>
      {stack.map((e, i) => {
        const common: SheetCommon = {
          depth: i,
          covered: i < stack.length - 1,
          phone,
          framed,
          rootRef,
          sources,
          timing,
          hiddenKey: keyOf(stack[i + 1]),
          register,
          related: relatedFor(e.kind === "title" ? e.opening.title.radarrId : null, i + 1),
          onOpenTitle: openTitle,
          onOpenPerson: openPerson,
          onCloseStart: closeStart,
          onClosed: () => closed(e.id),
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

  return (
    <div className="fixed inset-0 z-[100] bg-black">
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
                <button
                  key={key}
                  ref={register(key)}
                  type="button"
                  onClick={() => onOpen({ title: m, key, poster: m.posterUrl ?? "", radius: 8 })}
                  // La carte de CinemaCard, survol compris.
                  className={`${CARD_WIDTH} relative shrink-0 overflow-hidden rounded-lg shadow-lg shadow-black/40 transition-[transform,box-shadow] duration-200 hover:z-10 hover:scale-105 hover:shadow-xl hover:shadow-black/60`}
                  style={{ visibility: hiddenKey === key ? "hidden" : undefined }}
                >
                  <img src={m.posterUrl ?? ""} alt={m.title} className="block aspect-[2/3] w-full object-cover" />
                </button>
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
              return (
                <div key={key} className={`hero-peek-slide shrink-0 px-1.5 ${on ? "hero-peek-on" : ""}`}>
                  <button
                    ref={on ? register(key) : undefined}
                    type="button"
                    tabIndex={on ? 0 : -1}
                    onClick={on ? () => onOpen({ title: m, key, poster, radius: 16 }) : undefined}
                    className="relative block w-full overflow-hidden rounded-2xl bg-surface text-left shadow-xl shadow-black/50"
                    style={{ visibility: hiddenKey === key ? "hidden" : undefined }}
                  >
                    <img src={poster} alt="" className="block aspect-[2/3] w-full object-cover" />
                    {m.logoUrl && (
                      <div className="absolute inset-x-0 bottom-0 flex justify-center bg-linear-to-t from-black/70 to-transparent px-6 pb-6 pt-20">
                        <CinemaLogo src={m.logoUrl} alt={m.title} surface="phone" className="object-center" />
                      </div>
                    )}
                  </button>
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
                <button
                  key={key}
                  ref={register(key)}
                  type="button"
                  onClick={() => onOpen({ title: m, key, poster: m.posterUrl ?? "", radius: 8 })}
                  className={`${PHONE_POSTER_WIDTH} relative shrink-0 overflow-hidden rounded-lg bg-surface`}
                  style={{ visibility: hiddenKey === key ? "hidden" : undefined }}
                >
                  <img src={m.posterUrl ?? ""} alt={m.title} className="block aspect-[2/3] w-full object-cover" />
                </button>
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
            <button
              key={key}
              ref={register(key)}
              type="button"
              onClick={() => onOpen({ title: m, key, poster: m.posterUrl ?? "", radius: 8, outside })}
              className={`${phone ? PHONE_POSTER_WIDTH : SHEET_POSTER_WIDTH} relative shrink-0 overflow-hidden rounded-lg bg-surface shadow-lg shadow-black/40`}
              style={{ visibility: hiddenKey === key ? "hidden" : undefined }}
            >
              <img src={m.posterUrl ?? ""} alt={m.title} className="block aspect-[2/3] w-full object-cover" />
              {outside && (
                <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-accent-400 ring-1 ring-accent-400/40">
                  {t("player.notInLibrary")}
                </span>
              )}
            </button>
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
function MockSheet({
  entryId, opening, stagger, depth, covered, phone, framed, rootRef, sources, timing, hiddenKey, register, related,
  onOpenTitle, onOpenPerson, onCloseStart, onClosed,
}: SheetCommon & { entryId: number; opening: Opening; stagger: boolean }) {
  const t = useT();
  const { title, mode, outside } = opening;
  const sheetRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  // Le visuel du trajet et ses voiles, dans une seule enveloppe : une échelle, une opacité.
  const morphBackdropRef = useRef<HTMLDivElement>(null);
  const morphPosterRef = useRef<HTMLImageElement>(null);
  const imageRef = useRef<HTMLDivElement>(null);
  const photoRef = useRef<HTMLImageElement>(null);
  const dimRef = useRef<HTMLDivElement>(null);
  const homeAnimRef = useRef<Animation | null>(null);
  const closingRef = useRef(false);
  const openTimersRef = useRef<number[]>([]);
  // Toutes les animations de l'ouverture, pour que la fermeture les arrête d'un coup.
  const openAnimsRef = useRef<Animation[]>([]);
  // Le flou localisé du bas de la fiche du bureau (`backdrop-blur`) n'est posé qu'une fois le
  // visuel arrivé : un filtre ne doit pas voyager avec un calque qui bouge.
  const [settled, setSettled] = useState(mode === "fade");
  // Où le doigt a laissé la fiche quand la fermeture a commencé (0 pour la croix ou Échap) :
  // gelé là, pour que le décalage du geste, que `useSwipeToDismiss` pousse ensuite jusqu'au bas de
  // l'écran, ne fasse pas sauter la fiche sous le trajet de retour. Non nul : la fiche se ferme.
  const [frozenOffset, setFrozenOffset] = useState<number | null>(null);
  const closing = frozenOffset !== null;
  const backdrop = title.backdropUrl ?? "";
  const imageRadius = phone ? "16px 16px 0px 0px" : "0px 0px 0px 0px";
  const sourceRadius = `${opening.radius}px ${opening.radius}px ${opening.radius}px ${opening.radius}px`;
  // Seule la première fiche fait reculer l'accueil ; celles du dessus passent devant une fiche.
  const scalesHome = !phone && depth === 0;

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
   * Le visuel de la fiche et ses voiles, cachés le temps du trajet : c'est la copie du calque découpé
   * qui se montre. Les voiles sont repérés par `data-alab-veil`.
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
    const play = (el: Element | null, frames: Keyframe[], opts: KeyframeAnimationOptions) => {
      const a = el?.animate(frames, { fill: "both", ...opts });
      if (a) anims.push(a);
    };
    // Un rappel de l'ouverture ne s'exécute que tant qu'aucune fermeture n'a commencé.
    const later = (fn: () => void, ms: number) =>
      timers.push(
        window.setTimeout(() => {
          if (!closingRef.current) fn();
        }, ms),
      );
    const cleanup = () => {
      for (const a of anims.splice(0)) a.cancel();
      for (const id of timers.splice(0)) window.clearTimeout(id);
    };
    if (mode === "fade") {
      // « Réduire les animations » : un fondu simple, rien qui se déplace.
      play(sheet, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
      play(cardRef.current, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
      play(dimRef.current, [{ opacity: 0 }, { opacity: DIM }], { duration: 200, easing: "ease-out" });
      return cleanup;
    }
    const m = measure();
    if (!m) return cleanup;
    const d = timing.duration;
    // Ce qui est derrière s'éteint : la fiche passe devant, elle ne remplace rien. Une courbe simple
    // et non le ressort, dont le dépassement ferait clignoter l'assombrissement.
    play(dimRef.current, [{ opacity: 0 }, { opacity: DIM }], { duration: d, easing: "cubic-bezier(0.33, 1, 0.68, 1)" });
    const { items, fades } = parts();
    // Le contenu part à 60 % du trajet et arrive avec la bannière, d'un bloc.
    revealContent(items, d * REVEAL_AT, stagger, play);
    fades.forEach((el) => play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: d * 0.6, delay: d * 0.3, easing: "ease-out" }));
    // Sans remplissage à la fin : la montée finie, c'est le style de la carte qui reprend sa
    // transformation — celle du doigt quand on tire la fiche. Une animation restée « both » la
    // tiendrait à sa place pour toujours.
    play(cardRef.current, [{ transform: `translateY(${m.cardDrop}px)` }, { transform: "none" }], { ...timing, fill: "backwards" });
    later(() => setSettled(true), d + 40);

    const frame = frameRef.current;
    const bd = morphBackdropRef.current;
    const poster = morphPosterRef.current;
    const photo = photoRef.current;
    if (mode === "flip" && frame && bd && poster && photo) {
      place(bd, m.target);
      place(poster, m.source);
      frame.style.display = "";
      showSheetImage(false);
      play(frame, [{ clipPath: insetClip(m.source, m.W, m.H, sourceRadius) }, { clipPath: insetClip(m.target, m.W, m.H, imageRadius) }], timing);
      play(bd, [{ transform: coverTransform(m.target, m.source) }, { transform: "none" }], timing);
      play(bd, BACKDROP_IN, { duration: d, easing: "linear" });
      play(poster, [{ transform: "none" }, { transform: coverTransform(m.source, m.target) }], timing);
      play(poster, POSTER_OUT, { duration: d, easing: "linear" });
      // Au bureau, l'accueil recule d'un rien : la profondeur, sans rien déplacer qui se lise.
      const h = scalesHome ? home() : null;
      if (h) {
        homeAnimRef.current = h.animate([{ transform: "none" }, { transform: `scale(${HOME_SCALE})` }], { duration: d, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "both" });
        anims.push(homeAnimRef.current);
      }
      later(() => {
        frame.style.display = "none";
        showSheetImage(true);
      }, d);
    }
    return cleanup;
    // Une fois, à l'ouverture : les réglages ne changent pas pendant qu'une fiche est ouverte, et
    // `measure` / `parts` ne lisent que des refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, phone, timing, stagger, sourceRadius, imageRadius]);

  const requestClose = () => {
    if (closingRef.current || covered) return;
    closingRef.current = true;
    onCloseStart();
    const d = timing.duration;
    const sheet = sheetRef.current;
    const frame = frameRef.current;
    const bd = morphBackdropRef.current;
    const poster = morphPosterRef.current;
    const card = cardRef.current;
    const dim = dimRef.current;
    const h = scalesHome ? home() : null;
    const { items, fades } = parts();

    // 1. Tout lire d'où on en est, *avant* d'arrêter l'ouverture — le doigt, la montée de la carte,
    //    la découpe et les échelles du trajet, chaque opacité.
    const off = sheet ? translateYOf(getComputedStyle(sheet).transform) : 0;
    const cardFrom = card ? translateYOf(getComputedStyle(card).transform) : off;
    const midOpen = !!frame && frame.style.display !== "none";
    const now = {
      clip: midOpen && frame ? getComputedStyle(frame).clipPath : "",
      bdTransform: midOpen && bd ? getComputedStyle(bd).transform : "",
      bdOpacity: midOpen ? opacityNow(bd) : 1,
      posterTransform: midOpen && poster ? getComputedStyle(poster).transform : "",
      posterOpacity: midOpen ? opacityNow(poster) : 0,
      dim: opacityNow(dim),
      home: h ? getComputedStyle(h).transform : "none",
    };
    const snapshot = new Map<HTMLElement, number>();
    for (const el of [...items, ...fades]) snapshot.set(el, opacityNow(el));

    // 2. L'ouverture s'arrête net : plus rien d'elle ne peut révéler une ligne ou basculer un calque.
    for (const a of openAnimsRef.current.splice(0)) a.cancel();
    for (const id of openTimersRef.current.splice(0)) window.clearTimeout(id);
    homeAnimRef.current = null;
    setSettled(false);
    setFrozenOffset(off);

    // 3. Le contenu s'efface depuis où il en est ; rien ne se rejoue à l'envers.
    fadeContentOut(items, snapshot, CONTENT_OUT_MS);
    fadeContentOut(fades, snapshot, Math.max(CONTENT_OUT_MS, d * 0.5));

    if (mode === "fade") {
      sheet?.animate([{ opacity: opacityNow(sheet) }, { opacity: 0 }], { duration: 180, easing: "ease-in", fill: "both" });
      card?.animate([{ opacity: opacityNow(card) }, { opacity: 0 }], { duration: 180, easing: "ease-in", fill: "both" });
      dim?.animate([{ opacity: now.dim }, { opacity: 0 }], { duration: 180, easing: "ease-in", fill: "both" });
      window.setTimeout(onClosed, 180);
      return;
    }

    // L'accueil reprend sa taille avant la mesure (l'animation vient d'être annulée) : la carte
    // d'arrivée se lit à sa vraie place, pas à celle de l'accueil reculé.
    const m = measure();
    const src = sources.current.get(opening.key);
    const root = rootRef.current;
    const homeBack = () => {
      // Sans remplissage : à la fin, l'accueil retrouve simplement son état.
      if (h && now.home !== "none") h.animate([{ transform: now.home }, { transform: "none" }], { ...timing });
    };

    // L'affiche d'origine n'est plus à l'écran (la rangée a défilé, la fiche du dessous aussi) : pas
    // de trajet vers un endroit qu'on ne voit pas — la fiche descend un peu en s'effaçant.
    if (!m || !frame || !bd || !poster || !src || !root || !sourceOnScreen(src, root)) {
      if (frame) frame.style.display = "none";
      showSheetImage(true);
      const out = { duration: PLAIN_OUT_MS, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "both" as const };
      sheet?.animate([{ opacity: 1, transform: `translateY(${off}px)` }, { opacity: 0, transform: `translateY(${off + PLAIN_OUT_DROP}px)` }], out);
      card?.animate([{ opacity: 1, transform: `translateY(${cardFrom}px)` }, { opacity: 0, transform: `translateY(${cardFrom + PLAIN_OUT_DROP}px)` }], out);
      dim?.animate([{ opacity: now.dim }, { opacity: 0 }], out);
      homeBack();
      window.setTimeout(() => {
        if (src) src.style.visibility = "";
        onClosed();
      }, PLAIN_OUT_MS);
      return;
    }

    // Remesuré ici : la fiche du téléphone a pu défiler, la bannière n'est plus forcément en haut.
    place(bd, m.target);
    place(poster, m.source);
    frame.style.display = "";
    showSheetImage(false);
    const opts = { ...timing, fill: "both" as const };
    // Tirée vers le bas, la carte a pris les coins arrondis du geste : le retour part de ceux-là.
    const c = phone ? phoneSheetCorner(off) : 0;
    const fromRadius = phone ? `${c}px ${c}px 0px 0px` : imageRadius;
    const fromClip = now.clip && now.clip !== "none" ? now.clip : insetClip(m.target, m.W, m.H, fromRadius);
    const back = frame.animate([{ clipPath: fromClip }, { clipPath: insetClip(m.source, m.W, m.H, sourceRadius) }], opts);
    bd.animate([{ transform: now.bdTransform && now.bdTransform !== "none" ? now.bdTransform : "none" }, { transform: coverTransform(m.target, m.source) }], opts);
    bd.animate(backdropOut(now.bdOpacity), { duration: d, easing: "linear", fill: "both" });
    poster.animate([{ transform: now.posterTransform && now.posterTransform !== "none" ? now.posterTransform : coverTransform(m.source, m.target) }, { transform: "none" }], opts);
    poster.animate(posterIn(now.posterOpacity), { duration: d, easing: "linear", fill: "both" });
    // La carte part d'où elle en est (le doigt, ou sa montée interrompue), et finit sous l'écran.
    card?.animate([{ transform: `translateY(${cardFrom}px)` }, { transform: `translateY(${off + m.cardDrop}px)` }], opts);
    dim?.animate([{ opacity: now.dim }, { opacity: 0 }], { duration: d, easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "both" });
    homeBack();
    // Le relais : la vraie carte reparaît dessous, et le calque, maintenant superposé à elle, s'efface.
    back.onfinish = () => {
      src.style.visibility = "";
      frame.animate([{ opacity: 1 }, { opacity: 0 }], { duration: HANDOVER_MS, easing: "ease-out", fill: "both" }).onfinish = () => onClosed();
    };
  };

  // Le geste de la vraie fiche du téléphone, à l'identique : la bannière pour poignée, la croix
  // tenue hors de la poignée. Couverte, la fiche ne le reçoit pas.
  const swipe = useSwipeToDismiss(requestClose);
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
  // du FLIP. Le visuel y emporte une copie de ses voiles, qui grandit avec lui.
  const frame = (
    <div ref={frameRef} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden bg-ink" style={{ display: "none" }}>
      <div ref={morphBackdropRef} className="absolute overflow-hidden" style={{ transformOrigin: "0 0", opacity: 0 }}>
        <img src={backdrop} alt="" className="absolute inset-0 h-full w-full object-cover" />
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
          style={{ pointerEvents: quiet ? "none" : undefined }}
        >
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
                <div data-alab-stagger className="pb-10">
                  {saga}
                </div>
              </div>
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
        style={dragStyle({ top, boxShadow: dragOffset > 0 ? "0 -18px 50px rgba(0,0,0,0.55)" : undefined })}
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
          {...(covered ? {} : swipe.handlers)}
          style={{ touchAction: "none", maxHeight: framed ? PHONE_FRAME.h * 0.52 : "52svh" }}
        >
          <div ref={imageRef} className="absolute inset-0">
            <img ref={photoRef} src={backdrop} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
            <div data-alab-fade data-alab-veil className="absolute inset-0 bg-linear-to-t from-ink via-ink/20 to-transparent" />
            <button
              data-alab-fade
              type="button"
              {...NOT_THE_HANDLE}
              onClick={requestClose}
              aria-label="Fermer la fiche"
              className="nav-glass absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full text-white"
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
  entryId, name, reduced, covered, phone, framed, timing, hiddenKey, register, related, onOpenTitle, onCloseStart, onClosed,
}: SheetCommon & { entryId: number; name: string; reduced: boolean }) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const dimRef = useRef<HTMLDivElement>(null);
  const openAnimsRef = useRef<Animation[]>([]);
  const closingRef = useRef(false);
  const [frozenOffset, setFrozenOffset] = useState<number | null>(null);
  const closing = frozenOffset !== null;
  const rise = reduced ? 0 : 24;

  useLayoutEffect(() => {
    const anims = openAnimsRef.current;
    const opts = reduced ? { duration: 200, easing: "ease-out" } : timing;
    const a = panelRef.current?.animate([{ opacity: 0, transform: `translateY(${rise}px)` }, { opacity: 1, transform: "none" }], { ...opts, fill: "backwards" });
    const b = dimRef.current?.animate([{ opacity: 0 }, { opacity: DIM }], { duration: opts.duration, easing: "ease-out", fill: "both" });
    if (a) anims.push(a);
    if (b) anims.push(b);
    return () => {
      for (const x of anims.splice(0)) x.cancel();
    };
  }, [reduced, rise, timing]);

  const requestClose = () => {
    if (closingRef.current || covered) return;
    closingRef.current = true;
    onCloseStart();
    const panel = panelRef.current;
    const off = panel ? translateYOf(getComputedStyle(panel).transform) : 0;
    const from = { opacity: opacityNow(panel), dim: opacityNow(dimRef.current) };
    for (const a of openAnimsRef.current.splice(0)) a.cancel();
    setFrozenOffset(off);
    const out = { duration: 180, easing: "ease-in", fill: "both" as const };
    panel?.animate([{ opacity: from.opacity, transform: `translateY(${off}px)` }, { opacity: 0, transform: `translateY(${off + rise}px)` }], out);
    dimRef.current?.animate([{ opacity: from.dim }, { opacity: 0 }], out);
    window.setTimeout(onClosed, 180);
  };

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
        <div className="relative h-14 w-full" {...(covered ? {} : swipe.handlers)} style={{ touchAction: "none" }}>
          <div className="absolute left-1/2 top-2 h-1 w-9 -translate-x-1/2 rounded-full bg-white/25" />
          <button
            type="button"
            {...NOT_THE_HANDLE}
            onClick={requestClose}
            aria-label="Fermer la fiche"
            className="nav-glass absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full text-white"
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
