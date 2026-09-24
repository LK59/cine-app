"use client";

import { useEffect } from "react";

/**
 * Le verrou d'écran de l'API Wake Lock, tel que ce projet peut le voir.
 *
 * Écrit à la main : `navigator.wakeLock` n'est pas dans la bibliothèque DOM contre laquelle ce
 * dépôt compile, et c'est précisément sur les plateformes où il manque qu'il faut pouvoir être
 * absent sans que rien ne casse.
 */
interface WakeLockSentinelLike {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void) => void;
}
type NavigatorWithWakeLock = Navigator & {
  wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
};

/**
 * Garder l'écran allumé tant qu'un film joue.
 *
 * Un `<video>` visible qui joue obtient déjà un verrou *implicite* du navigateur, et les deux
 * lecteurs en alimentent un. Le verrou explicite couvre les cas où cette heuristique ne s'applique
 * pas — lecture muette, notamment — et ne coûte rien ailleurs. (Il est né pour un lecteur canevas,
 * retiré le 24/09/2026, où rien ne jouait aux yeux du navigateur et l'écran s'éteignait en plein
 * film.)
 *
 * Le verrou est relâché par la plateforme dès que la page passe en arrière-plan, et n'est *pas*
 * rendu au retour : d'où la reprise sur `visibilitychange`, sans laquelle une veille suffisait à
 * le perdre définitivement pour le reste du film.
 *
 * Chaque appel peut échouer et doit pouvoir échouer : l'API manque sur Safari avant 16.4 et sur
 * Firefox avant 126, et même là où elle existe une demande peut être refusée. Un refus n'est
 * jamais une raison pour qu'un film s'arrête, donc il n'est ni remonté ni affiché.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const request = (navigator as NavigatorWithWakeLock).wakeLock?.request;
    if (!request) return;

    let sentinel: WakeLockSentinelLike | null = null;
    let abandoned = false;

    const acquire = async () => {
      // Une demande faite page cachée est refusée d'office : on attend le retour.
      if (abandoned || sentinel || document.visibilityState !== "visible") return;
      try {
        const held = await (navigator as NavigatorWithWakeLock).wakeLock!.request("screen");
        if (abandoned) {
          void held.release().catch(() => {});
          return;
        }
        sentinel = held;
        held.addEventListener("release", () => {
          if (sentinel === held) sentinel = null;
        });
      } catch {
        // Refusé. Le film continue.
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      abandoned = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, [active]);
}
