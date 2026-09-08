"use client";

import { usePathname } from "next/navigation";
import useSWR from "swr";
import { isPublicPath } from "@/lib/publicPaths";
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
  // Rien à demander sans session. La mise en page racine monte le lecteur sur *toutes* les pages,
  // page de connexion comprise, où cette route répond 401 — et le court `errorRetryInterval`
  // ci-dessous en faisait une requête toutes les 1,5 s tant que la personne tapait son mot de
  // passe. Sur une adresse publique on ne pose donc pas la question ; la clé redevient d'elle-même
  // non nulle à la première adresse privée, y compris après la navigation client de la connexion.
  //
  // Ce que cette clé nulle repose sur, et qui ne se lit pas ici : `keepPreviousData: true`, posé
  // pour toute l'application dans `SWRProvider`. Sans lui, une clé nulle rend `data: undefined`,
  // donc `legacy: undefined`, et `PlayerHost` ne rend **rien** dans cet état (son `return null`,
  // voir le commentaire qui l'accompagne). Le cas n'est pas théorique : le mini-lecteur survit aux
  // changements de page, donc ouvrir la page d'état avec un film réduit passe par ici — et sans la
  // valeur retenue, le film disparaîtrait au moment précis où l'adresse devient publique. Trois
  // fichiers décident cela ensemble ; `useLegacyPlayer-public-path.test.tsx` monte le vrai
  // `SWRProvider` pour que retirer l'option là-bas casse un test plutôt qu'une lecture.
  const pathname = usePathname();
  const key = pathname && isPublicPath(pathname) ? null : "/api/user/preferences";

  const { data, error } = useSWR<PreferencesPayload>(key, fetcher, {
    // Sans quoi le lecteur attend une réponse que sa propre ouverture empêche d'arriver.
    ...playerBootstrapOptions,
    // Réessayer vite : le cas courant d'échec est une réponse obtenue *avant* d'être connecté, et
    // la vraie valeur arrive dès la première nouvelle tentative.
    errorRetryInterval: 1500,
  });

  // Une réponse en échec vaut « pas d'ancien lecteur », et surtout pas « je ne sais pas ».
  //
  // Le cas qui a fait écrire cette ligne n'existe plus : le lecteur d'accueil est monté par la
  // mise en page racine, donc y compris sur la page de connexion, où cette route répondait 401 —
  // SWR retenait l'échec, et après connexion la valeur restait indéfinie plusieurs secondes le
  // temps d'une nouvelle tentative, pendant lesquelles PlayerHost ne rendait rien et le bouton
  // Lire ne faisait rien du tout. La clé nulle sur les chemins publics (plus haut) supprime ce
  // 401-là à la racine : sur `/login`, il n'y a plus de requête, donc plus d'échec à retenir.
  //
  // La branche n'est pas morte pour autant, et c'est pourquoi elle reste : sur une adresse
  // *privée*, cette route peut encore échouer — session expirée sous l'application ouverte, base
  // indisponible, 500 amont. Ce qu'elle décide alors est inchangé, seul son exemple fondateur a
  // disparu.
  //
  // « Pas d'ancien lecteur » est de toute façon le défaut : c'est une option qu'un compte doit
  // aller activer. Se tromper ici coûte au pire un basculement une seconde plus tard, quand la
  // vraie réponse arrive ; attendre coûtait un bouton mort.
  if (data) return { legacy: data.legacyPlayer?.enabled === true };
  return { legacy: error ? false : undefined };
}
