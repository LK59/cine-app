"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import useSWR from "swr";
import { isPublicPath } from "@/lib/publicPaths";
import { fetcher, playerBootstrapOptions } from "@/lib/swr";

/**
 * Le chargeur des préférences du compte (`/api/user/preferences`) : langue, défilement guidé,
 * disposition de l'accueil.
 *
 * Seul porteur du `fetcher` de cette clé : `useGuidedScroll` et `useHomeLayout` la suivent sans la
 * demander (`followOnlyOptions` — voir le piège `revalidators[0]` de CLAUDE.md). Monté une fois,
 * par `PlayerHost`, qui l'est sur toutes les pages.
 *
 * Il s'appelait `useLegacyPlayer` et disait aussi si le compte avait choisi le lecteur serveur pour
 * toutes ses lectures ; `PlayerHost` attendait sa réponse avant de monter quoi que ce soit. Ce choix
 * a disparu le 13/10/2026 — le lecteur natif est toujours le chemin par défaut — et le hook ne
 * fait plus que charger. Une colonne `legacy_player` restée à 1 en base n'est plus lue.
 */
export function useAccountPreferencesLoader(): void {
  // Rien à demander sans session. La mise en page racine monte le lecteur sur *toutes* les pages,
  // page de connexion comprise, où cette route répond 401 — et le court `errorRetryInterval`
  // ci-dessous en faisait une requête toutes les 1,5 s tant que la personne tapait son mot de
  // passe. Sur une adresse publique on ne pose donc pas la question.
  //
  // **On se tait, on n'oublie pas.** La clé reste constante et c'est `isPaused` qui tait la
  // requête : une clé nulle effaçait la réponse, et un remontage repartait de zéro. SWR consulte
  // cette fonction avant la revalidation initiale, avant chaque revalidation et avant même de
  // traiter une erreur, donc rien ne part et aucune boucle de réessai ne peut naître. La réponse,
  // elle, reste dans le cache SWR, global, qu'une adresse publique atteinte ensuite lit encore.
  const pathname = usePathname();
  const onPublicPath = !!pathname && isPublicPath(pathname);

  const { data, error, isValidating, mutate } = useSWR("/api/user/preferences", fetcher, {
    // Jamais mis en pause parce qu'un film occupe l'écran : une application ouverte directement sur
    // un film doit quand même apprendre la langue et la disposition du compte.
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
   * changement de configuration. Sans ceci, les préférences restaient inconnues après la connexion
   * — et, tant que le lecteur attendait cette réponse pour exister, le bouton Lire ne faisait rien
   * du tout.
   *
   * Uniquement quand on ne sait encore rien : au retour de la page d'état, la réponse est déjà
   * dans le cache et il n'y a aucune raison de la redemander. Ni boucle possible — la condition
   * se ferme dès qu'une réponse ou une erreur existe, et les réessais après erreur restent ceux
   * de SWR (`errorRetryInterval` ci-dessus).
   */
  //
  // Ni pendant qu'une demande est déjà en route (08/10/2026) : au lancement, celle que l'amorçage de
  // la langue a lancée (`preloadQuietly`) n'avait pas encore répondu quand ce hook montait, et ce
  // `mutate` en lançait une seconde, sans déduplication — les préférences partaient deux fois à
  // chaque ouverture.
  useEffect(() => {
    if (!onPublicPath && data === undefined && error === undefined && !isValidating) void mutate();
  }, [onPublicPath, data, error, isValidating, mutate]);
}
