"use client";

import "./animLab.css";
import { createPortal } from "react-dom";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import useSWR from "swr";
import {
  AudioLines, Bookmark, Captions, Cast, Check, ChevronLeft, ChevronRight, EllipsisVertical, Expand, Film, Gauge, Heart, Home, Maximize, Pause,
  PictureInPicture2, Play, Plus, RotateCcw, RotateCw, Share2, SlidersHorizontal, Subtitles, Tv, Volume2, VolumeX, X,
} from "lucide-react";
import { cacheOnlyOptions, MOVIES_CATALOGUE_KEY } from "@/lib/swr";
import { usePointerCapture } from "@/lib/usePointerCapture";
import { catalogueTitles, cinemaFetcher } from "@/lib/cinemaPayload";
import { PlayerIntroLot, SheetOpenLot } from "./IntroLots";
import type { CinemaMoviesPayload } from "@/app/api/cinema/movies/route";
import { tmdbResize } from "@/lib/images";
import { isWebKitEngine } from "@/lib/webkitEngine";
import { liquidTransform, pullFrom, toSpring } from "@/lib/liquidGlass/liquid";
import { attachGesture, attachLabLiquid, GESTURES, type GestureKind, type GestureSettings } from "./gestures";
import { simulateSpring, springKeyframes, springOvershoot, type SpringParams } from "@/lib/liquidGlass/spring";

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
  { cls: "alab-mat-mixed", name: "Verre mixte — clair + poli (choix)", cost: "faible", hint: "Le choix du 04/10 : reflet et bord du verre clair, flou 20 px du verre poli, teinte sombre de 32 % pour rester lisible sur un fond clair." },
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


type LabImage = { full: string; thumb: string; title: string } | null;

type Lab = {
  settingsRef: RefObject<GestureSettings>;
  /** Le facteur du ralenti, pour ce qui vit hors de la page (le lecteur en plein écran, porté dans `body`). */
  slow: number;
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
  { id: "F", name: "Lecteur simulé" },
  { id: "A", name: "Gestes d'appui" },
  { id: "B", name: "Matières" },
  { id: "C", name: "Apparition du flou" },
  { id: "D", name: "Groupes et métamorphoses" },
  { id: "E", name: "Défilement sous verre" },
  { id: "G", name: "Lancement de la lecture" },
  { id: "H", name: "Ouverture de fiche" },
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
  const [lot, setLot] = useState<LotId>("F");
  const [response, setResponse] = useState(0.45);
  const [ratio, setRatio] = useState(0.8);
  const [slow, setSlow] = useState(false);
  const [moving, setMoving] = useState(false);
  const [whiteText, setWhiteText] = useState(false);
  const [lensOn, setLensOn] = useState(support.lens);
  const [gesture, setGesture] = useState<GestureKind>("liquid");
  const [materialIndex, setMaterialIndex] = useState(0);
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
  // Les titres entiers (logo, affiche, visuel) pour les lots G et H — voir `IntroLots.tsx`.
  const titles = useMemo(() => (movies ? catalogueTitles(movies) : []), [movies]);

  const spring = useMemo(() => toSpring(response, ratio), [response, ratio]);
  const overshoot = useMemo(() => springOvershoot(spring), [spring]);
  const settingsRef = useRef<GestureSettings>({ spring, slow: 1 });
  useEffect(() => {
    settingsRef.current = { spring, slow: slow ? 5 : 1 };
  }, [spring, slow]);

  const lab = useMemo<Lab>(
    () => ({ settingsRef, slow: slow ? 5 : 1, gesture, material: MATERIALS[materialIndex], image, moving, whiteText }),
    [slow, gesture, materialIndex, image, moving, whiteText],
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
        {lot !== "A" && lot !== "G" && lot !== "H" && (
          <Row label="Geste des boutons">
            <select className="select max-w-full" value={gesture} onChange={(e) => setGesture(e.target.value as GestureKind)}>
              {GESTURES.map((g) => <option key={g.kind} value={g.kind}>{g.name}</option>)}
            </select>
          </Row>
        )}

        {lot === "F" && <PlayerSimLot />}
        {lot === "G" && <PlayerIntroLot movies={titles} />}
        {lot === "H" && <SheetOpenLot movies={titles} />}
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
  active,
}: {
  /** `grouped` : le bouton d'une pilule qui porte le geste liquide — c'est elle qui l'écoute. */
  gesture: GestureKind | "grouped";
  material?: Material;
  size?: string;
  label: string;
  children: ReactNode;
  className?: string;
  /** Reçoit le bouton : un menu a besoin de savoir d'où il naît. */
  onClick?: (button: HTMLButtonElement) => void;
  /** Un réglage en service (sous-titres affichés) : un point sous l'icône, comme dans le lecteur. */
  active?: boolean;
}) {
  const { settingsRef } = useLab();
  const ref = useRef<HTMLButtonElement>(null);
  // Les deux fonctions sont stables ; l'objet qui les porte ne l'est pas — d'où la déstructuration,
  // sans quoi chaque rendu décrocherait et raccrocherait le geste.
  const { take, release } = usePointerCapture();
  useEffect(() => {
    const el = ref.current;
    if (!el || gesture === "grouped") return;
    return attachGesture(el, gesture, () => settingsRef.current, { take, release });
  }, [gesture, settingsRef, take, release]);
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      // Le clic d'un bouton ne remonte pas jusqu'au fond : dans le lecteur simulé, le fond
      // montre et cache les commandes.
      data-active={active ? "" : undefined}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e.currentTarget);
      }}
      className={`alab-btn ${size} ${material?.cls ?? ""} ${gesture === "liquid" ? "alab-slop" : ""} ${gesture === "active" ? "alab-press-active" : ""} ${gesture === "stretch" ? "alab-stretchy" : ""} ${className}`}
    >
      {material?.copy && <PrefrostCopy />}
      {material?.rim && <span className="alab-rim" />}
      <span className="alab-sheen" />
      <span className="alab-glowclip"><span className="alab-glow" /></span>
      {children}
    </button>
  );
}

