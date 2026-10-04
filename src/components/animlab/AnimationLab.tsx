"use client";

import "./animLab.css";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import useSWR from "swr";
import {
  Bookmark, ChevronLeft, ChevronRight, Film, Heart, Home, Play, Plus, RotateCcw, Share2, SlidersHorizontal, Subtitles, Tv, Volume2, X,
} from "lucide-react";
import { cacheOnlyOptions, MOVIES_CATALOGUE_KEY } from "@/lib/swr";
import { usePointerCapture } from "@/lib/usePointerCapture";
import { cinemaFetcher } from "@/lib/cinemaPayload";
import type { CinemaMoviesPayload } from "@/app/api/cinema/movies/route";
import { tmdbResize } from "@/lib/images";
import { isWebKitEngine } from "@/lib/webkitEngine";
import { attachGesture, GESTURES, type GestureKind, type GestureSettings } from "./gestures";
import { springKeyframes, springOvershoot, type SpringParams } from "./spring";

/**
 * « Tests animations » — un banc de gestes et de matières, pour l'administrateur.
 *
 * Demandé le 04/10/2026 pour juger sur pièce, sur l'iPhone et sur le PC, avant de toucher aux
 * boutons du cinéma : gestes d'appui façon Liquid Glass, flous de plusieurs épaisseurs, et ce qu'ils
 * coûtent quand le fond bouge. Rien ici n'est branché sur le reste de l'application ; les textes
 * sont des notes techniques en français, comme les lignes des journaux, et ne passent pas par les
 * dictionnaires. Un lot à la fois est monté : trente cartes floutées ensemble fausseraient la
 * sensation de chacune.
 */

type Material = { cls: string; name: string; cost: Cost; hint: string; rim?: boolean; copy?: boolean };
type Cost = "nul" | "faible" | "moyen" | "élevé";

const MATERIALS: Material[] = [
  { cls: "alab-mat-smoke", name: "Fumé opaque (actuel)", cost: "nul", hint: "La matière du lecteur aujourd'hui : gris à 82 %, reflet, double liseré. Aucun filtre." },
  { cls: "alab-mat-blur8", name: "Flou léger 8 px", cost: "faible", hint: "Un voile fin : le fond reste reconnaissable." },
  { cls: "alab-mat-frost", name: "Verre poli 20 px", cost: "faible", hint: "Flou 20 px + saturation 1,6 : le verre poli classique. Coût par image si le fond bouge." },
  { cls: "alab-mat-thick", name: "Verre épais 40 px", cost: "moyen", hint: "Très flou et assombri : lisible sur tout, mais le fond n'est plus qu'une couleur." },
  { cls: "alab-mat-clear", name: "Verre clair (iOS 26)", cost: "faible", hint: "Presque sans teinte, reflet fort en haut, bord qui accroche la lumière." },
  { cls: "alab-mat-tint", name: "Verre teinté violet", cost: "faible", hint: "Le verre poli, teinté de la couleur d'accent — pour une action principale." },
  { cls: "alab-mat-prefrost", name: "Pré-flouté (sans filtre)", cost: "nul", hint: "L'image réduite à 48 px dans un canevas, agrandie par le GPU : pas de flou calculé, rien par image. Ne marche que sur une image connue — pas sur la vidéo.", copy: true },
  { cls: "alab-mat-frost", name: "Verre poli + liseré de lumière", cost: "faible", hint: "Un anneau de lumière qui se tourne vers le pointeur ou le doigt (bouge-le sur la carte). Seule une rotation change.", rim: true },
  { cls: "alab-mat-lens", name: "Verre dépoli réfractant", cost: "élevé", hint: "Bruit + déplacement des pixels du fond : une vraie réfraction. Chrome/Edge seulement — ailleurs, fond de secours." },
];

const COST_TONE: Record<Cost, string> = {
  nul: "bg-emerald-500/15 text-emerald-300",
  faible: "bg-sky-500/15 text-sky-300",
  moyen: "bg-amber-500/15 text-amber-300",
  élevé: "bg-rose-500/15 text-rose-300",
};

/** Ressorts nommés : durée de réponse (s) et taux d'amortissement, comme SwiftUI les décrit. */
const PRESETS: { name: string; response: number; ratio: number }[] = [
  { name: "Sans rebond", response: 0.35, ratio: 1 },
  { name: "Apple", response: 0.45, ratio: 0.8 },
  { name: "Vif", response: 0.3, ratio: 0.7 },
  { name: "Rebond", response: 0.5, ratio: 0.55 },
  { name: "Gelée", response: 0.6, ratio: 0.32 },
];

/** Masse 1 : k = (2π / réponse)², c = 4π·ζ / réponse. */
function toSpring(response: number, ratio: number): SpringParams {
  return { stiffness: (2 * Math.PI / response) ** 2, damping: (4 * Math.PI * ratio) / response };
}

type LabImage = { full: string; thumb: string; title: string } | null;

type Lab = {
  settingsRef: RefObject<GestureSettings>;
  gesture: GestureKind;
  material: Material;
  image: LabImage;
  moving: boolean;
  whiteText: boolean;
};

const LabContext = createContext<Lab | null>(null);
function useLab(): Lab {
  const lab = useContext(LabContext);
  if (!lab) throw new Error("AnimationLab: contexte absent");
  return lab;
}

const LOTS = [
  { id: "A", name: "Gestes d'appui" },
  { id: "B", name: "Matières" },
  { id: "C", name: "Apparition du flou" },
  { id: "D", name: "Groupes et métamorphoses" },
  { id: "E", name: "Défilement sous verre" },
] as const;
type LotId = (typeof LOTS)[number]["id"];

