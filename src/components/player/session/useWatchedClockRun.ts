// L'horloge du temps regardé, en marche tant que ça joue — écrit une fois pour les trois lecteurs qui
// la tenaient chacun au caractère près : natif (`useNativeSessionRecord`), serveur (`ActivePlayer`,
// `PlayerHost.tsx`) et Chromecast (23/10/2026, DECISIONS.md §115). Ce que « joue » veut dire reste à
// chaque hôte (l'attente du récepteur exclue pour Chromecast, §97) ; les attentes de l'élément,
// elles, passent par `watchElementWaits` (`playerSessionTally.ts`).
//
// Appelé à la place exacte de chaque copie : au démontage, l'horloge doit s'arrêter avant que l'arrêt
// écrit au démontage (`stop "unmount"`) ne la lise — l'ordre des effets en dépend.
import { useEffect } from "react";
import type { WatchedClock } from "@/lib/playerSessionTally";

export function useWatchedClockRun(watched: WatchedClock, playing: boolean): void {
  useEffect(() => {
    if (!playing) return;
    watched.run(Date.now());
    return () => watched.halt(Date.now());
  }, [playing, watched]);
}
