"use client";

/* eslint-disable @next/next/no-img-element -- des `<img>` nus, voulus : le FLIP lit `currentSrc` et la
   place exacte de l'image, la lueur se découpe sur le logo par un masque, et les visuels sont déjà des
   tailles du CDN de TMDB — l'optimiseur de Next n'apporterait rien à ce banc d'essai. */

import { createPortal, flushSync } from "react-dom";
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { Play, RotateCcw, X } from "lucide-react";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import { tmdbResize } from "@/lib/images";
import { toSpring } from "@/lib/liquidGlass/liquid";
import { simulateSpring } from "@/lib/liquidGlass/spring";

/**
 * Deux prototypes de la page « Tests animations » (10/10/2026), à juger sur l'iPhone et le Mac avant
 * d'en brancher quoi que ce soit : le lancement de la lecture, et l'affiche qui se déploie en fiche.
 *
 * Rien ici ne touche au vrai lecteur ni aux vraies fiches. Comme le reste de la page, les textes sont
 * des notes en français, hors dictionnaires. Seules l'opacité et la transformation s'animent — ce
 * que le compositeur joue seul, sans le fil principal — et aucun filtre CSS : le flou du fond vient
 * d'une petite image agrandie, parce que les calques filtrés sont justement ce que Safari a mal
 * repeint sur les fiches (logo invisible, 09/10/2026).
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
  const [run, setRun] = useState(0);
  const title = choices.length > 0 ? choices[Math.min(pick, choices.length - 1)] : null;

  return (
    <section className="space-y-4 rounded-2xl border border-white/8 bg-white/[0.03] p-4">
      <p className="text-sm text-muted">
        {"Ce qu'on verrait entre l'appui sur « Lire » et la première image : le visuel du film flou (une image de 300 px agrandie, sans filtre) qui avance lentement, son logo qui apparaît avec une lueur, une ligne de chargement, puis un fondu enchaîné vers la « vidéo » (ici le visuel net). « Délai simulé » joue le temps que met le vrai lecteur ; sous le seuil de passage direct, il n'y a pas d'ouverture du tout."}
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
  title, delay, threshold, zoom, logoMs, sweep, caption, reduced, onReplay, onClose,
}: {
  title: CinemaMovie;
  delay: number;
  threshold: number;
  zoom: number;
  logoMs: number;
  sweep: boolean;
  caption: Caption;
  reduced: boolean;
  onReplay: () => void;
  onClose: () => void;
}) {
  // Sous le seuil, la « vidéo » est prête avant qu'une ouverture ait un sens : pas d'ouverture.
  const direct = delay < threshold;
  const [phase, setPhase] = useState<Phase>(direct ? "video" : "intro");
  const backdropRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLDivElement>(null);
  const sweepRef = useRef<HTMLDivElement>(null);
  const introRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLDivElement>(null);
  const small = tmdbResize(title.backdropUrl, "w300") ?? title.backdropUrl ?? "";
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
            {/* 300 px agrandis à tout l'écran : flou naturel, sans filtre à calculer à chaque image. */}
            <img src={small} alt="" className="h-full w-full object-cover" />
          </div>
          <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse at center, rgba(0,0,0,0.35), rgba(0,0,0,0.78) 75%)" }} />
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

type Variant = "vt" | "flip";
type Ease = "spring" | "emphasized" | "easeOut";

function easingFor(ease: Ease, duration: number): { easing: string; duration: number } {
  if (ease === "spring") return springEasing(Math.max(0.2, duration / 1000), 0.82);
  if (ease === "emphasized") return { easing: "cubic-bezier(0.2, 0, 0, 1)", duration };
  return { easing: "cubic-bezier(0.33, 1, 0.68, 1)", duration };
}

type ViewTransitionDoc = Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } };

export function SheetOpenLot({ movies }: { movies: readonly CinemaMovie[] }) {
  const { withLogo } = useMemo(() => usableTitles(movies), [movies]);
  const supportsVT = typeof document !== "undefined" && "startViewTransition" in document;
  const [variant, setVariant] = useState<Variant>(supportsVT ? "vt" : "flip");
  const [duration, setDuration] = useState(450);
  const [ease, setEase] = useState<Ease>("spring");
  const [reduced, setReduced] = useState(prefersReduced);
  const [open, setOpen] = useState<CinemaMovie | null>(null);
  const posterRefs = useRef(new Map<number, HTMLImageElement>());
  const flipFrom = useRef<DOMRect | null>(null);
  const timing = useMemo(() => easingFor(ease, duration), [ease, duration]);

  const openTitle = (m: CinemaMovie) => {
    const el = posterRefs.current.get(m.radarrId);
    const doc = document as ViewTransitionDoc;
    if (variant === "vt" && doc.startViewTransition && !reduced && el) {
      // L'affiche touchée porte le nom partagé avant la capture, puis le cède à celle de la fiche.
      el.style.setProperty("view-transition-name", "alab-poster");
      doc.startViewTransition(() => {
        el.style.removeProperty("view-transition-name");
        flushSync(() => setOpen(m));
      });
      return;
    }
    flipFrom.current = el?.getBoundingClientRect() ?? null;
    setOpen(m);
  };

  const closeTitle = () => {
    if (!open) return;
    const el = posterRefs.current.get(open.radarrId);
    const doc = document as ViewTransitionDoc;
    if (variant === "vt" && doc.startViewTransition && !reduced && el) {
      const t = doc.startViewTransition(() => {
        flushSync(() => setOpen(null));
        el.style.setProperty("view-transition-name", "alab-poster");
      });
      void t.finished.finally(() => el.style.removeProperty("view-transition-name"));
      return;
    }
    flipFrom.current = el?.getBoundingClientRect() ?? null;
    // Le FLIP de fermeture est joué par la fiche elle-même, qui se démonte à la fin.
    setOpen(null);
  };

  return (
    <section className="space-y-4 rounded-2xl border border-white/8 bg-white/[0.03] p-4">
      {/* Les durées et la courbe des View Transitions se règlent par CSS : posées ici, à jour à chaque réglage. */}
      <style>{`
        ::view-transition-group(alab-poster) { animation-duration: ${Math.round(timing.duration)}ms; animation-timing-function: ${timing.easing}; }
        ::view-transition-old(root), ::view-transition-new(root) { animation-duration: ${Math.round(Math.min(timing.duration, 320))}ms; }
      `}</style>
      <p className="text-sm text-muted">
        {"Touche une affiche : elle grandit et se pose dans la fiche, à la place de la fiche qui monte du bas. Deux façons de le faire : les View Transitions du navigateur (Safari 18 et Chrome récents), et un FLIP fait à la main, qui marche partout. La croix ramène l'affiche à sa place."}
      </p>
      <Row label="Façon">
        <Chip on={variant === "vt"} onClick={() => setVariant("vt")}>
          View Transitions{supportsVT ? "" : " (absent ici)"}
        </Chip>
        <Chip on={variant === "flip"} onClick={() => setVariant("flip")}>FLIP manuel</Chip>
      </Row>
      <Row label="Courbe">
        <Chip on={ease === "spring"} onClick={() => setEase("spring")}>Ressort Apple</Chip>
        <Chip on={ease === "emphasized"} onClick={() => setEase("emphasized")}>Accentuée</Chip>
        <Chip on={ease === "easeOut"} onClick={() => setEase("easeOut")}>Décélération douce</Chip>
        <Chip on={reduced} onClick={() => setReduced(!reduced)}>« Réduire les animations »</Chip>
      </Row>
      <Slider label={`Durée ${duration} ms${ease === "spring" ? ` (ressort : ${Math.round(timing.duration)} ms réels)` : ""}`} min={200} max={1000} step={25} value={duration} set={setDuration} />
      <div className="flex gap-3 overflow-x-auto pb-2">
        {withLogo.length === 0 && <span className="text-sm text-subtle">Chargement du catalogue…</span>}
        {withLogo.map((m) => (
          <button key={m.radarrId} type="button" onClick={() => openTitle(m)} className="w-28 shrink-0 overflow-hidden rounded-lg sm:w-32">
            <img
              ref={(el) => {
                if (el) posterRefs.current.set(m.radarrId, el);
                else posterRefs.current.delete(m.radarrId);
              }}
              src={m.posterUrl ?? ""}
              alt={m.title}
              className="block aspect-[2/3] w-full object-cover"
              // Pendant que sa fiche est ouverte par FLIP, l'affiche de la rangée laisse la place à son double.
              style={{ visibility: open?.radarrId === m.radarrId && variant === "flip" && !reduced ? "hidden" : undefined }}
            />
          </button>
        ))}
      </div>
      {open && createPortal(
        <MockSheet
          key={open.radarrId}
          title={open}
          variant={reduced ? "fade" : variant}
          from={flipFrom}
          timing={timing}
          onClose={closeTitle}
        />,
        document.body,
      )}
    </section>
  );
}

