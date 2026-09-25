"use client";

import { useCallback, useEffect, useState } from "react";
import { usePrefersReducedMotion } from "@/lib/reducedMotion";
import { ROTATE_MS } from "@/lib/useRotatingIndex";
import type { CinemaRoute } from "@/lib/cinemaRoute";

/**
 * La bannière du cinéma quand ses données changent sous elle — bureau et téléphone, une seule règle.
 *
 * Depuis le 25/09/2026 le catalogue s'affiche d'abord depuis le cache de l'appareil, puis les
 * données fraîches arrivent un instant après. La bannière est la vitrine de la plateforme : c'est
 * elle qui montre qu'un film ajouté cette nuit est déjà là. Mais changer le film à l'écran une
 * demi-seconde après l'ouverture ressemble à un bug, aussi soignée que soit l'animation. D'où :
 *
 * - **on suit le film, pas sa place.** La rotation retenait un index ; une nouveauté insérée en
 *   tête de liste faisait désigner à ce même index un *autre* film, sans rien qui l'explique ;
 * - **le film à l'écran reste à l'écran**, et une nouveauté vient juste après lui : elle arrive au
 *   passage suivant de la rotation, huit secondes au plus, par la transition que tout le monde
 *   connaît déjà ;
 * - **dès que la bannière n'est plus à l'écran**, elle reprend l'ordre officiel et revient au
 *   début — la nouveauté en premier. Personne ne la regarde : c'est le moment de remettre d'aplomb.
 *
 * Rien ne bouge sous une personne qui interagit : la réconciliation ne change jamais le film à
 * l'écran, et la rotation est en pause pendant une sélection, un geste, une fiche (voir les
 * appelants). Pas de mention « nouveau » : ce n'est ni utile ni vérifiable simplement.
 *
 * La décision porte sur des **clés** (`f<radarrId>`, `s<sonarrId>`), pas sur des objets : le hook du
 * bureau ne reçoit que des valeurs primitives — voir `useHeroOrder`.
 */

export interface HeroOrder {
  /** L'ordre de cette session — pas forcément l'ordre officiel. */
  keys: string[];
  /** La place du titre à l'écran dans `keys`. */
  index: number;
}

/**
 * Le nouvel ordre de la bannière quand l'ordre officiel change. **La** décision, commune aux deux
 * bannières.
 *
 * - aucune donnée encore (premier rendu, pas de cache) : l'ordre officiel, depuis le début ;
 * - aucune nouveauté : **rien ne bouge** — même ordre, mêmes places ; un titre sorti de la liste
 *   disparaît, sauf celui qu'on regarde, qui reste jusqu'à la remise à plat ;
 * - des nouveautés : l'ordre officiel sans le titre à l'écran, ce titre gardé à sa place (les
 *   barres ne sautent pas), et les nouveautés juste après lui, dans leur ordre officiel — la plus
 *   en tête vient donc au passage suivant.
 */
export function reconcileHeroOrder(shown: readonly string[], index: number, official: readonly string[]): HeroOrder {
  const current = shown[index];
  if (shown.length === 0 || current === undefined) return { keys: [...official], index: 0 };
  const fresh = new Set(official);
  const known = new Set(shown);
  const novelties = official.filter((key) => !known.has(key));

  if (novelties.length === 0) {
    const keys = shown.filter((key) => key === current || fresh.has(key));
    return { keys, index: keys.indexOf(current) };
  }

  const isNew = new Set(novelties);
  const rest = official.filter((key) => key !== current && !isNew.has(key));
  const at = Math.min(index, rest.length);
  return { keys: [...rest.slice(0, at), current, ...novelties, ...rest.slice(at)], index: at };
}

/**
 * La bannière est-elle hors de l'écran — le moment de la remettre dans l'ordre officiel ?
 *
 * L'autre onglet (Séries, Films), le lecteur en plein écran, un panneau du rail (Ma liste, Compte,
 * la recherche, la grille complète, l'activité). **Pas** une fiche, ni une fiche TMDB ou
 * personne : ouvertes depuis la bannière, la refermer doit retrouver le titre d'où l'on vient —
 * c'est une interaction, et la rotation y est déjà en pause. **Pas** le retour d'arrière-plan :
 * la bannière est alors à l'écran, la remettre au début la ferait sauter sous les yeux.
 */
export function heroOffscreen(
  heroTab: "movies" | "series",
  route: Pick<CinemaRoute, "tab" | "list" | "account" | "search" | "browse" | "activity" | "report">,
  playerMode: string
): boolean {
  return (
    route.tab !== heroTab ||
    playerMode === "full" ||
    route.list ||
    route.account ||
    route.search ||
    route.browse !== null ||
    route.activity !== null ||
    // « Signaler un problème » recouvre l'écran comme l'activité (chasse aux défauts du 25/09/2026).
    route.report !== null
  );
}

/**
 * Le dernier changement du titre de la bannière, pour que les rangées attendent qu'elle ait fini :
 * bannière d'abord, rangées ensuite — sinon tout l'écran bouge en même temps et l'œil ne sait plus
 * où regarder. Une horloge du module plutôt qu'un contexte : les rangées mémoïsées n'ont pas à se
 * redessiner pour la lire, elles la consultent au moment d'animer.
 */
const HERO_LEAD_MS = 300;
let heroChangedAt = -Infinity;

export function noteHeroChange(now = performance.now()): void {
  heroChangedAt = now;
}

/** Combien de temps une rangée qui se réorganise maintenant doit attendre la bannière. */
export function rowsDelayMs(now = performance.now()): number {
  return Math.max(0, HERO_LEAD_MS - (now - heroChangedAt));
}

