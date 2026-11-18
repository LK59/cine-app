"use client";

import { useSyncExternalStore } from "react";

/**
 * L'heure, arrondie au quart de minute et relue au même pas — pour ce qui s'écrit à la minute (« fin à 23:42 »,
 * « demain ») sans recalculer à chaque image ni décaler d'une minute entière. `0` au rendu serveur : rien de daté
 * ne s'y écrit.
 */
const subscribeClock = (onChange: () => void) => {
  const timer = setInterval(onChange, 15_000);
  return () => clearInterval(timer);
};
const minuteNow = () => Math.floor(Date.now() / 15_000) * 15_000;

/**
 * `subscribe` : ce qui relit l'heure. Par défaut, une minuterie ; le lecteur passe la progression de sa vidéo
 * (`timeupdate`), qui avance déjà — une minuterie de plus dans les commandes déplaçait l'ordre de celles du
 * lecteur, et ses empreintes avec (18/11/2026).
 */
export function useMinuteNow(subscribe: (onChange: () => void) => () => void = subscribeClock): number {
  return useSyncExternalStore(subscribe, minuteNow, () => 0);
}
