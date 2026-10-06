"use client";

import { useEffect, useState, type RefObject } from "react";
import { arrivedByBack } from "@/lib/cinemaRoute";

/**
 * La position de défilement d'un panneau, retrouvée au retour (demandé le 06/10/2026).
 *
 * Chaque vue de l'activité est une entrée d'historique, montée à neuf sous sa propre clé : revenir
 * d'une fiche compte ou d'une séance remettait la vue d'ensemble tout en haut, et il fallait
 * redescendre jusqu'à la liste qu'on venait de quitter. La position est gardée par vue
 * (`sessionStorage`, la durée de l'onglet), et rendue **seulement en revenant en arrière**
 * (`arrivedByBack`, lu une fois au montage) : ouvrir l'activité depuis Compte commence en haut.
 *
 * Le contenu arrive après le montage (les données de la vue) : la position est rendue dès que la
 * hauteur le permet, abandonnée au premier geste de la personne ou au bout de quatre secondes —
 * jamais un saut sous le doigt de quelqu'un qui a déjà commencé à lire.
 */
const STORE = "cine:panel-scroll";
const GIVE_UP_MS = 4000;

function readAll(): Record<string, number> {
  try {
    return JSON.parse(sessionStorage.getItem(STORE) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}
function save(key: string, top: number): void {
  try {
    const all = readAll();
    all[key] = Math.round(top);
    // Borné : une vingtaine de vues suffisent à un aller-retour dans l'activité.
    const keys = Object.keys(all);
    if (keys.length > 40) for (const k of keys.slice(0, keys.length - 40)) delete all[k];
    sessionStorage.setItem(STORE, JSON.stringify(all));
  } catch {
    /* navigation privée : on repartira du haut */
  }
}

export function usePanelScrollMemory(bodyRef: RefObject<HTMLElement | null>, key: string | undefined, remountKey?: unknown): void {
  // Lu une fois, au montage : c'est un fait de cette arrivée-ci (règle des fiches, CLAUDE.md).
  // Seulement pour un panneau qui garde sa position : les autres n'ont rien à demander.
  const [cameBack] = useState(() => (key ? arrivedByBack() : false));

  useEffect(() => {
    const body = bodyRef.current;
    if (!key || !body) return;
    let restoring = cameBack ? readAll()[key] ?? 0 : 0;
    let frame = 0;
    // Déclarés avant `stopRestoring`, qui peut être appelé dès l'observation : un contenu déjà assez
    // haut au montage rend la position tout de suite.
    let observer: ResizeObserver | null = null;
    let giveUp = 0;
    const stopRestoring = () => {
      restoring = 0;
      observer?.disconnect();
      window.clearTimeout(giveUp);
    };
    const tryRestore = () => {
      if (!restoring) return;
      if (body.scrollHeight - body.clientHeight >= restoring - 2) {
        body.scrollTop = restoring;
        stopRestoring();
      }
    };
    giveUp = window.setTimeout(stopRestoring, GIVE_UP_MS);
    tryRestore();
    if (restoring) {
      observer = new ResizeObserver(tryRestore);
      if (body.firstElementChild) observer.observe(body.firstElementChild);
    }

    const onScroll = () => {
      if (restoring) return; // nos propres réglages pendant la remise en place ne comptent pas
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => save(key, body.scrollTop));
    };
    const onGesture = () => stopRestoring();
    body.addEventListener("scroll", onScroll, { passive: true });
    body.addEventListener("wheel", onGesture, { passive: true });
    body.addEventListener("touchstart", onGesture, { passive: true });
    body.addEventListener("keydown", onGesture);
    return () => {
      stopRestoring();
      cancelAnimationFrame(frame);
      body.removeEventListener("scroll", onScroll);
      body.removeEventListener("wheel", onGesture);
      body.removeEventListener("touchstart", onGesture);
      body.removeEventListener("keydown", onGesture);
    };
  }, [bodyRef, key, cameBack, remountKey]);
}
