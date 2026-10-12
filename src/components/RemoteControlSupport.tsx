"use client";

import { useEffect } from "react";
import { installRemoteKeyShim } from "@/lib/remoteKeys";
import { installEdgeScroll, installRemoteDiag, isFireTv } from "@/lib/fireTv";
import { tvGridMoveCount } from "@/lib/useTvGridNav";
import { trackPointer } from "@/lib/pointerHover";

/**
 * Les télécommandes : les touches ramenées à leurs noms modernes partout (`remoteKeys.ts`), et sur
 * Fire TV le défilement au bord du curseur de Silk et le relevé de télécommande, un par mode de
 * Silk (`fireTv.ts`).
 *
 * Le relevé est posé avant la traduction : écoutant tous deux en capture sur la fenêtre, il voit
 * ainsi l'évènement tel qu'il est arrivé, avant que la traduction ne l'arrête.
 */
export function RemoteControlSupport() {
  useEffect(() => {
    const cleanups: (() => void)[] = [];
    // Le pointeur suivi dès l'ouverture, et non au premier survol : un curseur posé puis laissé
    // immobile doit être connu pour que ses survols « sans mouvement » soient reconnus
    // (`pointerHover.ts`).
    trackPointer();
    if (isFireTv()) {
      // La grille dit au relevé quand c'est elle qui a déplacé le focus (`gridMoved`).
      cleanups.push(installRemoteDiag(window, undefined, tvGridMoveCount));
      cleanups.push(installEdgeScroll());
    }
    cleanups.push(installRemoteKeyShim());
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, []);
  return null;
}
