"use client";

import useSWR from "swr";
import { fetcher, playerBootstrapOptions } from "@/lib/swr";

interface PreferencesPayload {
  legacyPlayer?: { enabled: boolean };
}

/**
 * Whether this account has asked to go back to playback through the server.
 *
 * Answers `undefined` while it does not know yet, and the caller is expected to wait for it
 * rather than assume. Assuming was not free: the player that was assumed would mount, start —
 * which for the server-side one means negotiating a stream and warming a transcode — and then be
 * thrown away a round trip later when the answer arrived. One request, once per session, against
 * an abandoned transcode on every single playback.
 */
export function useLegacyPlayer(): { legacy: boolean | undefined } {
  const { data, error } = useSWR<PreferencesPayload>("/api/user/preferences", fetcher, {
    // Sans quoi le lecteur attend une réponse que sa propre ouverture empêche d'arriver.
    ...playerBootstrapOptions,
    // Réessayer vite : le cas courant d'échec est une réponse obtenue *avant* d'être connecté, et
    // la vraie valeur arrive dès la première nouvelle tentative.
    errorRetryInterval: 1500,
  });

  // Une réponse en échec vaut « pas d'ancien lecteur », et surtout pas « je ne sais pas ».
  //
  // Le lecteur d'accueil est monté par la mise en page racine, donc y compris sur la page de
  // connexion, où cette route répond 401 — il n'y a pas encore de session. SWR retient l'échec, et
  // après connexion la valeur restait indéfinie plusieurs secondes le temps d'une nouvelle
  // tentative. Or PlayerHost ne rend rien tant qu'il ne sait pas : le bouton Lire ne faisait donc
  // rien du tout à la première connexion, et remarchait après un rechargement de page — le cache
  // de SWR repartant à zéro.
  //
  // « Pas d'ancien lecteur » est de toute façon le défaut : c'est une option qu'un compte doit
  // aller activer. Se tromper ici coûte au pire un basculement une seconde plus tard, quand la
  // vraie réponse arrive ; attendre coûtait un bouton mort.
  if (data) return { legacy: data.legacyPlayer?.enabled === true };
  return { legacy: error ? false : undefined };
}
