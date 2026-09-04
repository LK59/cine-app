"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Les écrans où revenir en arrière doit rendre sa place, et eux seuls.
 *
 * Une grille de six cents affiches parcourue jusqu'au milieu, c'est un travail : la rouvrir en
 * haut le jette. Une fiche de film, non — on y arrive pour la lire, et on la lit depuis le haut.
 * Restaurer la position sur une fiche ne rendait service à personne et faisait exactement ce qui
 * a été signalé : ouvrir un film et se retrouver au milieu de sa page.
 */
const RESTORES_SCROLL = new Set([
  "/",
  "/radarr",
  "/sonarr",
  "/discover",
  "/recommendations",
  "/watchlist",
  "/calendar",
  "/timeline",
  "/qbittorrent",
  "/jellyfin",
  "/jellyseerr",
  "/bazarr",
  "/stats",
]);

export function ScrollRestorer() {
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    const main = document.querySelector("main");
    if (!main) return;

    const remember = (path: string) => {
      if (!RESTORES_SCROLL.has(path) || main.scrollTop <= 0) return;
      sessionStorage.setItem(`scroll:${path}`, String(Math.round(main.scrollTop)));
    };

    const onCapture = (e: MouseEvent) => {
      const a = (e.target as Element)?.closest("a[href]");
      if (!a) return;
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("http") || href.startsWith("//") || href.startsWith("mailto:")) return;
      remember(window.location.pathname);
    };

    const onPopstate = () => remember(pathnameRef.current);

    document.addEventListener("click", onCapture, true);
    window.addEventListener("popstate", onPopstate);
    return () => {
      document.removeEventListener("click", onCapture, true);
      window.removeEventListener("popstate", onPopstate);
    };
  }, []);

  useEffect(() => {
    const main = document.querySelector("main");
    if (!main) return;

    const saved = RESTORES_SCROLL.has(pathname) ? sessionStorage.getItem(`scroll:${pathname}`) : null;
    if (saved === null) {
      const frame = requestAnimationFrame(() => {
        main.scrollTop = 0;
      });
      return () => cancelAnimationFrame(frame);
    }

    sessionStorage.removeItem(`scroll:${pathname}`);
    const target = Number(saved);

    /**
     * La restauration attend que la page soit assez haute pour l'accepter — le contenu arrive
     * par SWR, après le premier rendu — mais elle doit s'arrêter net quand on quitte la page.
     *
     * Elle ne s'arrêtait pas : l'observateur survivait cinq secondes à la navigation suivante et
     * continuait de repousser le défilement à l'ancienne position à chaque fois que la nouvelle
     * page grandissait. Ouvrir un film dans les cinq secondes suivant un retour sur la grille le
     * faisait donc s'ouvrir au milieu — et une fois sur deux seulement, selon la vitesse à
     * laquelle les données arrivaient. C'est le bug signalé.
     */
    let observer: MutationObserver | null = null;
    const settle = () => {
      main.scrollTop = target;
      return Math.abs(main.scrollTop - target) <= 2;
    };

    const frame = requestAnimationFrame(() => {
      if (settle()) return;
      observer = new MutationObserver(() => {
        if (settle()) observer?.disconnect();
      });
      observer.observe(main, { childList: true, subtree: true });
    });
    const giveUp = setTimeout(() => observer?.disconnect(), 5000);

    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(giveUp);
      observer?.disconnect();
    };
  }, [pathname]);

  return null;
}
