"use client";

/* eslint-disable @next/next/no-img-element -- des `<img>` nus, voulus : le FLIP lit la place exacte de
   l'image, la lueur se découpe sur le logo par un masque, et les visuels sont déjà des tailles du CDN de
   TMDB — l'optimiseur de Next n'apporterait rien à ce banc d'essai. */

import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { ArrowLeft, Check, Play, Plus, RotateCcw, Video, X } from "lucide-react";
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

type Caption = "none" | "episode" | "resume";
type Phase = "intro" | "video";
type BgMode = "light" | "net" | "strong" | "old";

/**
 * Les fonds proposés, le premier par défaut. « Net » depuis le 10/10/2026 : même adouci, le flou
 * se voyait comme une image de basse qualité ; net en 1 280 px, le voile suffit à faire lire le
 * logo. « Flou léger » reste pour comparer — 1 280 px adoucie de 10 px, pas les gros pixels de
 * l'ancienne image de 300 px agrandie.
 */
const BG_MODES: { id: BgMode; label: string; blur: number }[] = [
  { id: "net", label: "Net", blur: 0 },
  { id: "light", label: "Flou léger", blur: 10 },
  { id: "strong", label: "Flou marqué", blur: 24 },
  { id: "old", label: "Ancien (300 px agrandi)", blur: 0 },
];

/** Le visuel du fond : la petite image d'avant pour comparer, sinon 1 280 px — l'original quand l'écran en montre plus. */
function bgSource(url: string | null, mode: BgMode): string {
  if (!url) return "";
  if (mode === "old") return tmdbResize(url, "w300") ?? url;
  const wide = typeof window !== "undefined" && window.innerWidth * (window.devicePixelRatio || 1) > 1700;
  return tmdbResize(url, wide ? "original" : "w1280") ?? url;
}

/**
 * Le voile du fond. Plus dense sur une image nette, qui garde tous ses détails derrière le logo :
 * un voile radial pour le centrer, un dégradé du bas pour la légende et la ligne de chargement.
 * `brightness` (en %, 0 par défaut — le voile d'origine) l'allège ou l'épaissit d'autant : +30
 * retire 30 % de chaque opacité, −30 en ajoute 30 %, plafonné pour que le fond reste visible.
 */
function bgVeil(mode: BgMode, brightness = 0): string {
  const a = (alpha: number) => `rgba(0,0,0,${Math.min(0.95, alpha * (1 - brightness / 100)).toFixed(3)})`;
  if (mode === "net") {
    return `radial-gradient(ellipse at center, ${a(0.3)}, ${a(0.82)} 78%), linear-gradient(to top, ${a(0.6)}, rgba(0,0,0,0) 45%)`;
  }
  if (mode === "old") return `radial-gradient(ellipse at center, ${a(0.35)}, ${a(0.78)} 75%)`;
  return `radial-gradient(ellipse at center, ${a(0.25)}, ${a(0.72)} 78%), linear-gradient(to top, ${a(0.45)}, rgba(0,0,0,0) 40%)`;
}

