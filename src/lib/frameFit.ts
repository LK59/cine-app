/**
 * Agrandir l'image jusqu'au bord le plus proche de l'écran, sans jamais en couper.
 *
 * Côté navigateur : la mesure vient du serveur (`pictureFrame.ts`), qui dit où l'image se trouve
 * dans le cadre du fichier. L'élément vidéo, lui, ajuste le *cadre* à l'écran (`object-contain`).
 * On l'agrandit ensuite du facteur qui amène l'image — et non plus le cadre — contre le premier bord
 * de l'écran qu'elle touche : seul du noir sort de l'écran, jamais une ligne d'image.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties, type RefObject } from "react";

/** Le rectangle de l'image dans le cadre, en fractions de sa largeur et de sa hauteur. */
export interface PictureFrame {
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Largeur ÷ hauteur du cadre, tel que Jellyfin l'a réduit en vignette. */
  aspect: number;
  /** Combien de vignettes avaient quelque chose à dire. */
  samples: number;
}

/** En deçà, on ne bouge pas : 1 % d'agrandissement ne se voit pas, un mouvement si. */
const MIN_GAIN = 1.01;

/**
 * Ce qu'on laisse de noir autour de l'image sur un écran tactile, en fraction de l'écran.
 *
 * Les téléphones et les tablettes ont des coins arrondis : une image amenée exactement au bord
 * s'y faisait rogner quatre petits triangles (The Kissing Booth sur iPhone, 24/09/2026). Deux pour
 * cent — huit points sur un iPhone en paysage — les rendent invisibles sans rien reprendre de ce
 * qu'on gagne. Pas davantage : le rayon des coins fait une cinquantaine de points, aucune marge
 * raisonnable ne l'efface tout à fait. La Dynamic Island, elle, passe sur l'image, comme dans
 * toutes les apps vidéo d'iOS : l'éviter coûterait soixante points de chaque côté.
 */
export const TOUCH_MARGIN = 0.02;

/**
 * Le facteur et le décalage à appliquer à l'élément, ou null s'il n'y a rien à gagner.
 *
 * Le décalage recentre l'image quand ses bandes ne sont pas égales : c'est son centre, et non celui
 * du cadre, qui doit tomber au milieu de l'écran.
 */
export function frameFit(
  frame: PictureFrame,
  screen: { width: number; height: number },
  margin = 0
): { scale: number; x: number; y: number } | null {
  const { width, height } = screen;
  if (!(width > 0 && height > 0 && frame.aspect > 0)) return null;
  // Le cadre tel que `object-contain` le pose.
  const shownWidth = Math.min(width, height * frame.aspect);
  const shownHeight = shownWidth / frame.aspect;
  const pictureWidth = shownWidth * (frame.right - frame.left);
  const pictureHeight = shownHeight * (frame.bottom - frame.top);
  if (!(pictureWidth > 0 && pictureHeight > 0)) return null;
  // Le plus petit des deux : l'image touche le premier bord atteint, et l'autre dimension garde tout.
  const scale = Math.min((width * (1 - margin)) / pictureWidth, (height * (1 - margin)) / pictureHeight);
  if (scale < MIN_GAIN) return null;
  const centreX = ((frame.left + frame.right) / 2 - 0.5) * shownWidth;
  const centreY = ((frame.top + frame.bottom) / 2 - 0.5) * shownHeight;
  return { scale, x: -centreX * scale, y: -centreY * scale };
}

const PREFERENCE_KEY = "cine:frame-fit";
let preferenceCached: boolean | null = null;
const preferenceListeners = new Set<() => void>();

/**
 * L'ajustement voulu sur cet appareil : oui par défaut, non si la personne l'a coupé.
 *
 * Par appareil, comme l'apparence des sous-titres : qui préfère voir l'image entière — par exemple
 * pour qu'elle ne passe pas sous la Dynamic Island — le préfère pour tous ses films, et pas sur son
 * ordinateur, qui n'en a pas. Stockage indisponible : l'ajustement, qui est le défaut.
 */
export const frameFitPreference = {
  subscribe(listener: () => void): () => void {
    preferenceListeners.add(listener);
    return () => preferenceListeners.delete(listener);
  },
  snapshot(): boolean {
    if (preferenceCached === null) {
      try {
        preferenceCached = window.localStorage.getItem(PREFERENCE_KEY) !== "off";
      } catch {
        preferenceCached = true;
      }
    }
    return preferenceCached;
  },
  serverSnapshot: (): boolean => true,
  set(on: boolean): void {
    preferenceCached = on;
    try {
      window.localStorage.setItem(PREFERENCE_KEY, on ? "on" : "off");
    } catch {
      // Voir plus haut : le réglage vaut pour cette séance.
    }
    for (const listener of preferenceListeners) listener();
  },
};

/** Au-delà de cet écart, la mesure et la vidéo ne parlent pas du même fichier. */
const ASPECT_TOLERANCE = 0.02;

