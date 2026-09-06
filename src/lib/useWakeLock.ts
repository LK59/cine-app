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
 * Pourquoi ce n'est pas gratuit partout : un `<video>` visible qui joue obtient déjà un verrou
 * *implicite* du navigateur — c'est le cas du chemin natif et du remultiplexage, qui alimentent
 * tous deux un vrai élément vidéo. Le chemin WebCodecs, lui, peint dans un `<canvas>` : pour le
 * navigateur, rien ne joue, et l'écran s'éteint au milieu du film. C'est ce trou-là qui justifie
 * un verrou explicite ; le demander aussi sur les deux autres chemins ne coûte rien et couvre les
 * cas où l'heuristique implicite ne s'applique pas (lecture muette, notamment).
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