function detectSupport() {
  const css = (q: string) => typeof CSS !== "undefined" && CSS.supports(q);
  const media = (q: string) => typeof window !== "undefined" && window.matchMedia?.(q).matches;
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return {
    backdrop: css("backdrop-filter: blur(1px)") || css("-webkit-backdrop-filter: blur(1px)"),
    linear: css("transition-timing-function: linear(0, 1)"),
    viewTransitions: typeof document !== "undefined" && "startViewTransition" in document,
    reducedMotion: media("(prefers-reduced-motion: reduce)"),
    reducedTransparency: media("(prefers-reduced-transparency: reduce)"),
    webkit: isWebKitEngine(ua),
    // `url()` dans `backdrop-filter` : Chromium seul. Aucune requête CSS ne le dit honnêtement
    // (Safari répond oui et n'applique rien), d'où le moteur — c'est un défaut d'implémentation.
    lens: !isWebKitEngine(ua) && !/Firefox\//.test(ua),
  };
}

export function AnimationLab() {
  const [support] = useState(detectSupport);
  const [lot, setLot] = useState<LotId>("A");
  const [response, setResponse] = useState(0.45);
  const [ratio, setRatio] = useState(0.8);
  const [slow, setSlow] = useState(false);
  const [moving, setMoving] = useState(false);
  const [whiteText, setWhiteText] = useState(false);
  const [lensOn, setLensOn] = useState(support.lens);
  const [gesture, setGesture] = useState<GestureKind>("swell");
  const [materialIndex, setMaterialIndex] = useState(2);
  const [imageIndex, setImageIndex] = useState(0);

  const { data: movies } = useSWR<CinemaMoviesPayload>(MOVIES_CATALOGUE_KEY, cinemaFetcher, cacheOnlyOptions);
  const images = useMemo<NonNullable<LabImage>[]>(() => {
    if (!movies) return [];
    const seen = new Set<string>();
    const out: NonNullable<LabImage>[] = [];
    for (const m of [...movies.spotlight, ...movies.recentlyAdded, ...Object.values(movies.rows).flat()]) {
      if (!m.backdropUrl || seen.has(m.backdropUrl)) continue;
      seen.add(m.backdropUrl);
      out.push({ full: tmdbResize(m.backdropUrl, "w1280") ?? m.backdropUrl, thumb: tmdbResize(m.backdropUrl, "w300") ?? m.backdropUrl, title: m.title });
      if (out.length >= 24) break;
    }
    return out;
  }, [movies]);
  const posters = useMemo(() => {
    if (!movies) return [];
    return [...movies.recentlyAdded, ...Object.values(movies.rows).flat()].map((m) => m.posterUrl).filter((u): u is string => !!u).slice(0, 60);
  }, [movies]);
  const image = images.length > 0 ? images[((imageIndex % images.length) + images.length) % images.length] : null;

  const spring = useMemo(() => toSpring(response, ratio), [response, ratio]);
  const overshoot = useMemo(() => springOvershoot(spring), [spring]);
  const settingsRef = useRef<GestureSettings>({ spring, slow: 1 });
  useEffect(() => {
    settingsRef.current = { spring, slow: slow ? 5 : 1 };
  }, [spring, slow]);

  const lab = useMemo<Lab>(
    () => ({ settingsRef, gesture, material: MATERIALS[materialIndex], image, moving, whiteText }),
    [gesture, materialIndex, image, moving, whiteText],
  );

  return (
    <LabContext.Provider value={lab}>
      <div className={`alab-root space-y-6 pb-10 ${lensOn ? "alab-lens-on" : ""}`} style={{ "--alab-slow": slow ? 5 : 1 } as CSSProperties}>
        <SvgFilters />

        <section className="space-y-4 rounded-2xl border border-white/8 bg-white/[0.03] p-4">
          <p className="text-sm text-muted">
            {"Chaque carte pose des boutons sur une image du catalogue. Appuie, tapote vite, glisse le doigt. Les réglages ci-dessous s'appliquent à toutes les cartes ; « Fond animé » simule une vidéo ou un défilement sous les boutons — c'est là qu'un flou coûte."}
          </p>

          <Row label="Fond">
            <button type="button" className="chip" onClick={() => setImageIndex((i) => i - 1)} aria-label="Image précédente"><ChevronLeft size={16} /></button>
            <span className="min-w-0 max-w-[14rem] truncate text-sm text-white">{image?.title ?? "Chargement du catalogue…"}</span>
            <button type="button" className="chip" onClick={() => setImageIndex((i) => i + 1)} aria-label="Image suivante"><ChevronRight size={16} /></button>
            <Toggle on={moving} set={setMoving}>Fond animé</Toggle>
            <Toggle on={whiteText} set={setWhiteText}>Texte blanc</Toggle>
          </Row>

          <Row label="Ressort">
            {PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                className={`chip ${Math.abs(p.response - response) < 0.001 && Math.abs(p.ratio - ratio) < 0.001 ? "chip-on" : ""}`}
                onClick={() => { setResponse(p.response); setRatio(p.ratio); }}
              >
                {p.name}
              </button>
            ))}
          </Row>
          <div className="grid gap-3 sm:grid-cols-2">
            <Slider label={`Réponse ${response.toFixed(2)} s`} min={0.15} max={1} step={0.01} value={response} set={setResponse} />
            <Slider label={`Amortissement ${ratio.toFixed(2)} — dépasse de ${Math.round(overshoot * 100)} %`} min={0.2} max={1.2} step={0.01} value={ratio} set={setRatio} />
          </div>

          <Row label="Vitesse">
            <Toggle on={slow} set={setSlow}>Ralenti ×5</Toggle>
            <Toggle on={lensOn} set={setLensOn}>Réfraction (Chrome)</Toggle>
          </Row>

          <div className="flex flex-wrap gap-1.5 text-[11px]">
            <Fact ok={support.backdrop}>backdrop-filter</Fact>
            <Fact ok={support.linear}>linear()</Fact>
            <Fact ok={support.viewTransitions}>View Transitions</Fact>
            <Fact ok={support.lens}>réfraction url()</Fact>
            <Fact ok={!support.reducedMotion}>{support.reducedMotion ? "« Réduire les animations » activé" : "animations non réduites"}</Fact>
            {support.reducedTransparency && <Fact ok={false}>« Réduire la transparence » activé</Fact>}
          </div>
        </section>

        <div className="flex flex-wrap gap-1.5">
          {LOTS.map((l) => (
            <button key={l.id} type="button" className={`chip ${lot === l.id ? "chip-on" : ""}`} onClick={() => setLot(l.id)}>
              {l.id} · {l.name}
            </button>
          ))}
        </div>

        {(lot === "A" || lot === "D") && (
          <Row label="Matière des cartes">
            <select
              className="select max-w-full"
              value={materialIndex}
              onChange={(e) => setMaterialIndex(Number(e.target.value))}
            >
              {MATERIALS.map((m, i) => <option key={i} value={i}>{m.name}</option>)}
            </select>
          </Row>
        )}
        {(lot === "B" || lot === "C" || lot === "D" || lot === "E") && (
          <Row label="Geste des boutons">
            <select className="select max-w-full" value={gesture} onChange={(e) => setGesture(e.target.value as GestureKind)}>
              {GESTURES.map((g) => <option key={g.kind} value={g.kind}>{g.name}</option>)}
            </select>
          </Row>
        )}

        <div key={lot} className="grid gap-x-5 gap-y-7 sm:grid-cols-2 xl:grid-cols-3">
          {lot === "A" && GESTURES.map((g) => (
            <Card key={g.kind} title={g.name} hint={g.hint} cost="nul">
              <ControlSet gesture={g.kind} material={MATERIALS[materialIndex]} />
            </Card>
          ))}
          {lot === "B" && MATERIALS.map((m, i) => (
            <Card key={i} title={m.name} hint={m.hint} cost={m.cost}>
              <ControlSet gesture={gesture} material={m} />
            </Card>
          ))}
          {lot === "C" && <AppearLot />}
          {lot === "D" && <MorphLot />}
          {lot === "E" && <ScrollLot posters={posters} />}
        </div>
      </div>
    </LabContext.Provider>
  );
}