export function PlayerIntroLot({ movies }: { movies: readonly CinemaMovie[] }) {
  const { withLogo, withoutLogo } = useMemo(() => usableTitles(movies), [movies]);
  const choices = useMemo(() => (withoutLogo ? [...withLogo.slice(0, 6), withoutLogo] : withLogo.slice(0, 6)), [withLogo, withoutLogo]);
  const [pick, setPick] = useState(0);
  const [delay, setDelay] = useState(2000);
  const [threshold, setThreshold] = useState(300);
  const [zoom, setZoom] = useState(1.08);
  const [logoMs, setLogoMs] = useState(600);
  const [sweep, setSweep] = useState(true);
  const [caption, setCaption] = useState<Caption>("none");
  const [reduced, setReduced] = useState(prefersReduced);
  const [bg, setBg] = useState<BgMode>("net");
  const [brightness, setBrightness] = useState(0);
  const [run, setRun] = useState(0);
  const title = choices.length > 0 ? choices[Math.min(pick, choices.length - 1)] : null;

  // Le fond demandé d'avance, dès qu'il est choisi : à « Lancer », il est d'ordinaire déjà en cache.
  useEffect(() => {
    if (!title?.backdropUrl) return;
    const img = new Image();
    img.src = bgSource(title.backdropUrl, bg);
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
        {BG_MODES.map((m) => (
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

function captionText(caption: Caption): string | null {
  if (caption === "episode") return "S01·É03 · Le Fil de l'histoire";
  if (caption === "resume") return "Reprise à 1 h 12";
  return null;
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
  bg: BgMode;
  brightness: number;
  onReplay: () => void;
  onClose: () => void;
}) {
  // Sous le seuil, la « vidéo » est prête avant qu'une ouverture ait un sens : pas d'ouverture.
  const direct = delay < threshold;
  const [phase, setPhase] = useState<Phase>(direct ? "video" : "intro");
  const backdropRef = useRef<HTMLDivElement>(null);
  const bgImgRef = useRef<HTMLImageElement>(null);
  const logoRef = useRef<HTMLDivElement>(null);
  const sweepRef = useRef<HTMLDivElement>(null);
  const introRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLDivElement>(null);
  const bgSrc = bgSource(title.backdropUrl, bg);
  const blur = BG_MODES.find((m) => m.id === bg)?.blur ?? 0;
  const full = tmdbResize(title.backdropUrl, "w1280") ?? title.backdropUrl ?? "";
  const logo = title.logoUrl;
  const text = captionText(caption);

  // L'ouverture : le fond qui avance, le logo qui paraît, une lueur. Lancée une fois au montage.
  useLayoutEffect(() => {
    if (direct) {
      videoRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, fill: "both" });
      return;
    }
    const animations: Animation[] = [];
    if (!reduced) {
      // Avance lente et continue : la durée réelle d'un chargement n'est pas connue d'avance, on part
      // donc sur six secondes, coupées net par le fondu dès que l'image est là.
      const b = backdropRef.current?.animate([{ transform: `scale(${zoom})` }, { transform: "scale(1)" }], {
        duration: 6000, easing: "cubic-bezier(0.25, 0.6, 0.3, 1)", fill: "both",
      });
      if (b) animations.push(b);
    }
    const l = logoRef.current?.animate(
      reduced
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [{ opacity: 0, transform: "scale(0.96)" }, { opacity: 1, transform: "scale(1)" }],
      { duration: reduced ? 200 : logoMs, delay: reduced ? 0 : 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "both" },
    );
    if (l) animations.push(l);
    if (sweep && !reduced && logo) {
      const s = sweepRef.current?.animate([{ transform: "translateX(-120%)" }, { transform: "translateX(120%)" }], {
        duration: 1100, delay: 200 + logoMs * 0.6, easing: "cubic-bezier(0.45, 0, 0.25, 1)", fill: "both",
      });
      if (s) animations.push(s);
    }
    const ready = window.setTimeout(() => setPhase("video"), delay);
    return () => {
      window.clearTimeout(ready);
      for (const a of animations) a.cancel();
    };
  }, [direct, reduced, zoom, logoMs, sweep, logo, delay]);

  // Le fond paraît une fois décodé, jamais d'un coup. Déjà en cache — le cas courant, demandé dès le
  // choix du titre —, il se pose en 250 ms avec le logo ; sinon le voile sombre attend seul, et
  // l'image le rejoint en 600 ms dès qu'elle est prête. Un échec laisse le voile, sans image cassée.
  useLayoutEffect(() => {
    const img = bgImgRef.current;
    if (direct || !img) return;
    let cancelled = false;
    let fade: Animation | undefined;
    const t0 = performance.now();
    const decoded = typeof img.decode === "function" ? img.decode() : Promise.resolve();
    void decoded.then(
      () => {
        if (cancelled) return;
        fade = img.animate([{ opacity: 0 }, { opacity: 1 }], { duration: performance.now() - t0 < 150 ? 250 : 600, easing: "ease-out", fill: "both" });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      fade?.cancel();
    };
  }, [direct, bgSrc]);

  // La première image : fondu enchaîné, le logo s'éloigne un peu.
  useLayoutEffect(() => {
    if (phase !== "video" || direct) return;
    const d = reduced ? 200 : 400;
    introRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: d, easing: "ease-out", fill: "both" });
    if (!reduced) logoRef.current?.animate([{ transform: "scale(1)" }, { transform: "scale(1.06)" }], { duration: d, easing: "ease-out", fill: "forwards", composite: "replace" });
    videoRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: d, easing: "ease-out", fill: "both" });
  }, [phase, direct, reduced]);

  return (
    <div className="fixed inset-0 z-[100] overflow-hidden bg-black" style={{ pointerEvents: "none" }}>
      {/* La « vidéo » : le visuel net, posé dessous dès le départ, révélé par le fondu. */}
      <div ref={videoRef} className="absolute inset-0" style={{ opacity: 0 }}>
        <img src={full} alt="" className="h-full w-full object-cover" />
        <div className="absolute bottom-4 left-5 text-xs font-medium text-white/70">{direct ? "Passage direct (sous le seuil)" : "Première image"}</div>
      </div>

      {!direct && (
        <div ref={introRef} className="absolute inset-0">
          <div ref={backdropRef} className="absolute inset-0" style={{ willChange: "transform" }}>
            {/* Le filtre est posé sur l'image, qui ne bouge pas ; seul ce conteneur avance. Floutée,
                elle est agrandie de 8 % : le bord adouci d'une image floutée ne doit jamais se voir.
                Invisible jusqu'à son décodage — voir l'effet plus haut. */}
            <img
              ref={bgImgRef}
              src={bgSrc}
              alt=""
              decoding="async"
              className="h-full w-full object-cover"
              style={{ opacity: 0, filter: blur ? `blur(${blur}px)` : undefined, transform: blur ? "scale(1.08)" : undefined }}
            />
          </div>
          {/* Une vignette, puis le voile : le bord de l'écran s'assombrit, le logo se lit au centre. */}
          <div className="absolute inset-0" style={{ background: bgVeil(bg, brightness) }} />
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8">
            <div ref={logoRef} className="relative" style={{ opacity: 0 }}>
              {logo ? (
                <>
                  <img src={logo} alt={title.title} className="block max-h-[22vh] max-w-[min(60vw,32rem)] object-contain" />
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
                <h1 className="text-center text-4xl font-bold text-white sm:text-6xl font-display">{title.title}</h1>
              )}
            </div>
            {text && <p className="text-sm font-medium text-white/75 sm:text-base">{text}</p>}
            {/* La ligne de chargement : une lueur qui passe, à la place de la roue. */}
            <div className="relative h-[2px] w-28 overflow-hidden rounded-full bg-white/15">
              <div className={`absolute inset-y-0 w-1/2 rounded-full bg-gradient-to-r from-transparent via-white/90 to-transparent ${reduced ? "" : "alab-intro-line"}`} />
            </div>
          </div>
        </div>
      )}

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

/** Ce que la fiche doit savoir de la carte touchée pour en partir, et pour y revenir. */
type Opening = { title: CinemaMovie; key: string; poster: string; radius: number; mode: Mode };
type Register = (key: string) => (el: HTMLElement | null) => void;

// Les largeurs des vraies cartes : `CARD_WIDTH` de CinemaClient, `POSTER_WIDTH` de CinemaMobileClient.
const CARD_WIDTH = "w-24 sm:w-28 md:w-32 lg:w-36";
const PHONE_POSTER_WIDTH = "w-28 sm:w-32";
// La cascade de la colonne, resserrée pour un trajet de 250 ms : un pas de 30 ms, chaque ligne
// en 250 ms. À 50 ms et 420 ms, elle durait deux fois le trajet et la fiche paraissait lente.
const STAGGER_MS = 30;
const LINE_MS = 250;
// L'assombrissement de l'accueil derrière la fiche, et le recul de celui du bureau.
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
 * bannière et ses voiles s'effacent de 35 à 95 %.
 */
const POSTER_OUT: Keyframe[] = [{ opacity: 1, easing: "ease-in" }, { opacity: 0, offset: 0.35 }, { opacity: 0 }];
const BACKDROP_IN: Keyframe[] = [{ opacity: 0 }, { opacity: 0, offset: 0.1, easing: "ease-out" }, { opacity: 1, offset: 0.5 }, { opacity: 1 }];
const POSTER_IN: Keyframe[] = [{ opacity: 0 }, { opacity: 0, offset: 0.25, easing: "ease-in-out" }, { opacity: 1, offset: 0.85 }, { opacity: 1 }];
const BACKDROP_OUT: Keyframe[] = [{ opacity: 1 }, { opacity: 1, offset: 0.35, easing: "ease-in-out" }, { opacity: 0, offset: 0.95 }, { opacity: 0 }];
// Le relais final de la fermeture : la vraie carte reparaît sous le calque du trajet, qui s'efface
// par-dessus en ce temps-là — plus de bascule de visibilité qui se voie (le logo de la grande
// bannière du téléphone, absent de l'affiche du trajet, surgissait d'un coup).
const HANDOVER_MS = 120;
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

function place(el: HTMLElement, b: Box) {
  Object.assign(el.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
}

export function SheetOpenLot({ movies }: { movies: readonly CinemaMovie[] }) {
  const { withLogo } = useMemo(() => usableTitles(movies), [movies]);
  // 250 ms (quatrième passe) : à 520 ms, « joli, mais il faut absolument plus rapide ».
  const [duration, setDuration] = useState(250);
  const [ease, setEase] = useState<Ease>("spring");
  const [stagger, setStagger] = useState(true);
  const [layout, setLayout] = useState<Layout>("auto");
  const [reduced, setReduced] = useState(prefersReduced);
  const [staged, setStaged] = useState(false);
  const timing = useMemo(() => easingFor(ease, duration), [ease, duration]);

  return (
    <section className="space-y-4 rounded-2xl border border-white/8 bg-white/[0.03] p-4">
      <p className="text-sm text-muted">
        {"Une maquette de l'accueil et des vraies fiches — visuel et logo, pas d'affiche. Au bureau, l'affiche touchée s'agrandit jusqu'à l'écran entier en devenant le visuel du film, puis la colonne (logo, infos, accroche, synopsis, menu) paraît ligne par ligne. Au téléphone, l'affiche d'une rangée ou de la grande bannière devient la bannière 16:9 de la fiche, pendant que la carte monte du bas. Fermer (Retour, la croix, Échap, ou la bannière tirée vers le bas au téléphone, comme dans la vraie fiche) refait le chemin à l'envers, jusqu'à la carte."}
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
  const [open, setOpen] = useState<Opening | null>(null);

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

  const openFrom = (o: Omit<Opening, "mode">) => {
    if (open) return;
    const el = sources.current.get(o.key);
    setOpen({ ...o, mode: reduced || !el ? "fade" : "flip" });
  };

  // Appelée par la fiche une fois sa sortie jouée.
  const closed = () => setOpen(null);

  useEffect(() => {
    if (open) return; // Échap ferme d'abord la fiche, qui l'écoute elle-même
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onExit]);

  const content = (
    <>
      {phone ? (
        <PhoneHome titles={titles} framed={framed} hiddenKey={open?.key ?? null} register={register} onOpen={openFrom} />
      ) : (
        <DesktopHome titles={titles} hiddenKey={open?.key ?? null} register={register} onOpen={openFrom} />
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
      {open && (
        <MockSheet
          key={open.title.radarrId}
          opening={open}
          phone={phone}
          framed={framed}
          rootRef={rootRef}
          sources={sources}
          timing={timing}
          stagger={stagger}
          onClosed={closed}
        />
      )}
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
  onOpen: (o: Omit<Opening, "mode">) => void;
};

function DesktopHome({ titles, hiddenKey, register, onOpen }: HomeProps) {
  const hero = titles[0];
  const rows = [
    { name: "Récemment ajoutés", items: titles },
    { name: "Ma liste", items: [...titles].reverse() },
  ];
  return (
    <div data-alab-home className="scrollbar-thin absolute inset-0 overflow-y-auto bg-ink pb-10">
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
          <div className="scrollbar-none -mx-3 flex gap-3 overflow-x-auto px-3 py-3">
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
          <div className="scrollbar-none flex gap-2 overflow-x-auto px-4 py-2">
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
 * Troisième passe (10/10/2026), d'après les captures de la deuxième :
 * - Les voiles du visuel voyagent *dans* le calque découpé, avec le visuel, à la même échelle — ceux
 *   de la fiche, posés à leur place finale et fondus pendant le trajet, assombrissaient l'accueil
 *   hors de la découpe : la bande sombre au bas de la bannière du téléphone, le fond boueux du bureau.
 * - Les images ne grandissent que d'une échelle uniforme (`coverTransform`) : la découpe suit la
 *   place, l'image la couvre toujours sans être étirée.
 * - Le fondu est court et décalé : l'affiche s'efface sur le premier tiers, le visuel paraît de
 *   10 à 50 % — plus de long passage où les deux se superposent à moitié.
 * - L'accueil s'assombrit derrière la fiche (et recule un peu au bureau), puis revient à la fermeture.
 *
 * Quatrième passe (10/10/2026) :
 * - 250 ms par défaut, cascade resserrée (voir `STAGGER_MS`).
 * - La fermeture fond la bannière dans l'affiche sur presque tout le retour (`POSTER_IN`,
 *   `BACKDROP_OUT`), et la vraie carte reprend la main sous un dernier fondu (`HANDOVER_MS`).
 * - Au téléphone, la bannière se tire vers le bas comme dans la vraie fiche : le même
 *   `useSwipeToDismiss`, la même poignée, les mêmes coins et la même ombre (`phoneSheetCorner`).
 *   Lâchée au-delà du seuil, la fiche part de là où le doigt l'a laissée — la fermeture reprend
 *   la place mesurée, transformation comprise, sans revenir d'abord en haut.
 */
function MockSheet({
  opening, phone, framed, rootRef, sources, timing, stagger, onClosed,
}: {
  opening: Opening;
  phone: boolean;
  framed: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
  sources: RefObject<Map<string, HTMLElement>>;
  timing: Timing;
  stagger: boolean;
  onClosed: () => void;
}) {
  const t = useT();
  const { title, mode } = opening;
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

  /** L'accueil, que le bureau fait reculer d'un rien derrière la fiche. */
  const home = () => rootRef.current?.querySelector<HTMLElement>("[data-alab-home]") ?? null;

  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    const anims: Animation[] = [];
    const timers = openTimersRef.current;
    const play = (el: Element | null, frames: Keyframe[], opts: KeyframeAnimationOptions) => {
      const a = el?.animate(frames, { fill: "both", ...opts });
      if (a) anims.push(a);
    };
    const cleanup = () => {
      for (const a of anims) a.cancel();
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
    // L'accueil s'éteint derrière : la fiche passe devant lui, elle ne le remplace pas. Une courbe
    // simple et non le ressort, dont le dépassement ferait clignoter l'assombrissement.
    play(dimRef.current, [{ opacity: 0 }, { opacity: DIM }], { duration: d, easing: "cubic-bezier(0.33, 1, 0.68, 1)" });
    const { items, fades } = parts();
    // Le contenu paraît quand le visuel a fait l'essentiel du chemin : avant, il se lirait sur un
    // fond encore en mouvement. Plus tard au téléphone : le texte s'y pose sur la carte qui monte, et
    // ne doit pas flotter sur l'accueil avant qu'elle soit arrivée sous lui.
    // Sur un trajet de 250 ms, la cascade commence vers la fin du mouvement plutôt qu'au milieu.
    const reveal = d * (phone ? 0.7 : 0.6);
    items.forEach((el, i) =>
      play(el, [{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }], {
        duration: LINE_MS, delay: reveal + (stagger ? i * STAGGER_MS : 0), easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      }),
    );
    fades.forEach((el) => play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: d * 0.6, delay: d * 0.3, easing: "ease-out" }));
    // Sans remplissage à la fin : la montée finie, c'est le style de la carte qui reprend sa
    // transformation — celle du doigt quand on tire la fiche. Une animation restée « both » la
    // tiendrait à sa place pour toujours.
    play(cardRef.current, [{ transform: `translateY(${m.cardDrop}px)` }, { transform: "none" }], { ...timing, fill: "backwards" });
    timers.push(window.setTimeout(() => setSettled(true), d + 40));

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
      const h = phone ? null : home();
      if (h) {
        homeAnimRef.current = h.animate([{ transform: "none" }, { transform: `scale(${HOME_SCALE})` }], { duration: d, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "both" });
        anims.push(homeAnimRef.current);
      }
      timers.push(
        window.setTimeout(() => {
          frame.style.display = "none";
          showSheetImage(true);
        }, d),
      );
    }
    return cleanup;
    // Une fois, à l'ouverture : les réglages ne changent pas pendant qu'une fiche est ouverte, et
    // `measure` / `parts` ne lisent que des refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, phone, timing, stagger, sourceRadius, imageRadius]);

  const requestClose = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    // Une fermeture pendant l'ouverture : le relais prévu à l'arrivée (calque du trajet caché, vrai
    // visuel montré) tomberait au milieu du retour.
    for (const id of openTimersRef.current.splice(0)) window.clearTimeout(id);
    setSettled(false);
    const d = timing.duration;
    const sheet = sheetRef.current;
    // Lu sur la fiche elle-même : le geste qui vient de la lâcher, ou un retour en place encore en
    // cours si la croix est touchée juste après.
    const off = sheet ? translateYOf(getComputedStyle(sheet).transform) : 0;
    setFrozenOffset(off);
    if (mode === "fade") {
      sheet?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: "ease-in", fill: "both" });
      cardRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: "ease-in", fill: "both" });
      dimRef.current?.animate([{ opacity: DIM }, { opacity: 0 }], { duration: 180, easing: "ease-in", fill: "both" });
      window.setTimeout(onClosed, 180);
      return;
    }
    // Le contenu s'efface d'abord, d'un coup : la cascade ne se rejoue pas à l'envers en partant.
    const { items, fades } = parts();
    for (const el of items) el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(8px)" }], { duration: 140, easing: "ease-in", fill: "both" });
    for (const el of fades) el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: d * 0.5, easing: "ease-in", fill: "both" });
    // L'accueil reprend sa taille avant la mesure : la carte d'arrivée se lit à sa vraie place, pas
    // à celle de l'accueil reculé — retirée et relancée dans la même tâche, rien ne se peint entre.
    homeAnimRef.current?.cancel();
    const m = measure();
    const frame = frameRef.current;
    const bd = morphBackdropRef.current;
    const poster = morphPosterRef.current;
    const photo = photoRef.current;
    if (!m || !frame || !bd || !poster || !photo) {
      window.setTimeout(onClosed, 160);
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
    const back = frame.animate([{ clipPath: insetClip(m.target, m.W, m.H, fromRadius) }, { clipPath: insetClip(m.source, m.W, m.H, sourceRadius) }], opts);
    bd.animate([{ transform: "none" }, { transform: coverTransform(m.target, m.source) }], opts);
    bd.animate(BACKDROP_OUT, { duration: d, easing: "linear", fill: "both" });
    poster.animate([{ transform: coverTransform(m.source, m.target) }, { transform: "none" }], opts);
    poster.animate(POSTER_IN, { duration: d, easing: "linear", fill: "both" });
    // La carte est mesurée là où le doigt l'a laissée : elle part de ce décalage, et finit sous
    // l'écran — `cardDrop` compte depuis sa place déplacée.
    cardRef.current?.animate([{ transform: `translateY(${off}px)` }, { transform: `translateY(${off + m.cardDrop}px)` }], opts);
    dimRef.current?.animate([{ opacity: DIM }, { opacity: 0 }], { duration: d, easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "both" });
    // Sans remplissage : à la fin, l'accueil retrouve simplement son état, sans animation qui traîne.
    if (!phone) home()?.animate([{ transform: `scale(${HOME_SCALE})` }, { transform: "none" }], { ...timing });
    // Le relais : la vraie carte reparaît dessous, et le calque, maintenant superposé à elle, s'efface.
    back.onfinish = () => {
      const src = sources.current.get(opening.key);
      if (src) src.style.visibility = "";
      frame.animate([{ opacity: 1 }, { opacity: 0 }], { duration: HANDOVER_MS, easing: "ease-out", fill: "both" }).onfinish = () => onClosed();
    };
  };

  // Le geste de la vraie fiche du téléphone, à l'identique : la bannière pour poignée, la croix
  // tenue hors de la poignée.
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Le calque du trajet : sous le contenu de la fiche, au-dessus de l'accueil. Caché hors du FLIP.
  // Le visuel y emporte une copie de ses voiles, qui grandit avec lui : vue de la carte, la fiche en
  // miniature ; rien ne s'assombrit hors de la découpe.
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
  // L'accueil éteint derrière la fiche, sous tout le reste.
  const dim = <div ref={dimRef} aria-hidden="true" className="pointer-events-none absolute inset-0 bg-ink" style={{ opacity: 0 }} />;

  if (!phone) {
    return (
      <>
        {dim}
        {frame}
        <div ref={sheetRef} className="absolute inset-0 overflow-hidden">
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
          <div className="scrollbar-thin relative h-full overflow-y-auto">
            <div className={SECTION_CLASS}>
              <div style={COLUMN_STYLE} className={`flex flex-col ${COLUMN_GAP} px-8 sm:px-16`}>
                {/* Chaque ligne dans son enveloppe, pour la cascade ; celle du logo est une colonne
                    flexible, comme la colonne qui le porte dans la vraie fiche. */}
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
                {title.castNames && title.castNames.length > 0 && (
                  <div data-alab-stagger className="flex items-baseline gap-1.5">
                    <p className={CAST_CLASS}>
                      {t("cinema.cast")} {title.castNames.slice(0, CAST_SHOWN).join(", ")}
                    </p>
                    {title.castNames.length > CAST_SHOWN && <span className="shrink-0 text-xs font-medium text-muted">+{title.castNames.length - CAST_SHOWN}</span>}
                  </div>
                )}
                <div className="mt-2 flex flex-col gap-1" style={MENU_STYLE}>
                  <MenuRow icon={<Play size={14} fill="currentColor" />} label={t("common.play")} />
                  {title.trailerKey && <MenuRow icon={<Video size={14} />} label={t("cinema.trailer")} />}
                  <MenuRow icon={<Check size={14} />} label={t("cinema.markWatched")} />
                  <MenuRow icon={<Plus size={14} />} label={t("watchlist.statuses.toWatch")} />
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
        className="scrollbar-none absolute inset-x-0 bottom-0 overflow-y-auto overscroll-contain rounded-t-2xl"
        style={dragStyle({ top, pointerEvents: closing ? "none" : undefined })}
      >
        {/* La poignée, comme dans CinemaMobileDetail : la bannière seule, `touch-action: none` pour
            que le navigateur n'en fasse pas un défilement ; le reste de la fiche défile. */}
        <div className="relative aspect-video w-full" {...swipe.handlers} style={{ touchAction: "none", maxHeight: framed ? PHONE_FRAME.h * 0.52 : "52svh" }}>
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
          <button data-alab-stagger type="button" className="mb-2 flex w-full items-center justify-center gap-2 rounded-lg bg-white px-4 py-3 text-base font-semibold text-ink">
            <Play size={18} fill="currentColor" />
            {t("common.play")}
          </button>
          {title.trailerKey && (
            <button data-alab-stagger type="button" className="mb-4 flex w-full items-center justify-center gap-2 rounded-lg bg-white/10 px-4 py-3 text-sm font-medium text-white">
              <Video size={16} />
              {t("cinema.trailer")}
            </button>
          )}
          {title.tagline?.trim() && (
            <div data-alab-stagger>
              <CinemaTagline text={title.tagline} className="mb-1.5" />
            </div>
          )}
          {title.overview && <p data-alab-stagger className="mb-3 text-sm leading-6 text-white">{title.overview}</p>}
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
        </div>
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
