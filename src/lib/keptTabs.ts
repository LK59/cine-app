"use client";

import { useState } from "react";

/**
 * Films ↔ Séries sans reconstruction (25/09/2026).
 *
 * Changer d'onglet démontait les rangées de l'onglet quitté : au retour, chaque rangée se
 * reconstruisait, chaque affiche se rechargeait et refaisait son fondu — « quand je retourne dans
 * Films, ça régénère les affiches ». Un onglet visité reste désormais monté, simplement caché.
 *
 * Caché veut dire : `hidden` (rien n'est peint ni mesuré, il ne coûte rien au rendu), `inert` (ni
 * focus, ni clic, ni lecteur d'écran) et `data-tab-hidden`, que la navigation au clavier et aux
 * gestes lit pour l'ignorer — « un écran qui s'en va n'a pas d'avis ». Une rangée cachée n'a
 * aucune surface : le décodage anticipé ne la chauffe pas, son défilement ne bouge pas.
 *
 * La bannière n'est pas concernée : elle vit hors de ces volets, et sa remise à plat quand son
 * onglet n'est pas affiché (`heroOffscreen`) ne dépend que de l'onglet courant.
 *
 * Une seule règle pour le bureau (`CinemaClient`) et le téléphone (`CinemaMobileClient`).
 */
export type CinemaTab = "movies" | "series";

/** L'attribut posé sur le volet d'un onglet caché. */
export const HIDDEN_TAB_ATTR = "data-tab-hidden";

/**
 * Les onglets à garder montés : ceux qu'on a déjà visités. Tenu pendant le rendu, comme les autres
 * « dernier vu » de ces écrans, et non dans un effet.
 */
export function useKeptTabs(active: CinemaTab): readonly CinemaTab[] {
  const [kept, setKept] = useState<readonly CinemaTab[]>([active]);
  if (!kept.includes(active)) {
    const next = [...kept, active];
    setKept(next);
    return next;
  }
  return kept;
}

/** Les propriétés du volet d'un onglet : visible, ou caché et inerte. */
export function tabPaneProps(
  tab: CinemaTab,
  active: CinemaTab,
  className?: string
): { hidden: boolean; inert: boolean; className?: string; "data-tab-hidden"?: "" } {
  const hidden = tab !== active;
  return {
    hidden,
    inert: hidden,
    ...(hidden ? { [HIDDEN_TAB_ATTR]: "" as const } : {}),
    ...(!hidden && className ? { className } : {}),
  };
}

/** Cet élément est-il dans l'onglet qu'on ne regarde pas ? */
export function inHiddenTab(element: Element): boolean {
  return element.closest(`[${HIDDEN_TAB_ATTR}]`) !== null;
}