/* ─── Petits composants de réglage ──────────────────────────────────────────── */

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-full text-xs font-medium uppercase tracking-wide text-subtle sm:w-32">{label}</span>
      {children}
    </div>
  );
}

function Toggle({ on, set, children }: { on: boolean; set: (v: boolean) => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} className={`chip ${on ? "chip-on" : ""}`} onClick={() => set(!on)}>
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

function Fact({ ok, children }: { ok: boolean; children: ReactNode }) {
  return <span className={`rounded-full px-2 py-0.5 ${ok ? "bg-emerald-500/12 text-emerald-300" : "bg-white/6 text-subtle"}`}>{ok ? "✓" : "✗"} {children}</span>;
}

/* ─── Les cartes ───────────────────────────────────────────────────────────── */

function Card({ title, hint, cost, children, footer, tall }: { title: string; hint: string; cost: Cost; children: ReactNode; footer?: ReactNode; tall?: boolean }) {
  const { image, moving, whiteText } = useLab();
  const cardRef = useRef<HTMLDivElement>(null);
  // La lumière du liseré se tourne vers le pointeur : une variable posée sur la carte, jamais un état.
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const onMove = (e: PointerEvent) => {
      for (const rim of card.querySelectorAll<HTMLElement>(".alab-rim")) {
        const box = rim.getBoundingClientRect();
        const angle = Math.atan2(e.clientY - (box.top + box.height / 2), e.clientX - (box.left + box.width / 2));
        // Le dégradé conique part du haut (−90°) : on le tourne pour que son point clair regarde le doigt.
        rim.style.setProperty("--alab-angle", `${(angle * 180) / Math.PI + 90}deg`);
      }
    };
    card.addEventListener("pointermove", onMove);
    return () => card.removeEventListener("pointermove", onMove);
  }, []);
  return (
    <figure className="min-w-0">
      <div
        ref={cardRef}
        className={`alab-card ${moving ? "alab-moving" : ""}`}
        style={tall ? { aspectRatio: "4 / 5" } : undefined}
      >
        <div
          className="alab-bg alab-drift"
          style={{ backgroundImage: image ? `url("${image.full}")` : "linear-gradient(135deg, #2a2340, #0d1b2a 60%, #3b2a1a)" }}
        />
        {whiteText && (
          <div className="alab-white-text">
            <span>TEXTE BLANC</span>
            <span>SOUS LE VERRE</span>
          </div>
        )}
        {children}
      </div>
      <figcaption className="mt-2.5 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-white">{title}</span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${COST_TONE[cost]}`}>coût {cost}</span>
        </div>
        <p className="text-xs leading-relaxed text-subtle">{hint}</p>
        {footer}
      </figcaption>
    </figure>
  );
}

/** Un bouton de la page : la matière sur lui, ou transparent dans une pilule qui la porte. */
function GlassButton({
  gesture,
  material,
  size = "alab-round",
  label,
  children,
  className = "",
  onClick,
}: {
  gesture: GestureKind;
  material?: Material;
  size?: string;
  label: string;
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  const { settingsRef } = useLab();
  const ref = useRef<HTMLButtonElement>(null);
  // Les deux fonctions sont stables ; l'objet qui les porte ne l'est pas — d'où la déstructuration,
  // sans quoi chaque rendu décrocherait et raccrocherait le geste.
  const { take, release } = usePointerCapture();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return attachGesture(el, gesture, () => settingsRef.current, { take, release });
  }, [gesture, settingsRef, take, release]);
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`alab-btn ${size} ${material?.cls ?? ""} ${gesture === "active" ? "alab-press-active" : ""} ${gesture === "stretch" ? "alab-stretchy" : ""} ${className}`}
    >
      {material?.copy && <PrefrostCopy />}
      {material?.rim && <span className="alab-rim" />}
      <span className="alab-sheen" />
      <span className="alab-glow" />
      {children}
    </button>
  );
}

/** Une pilule de trois boutons, la matière sur la pilule — un seul calque flou pour le groupe. */
function GlassPill({ gesture, material, children }: { gesture: GestureKind; material: Material; children: (gesture: GestureKind) => ReactNode }) {
  return (
    <div className={`alab-pill ${material.cls}`}>
      {material.copy && <PrefrostCopy />}
      {material.rim && <span className="alab-rim" style={{ borderRadius: 999 }} />}
      {children(gesture)}
    </div>
  );
}

/** Le jeu de commandes des lots A et B : fermer, une pilule de réglages, lecture, et un libellé. */
function ControlSet({ gesture, material }: { gesture: GestureKind; material: Material }) {
  return (
    <>
      <div className="absolute left-3 top-3">
        <GlassButton gesture={gesture} material={material} size="alab-round-sm" label="Fermer"><X size={18} /></GlassButton>
      </div>
      <div className="absolute right-3 top-3">
        <GlassPill gesture={gesture} material={material}>
          {(g) => (
            <>
              <GlassButton gesture={g} label="Sous-titres"><Subtitles size={19} /></GlassButton>
              <GlassButton gesture={g} label="Son"><Volume2 size={19} /></GlassButton>
              <GlassButton gesture={g} label="Réglages"><SlidersHorizontal size={19} /></GlassButton>
            </>
          )}
        </GlassPill>
      </div>
      <div className="alab-stage pointer-events-none">
        <div className="pointer-events-auto">
          <GlassButton gesture={gesture} material={material} size="alab-round-lg" label="Lecture"><Play size={30} fill="currentColor" /></GlassButton>
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-3 flex justify-center">
        <GlassButton gesture={gesture} material={material} size="alab-label-btn" label="Reprendre">
          <RotateCcw size={16} />
          <span className="relative z-[2]">Reprendre</span>
        </GlassButton>
      </div>
    </>
  );
}

/**
 * Le fond du bouton « pré-flouté » : l'image de la carte réduite dans un canevas minuscule, placé
 * sous le bouton exactement où l'image se trouve dans la carte. Le canevas est dessiné une fois ;
 * agrandi, il est flou par nature — le GPU ne fait qu'échantillonner une texture de 48 × 27.
 * Une image d'un autre domaine *s'affiche* très bien dans un canevas : seule sa relecture est
 * interdite, et on ne relit rien.
 */
function PrefrostCopy() {
  const { image } = useLab();
  const frameRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // La place du bouton dans la carte, en coordonnées de mise en page — les `transform` d'un geste
  // n'y entrent pas. Posée en variables sur le cadre, sans état React.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    // Le cadre est dans une enveloppe de découpe : l'hôte est le parent de celle-ci.
    const host = frame?.parentElement?.parentElement;
    const card = frame?.closest<HTMLElement>(".alab-card");
    if (!frame || !host || !card) return;
    const place = () => {
      let x = 0;
      let y = 0;
      let node: HTMLElement | null = host;
      while (node && node !== card) {
        x += node.offsetLeft;
        y += node.offsetTop;
        node = node.offsetParent as HTMLElement | null;
      }
      frame.style.setProperty("--alab-ox", `${x + host.clientLeft}px`);
      frame.style.setProperty("--alab-oy", `${y + host.clientTop}px`);
      frame.style.setProperty("--alab-cw", `${card.clientWidth}px`);
      frame.style.setProperty("--alab-ch", `${card.clientHeight}px`);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(card);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    let cancelled = false;
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      if (cancelled) return;
      // Réduite par moitiés successives : d'un coup, de 300 à 48 px, la réduction crénelle.
      let source: CanvasImageSource = img;
      let w = img.naturalWidth;
      let h = img.naturalHeight;
      while (w / 2 >= 48) {
        const step = document.createElement("canvas");
        step.width = Math.round(w / 2);
        step.height = Math.round(h / 2);
        step.getContext("2d")?.drawImage(source, 0, 0, step.width, step.height);
        source = step;
        w = step.width;
        h = step.height;
      }
      canvas.width = 48;
      canvas.height = 27;
      canvas.getContext("2d")?.drawImage(source, 0, 0, 48, 27);
    };
    img.src = image.thumb;
    return () => {
      cancelled = true;
    };
  }, [image]);

  return (
    // Sa propre découpe, aux coins de l'hôte : la barre d'onglets ne coupe pas ce qui dépasse
    // d'elle (la lentille gonflée doit déborder), mais la copie de l'image, si.
    <span className="pointer-events-none absolute inset-0 z-0 overflow-hidden" style={{ borderRadius: "inherit" }} aria-hidden>
      <span ref={frameRef} className="alab-copy-frame">
        <span className="alab-drift absolute inset-0 block">
          <canvas ref={canvasRef} width={48} height={27} />
        </span>
      </span>
    </span>
  );
}

/** Les filtres SVG de la page : le verre dépoli (lot B) et les gouttes (lot D). */
function SvgFilters() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden>
      <defs>
        <filter id="alab-frost" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="4" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="22" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <filter id="alab-goo">
          <feGaussianBlur in="SourceGraphic" stdDeviation="9" result="blur" />
          <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -9" result="goo" />
          <feComposite in="SourceGraphic" in2="goo" operator="atop" />
        </filter>
      </defs>
    </svg>
  );
}

/* ─── Lot C : l'apparition du flou ─────────────────────────────────────────── */

type AppearVariant = "wrap" | "self" | "scale" | "late";
const APPEAR: { variant: AppearVariant; title: string; hint: string; cost: Cost }[] = [
  {
    variant: "late",
    title: "Comme la 8.2.4 (le défaut)",
    hint: "Le conteneur des commandes apparaît en fondu ET le flou est ajouté à l'apparition. On voit les boutons nets, puis flous : c'est ce qui a fait retirer le flou le 02/10.",
    cost: "faible",
  },
  {
    variant: "wrap",
    title: "Fondu du conteneur, flou permanent",
    hint: "Un parent à opacité < 1 isole ce qu'il y a dessous : pendant tout le fondu, le flou n'a rien à flouter. Il apparaît d'un coup à la fin.",
    cost: "faible",
  },
  {
    variant: "self",
    title: "Fondu sur chaque pilule (la correction)",
    hint: "Même fondu, mais porté par l'élément flouté lui-même : le flou est là dès la première image.",
    cost: "faible",
  },
  {
    variant: "scale",
    title: "Entrée par échelle, sans fondu",
    hint: "Les pilules naissent petites et gonflent sur le ressort, opaques du début à la fin. Aucune opacité en jeu.",
    cost: "faible",
  },
];

function AppearLot() {
  return (
    <>
      {APPEAR.map((a) => <AppearCard key={a.variant} {...a} />)}
    </>
  );
}

function AppearCard({ variant, title, hint, cost }: (typeof APPEAR)[number]) {
  const { gesture, settingsRef } = useLab();
  const [shown, setShown] = useState(true);
  const stageRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // L'entrée par échelle : jouée sur les nœuds quand `shown` change — des animations, pas d'état.
  useEffect(() => {
    if (variant !== "scale") return;
    const stage = stageRef.current;
    if (!stage) return;
    const s = settingsRef.current;
    for (const child of Array.from(stage.children) as HTMLElement[]) {
      for (const a of child.getAnimations()) if (a.id === "appear") a.cancel();
      if (shown) {
        const { keyframes, duration } = springKeyframes(0.4, 1, s.spring, (p) => ({ transform: `scale(${p.x})` }));
        child.animate(keyframes, { duration: duration * s.slow, easing: "linear", fill: "both" }).id = "appear";
      } else {
        child.animate([{ transform: "scale(1)" }, { transform: "scale(0)" }], { duration: 180 * s.slow, easing: "ease-in", fill: "forwards" }).id = "appear";
      }
    }
  }, [shown, variant, settingsRef]);

  const replay = () => {
    window.clearTimeout(timer.current);
    setShown(false);
    timer.current = window.setTimeout(() => setShown(true), 700 * settingsRef.current.slow);
  };

  const pillCls = variant === "late" ? "alab-late-target" : variant === "self" ? "alab-mat-frost alab-fade-self" : "alab-mat-frost";
  const stageCls = variant === "late" ? "alab-fade-wrap alab-blur-late" : variant === "wrap" ? "alab-fade-wrap" : "";
  const frost: Material = { cls: pillCls, name: "", cost: "faible", hint: "" };
  return (
    <Card
      title={title}
      hint={hint}
      cost={cost}
      footer={
        <button type="button" className="chip mt-1" onClick={replay}>
          <RotateCcw size={14} /> Rejouer l&apos;apparition
        </button>
      }
    >
      <div ref={stageRef} className={`alab-stage ${stageCls}`} data-shown={String(shown)}>
        <GlassPill gesture={gesture} material={frost}>
          {(g) => (
            <>
              <GlassButton gesture={g} label="Sous-titres"><Subtitles size={19} /></GlassButton>
              <GlassButton gesture={g} label="Son"><Volume2 size={19} /></GlassButton>
            </>
          )}
        </GlassPill>
        <GlassButton gesture={gesture} material={frost} size="alab-round-lg" label="Lecture"><Play size={30} fill="currentColor" /></GlassButton>
        <GlassButton gesture={gesture} material={frost} label="Fermer"><X size={20} /></GlassButton>
      </div>
    </Card>
  );
}

/* ─── Lot D : groupes et métamorphoses ─────────────────────────────────────── */

function MorphLot() {
  const { gesture, material } = useLab();
  const frost = MATERIALS[2];
  return (
    <>
      <Card
        title="Cinq calques ou un seul"
        hint="En haut, cinq ronds floutés chacun : cinq passes de flou par image. En bas, une pilule floutée qui porte cinq boutons : une seule. Même rendu ou presque — compare au fond animé."
        cost="faible"
      >
        <div className="alab-stage flex-col">
          <div className="flex gap-2">
            {[Subtitles, Volume2, Heart, Share2, SlidersHorizontal].map((Icon, i) => (
              <GlassButton key={i} gesture={gesture} material={frost} size="alab-round-sm" label={`Bouton ${i + 1}`}><Icon size={17} /></GlassButton>
            ))}
          </div>
          <GlassPill gesture={gesture} material={frost}>
            {(g) => [Subtitles, Volume2, Heart, Share2, SlidersHorizontal].map((Icon, i) => (
              <GlassButton key={i} gesture={g} label={`Bouton ${i + 1}`}><Icon size={18} /></GlassButton>
            ))}
          </GlassPill>
        </div>
      </Card>
      <MorphMenuCard material={material} />
      <LensTabsCard material={material} />
      <DropsCard />
      <SwitchCard />
    </>
  );
}

const MENU_ITEMS = ["Français — 5.1", "English — 5.1", "Español — Stéréo", "Audiodescription"];

/** La pilule qui s'ouvre en menu, vers le haut, sur le ressort — par `clip-path`, sans changer la mise en page. */
function MorphMenuCard({ material }: { material: Material }) {
  const { settingsRef } = useLab();
  const boxRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(0);
  const state = useRef({ open: false });

  const morph = (toOpen: boolean) => {
    const box = boxRef.current;
    if (!box) return;
    state.current.open = toOpen;
    setOpen(toOpen);
    const s = settingsRef.current;
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    const closedTop = h - 48;
    const closedSide = Math.max(0, (w - 184) / 2);
    const { keyframes, duration } = springKeyframes(toOpen ? 0 : 1, toOpen ? 1 : 0, s.spring, ({ x }) => {
      const p = Math.min(Math.max(x, 0), 1);
      // Le dépassement du ressort ne peut pas agrandir la découpe au-delà de la boîte : il passe
      // en échelle, ce qui garde le rebond visible.
      const bounce = 1 + Math.max(0, x - 1) * 0.35 - Math.max(0, -x) * 0.35;
      return {
        clipPath: `inset(${closedTop * (1 - p)}px ${closedSide * (1 - p)}px 0px ${closedSide * (1 - p)}px round ${24 - 4 * p}px)`,
        transform: `scale(${bounce})`,
      };
    });
    box.getAnimations().forEach((a) => a.cancel());
    box.animate(keyframes, { duration: duration * s.slow, easing: "linear", fill: "forwards" });
  };

  // Fermée au montage, sans animation : la découpe de départ posée une fois la taille connue.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const side = Math.max(0, (box.offsetWidth - 184) / 2);
    box.animate([{ clipPath: `inset(${box.offsetHeight - 48}px ${side}px 0px ${side}px round 24px)` }], { duration: 0, fill: "forwards" });
  }, []);

  return (
    <Card title="Pilule → menu" hint="Le bouton du son s'ouvre en menu en grandissant vers le haut, comme les menus d'iOS 26. Une seule surface qui change de forme, au lieu d'un menu qui apparaît à côté." cost="faible">
      <div ref={boxRef} className={`alab-morph ${material.cls}`} style={{ transformOrigin: "50% 100%" }}>
        {material.copy && <PrefrostCopy />}
        <div className="relative z-[2]">
          {MENU_ITEMS.map((item, i) => (
            <button
              key={item}
              type="button"
              tabIndex={open ? 0 : -1}
              className="alab-morph-item w-full text-left"
              onClick={() => { setChoice(i); morph(false); }}
            >
              <span className="w-4">{i === choice ? "✓" : ""}</span>
              {item}
            </button>
          ))}
          <button
            type="button"
            className="alab-morph-item w-full justify-center font-semibold"
            onClick={() => morph(!state.current.open)}
            aria-expanded={open}
          >
            <Volume2 size={17} />
            {MENU_ITEMS[choice].split(" — ")[0]}
          </button>
        </div>
      </div>
    </Card>
  );
}

const TABS = [
  { icon: Home, name: "Accueil" },
  { icon: Film, name: "Films" },
  { icon: Tv, name: "Séries" },
  { icon: Bookmark, name: "Ma liste" },
];
const TAB_W = 64;

/**
 * La barre d'onglets à lentille : la pastille de verre glisse d'un onglet à l'autre sur le ressort,
 * s'étire selon sa vitesse, et suit le doigt quand on la fait glisser — la signature d'iOS 26.
 */
function LensTabsCard({ material }: { material: Material }) {
  const { settingsRef } = useLab();
  const [index, setIndex] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);
  const lensRef = useRef<HTMLSpanElement>(null);
  const drag = useRef({ active: false, pos: 0, lastX: 0, lastT: 0, v: 0, moved: false });
  const { take, release } = usePointerCapture();

  const lensAt = (x: number, swell: number, stretch: number) =>
    `translateX(${x}px) scale(${swell * (1 + stretch)}, ${swell * (1 - stretch * 0.45)})`;

  useEffect(() => {
    const bar = barRef.current;
    const lens = lensRef.current;
    if (!bar || !lens) return;
    const d = drag.current;
    const localX = (e: PointerEvent) => e.clientX - bar.getBoundingClientRect().left - 4 - TAB_W / 2;
    const clampPos = (x: number) => Math.min(Math.max(x, -10), (TABS.length - 1) * TAB_W + 10);

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      d.active = true;
      d.moved = false;
      d.v = 0;
      d.lastX = e.clientX;
      d.lastT = e.timeStamp;
      take(e);
      lens.getAnimations().forEach((a) => a.cancel());
      // Posée sous le doigt, gonflée : la lentille « se soulève » avant même de bouger.
      d.pos = clampPos(Math.round(localX(e) / TAB_W) * TAB_W);
      const s = settingsRef.current;
      lens.animate([{ transform: lens.style.transform || lensAt(d.pos, 1, 0) }, { transform: lensAt(d.pos, 1.18, 0) }], { duration: 120 * s.slow, easing: "ease-out", fill: "forwards" });
      lens.style.transform = lensAt(d.pos, 1.18, 0);
    };
    const onMove = (e: PointerEvent) => {
      if (!d.active) return;
      const dt = Math.max(1, e.timeStamp - d.lastT);
      d.v = ((e.clientX - d.lastX) / dt) * 1000;
      d.lastX = e.clientX;
      d.lastT = e.timeStamp;
      if (Math.abs(localX(e) - d.pos) > 4) d.moved = true;
      if (!d.moved) return;
      d.pos = clampPos(localX(e));
      lens.getAnimations().forEach((a) => a.cancel());
      lens.style.transform = lensAt(d.pos, 1.18, Math.min(Math.abs(d.v) / 3000, 0.25));
    };
    const onUp = () => {
      if (!d.active) return;
      d.active = false;
      release();
      const target = Math.min(Math.max(Math.round(d.pos / TAB_W), 0), TABS.length - 1);
      setIndex(target);
      const s = settingsRef.current;
      const from = d.pos;
      const to = target * TAB_W;
      const span = Math.max(Math.abs(to - from), 1);
      const { keyframes, duration } = springKeyframes(from, to, s.spring, ({ x, v }) => {
        const swell = 1 + 0.18 * Math.min(1, Math.abs(to - x) / span);
        return { transform: lensAt(x, from === to ? 1 : swell, Math.min(Math.abs(v) / 3000, 0.25)) };
      }, d.moved ? d.v : 0);
      lens.getAnimations().forEach((a) => a.cancel());
      lens.style.transform = lensAt(to, 1, 0);
      if (from === to) {
        lens.animate([{ transform: lensAt(to, 1.18, 0) }, { transform: lensAt(to, 0.96, 0), offset: 0.5 }, { transform: lensAt(to, 1, 0) }], { duration: 320 * s.slow, easing: "ease-out" });
      } else {
        lens.animate(keyframes, { duration: duration * s.slow, easing: "linear" });
      }
    };
    bar.addEventListener("pointerdown", onDown);
    bar.addEventListener("pointermove", onMove);
    bar.addEventListener("pointerup", onUp);
    bar.addEventListener("pointercancel", onUp);
    return () => {
      bar.removeEventListener("pointerdown", onDown);
      bar.removeEventListener("pointermove", onMove);
      bar.removeEventListener("pointerup", onUp);
      bar.removeEventListener("pointercancel", onUp);
      release();
    };
  }, [settingsRef, take, release]);

  return (
    <Card title="Onglets à lentille" hint="Tape un onglet : la lentille y glisse et s'étire selon sa vitesse. Appuie et fais-la glisser : elle se soulève et suit le doigt, puis se pose sur l'onglet le plus proche." cost="nul">
      <div className="absolute inset-x-0 bottom-4 flex justify-center">
        <div ref={barRef} className={`alab-tabs ${material.cls}`} style={{ touchAction: "none" }}>
          {material.copy && <PrefrostCopy />}
          <span ref={lensRef} className="alab-lens" />
          {TABS.map((tab, i) => (
            <span key={tab.name} className="alab-tab" data-on={i === index ? "" : undefined} role="button" aria-label={tab.name} aria-pressed={i === index}>
              <tab.icon size={20} />
              {tab.name}
            </span>
          ))}
        </div>
      </div>
    </Card>
  );
}

/** Trois gouttes qui sortent l'une de l'autre : un filtre SVG (flou + seuil) les fait fusionner. */
function DropsCard() {
  const { settingsRef } = useLab();
  const [open, setOpen] = useState(false);
  const dropsRef = useRef<HTMLDivElement>(null);
  const iconsRef = useRef<HTMLDivElement>(null);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    const s = settingsRef.current;
    const run = (el: HTMLElement, frame: (x: number) => Keyframe) => {
      const { keyframes, duration } = springKeyframes(next ? 0 : 1, next ? 1 : 0, s.spring, ({ x }) => frame(x));
      el.getAnimations().forEach((a) => a.cancel());
      el.animate(keyframes, { duration: duration * s.slow, easing: "linear", fill: "forwards" });
    };
    for (const layer of [dropsRef.current, iconsRef.current]) {
      if (!layer) continue;
      const [left, center, right] = Array.from(layer.children) as HTMLElement[];
      run(left, (x) => ({ transform: `translateX(${-78 * x}px)` }));
      run(right, (x) => ({ transform: `translateX(${78 * x}px)` }));
      if (layer !== iconsRef.current) continue;
      run(center, (x) => ({ transform: `rotate(${45 * x}deg)` }));
      // Les icônes des côtés apparaissent en plus du glissement : une autre propriété, une autre animation.
      for (const el of [left, right]) {
        el.animate([{ opacity: next ? 0 : 1 }, { opacity: next ? 1 : 0 }], { duration: 200 * s.slow, fill: "forwards" });
      }
    }
  };

  return (
    <Card title="Gouttes qui fusionnent" hint="Tape le + : deux gouttes sortent du bouton et s'en détachent comme du liquide. Le filtre se redessine à chaque image du mouvement — à réserver aux gestes brefs." cost="moyen">
      <div className="alab-stage">
        <div className="relative" style={{ width: 240, height: 80 }}>
          <div ref={dropsRef} className="alab-goo absolute inset-0">
            <span className="alab-drop absolute" style={{ left: 90, top: 10 }} />
            <span className="alab-drop absolute" style={{ left: 90, top: 10 }} />
            <span className="alab-drop absolute" style={{ left: 90, top: 10 }} />
          </div>
          <div ref={iconsRef} className="absolute inset-0">
            <span className="alab-drop-icons" style={{ opacity: 0 }}><Heart size={20} /></span>
            <span className="alab-drop-icons"><Plus size={24} /></span>
            <span className="alab-drop-icons" style={{ opacity: 0 }}><Share2 size={20} /></span>
          </div>
          <button type="button" aria-label="Ouvrir" aria-expanded={open} onClick={toggle} className="absolute rounded-full" style={{ left: 90, top: 10, width: 60, height: 60 }} />
        </div>
      </div>
    </Card>
  );
}

/** L'interrupteur d'iOS 26 : le curseur devient une bulle de verre sous le doigt, puis glisse sur le ressort. */
function SwitchCard() {
  const { settingsRef } = useLab();
  const [on, setOn] = useState(false);
  const thumbRef = useRef<HTMLSpanElement>(null);
  const pressed = useRef(false);

  const down = () => {
    const thumb = thumbRef.current;
    if (!thumb) return;
    pressed.current = true;
    const s = settingsRef.current;
    const x = on ? 22 : 0;
    thumb.getAnimations().forEach((a) => a.cancel());
    thumb.animate(
      [{ transform: `translateX(${x}px) scale(1)`, background: "#fff" }, { transform: `translateX(${x}px) scale(1.35, 1.25)`, background: "rgb(255 255 255 / 0.35)" }],
      { duration: 140 * s.slow, easing: "ease-out", fill: "forwards" },
    );
  };
  const up = () => {
    const thumb = thumbRef.current;
    if (!thumb || !pressed.current) return;
    pressed.current = false;
    const next = !on;
    setOn(next);
    const s = settingsRef.current;
    const from = on ? 22 : 0;
    const to = next ? 22 : 0;
    const { keyframes, duration } = springKeyframes(from, to, s.spring, ({ x, v }) => {
      const p = Math.abs(x - from) / 22;
      const stretch = Math.min(Math.abs(v) / 1500, 0.2);
      const swell = 1 + 0.3 * Math.max(0, 1 - p);
      return { transform: `translateX(${x}px) scale(${swell + stretch}, ${swell * 0.95})`, background: p > 0.85 ? "#fff" : "rgb(255 255 255 / 0.4)" };
    });
    thumb.getAnimations().forEach((a) => a.cancel());
    thumb.animate(keyframes, { duration: duration * s.slow, easing: "linear", fill: "forwards" });
  };

  return (
    <Card title="Interrupteur à bulle" hint="Appuie et maintiens : le curseur gonfle et devient transparent comme une goutte, puis glisse et redevient plein. Le seul geste d'iOS 26 qui montre la matière sous le doigt." cost="nul">
      <div className="alab-stage">
        <div className="flex items-center gap-3 rounded-full bg-black/45 px-4 py-3 text-sm text-white">
          Sous-titres
          <span
            role="switch"
            aria-checked={on}
            tabIndex={0}
            className="alab-switch"
            data-on={on ? "" : undefined}
            onPointerDown={down}
            onPointerUp={up}
            onPointerLeave={up}
            onPointerCancel={up}
            onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); down(); up(); } }}
          >
            <span ref={thumbRef} className="alab-switch-thumb" />
          </span>
        </div>
      </div>
    </Card>
  );
}

/* ─── Lot E : défilement sous verre ────────────────────────────────────────── */

const SCROLL_MATERIALS: { cls: string; name: string; cost: Cost }[] = [
  { cls: "alab-mat-smoke", name: "Opaque", cost: "nul" },
  { cls: "alab-mat-blur8", name: "Flou 8", cost: "faible" },
  { cls: "alab-mat-frost", name: "Flou 20", cost: "moyen" },
  { cls: "alab-mat-thick", name: "Flou 40", cost: "élevé" },
  { cls: "alab-mat-clear", name: "Verre clair", cost: "moyen" },
];

function ScrollLot({ posters }: { posters: string[] }) {
  const { gesture } = useLab();
  const [pick, setPick] = useState(2);
  const m = SCROLL_MATERIALS[pick];
  return (
    <>
      <Card
        tall
        title={`Barre sur une liste qui défile — ${m.name}`}
        hint="Le cas cher : chaque image du défilement refait le flou sous la barre. C'est ce qui faisait hoqueter iOS sous la barre du téléphone. Fais défiler vite, compare les matières."
        cost={m.cost}
        footer={
          <div className="flex flex-wrap gap-1.5 pt-1">
            {SCROLL_MATERIALS.map((s, i) => (
              <button key={s.name} type="button" className={`chip ${i === pick ? "chip-on" : ""}`} onClick={() => setPick(i)}>{s.name}</button>
            ))}
          </div>
        }
      >
        <div className="alab-scroller bg-[#0b0b0e]">
          <div className="grid grid-cols-3 gap-2">
            {(posters.length > 0 ? posters : Array.from({ length: 30 }, () => "")).map((url, i) => (
              <div
                key={i}
                className="aspect-[2/3] rounded-lg bg-white/5 bg-cover bg-center"
                style={url ? { backgroundImage: `url("${tmdbResize(url, "w185") ?? url}")` } : undefined}
              />
            ))}
          </div>
        </div>
        <div className={`alab-scroll-bar ${m.cls}`}>
          {TABS.map((tab) => (
            <GlassButton key={tab.name} gesture={gesture} label={tab.name} size="alab-round"><tab.icon size={20} /></GlassButton>
          ))}
        </div>
      </Card>
    </>
  );
}