/**
 * Si la mesure décrit bien la vidéo qui joue.
 *
 * La mesure est gardée par élément Jellyfin, et un fichier remplacé par Radarr ou Sonarr garde
 * souvent son élément, son chemin et parfois ses vignettes : une mesure faite sur un 1920×1080 à
 * bandes, appliquée à son remplaçant 1920×800 sans bandes, coupait 16 % de la largeur sur un
 * téléphone (relu le 24/09/2026). Quand deux lectures d'un fichier se contredisent, on ne choisit
 * pas : on n'agrandit pas. Les vignettes suivent le format d'affichage — vérifié sur 2 999
 * éléments, DVD anamorphosés compris —, donc en temps normal les deux concordent.
 */
export function frameMatchesMedia(frame: PictureFrame, mediaAspect: number | null): boolean {
  if (!mediaAspect || !(mediaAspect > 0)) return false;
  return Math.abs(frame.aspect - mediaAspect) / mediaAspect <= ASPECT_TOLERANCE;
}

export interface FrameFitState {
  /** À poser sur le cadre qui porte les surfaces. */
  style: CSSProperties;
  /** Un agrandissement existe pour ce film sur cet écran — l'interrupteur n'a de sens qu'alors. */
  available: boolean;
  on: boolean;
  setOn: (on: boolean) => void;
}

/**
 * Le style à poser sur la vidéo pour un élément donné, recalculé quand l'écran change de taille
 * (rotation, fenêtre redimensionnée).
 *
 * La mesure est demandée dès l'ouverture, en parallèle et sans que rien ne l'attende : servie par
 * le cache, elle est là avant la première image et l'agrandissement ne se voit pas se faire ; mesurée
 * pour la première fois, elle arrive une demi-seconde plus tard et l'image glisse à sa place.
 * Hors SWR à dessein : SWR est suspendu tant qu'un film occupe l'écran (voir CLAUDE.md).
 */
export function useFrameFit(
  itemId: string,
  enabled: boolean,
  screenRef: RefObject<HTMLElement | null>,
  /** La vidéo qui joue : son propre format est ce à quoi la mesure est comparée. */
  mediaRef: RefObject<HTMLVideoElement | null>
): FrameFitState {
  const [measured, setMeasured] = useState<{ itemId: string; frame: PictureFrame | null } | null>(null);
  const [mediaAspect, setMediaAspect] = useState<number | null>(null);
  const [screen, setScreen] = useState<{ width: number; height: number } | null>(null);
  // Un écran tactile a des coins arrondis — voir `TOUCH_MARGIN`. Lu une fois : on ne change pas
  // d'écran en cours de film.
  const [margin] = useState(() =>
    typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches ? TOUCH_MARGIN : 0
  );

  useEffect(() => {
    const aborted = new AbortController();
    fetch(`/api/player/frame/${encodeURIComponent(itemId)}`, { signal: aborted.signal })
      .then((res) => (res.ok ? (res.json() as Promise<{ frame: PictureFrame | null }>) : { frame: null }))
      .then((body) => setMeasured({ itemId, frame: body.frame ?? null }))
      // Une mesure manquée ne coûte que l'agrandissement : le film est montré comme avant.
      .catch(() => {});
    return () => aborted.abort();
  }, [itemId]);

  useEffect(() => {
    const element = screenRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setScreen((previous) => (previous && previous.width === width && previous.height === height ? previous : { width, height }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [screenRef]);

  // Le format de l'image décodée, lu à chaque changement de dimensions. Le chemin canevas n'en
  // donne pas — l'élément vidéo y reste vide —, et n'est donc jamais agrandi : c'est le chemin de
  // secours, et ne rien couper y compte plus que de remplir l'écran.
  useEffect(() => {
    const video = mediaRef.current;
    if (!video) return;
    const read = () => setMediaAspect(video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : null);
    read();
    video.addEventListener("loadedmetadata", read);
    video.addEventListener("resize", read);
    return () => {
      video.removeEventListener("loadedmetadata", read);
      video.removeEventListener("resize", read);
    };
  }, [mediaRef]);

  const on = useSyncExternalStore(frameFitPreference.subscribe, frameFitPreference.snapshot, frameFitPreference.serverSnapshot);
  const setOn = useCallback((value: boolean) => frameFitPreference.set(value), []);

  const frame = measured?.itemId === itemId ? measured.frame : null;
  const fit = useMemo(
    () => (enabled && frame && screen && frameMatchesMedia(frame, mediaAspect) ? frameFit(frame, screen, margin) : null),
    [enabled, frame, screen, margin, mediaAspect]
  );
  const applied = on ? fit : null;
  // Toujours un style, même sans agrandissement : c'est ce qui laisse la transition ramener
  // l'image à sa taille en douceur — à l'interrupteur, au passage en mini-lecteur, à la rotation.
  const style = useMemo<CSSProperties>(
    () => ({
      transform: applied ? `translate(${applied.x.toFixed(1)}px, ${applied.y.toFixed(1)}px) scale(${applied.scale.toFixed(4)})` : "none",
      transition: "transform 700ms cubic-bezier(0.32, 0.72, 0, 1)",
    }),
    [applied]
  );
  return { style, available: fit !== null, on, setOn };
}
