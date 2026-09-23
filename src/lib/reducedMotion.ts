"use client";

import { useSyncExternalStore } from "react";

/**
 * Le réglage « Réduire les animations » de l'appareil, pour ce que le CSS ne voit pas.
 *
 * globals.css l'applique à toutes les animations et transitions. Mais trois choses bougeaient en
 * JavaScript sans jamais le consulter (relevé le 23/09/2026) : la rotation automatique des
 * bannières, le défilement automatique du rail « À la une », et chaque `scrollIntoView` ou
 * `scrollTo` en `behavior: "smooth"` — la règle CSS `scroll-behavior: auto` ne s'applique pas à un
 * `smooth` demandé explicitement (spécification CSSOM View).
 */
const QUERY = "(prefers-reduced-motion: reduce)";

function media(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(QUERY);
}

/** Vrai quand l'appareil demande moins de mouvement. Faux quand on ne peut pas le savoir. */
export function prefersReducedMotion(): boolean {
  return media()?.matches ?? false;
}

/** Le `behavior` d'un défilement demandé par le code : animé, sauf si l'appareil n'en veut pas. */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}

function subscribe(onChange: () => void): () => void {
  const list = media();
  list?.addEventListener?.("change", onChange);
  return () => list?.removeEventListener?.("change", onChange);
}

/** Le même réglage, suivi : l'écran se met à jour si on le change pendant qu'il est ouvert. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}
