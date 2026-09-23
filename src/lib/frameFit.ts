/**
 * Agrandir l'image jusqu'au bord le plus proche de l'écran, sans jamais en couper.
 *
 * Côté navigateur : la mesure vient du serveur (`pictureFrame.ts`), qui dit où l'image se trouve
 * dans le cadre du fichier. L'élément vidéo, lui, ajuste le *cadre* à l'écran (`object-contain`).
 * On l'agrandit ensuite du facteur qui amène l'image — et non plus le cadre — contre le premier bord
 * de l'écran qu'elle touche : seul du noir sort de l'écran, jamais une ligne d'image.
 */

import { useEffect, useMemo, useState, type CSSProperties, type RefObject } from "react";

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
 * Le facteur et le décalage à appliquer à l'élément, ou null s'il n'y a rien à gagner.
 *
 * Le décalage recentre l'image quand ses bandes ne sont pas égales : c'est son centre, et non celui
 * du cadre, qui doit tomber au milieu de l'écran.
 */
export function frameFit(frame: PictureFrame, screen: { width: number; height: number }): { scale: number; x: number; y: number } | null {
  const { width, height } = screen;
  if (!(width > 0 && height > 0 && frame.aspect > 0)) return null;
  // Le cadre tel que `object-contain` le pose.
  const shownWidth = Math.min(width, height * frame.aspect);
  const shownHeight = shownWidth / frame.aspect;
  const pictureWidth = shownWidth * (frame.right - frame.left);
  const pictureHeight = shownHeight * (frame.bottom - frame.top);
  if (!(pictureWidth > 0 && pictureHeight > 0)) return null;
  // Le plus petit des deux : l'image touche le premier bord atteint, et l'autre dimension garde tout.
  const scale = Math.min(width / pictureWidth, height / pictureHeight);
  if (scale < MIN_GAIN) return null;
  const centreX = ((frame.left + frame.right) / 2 - 0.5) * shownWidth;
  const centreY = ((frame.top + frame.bottom) / 2 - 0.5) * shownHeight;
  return { scale, x: -centreX * scale, y: -centreY * scale };
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
export function useFrameFit(itemId: string, enabled: boolean, screenRef: RefObject<HTMLElement | null>): CSSProperties | undefined {
  const [measured, setMeasured] = useState<{ itemId: string; frame: PictureFrame | null } | null>(null);
  const [screen, setScreen] = useState<{ width: number; height: number } | null>(null);

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

  const frame = measured?.itemId === itemId ? measured.frame : null;
  return useMemo(() => {
    const fit = enabled && frame && screen ? frameFit(frame, screen) : null;
    // Toujours un style, même sans agrandissement : c'est ce qui laisse la transition ramener
    // l'image à sa taille en douceur quand on passe au mini-lecteur ou qu'on tourne l'écran.
    return {
      transform: fit ? `translate(${fit.x.toFixed(1)}px, ${fit.y.toFixed(1)}px) scale(${fit.scale.toFixed(4)})` : "none",
      transition: "transform 700ms cubic-bezier(0.32, 0.72, 0, 1)",
    };
  }, [enabled, frame, screen]);
}
