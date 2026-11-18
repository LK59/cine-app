"use client";

import { useSyncExternalStore } from "react";
import { KEYBOARD_MIN_PX } from "@/lib/ask/viewport";

/**
 * Le clavier de l'écran est-il ouvert ?
 *
 * Né pour les barres flottantes du bas (la pilule du cinéma, celle de la gestion) : pendant la saisie dans
 * Recherche, elles restaient posées au-dessus du clavier — sur Android, ~68 px de résultats cachés dans une
 * fenêtre déjà réduite ; sur iPhone, une pilule collée au clavier (18/11/2026). Elles s'effacent tant qu'il
 * est ouvert et reviennent quand il se ferme.
 *
 * Aucun navigateur ne dit « clavier ». On le reconnaît comme `ask/viewport.ts` : un champ de saisie a le
 * focus **et** la vue visuelle a perdu au moins `KEYBOARD_MIN_PX` depuis la hauteur relevée au moment du
 * focus (avant que le clavier monte). Les deux sont nécessaires :
 * - le focus seul ne suffit pas : le Retour d'Android et le « OK » d'iOS ferment le clavier en laissant le
 *   focus au champ — la barre serait restée absente jusqu'au prochain appui ailleurs ;
 * - la vue seule non plus : une barre d'outils qui se replie, un pincement, une rotation la changent aussi.
 * Sur ordinateur la vue ne rétrécit pas : rien ne change. Un pincement-zoom (`scale` > 1) n'est pas un clavier.
 *
 * Un seul jeu d'écouteurs pour toute l'application, posé au premier abonné (`useSyncExternalStore`).
 */

/** Ce qui ouvre un clavier : un champ de texte, pas une case à cocher, un bouton ou un curseur. */
const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);

export function isTextEntry(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has((el.getAttribute("type") ?? "").toLowerCase()) && !el.readOnly && !el.disabled;
  }
  return el.isContentEditable;
}

/** La hauteur de la vue relevée au focus d'un champ ; `null` sans champ actif. */
let baseline: number | null = null;
let open = false;
const listeners = new Set<() => void>();

function measure(): void {
  const vv = window.visualViewport;
  const next =
    baseline !== null && vv !== null && vv !== undefined && vv.scale <= 1.05 && baseline - vv.height >= KEYBOARD_MIN_PX;
  if (next === open) return;
  open = next;
  for (const l of listeners) l();
}

function onFocusIn(e: FocusEvent): void {
  if (!isTextEntry(e.target)) return;
  // D'un champ à l'autre, le clavier reste ouvert : la référence prise au premier focus est la bonne —
  // la reprendre ici, vue déjà rétrécie, aurait fait revenir la barre par-dessus le clavier.
  if (baseline === null) baseline = window.visualViewport?.height ?? null;
  measure();
}

function onFocusOut(e: FocusEvent): void {
  // Le focus passe à un autre champ : `focusin` suit, la référence est gardée.
  if (isTextEntry(e.relatedTarget)) return;
  baseline = null;
  measure();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    window.visualViewport?.addEventListener("resize", measure);
    // Un champ peut déjà avoir le focus quand la barre se monte : le clavier n'est pas mesuré pour lui
    // (aucune référence d'avant sa montée), il le sera à son prochain focus.
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      window.visualViewport?.removeEventListener("resize", measure);
      baseline = null;
      open = false;
    }
  };
}

const getSnapshot = () => open;
const getServerSnapshot = () => false;

export function useScreenKeyboard(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
