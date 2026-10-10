"use client";

import { useEffect } from "react";
import { installRemoteKeyShim } from "@/lib/remoteKeys";
import { installEdgeScroll, installRemoteDiag, isFireTv } from "@/lib/fireTv";

/**
 * Les télécommandes : les touches ramenées à leurs noms modernes partout (`remoteKeys.ts`), et sur
 * Fire TV le défilement au bord du curseur de Silk et le relevé des premières touches (`fireTv.ts`).
 *
 * Le relevé est posé avant la traduction : écoutant tous deux en capture sur la fenêtre, il voit
 * ainsi l'évènement tel qu'il est arrivé, avant que la traduction ne l'arrête.
 */
export function RemoteControlSupport() {
  useEffect(() => {
    const cleanups: (() => void)[] = [];
    if (isFireTv()) {
      cleanups.push(installRemoteDiag());
      cleanups.push(installEdgeScroll());
    }
    cleanups.push(installRemoteKeyShim());
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, []);
  return null;
}
