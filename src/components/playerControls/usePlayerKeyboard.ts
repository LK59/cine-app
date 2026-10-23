"use client";

/**
 * Le clavier du lecteur, posé une fois sur la fenêtre. Sorti de `PlayerControls` tel quel.
 */

import { useEffect, type RefObject } from "react";
import { normalizeKey } from "@/lib/remoteKeys";
import { useLatest } from "@/components/playerControls/useLatest";

/**
 * Le clavier du lecteur : un jeu fixe, et rien d'autre (demandé le 04/10/2026).
 *
 * Espace et K lisent ou mettent en pause, ← et → reculent ou avancent de dix secondes — où que
 * soit le focus. Le reste se fait à la souris ou au doigt. Le clavier circulait avant entre les
 * commandes (flèches de rangée en rangée, Échap, M, F, ↑/↓ pour le son), et la barre d'espace
 * cédait la place au bouton qui avait le focus : or un clic de souris *donne* le focus au bouton
 * cliqué, si bien qu'après avoir ouvert les sous-titres à la souris, Espace les rouvrait au lieu
 * de mettre en pause. Les boutons du lecteur ne prennent plus le focus à la souris (voir
 * `onMouseDown` sur la racine), et Espace n'active plus jamais un bouton.
 */
export function usePlayerKeyboard(
  togglePlay: () => void,
  skip: (deltaSeconds: number) => void,
  showControls: (delayMs?: number) => void,
  suspendedRef: RefObject<boolean>
) {
  // Les gestes du clavier lus au moment de la touche : `skip` dépend de `onSeekRequest`, qui peut
  // changer d'un rendu à l'autre, et l'écouteur, lui, n'est posé qu'une fois.
  const keyActionsRef = useLatest({ togglePlay, skip });
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (suspendedRef.current) return;
      // Ctrl+F cherche dans la page, Cmd+← revient en arrière, Alt+↑ appartient au système : aucun
      // n'est un raccourci du lecteur (23/09/2026).
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const active = document.activeElement;
      // Lecture / pause, commandes rappelées ; empêché au `keydown` dans tous les cas.
      const playPause = (ignoreRepeat: boolean) => {
        e.preventDefault();
        if (ignoreRepeat && e.repeat) return;
        keyActionsRef.current.togglePlay();
        showControls();
      };
      // Un champ où l'on écrit garde ses touches — la recherche de sous-titres en a un, et une
      // espace y mettait le film en pause au lieu d'écrire.
      if (
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable) ||
        (active instanceof HTMLInputElement && !["range", "checkbox", "radio", "button"].includes(active.type))
      ) {
        return;
      }
      if (e.code === "Space" || e.code === "KeyK") {
        // Empêché au `keydown` : c'est ce qui retient aussi l'activation d'un bouton qui aurait le
        // focus (une espace l'active au relâchement, sauf si l'appui a été empêché).
        playPause(true);
        return;
      }
      // Une télécommande (Fire TV, 10/10/2026) ne remplit pas toujours `code` : le nom de la touche,
      // ramené à sa forme moderne (`remoteKeys.ts`), fait foi à côté.
      const key = normalizeKey(e);
      if (key === "MediaPlayPause") {
        // La répétition n'est pas écartée ici, contrairement à l'espace et au centre du pavé.
        playPause(false);
        return;
      }
      // Le centre du pavé, quand aucun bouton n'a le focus : lecture / pause, comme l'espace. Sur un
      // bouton focalisé, il garde son rôle — l'activer.
      if (key === "Enter" && (!active || active === document.body || active === document.documentElement)) {
        playPause(true);
        return;
      }
      const left = e.code === "ArrowLeft" || key === "ArrowLeft" || key === "MediaRewind";
      const right = e.code === "ArrowRight" || key === "ArrowRight" || key === "MediaFastForward";
      if (left || right) {
        // Y compris sur la barre de progression focalisée : sa propre flèche la décalait d'un pas
        // d'input, sans passer par le saut du lecteur.
        e.preventDefault();
        keyActionsRef.current.skip(right ? 10 : -10);
        showControls();
        return;
      }
      // ↑ ↓ d'une télécommande : faire paraître les commandes, sans rien déplacer d'autre.
      if (key === "ArrowUp" || key === "ArrowDown") showControls();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showControls, suspendedRef, keyActionsRef]);
}
