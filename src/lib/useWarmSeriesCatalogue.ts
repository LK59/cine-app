"use client";

import { useEffect, useState } from "react";
import { preload } from "swr";
import { fetcher, SERIES_CATALOGUE_KEY } from "@/lib/swr";
import { isWatchingFullScreen } from "@/lib/playbackBusy";

/**
 * Le catalogue des séries, chargé pendant qu'on regarde l'accueil.
 *
 * Il était différé jusqu'au moment où l'on en avait besoin, et l'intention était bonne : l'onglet
 * Films est celui sur lequel tout le monde arrive, et rien ne doit retarder son affichage. Mais le
 * report se payait au pire moment — la première ouverture d'une série depuis « Reprendre », c'est
 * à-dire quand on voulait justement reprendre son épisode sans attendre. Mesuré sur cette
 * installation : 695 films contre 132 séries, soit un cinquième du catalogue reporté pour
 * protéger les quatre autres.
 *
 * Troisième voie : ne rien changer au démarrage, et réchauffer ensuite. L'onglet Films garde donc
 * exactement le temps d'affichage qu'il avait — le réchauffage n'est armé qu'une fois ses données
 * arrivées — et le catalogue des séries est déjà en cache quand on le demande. `preload` remplit
 * le cache de SWR sous la clé que les écrans liront : leur `useSWR` sert alors sans requête.
 *
 * Deux précautions. Le temps mort du navigateur plutôt que l'instant présent, pour ne pas
 * disputer le rendu de l'accueil ni le préchargement des affiches, déjà en cours ; et rien du tout
 * pendant qu'un film occupe l'écran, où la bande passante appartient au film — le catalogue se
 * chargera à la demande, comme avant, ce qui est exactement ce qu'on veut dans ce cas-là.
 */
export function useWarmSeriesCatalogue(ready: boolean): boolean {
  /**
   * Et il faut le dire, pas seulement le faire.
   *
   * `preload` remplit le cache de SWR, mais un `useSWR` dont la clé vaut `null` ne le lit pas :
   * les données étaient là et inutilisées. Sur l'onglet Films, le catalogue des séries restait
   * donc introuvable — et la bannière, qui doit basculer quand on survole une série de la rangée
   * « Reprendre », ne trouvait aucune série à montrer.
   *
   * Le crochet rend donc la main : « c'est chaud, tu peux t'y abonner ». Une seule décision sur le
   * *quand*, prise ici, et la clé la suit.
   */
  const [warmed, setWarmed] = useState(false);

  useEffect(() => {
    if (!ready || warmed) return;
    let cancelled = false;
    const warm = () => {
      if (cancelled || isWatchingFullScreen()) return;
      // L'échec ne se rattrape pas : ce n'est qu'une avance prise, et l'écran qui en a
      // vraiment besoin refera la demande lui-même.
      void preload(SERIES_CATALOGUE_KEY, fetcher)
        .then(() => {
          if (!cancelled) setWarmed(true);
        })
        .catch(() => {});
    };
    // `timeout` garantit que le réchauffage a bien lieu sur un onglet qui ne devient jamais
    // vraiment inactif ; le repli couvre les navigateurs sans temps mort déclaré.
    const idle =
      typeof requestIdleCallback === "function"
        ? requestIdleCallback(warm, { timeout: 3000 })
        : window.setTimeout(warm, 1200);
    return () => {
      cancelled = true;
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(idle);
      else clearTimeout(idle);
    };
  }, [ready, warmed]);

  return warmed;
}