/**
 * Charger et décoder une image avant qu'elle soit montrée — sans flash noir à la transition.
 * Au mieux : un échec ne bloque rien, la transition se fera avec l'image quand elle viendra.
 */
export function decodeAhead(url: string | null | undefined): void {
  if (!url || typeof Image === "undefined") return;
  try {
    const image = new Image();
    image.src = url;
    void image.decode?.().catch(() => {});
  } catch {
    /* au mieux */
  }
}

/** Séparateur des signatures : absent des clés et des adresses d'images. */
const SEP = "\u0000";

/** Une liste de clés en une seule valeur primitive — voir `useHeroOrder`. */
export function heroSignature(keys: readonly string[]): string {
  return keys.join(SEP);
}

function splitSignature(signature: string): string[] {
  return signature === "" ? [] : signature.split(SEP);
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, i) => key === b[i]);
}

interface OrderState extends HeroOrder {
  /** La signature officielle d'où cet ordre a été tiré. */
  source: string;
}

/**
 * La rotation de la bannière, réconciliée avec ses données — voir le haut de ce module.
 *
 * Remplace `useRotatingIndex` pour les deux bannières du cinéma : même cadence, même pause pour qui
 * demande moins de mouvement, mais l'ordre suit le titre affiché. Les réglages d'état se font
 * pendant le rendu, comme dans `useRotatingIndex` — la forme que React recommande pour un état
 * dérivé.
 *
 * **Rien que des valeurs primitives en entrée, et la forme de `useState` en sortie**
 * (`[index, setIndex, clés]`). Passé à un hook, le moindre tableau tiré des données du rendu fait
 * supposer au compilateur React que le hook peut le modifier : il cessait alors de tenir pour
 * stables les `setState` de `CinemaClient`, et refusait d'optimiser tout le composant (« existing
 * memoization could not be preserved » sur huit rappels qui n'avaient pas changé — mesuré le
 * 25/09/2026, `useRotatingIndex(longueur, booléen)` n'y a jamais été exposé).
 */
export function useHeroOrder(
  officialSignature: string,
  paused: boolean,
  offscreen: boolean
): [number, (next: number) => void, string[]] {
  const [state, setState] = useState<OrderState>(() => ({
    source: officialSignature,
    keys: splitSignature(officialSignature),
    index: 0,
  }));
  let current = state;
  if (offscreen) {
    // Hors de l'écran : l'ordre officiel, depuis le début.
    if (state.index !== 0 || state.source !== officialSignature || !sameKeys(state.keys, splitSignature(officialSignature))) {
      current = { source: officialSignature, keys: splitSignature(officialSignature), index: 0 };
      setState(current);
    }
  } else if (state.source !== officialSignature) {
    current = { source: officialSignature, ...reconcileHeroOrder(state.keys, state.index, splitSignature(officialSignature)) };
    setState(current);
  }

  const reducedMotion = usePrefersReducedMotion();
  const length = current.keys.length;
  const index = length > 0 ? Math.min(Math.max(0, current.index), length - 1) : 0;

  useEffect(() => {
    if (paused || offscreen || reducedMotion || length <= 1) return;
    const id = setTimeout(() => setState((s) => ({ ...s, index: (s.index + 1) % Math.max(1, s.keys.length) })), ROTATE_MS);
    return () => clearTimeout(id);
  }, [length, index, paused, offscreen, reducedMotion]);

  // Le titre à l'écran a changé : les rangées qui se réorganisent au même moment l'attendront.
  const shownKey = length > 0 ? current.keys[index] : null;
  useEffect(() => {
    if (shownKey !== null) noteHeroChange();
  }, [shownKey]);

  // Stable : les barres et le geste du carrousel la reçoivent, et une fonction neuve à chaque
  // rendu défaisait la mémoïsation de la bannière du téléphone.
  const setIndex = useCallback(
    (next: number) => setState((s) => ({ ...s, index: Math.max(0, Math.min(next, s.keys.length - 1)) })),
    []
  );
  return [index, setIndex, current.keys];
}

/**
 * Décoder d'avance les images du titre qui viendra au prochain passage, pendant les huit secondes
 * d'attente — pour une transition sans flash noir. Une signature primitive, pour la même raison
 * que `useHeroOrder`.
 */
export function useDecodeAhead(urlsSignature: string): void {
  useEffect(() => {
    for (const url of splitSignature(urlsSignature)) decodeAhead(url);
  }, [urlsSignature]);
}

/**
 * Les titres d'un ordre de clés : ceux de la liste officielle, et à défaut ceux de `fallback` — le
 * titre à l'écran quand il vient de sortir de la liste. Une clé introuvable est sautée, et l'index
 * suit le titre qu'il désignait (le suivant s'il a disparu), jamais une simple position.
 */
export function resolveHeroCarousel<T>(
  keys: readonly string[],
  index: number,
  official: readonly T[],
  keyOf: (item: T) => string,
  fallback?: (key: string) => T | undefined
): { items: T[]; index: number } {
  const byKey = new Map(official.map((item) => [keyOf(item), item]));
  const items: T[] = [];
  let shown = -1;
  keys.forEach((key, i) => {
    const item = byKey.get(key) ?? fallback?.(key);
    if (item === undefined) return;
    if (i >= index && shown === -1) shown = items.length;
    items.push(item);
  });
  return { items, index: shown === -1 ? 0 : shown };
}

/** Les adresses des images d'un titre, en une signature pour `useDecodeAhead`. */
export function upcomingImages<T>(items: readonly T[], index: number, urlsOf: (item: T) => (string | null | undefined)[]): string {
  if (items.length <= 1) return "";
  const next = items[(index + 1) % items.length];
  return next === undefined ? "" : heroSignature(urlsOf(next).filter((url): url is string => Boolean(url)));
}
