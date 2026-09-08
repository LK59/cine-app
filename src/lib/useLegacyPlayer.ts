"use client";

import { useEffect } from "react";
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
  // passe. Sur une adresse publique on ne pose donc pas la question.
  //
  // **On se tait, on n'oublie pas.** Une première version mettait la *clé* à `null` sur ces
  // adresses. Cela taisait bien la requête, mais cela effaçait aussi la réponse : une clé nulle
  // rend `data: undefined`, donc `legacy: undefined`, et `PlayerHost` ne rend alors plus rien —
  // il coupe le film en cours (voir son `return null`). Ce qui la retenait, `keepPreviousData`,
  // est un état porté par *l'instance du hook* : il survit à un nouveau rendu et à rien d'autre.
  // Un remontage — et il n'en faut pas plus qu'un changement d'arborescence entre deux groupes de
  // routes — repartait de zéro et tuait la lecture.
  //
  // La clé est donc redevenue constante, et c'est `isPaused` qui tait la requête. SWR consulte
  // cette fonction avant la revalidation initiale, avant chaque revalidation et avant même de
  // traiter une erreur (`swr/dist/index`, les trois `isPaused()`), donc rien ne part et aucune
  // boucle de réessai ne peut naître. La réponse, elle, reste là où elle doit être : dans le
  // cache SWR, qui est global et n'appartient à aucun montage. Une adresse publique atteinte avec
  // la réponse déjà connue la lit dans le cache, remontage ou pas.
  const pathname = usePathname();
  const onPublicPath = !!pathname && isPublicPath(pathname);

  const { data, error, mutate } = useSWR<PreferencesPayload>("/api/user/preferences", fetcher, {
    // Sans quoi le lecteur attend une réponse que sa propre ouverture empêche d'arriver.
    ...playerBootstrapOptions,
    // La seule pause légitime pour cette requête-là, et elle remplace celle qu'on vient d'étaler :
    // `playerBootstrapOptions` dit « jamais mis en pause parce qu'un film occupe l'écran », ce qui
    // reste vrai — c'est bien l'écran occupé qu'on refuse comme motif, pas toute pause. Une
    // closure neuve à chaque rendu : SWR range la configuration du dernier rendu dans une ref
    // (`configRef`) avant la peinture, donc elle est à jour quand il consulte celle-ci.
    isPaused: () => onPublicPath,
    // Réessayer vite : le cas courant d'échec est une réponse obtenue *avant* d'être connecté, et
    // la vraie valeur arrive dès la première nouvelle tentative.
    errorRetryInterval: 1500,
  });

  /**
   * Demander en arrivant, puisque plus personne ne le fera à notre place.
   *
   * Une clé qui changeait déclenchait une revalidation d'elle-même : c'est ce qui faisait partir
   * la requête au moment précis où l'on quittait `/login` pour l'application. Une clé constante
   * mise en pause, elle, ne redemande rien quand la pause se lève — rien, dans SWR, n'observe un
   * changement de configuration. Sans ceci, la valeur restait indéfinie après la connexion et le
   * bouton Lire ne faisait rien du tout : exactement le défaut décrit plus bas, par un autre
   * chemin.
   *
   * Uniquement quand on ne sait encore rien : au retour de la page d'état, la réponse est déjà
   * dans le cache et il n'y a aucune raison de la redemander. Ni boucle possible — la condition
   * se ferme dès qu'une réponse ou une erreur existe, et les réessais après erreur restent ceux
   * de SWR (`errorRetryInterval` ci-dessus).
   */
  useEffect(() => {
    if (!onPublicPath && data === undefined && error === undefined) void mutate();
  }, [onPublicPath, data, error, mutate]);

  // Une réponse en échec vaut « pas d'ancien lecteur », et surtout pas « je ne sais pas ».
  //
  // Le cas qui a fait écrire cette ligne n'existe plus : le lecteur d'accueil est monté par la
  // mise en page racine, donc y compris sur la page de connexion, où cette route répondait 401 —
  // SWR retenait l'échec, et après connexion la valeur restait indéfinie plusieurs secondes le
  // temps d'une nouvelle tentative, pendant lesquelles PlayerHost ne rendait rien et le bouton
  // Lire ne faisait rien du tout. La pause sur les chemins publics (plus haut) supprime ce 401-là
  // à la racine : sur `/login`, il n'y a plus de requête, donc plus d'échec à retenir.
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