function MockSheet({
  title, variant, from, timing, onClose,
}: {
  title: CinemaMovie;
  variant: Variant | "fade";
  from: RefObject<DOMRect | null>;
  timing: { easing: string; duration: number };
  onClose: () => void;
}) {
  const targetRef = useRef<HTMLImageElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const full = tmdbResize(title.backdropUrl, "w1280") ?? title.backdropUrl ?? "";

  // FLIP d'ouverture : un double de l'affiche part de la rangée et se pose sur l'affiche de la fiche.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const target = targetRef.current;
    if (!body || !target) return;
    if (variant === "fade") {
      body.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: "both" });
      return;
    }
    if (variant === "vt") return; // le navigateur s'en charge
    body.animate([{ opacity: 0, transform: "translateY(24px)" }, { opacity: 1, transform: "none" }], {
      duration: timing.duration, easing: timing.easing, fill: "both",
    });
    const source = from.current;
    if (!source) return;
    const dest = target.getBoundingClientRect();
    const clone = flyingClone(target.currentSrc || target.src, dest);
    target.style.visibility = "hidden";
    const a = clone.animate(
      [{ transform: deltaTransform(source, dest) }, { transform: "none" }],
      { duration: timing.duration, easing: timing.easing, fill: "both" },
    );
    a.onfinish = () => {
      target.style.visibility = "";
      clone.remove();
    };
    return () => clone.remove();
  }, [variant, timing, from]);

  const requestClose = () => {
    const body = bodyRef.current;
    const target = targetRef.current;
    if (variant !== "flip" || !body || !target || closing) {
      onClose();
      return;
    }
    // FLIP de fermeture : le double repart de la fiche vers sa place dans la rangée.
    setClosing(true);
    const source = target.getBoundingClientRect();
    const back = from.current;
    body.animate([{ opacity: 1 }, { opacity: 0 }], { duration: Math.min(timing.duration, 280), easing: "ease-out", fill: "both" });
    if (!back) {
      window.setTimeout(onClose, Math.min(timing.duration, 280));
      return;
    }
    const clone = flyingClone(target.currentSrc || target.src, source);
    target.style.visibility = "hidden";
    const a = clone.animate([{ transform: "none" }, { transform: deltaTransform(back, source) }], {
      duration: timing.duration, easing: timing.easing, fill: "both",
    });
    a.onfinish = () => {
      clone.remove();
      onClose();
    };
  };

  return (
    <div className="fixed inset-0 z-[100]">
      <div ref={bodyRef} className="absolute inset-0 overflow-y-auto bg-ink">
        <div className="relative aspect-video max-h-[60vh] w-full overflow-hidden">
          <img src={full} alt="" className="h-full w-full object-cover" />
          <div className="absolute inset-0 bg-linear-to-t from-ink via-ink/30 to-transparent" />
        </div>
        <div className="relative -mt-24 flex gap-5 px-5 pb-16 sm:-mt-40 sm:px-12">
          {/* La cible du morphing : l'affiche de la fiche, au même nom partagé pour les View Transitions. */}
          <img
            ref={targetRef}
            src={title.posterUrl ?? ""}
            alt=""
            className="aspect-[2/3] w-28 shrink-0 self-start rounded-lg object-cover shadow-2xl sm:w-48"
            style={{ viewTransitionName: variant === "vt" ? "alab-poster" : undefined } as CSSProperties}
          />
          <div className="flex min-w-0 flex-col justify-end gap-3 pt-10 sm:pt-24">
            {title.logoUrl ? (
              <img src={title.logoUrl} alt={title.title} className="max-h-16 max-w-[min(100%,22rem)] self-start object-contain sm:max-h-24" />
            ) : (
              <h1 className="text-2xl font-bold text-white sm:text-4xl">{title.title}</h1>
            )}
            <p className="text-sm text-muted">
              {[title.year, title.runtimeMinutes ? `${Math.floor(title.runtimeMinutes / 60)} h ${String(title.runtimeMinutes % 60).padStart(2, "0")}` : null, title.genres.slice(0, 2).join(" · ")].filter(Boolean).join("  ·  ")}
            </p>
            <button type="button" className="inline-flex w-fit items-center gap-2 rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-ink">
              <Play size={16} fill="currentColor" /> Lire
            </button>
          </div>
        </div>
      </div>
      <button type="button" onClick={requestClose} aria-label="Fermer la fiche" className="nav-glass absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full text-white">
        <X size={18} />
      </button>
    </div>
  );
}

/** Le double qui vole : une image posée au-dessus de tout, à la place `rect`, que l'on déplace par transformation. */
function flyingClone(src: string, rect: DOMRect): HTMLImageElement {
  const img = document.createElement("img");
  img.src = src;
  img.alt = "";
  Object.assign(img.style, {
    position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
    objectFit: "cover", borderRadius: "8px", zIndex: "101", pointerEvents: "none", transformOrigin: "top left", willChange: "transform",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(img);
  return img;
}

/** La transformation qui pose un élément de la place `to` sur la place `from`. */
function deltaTransform(from: DOMRect, to: DOMRect): string {
  const sx = from.width / Math.max(1, to.width);
  const sy = from.height / Math.max(1, to.height);
  return `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${sx}, ${sy})`;
}