/**
 * Une pilule de boutons, la matière sur la pilule — un seul calque flou pour le groupe. Avec le
 * geste liquide, c'est elle qui l'écoute et elle entière qui gonfle et s'étire (demandé le
 * 04/10/2026) ; ses boutons reçoivent `grouped` et ne font que s'éclairer.
 */
function GlassPill({
  gesture,
  material,
  children,
  className = "",
  pillRef,
}: {
  gesture: GestureKind;
  material: Material;
  children: (gesture: GestureKind | "grouped") => ReactNode;
  className?: string;
  pillRef?: RefObject<HTMLDivElement | null>;
}) {
  const { settingsRef } = useLab();
  const own = useRef<HTMLDivElement>(null);
  const ref = pillRef ?? own;
  useEffect(() => {
    const el = ref.current;
    if (!el || gesture !== "liquid") return;
    return attachLabLiquid(el, () => settingsRef.current);
  }, [gesture, settingsRef, ref]);
  return (
    // `alab-slop` écrit ici aussi : React réécrit `className` quand la matière change, et la
    // classe posée par `attachLiquid` aurait disparu avec.
    <div ref={ref} className={`alab-pill ${material.cls} ${gesture === "liquid" ? "alab-slop" : ""} ${className}`}>
      {material.copy && <PrefrostCopy />}
      {material.rim && <span className="alab-rim" style={{ borderRadius: 999 }} />}
      {children(gesture === "liquid" ? "grouped" : gesture)}
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
        const entry = child.animate(keyframes, { duration: duration * s.slow, easing: "linear", fill: "both" });
        entry.id = "appear";
        // Rendue une fois jouée : une animation qui reste « remplie » l'emporterait sur le
        // `transform` que le geste liquide écrit sur le nœud, et l'étirement ne se verrait plus.
        entry.finished.then(() => entry.cancel(), () => {});
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
  const frost = MATERIALS.find((m) => m.cls === "alab-mat-frost") ?? MATERIALS[0];
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

  const lensAt = (x: number, swell: number, stretch: number, y = 0) =>
    `translate(${x}px, ${y}px) scale(${swell * (1 + stretch)}, ${swell * (1 - stretch * 0.45)})`;

  useEffect(() => {
    const bar = barRef.current;
    const lens = lensRef.current;
    if (!bar || !lens) return;
    const d = drag.current;
    const localX = (e: PointerEvent) => e.clientX - bar.getBoundingClientRect().left - 4 - TAB_W / 2;
    const clampPos = (x: number) => Math.min(Math.max(x, -10), (TABS.length - 1) * TAB_W + 10);
    // La barre entière suit aussi le doigt, en plus léger que le geste liquide d'un bouton
    // (demandé le 04/10/2026) : gonflée de 3 %, tirée à 60 % de la force.
    const BAR_SWELL = 1.03;
    const BAR_STRENGTH = 0.6;
    let barSize = { w: 0, h: 0 };
    let barPull = { r: 0, angle: 0 };
    let lensY = 0;
    const followFinger = (e: PointerEvent) => {
      const box = bar.getBoundingClientRect();
      const dx = e.clientX - (box.left + box.width / 2);
      const dy = e.clientY - (box.top + box.height / 2);
      barPull = pullFrom(dx, dy, barSize.w, barSize.h);
      lensY = Math.max(-4, Math.min(4, dy * 0.12));
      bar.getAnimations().forEach((a) => a.cancel());
      bar.style.transform = liquidTransform(barPull.r, barPull.angle, BAR_SWELL, barSize.w, barSize.h, BAR_STRENGTH);
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      d.active = true;
      d.moved = false;
      d.v = 0;
      d.lastX = e.clientX;
      d.lastT = e.timeStamp;
      take(e);
      barSize = { w: bar.offsetWidth, h: bar.offsetHeight };
      barPull = { r: 0, angle: 0 };
      lensY = 0;
      const s0 = settingsRef.current;
      bar.getAnimations().forEach((a) => a.cancel());
      bar.style.transform = liquidTransform(0, 0, BAR_SWELL, barSize.w, barSize.h, BAR_STRENGTH);
      bar.animate([{ transform: "scale(1)" }, { transform: bar.style.transform }], { duration: 140 * s0.slow, easing: "cubic-bezier(0.2, 0.9, 0.3, 1.25)" });
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
      followFinger(e);
      if (Math.abs(localX(e) - d.pos) > 4) d.moved = true;
      if (!d.moved) return;
      d.pos = clampPos(localX(e));
      lens.getAnimations().forEach((a) => a.cancel());
      lens.style.transform = lensAt(d.pos, 1.18, Math.min(Math.abs(d.v) / 3000, 0.25), lensY);
    };
    const onUp = () => {
      if (!d.active) return;
      d.active = false;
      release();
      const target = Math.min(Math.max(Math.round(d.pos / TAB_W), 0), TABS.length - 1);
      setIndex(target);
      const s = settingsRef.current;
      const { r: br, angle: ba } = barPull;
      const { w: bw, h: bh } = barSize;
      bar.style.transform = "";
      const back = springKeyframes(1, 0, s.spring, ({ x }) => ({
        transform: liquidTransform(br * Math.max(x, -0.5), ba, 1 + (BAR_SWELL - 1) * x, bw, bh, BAR_STRENGTH),
      }));
      bar.getAnimations().forEach((a) => a.cancel());
      bar.animate(back.keyframes, { duration: back.duration * s.slow, easing: "linear" });
      const fromY = lensY;
      const from = d.pos;
      const to = target * TAB_W;
      const span = Math.max(Math.abs(to - from), 1);
      const { keyframes, duration } = springKeyframes(from, to, s.spring, ({ x, v }) => {
        const swell = 1 + 0.18 * Math.min(1, Math.abs(to - x) / span);
        const p = Math.min(1, Math.abs(to - x) / span);
        return { transform: lensAt(x, from === to ? 1 : swell, Math.min(Math.abs(v) / 3000, 0.25), fromY * p) };
      }, d.moved ? d.v : 0);
      lens.getAnimations().forEach((a) => a.cancel());
      lens.style.transform = lensAt(to, 1, 0);
      if (from === to) {
        lens.animate([{ transform: lensAt(to, 1.18, 0, fromY) }, { transform: lensAt(to, 0.96, 0), offset: 0.5 }, { transform: lensAt(to, 1, 0) }], { duration: 320 * s.slow, easing: "ease-out" });
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
      bar.style.transform = "";
    };
  }, [settingsRef, take, release]);

  return (
    <Card title="Onglets à lentille" hint="Tape un onglet : la lentille y glisse et s'étire selon sa vitesse. Appuie et fais-la glisser : elle se soulève et suit le doigt, et la barre entière gonfle et s'étire légèrement vers lui, puis tout se pose sur le ressort." cost="nul">
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
  { cls: "alab-mat-mixed", name: "Mixte (choix)", cost: "moyen" },
  { cls: "alab-mat-smoke", name: "Opaque", cost: "nul" },
  { cls: "alab-mat-blur8", name: "Flou 8", cost: "faible" },
  { cls: "alab-mat-frost", name: "Flou 20", cost: "moyen" },
  { cls: "alab-mat-thick", name: "Flou 40", cost: "élevé" },
  { cls: "alab-mat-clear", name: "Verre clair", cost: "moyen" },
];

function ScrollLot({ posters }: { posters: string[] }) {
  const { gesture } = useLab();
  const [pick, setPick] = useState(0);
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

/* ─── Lot F : le lecteur simulé ─────────────────────────────────────────────── */

const SIM_FORMATS = [
  { id: "portrait", name: "Téléphone portrait", aspect: "9 / 19.5", maxWidth: "22rem", desktop: false },
  { id: "landscape", name: "Téléphone paysage", aspect: "19.5 / 9", maxWidth: "54rem", desktop: false },
  { id: "desktop", name: "Bureau", aspect: "16 / 9", maxWidth: "64rem", desktop: true },
] as const;
type SimFormat = (typeof SIM_FORMATS)[number];

const SIM_MATERIALS = ["alab-mat-mixed", "alab-mat-clear", "alab-mat-frost", "alab-mat-smoke"]
  .map((cls) => MATERIALS.find((m) => m.cls === cls && !m.rim))
  .filter((m): m is Material => !!m);

type MenuKind = "speed" | "audio" | "subs" | "more";
const MENUS: Record<MenuKind, { title: string; icon: typeof Gauge; items: string[] }> = {
  speed: { title: "Vitesse", icon: Gauge, items: ["0,5×", "0,75×", "Normale", "1,25×", "1,5×", "1,75×", "2×"] },
  audio: {
    title: "Audio",
    icon: AudioLines,
    items: ["Français — 5.1", "English — TrueHD Atmos — 7.1", "English — 5.1", "Español — Stéréo", "Deutsch — 5.1", "Italiano — Stéréo", "Commentaire — Stéréo"],
  },
  subs: {
    title: "Sous-titres",
    icon: Captions,
    items: [
      "Désactivés", "Français — Forcés", "Français", "Français — SDH", "English", "English — SDH", "Español", "Deutsch", "Italiano",
      "Português (Brasil)", "Nederlands", "Polski", "Svenska", "Dansk", "Norsk", "Suomi",
    ],
  },
  more: {
    title: "Plus d'options",
    icon: EllipsisVertical,
    items: ["Minuterie de veille · Désactivée", "Remplir l'écran", "Luminosité HDR · Auto", "Infos techniques", "Signaler un problème"],
  },
};
/** Plus haut, la liste défile : un menu géant qui couvre le film a été refusé le 04/10/2026. */
const MENU_MAX_HEIGHT = 280;

/** Où le menu naît : le coin bas-droit de la pilule, sa taille, et le centre du bouton touché — dans le repère du lecteur. */
type MenuAnchor = { right: number; bottom: number; pillW: number; pillH: number; btnX: number; btnY: number; maxHeight: number };

/** La place d'un élément dans un ancêtre, en coordonnées de mise en page : les `transform` d'un geste en cours n'y entrent pas. */
function layoutBox(el: HTMLElement, ancestor: HTMLElement) {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== ancestor) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

function PlayerSimLot() {
  const [format, setFormat] = useState<SimFormat["id"]>(() =>
    typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches ? "landscape" : "desktop",
  );
  const [matIndex, setMatIndex] = useState(0);
  const [full, setFull] = useState(false);
  const f = SIM_FORMATS.find((x) => x.id === format) ?? SIM_FORMATS[0];
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {SIM_FORMATS.map((x) => (
          <button key={x.id} type="button" className={`chip ${x.id === format ? "chip-on" : ""}`} onClick={() => setFormat(x.id)}>{x.name}</button>
        ))}
        <button type="button" className="chip" onClick={() => setFull(true)}>
          <Expand size={14} /> Plein écran
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {SIM_MATERIALS.map((m, i) => (
          <button key={m.cls} type="button" className={`chip ${i === matIndex ? "chip-on" : ""}`} onClick={() => setMatIndex(i)}>{m.name}</button>
        ))}
      </div>
      <p className="text-xs leading-relaxed text-subtle">
        {"La disposition du vrai lecteur, avec les choix du 04/10. Touche le fond pour cacher ou montrer les commandes. Vitesse, son, sous-titres et ⋮ s'ouvrent depuis leur pilule. « Plein écran » montre le lecteur à sa vraie taille — tourne le téléphone pour le paysage ; la croix en haut à gauche en sort."}
      </p>
      {/* Pas les deux à la fois : celui de la page, caché sous le plein écran, ferait encore ses
          flous à chaque image et fausserait ce qu'on juge. */}
      {!full && <PlayerSim key={f.id} format={f} material={SIM_MATERIALS[matIndex]} />}
      {full &&
        createPortal(
          <PlayerSim format={f} material={SIM_MATERIALS[matIndex]} full onExit={() => setFull(false)} />,
          document.body,
        )}
    </section>
  );
}

/** ±10 s : la flèche fait un tour autour du « 10 », qui reste immobile. */
function TenIcon({ dir, size }: { dir: -1 | 1; size: number }) {
  const Arrow = dir < 0 ? RotateCcw : RotateCw;
  return (
    <span className="alab-ten relative z-[2] inline-flex items-center justify-center">
      <span className="alab-ten-arrow inline-flex"><Arrow size={size} strokeWidth={2} /></span>
      <span className="alab-ten-label">10</span>
    </span>
  );
}

function spinTen(button: HTMLElement, dir: -1 | 1, slow: number) {
  const arrow = button.querySelector<HTMLElement>(".alab-ten-arrow");
  if (!arrow || typeof arrow.animate !== "function") return;
  arrow.getAnimations().forEach((a) => a.cancel());
  arrow.animate(
    [{ transform: "rotate(0deg)" }, { transform: `rotate(${dir * 380}deg)`, offset: 0.7 }, { transform: `rotate(${dir * 360}deg)` }],
    { duration: 520 * slow, easing: "cubic-bezier(0.3, 0.7, 0.4, 1)" },
  );
}

/** Deux icônes l'une sur l'autre : l'une s'efface en tournant pendant que l'autre arrive. */
function SwapIcon({ on, a, b }: { on: boolean; a: ReactNode; b: ReactNode }) {
  return (
    <span className="alab-swap relative z-[2]">
      <span data-off={on ? "" : undefined}>{a}</span>
      <span data-off={on ? undefined : ""}>{b}</span>
    </span>
  );
}

function PlayerSim({ format, material, full, onExit }: { format: SimFormat; material: Material; full?: boolean; onExit?: () => void }) {
  const { gesture, image, moving, whiteText, slow } = useLab();
  const [shown, setShown] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [muted, setMuted] = useState(false);
  const [menu, setMenu] = useState<{ kind: MenuKind; anchor: MenuAnchor; closing: boolean } | null>(null);
  const [picked, setPicked] = useState<Record<MenuKind, number>>({ speed: 2, audio: 0, subs: 0, more: -1 });
  const simRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onExit?.();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full, onExit]);

  const openMenu = (kind: MenuKind, button: HTMLElement) => {
    const sim = simRef.current;
    const pill = settingsRef.current;
    if (!sim || !pill) return;
    if (menu) {
      setMenu({ ...menu, closing: true });
      return;
    }
    const p = layoutBox(pill, sim);
    const b = layoutBox(button, sim);
    setMenu({
      kind,
      closing: false,
      anchor: {
        right: sim.clientWidth - (p.x + p.w),
        bottom: sim.clientHeight - (p.y + p.h),
        pillW: p.w,
        pillH: p.h,
        btnX: b.x + b.w / 2,
        btnY: b.y + b.h / 2,
        maxHeight: Math.min(MENU_MAX_HEIGHT, p.y + p.h - 12),
      },
    });
  };
  const closeMenu = () => setMenu((m) => (m ? { ...m, closing: true } : m));

  const btn = format.desktop ? 20 : 22;
  const style: CSSProperties = full
    ? ({ "--alab-slow": slow } as CSSProperties)
    : { aspectRatio: format.aspect, maxWidth: format.maxWidth, maxHeight: format.id === "portrait" ? "44rem" : undefined };
  return (
    <div
      ref={simRef}
      className={`alab-sim ${full ? "alab-sim-full" : ""} ${format.desktop ? "alab-sim-desktop" : ""} ${moving ? "alab-moving" : ""}`}
      style={style}
      data-shown={String(shown)}
      onClick={() => (menu ? closeMenu() : setShown((v) => !v))}
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
      <div className="alab-sim-shade-top" />
      <div className="alab-sim-shade-bottom" />

      {/* Le centre : ±10 s et lecture, posés sur le film. */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-6 sm:gap-10">
        <div className="pointer-events-auto">
          <GlassButton gesture={gesture} material={material} size="alab-sim-ctr" className="alab-fade-self" label="Reculer de 10 s" onClick={(el) => spinTen(el, -1, slow)}>
            <TenIcon dir={-1} size={btn + 8} />
          </GlassButton>
        </div>
        <div className="pointer-events-auto">
          <GlassButton gesture={gesture} material={material} size="alab-sim-ctr-main" className="alab-fade-self" label={playing ? "Pause" : "Lecture"} onClick={() => setPlaying((v) => !v)}>
            {playing ? <Pause size={btn + 12} fill="currentColor" /> : <Play size={btn + 12} fill="currentColor" />}
          </GlassButton>
        </div>
        <div className="pointer-events-auto">
          <GlassButton gesture={gesture} material={material} size="alab-sim-ctr" className="alab-fade-self" label="Avancer de 10 s" onClick={(el) => spinTen(el, 1, slow)}>
            <TenIcon dir={1} size={btn + 8} />
          </GlassButton>
        </div>
      </div>

      <div className="alab-sim-chrome pointer-events-none absolute inset-0 flex flex-col justify-between">
        <div className="alab-sim-row alab-sim-row-top pointer-events-auto flex items-center justify-between gap-3" onClick={(e) => shown && e.stopPropagation()}>
          <div className="flex items-center gap-3">
            <GlassButton gesture={gesture} material={material} size="alab-sim-solo" className="alab-fade-self" label="Fermer" onClick={() => onExit?.()}>
              <X size={btn + 2} />
            </GlassButton>
            <GlassPill gesture={gesture} material={material} className="alab-fade-self">
              {(g) => (
                <>
                  <GlassButton gesture={g} label="Diffuser"><Cast size={btn} /></GlassButton>
                  <GlassButton gesture={g} label="Réduire"><PictureInPicture2 size={btn} /></GlassButton>
                </>
              )}
            </GlassPill>
          </div>
          <GlassPill gesture={gesture} material={material} className="alab-fade-self">
            {(g) => (
              <GlassButton gesture={g} label={muted ? "Rétablir le son" : "Couper le son"} onClick={() => setMuted((v) => !v)}>
                <SwapIcon on={!muted} a={<Volume2 size={btn} />} b={<VolumeX size={btn} />} />
              </GlassButton>
            )}
          </GlassPill>
        </div>

        <div className="alab-sim-row alab-sim-row-bottom pointer-events-auto flex flex-col gap-3" onClick={(e) => shown && e.stopPropagation()}>
          <div className="flex items-end gap-3">
            <p className="alab-sim-title alab-fade-self min-w-0 flex-1 truncate pb-0.5 text-lg sm:text-2xl">{image?.title ?? "Titre du film"}</p>
            <GlassPill gesture={gesture} material={material} className="alab-fade-self shrink-0" pillRef={settingsRef}>
              {(g) => (
                <>
                  <GlassButton gesture={g} label="Vitesse" onClick={(el) => openMenu("speed", el)}>
                    {picked.speed !== 2 ? <span className="relative z-[2] text-[13px] font-semibold tabular-nums">{MENUS.speed.items[picked.speed]}</span> : <Gauge size={btn} />}
                  </GlassButton>
                  <GlassButton gesture={g} label="Audio" onClick={(el) => openMenu("audio", el)}><AudioLines size={btn} /></GlassButton>
                  <GlassButton gesture={g} label="Sous-titres" active={picked.subs !== 0} onClick={(el) => openMenu("subs", el)}><Captions size={btn} /></GlassButton>
                  <GlassButton gesture={g} label="Plus d'options" onClick={(el) => openMenu("more", el)}><EllipsisVertical size={btn} /></GlassButton>
                  {format.desktop && <GlassButton gesture={g} label="Plein écran"><Maximize size={btn} /></GlassButton>}
                </>
              )}
            </GlassPill>
          </div>
          <div className="alab-fade-self flex items-center gap-3">
            <span className="alab-sim-time">1:02:14</span>
            <div className="alab-sim-track min-w-0 flex-1"><span style={{ width: "56%" }} /></div>
            <span className="alab-sim-time">48:09</span>
          </div>
        </div>
      </div>

      {menu && (
        <SimMenu
          key={menu.kind}
          kind={menu.kind}
          anchor={menu.anchor}
          closing={menu.closing}
          material={material}
          pillRef={settingsRef}
          simRef={simRef}
          selected={picked[menu.kind]}
          onPick={(i) => {
            if (menu.kind !== "more") setPicked((p) => ({ ...p, [menu.kind]: i }));
            closeMenu();
          }}
          onClose={closeMenu}
          onClosed={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * Un menu du lecteur, né de la pilule des réglages.
 *
 * Une seule surface qui change de forme : découpée au départ exactement à la pilule (même
 * matière, même place — la pilule s'efface dessous), elle s'ouvre vers le haut et la gauche sur
 * le ressort. L'icône du bouton touché glisse jusqu'à l'en-tête et devient le titre ; la liste
 * apparaît en fondu — sur le contenu, jamais sur la surface floutée (lot C).
 *
 * La fermeture rend la pilule *dès que le menu a retrouvé sa forme*, pas à la fin du ressort :
 * sa queue (les petites oscillations autour de zéro) durait près d'une seconde, pendant laquelle
 * on ne voyait que l'icône du menu à la place des cinq boutons (04/10/2026). À ce moment-là, le
 * menu s'efface en fondu pendant que la pilule revient.
 */
function SimMenu({
  kind,
  anchor,
  closing,
  material,
  pillRef,
  simRef,
  selected,
  onPick,
  onClose,
  onClosed,
}: {
  kind: MenuKind;
  anchor: MenuAnchor;
  closing: boolean;
  material: Material;
  pillRef: RefObject<HTMLDivElement | null>;
  simRef: RefObject<HTMLDivElement | null>;
  selected: number;
  onPick: (i: number) => void;
  onClose: () => void;
  onClosed: () => void;
}) {
  const { settingsRef } = useLab();
  const boxRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<HTMLSpanElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { title, icon: Icon, items } = MENUS[kind];

  const run = (opening: boolean) => {
    const box = boxRef.current;
    const icon = iconRef.current;
    const sim = simRef.current;
    if (!box || !icon || !sim) return;
    const s = settingsRef.current;
    const W = box.offsetWidth;
    const H = box.offsetHeight;
    const top = Math.max(0, H - anchor.pillH);
    const left = Math.max(0, W - anchor.pillW);
    const r0 = anchor.pillH / 2;
    const shape = springKeyframes(opening ? 0 : 1, opening ? 1 : 0, s.spring, ({ x }) => {
      const p = Math.min(Math.max(x, 0), 1);
      // Le dépassement ne peut pas agrandir la découpe au-delà de la boîte : il passe en échelle.
      const bounce = 1 + Math.max(0, x - 1) * 0.3 - Math.max(0, -x) * 0.3;
      return {
        clipPath: `inset(${top * (1 - p)}px 0px 0px ${left * (1 - p)}px round ${r0 * (1 - p) + 22 * p}px)`,
        transform: `scale(${bounce})`,
      };
    });
    box.getAnimations().forEach((a) => a.cancel());
    box.animate(shape.keyframes, { duration: shape.duration * s.slow, easing: "linear", fill: "forwards" });

    // L'icône part de celle du bouton touché.
    const i = layoutBox(icon, sim);
    const dx = anchor.btnX - (i.x + i.w / 2);
    const dy = anchor.btnY - (i.y + i.h / 2);
    const path = springKeyframes(opening ? 0 : 1, opening ? 1 : 0, s.spring, ({ x }) => ({
      transform: `translate(${dx * (1 - x)}px, ${dy * (1 - x)}px)`,
    }));
    icon.getAnimations().forEach((a) => a.cancel());
    icon.animate(path.keyframes, { duration: path.duration * s.slow, easing: "linear", fill: "forwards" });

    const fade = (el: HTMLElement | null, delay: number) => {
      if (!el) return;
      el.getAnimations().forEach((a) => a.cancel());
      el.animate(
        opening ? [{ opacity: 0, transform: "translateX(-6px)" }, { opacity: 1, transform: "none" }] : [{ opacity: 1 }, { opacity: 0 }],
        { duration: (opening ? 200 : 110) * s.slow, delay: opening ? delay * s.slow : 0, easing: "ease-out", fill: "both" },
      );
    };
    fade(labelRef.current, 60);
    fade(listRef.current, 90);

    const pill = pillRef.current;
    if (pill && opening) {
      for (const a of pill.getAnimations()) if (a.id === "menu-hide") a.cancel();
      const hide = pill.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90 * s.slow, fill: "forwards" });
      hide.id = "menu-hide";
    }
  };

  // Ouvert au montage : la taille du menu n'est connue qu'une fois posé.
  useLayoutEffect(() => {
    run(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- une seule ouverture, au montage ; `run` lit tout ce qu'il faut sur le moment
  }, []);

  useEffect(() => {
    if (!closing) return;
    run(false);
    const s = settingsRef.current;
    // Le premier instant où le menu est revenu à 6 % de sa forme ouverte : la pilule revient là.
    const samples = simulateSpring(1, 0, s.spring);
    const back = (samples.find((q) => q.x <= 0.06)?.t ?? samples[samples.length - 1].t) * 1000 * s.slow;
    const handover = 120 * s.slow;
    const timers = [
      window.setTimeout(() => {
        const pill = pillRef.current;
        for (const a of pill?.getAnimations() ?? []) if (a.id === "menu-hide") a.cancel();
        pill?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: handover, easing: "ease-out" });
        // Le menu s'efface lui-même : l'opacité portée par la surface floutée, jamais par un parent.
        boxRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: handover, easing: "ease-out", fill: "forwards" });
      }, back),
      window.setTimeout(onClosed, back + handover),
    ];
    return () => timers.forEach((t) => window.clearTimeout(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rejoué à la seule demande de fermeture
  }, [closing]);

  return (
    <div
      ref={boxRef}
      className={`alab-sim-menu ${material.cls}`}
      style={{ right: anchor.right, bottom: anchor.bottom, maxHeight: anchor.maxHeight }}
      onClick={(e) => e.stopPropagation()}
    >
      {material.copy && <PrefrostCopy />}
      <button type="button" className="alab-sim-menu-head relative z-[2] text-left" onClick={onClose}>
        <span ref={iconRef} className="inline-flex"><Icon size={20} /></span>
        <span ref={labelRef}>{title}</span>
      </button>
      <div ref={listRef} className="alab-sim-menu-list relative z-[2] min-h-0 flex-1">
        {items.map((item, i) => (
          <button key={item} type="button" className="alab-sim-menu-item" onClick={() => onPick(i)} disabled={closing}>
            <span className="inline-flex w-4 justify-center">{i === selected && <Check size={16} />}</span>
            {item}
          </button>
        ))}
      </div>
    </div>
  );
}
