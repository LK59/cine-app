"use client";

import useSWR from "swr";
import { fetcher, playerBootstrapOptions } from "@/lib/swr";

interface PublicPlayerConfig {
  playerEnabled: boolean;
  playerServerFallback: boolean;
}

/**
 * Ce que l'installation dit du lecteur — une seule requête pour les deux réponses.
 *
 * `playerBootstrapOptions` n'est pas décoratif ici : `PlayerHost` lit `usePlayerServerFallback`
 * pour savoir *quel* lecteur monter, donc c'est une requête dont le lecteur a besoin **pour
 * exister**. Sans elle, un film qui prend l'écran met SWR en pause, la requête est abandonnée —
 * pas différée, abandonnée — et l'écran reste sans lecteur. Même piège que
 * `useLegacyPlayer`, qui la porte pour la même raison.
 *
 * C'est aussi ce qui répare un défaut observé : après le rechargement que WebKit impose pour
 * changer de piste, la fiche derrière le film se montait pendant la pause, sa requête de
 * configuration était perdue, et le bouton Lire ne revenait plus.
 */
function usePublicPlayerConfig() {
  return useSWR<PublicPlayerConfig>("/api/config/public", fetcher, playerBootstrapOptions);
}

/**
 * La lecture dans l'app est-elle activée sur cette installation ?
 *
 * Répond « non » tant qu'on ne sait pas. C'est le sens prudent : le réglage existe pour qu'un
 * exploitant puisse fermer la lecture intégrée, et un bouton affiché par défaut la rouvrirait
 * chaque fois que la réponse tarde ou manque.
 */
export function usePlayerEnabled(): boolean {
  const { data } = usePublicPlayerConfig();
  return data?.playerEnabled ?? false;
}

/**
 * Y a-t-il un lecteur serveur vers qui se tourner quand le navigateur renonce ?
 *
 * Répond `undefined` tant qu'on ne sait pas, et l'appelant est censé attendre plutôt que
 * supposer — exactement comme `useLegacyPlayer`, et pour la même raison : celui des deux lecteurs
 * qu'on suppose se monte et *démarre*, et pour le lecteur serveur cela veut dire négocier un flux
 * et lancer un transcodage, jeté un aller-retour plus tard.
 */
export function usePlayerServerFallback(): boolean | undefined {
  const { data } = usePublicPlayerConfig();
  return data?.playerServerFallback;
}
