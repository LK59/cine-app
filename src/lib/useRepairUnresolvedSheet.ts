"use client";

import { useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { cinemaNavigate } from "@/lib/cinemaRoute";
import { isWatchingFullScreen } from "@/lib/playbackBusy";

/**
 * Le temps laissé au catalogue pour démentir avant qu'on efface l'adresse.
 *
 * Compté à partir de la réponse de la relecture (voir plus bas), pas de la demande : le temps
 * que la fiche se dessine sur le catalogue neuf. Généreux à dessein. Effacer une
 * adresse valable parce qu'on n'a pas attendu serait pire que le défaut qu'on répare.
 */
const GRACE_MS = 2000;

/** Le rythme auquel on regarde si le film a rendu l'écran, avant de relire le catalogue. */
const SCREEN_POLL_MS = 250;

/**
 * Une adresse qui désigne un titre que rien ne peut afficher se répare d'elle-même.
 *
 * Le cas, observé le 18/09/2026 : la recherche trouvait « Hannibal » et ouvrait `film=170`, mais
 * le catalogue ne contenait pas ce titre — Jellyfin repliait les films de collection dans leur
 * collection (voir `getAllMovies`). Aucune fiche ne s'ouvrait, et l'adresse restait. Sur téléphone
 * c'est la barre de navigation qui en payait le prix : elle s'efface tant qu'une fiche est
 * ouverte, et il n'y en avait aucune à fermer. L'écran restait donc sans navigation jusqu'à un
 * geste de retour du navigateur.
 *
 * La cause est corrigée à la source. Ceci est le filet : quelle qu'en soit la raison — un titre
 * retiré de la bibliothèque, un lien partagé devenu caduc, un défaut d'énumération qu'on n'a pas
 * encore vu — une adresse qui ne mène à rien ne doit pas amputer l'interface.
 *
 * `replace` et non `push` : on ne corrige pas une erreur en ajoutant une entrée d'historique que
 * le spectateur devra franchir à rebours.
 */
export function useRepairUnresolvedSheet(
  requested: string | null,
  resolved: boolean,
  catalogueReady: boolean,
  catalogueKey: string
): void {
  const { mutate } = useSWRConfig();
  /**
   * Le titre dont la relecture a répondu — et elle seule autorise à conclure.
   *
   * Le catalogue est figé pour la séance (DECISIONS 27) : un titre importé depuis le chargement
   * n'y est pas, alors que tout le reste — la notification « Disponible », Ma liste, une
   * filmographie — sait déjà qu'on l'a. « Voir » ouvrait `film=<id>`, rien ne le trouvait, et au
   * bout de deux secondes ce filet effaçait l'adresse : la fiche n'apparaissait jamais, au moment
   * précis où la notification l'annonçait (29/09/2026). On relit donc le catalogue d'abord, et
   * on ne conclut que sur sa réponse.
   */
  const [answered, setAnswered] = useState<string | null>(null);
  /** Une seule relecture par titre demandé : un titre vraiment absent ne coûte qu'une requête. */
  const asked = useRef(new Set<string>());

  useEffect(() => {
    if (requested === null || resolved || !catalogueReady) return;
    if (answered === requested) {
      const timer = setTimeout(() => {
        cinemaNavigate({ film: null, serie: null, episodes: false }, "replace");
      }, GRACE_MS);
      return () => clearTimeout(timer);
    }
    // Relecture en vol : c'est sa réponse qu'on attend, si longue soit-elle.
    if (asked.current.has(requested)) return;
    let cancelled = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    const ask = () => {
      if (cancelled) return;
      // SWR est en pause tant qu'un film occupe l'écran, et une relecture demandée alors est
      // abandonnée, pas différée : elle répondrait « rien de neuf » et le filet conclurait sur le
      // catalogue d'avant. On attend que l'écran soit libéré.
      if (isWatchingFullScreen()) {
        poll = setTimeout(ask, SCREEN_POLL_MS);
        return;
      }
      asked.current.add(requested);
      // `mutate` de la configuration, pas celui du module : il relit par le premier crochet
      // inscrit sur la clé (`revalidators[0]`), et tous les lecteurs du catalogue portent son
      // récupérateur — y compris ceux qui ne le demandent jamais d'eux-mêmes (`cacheOnlyOptions`).
      // Un échec compte comme une réponse : le filet conclut alors comme avant.
      void Promise.resolve(mutate(catalogueKey))
        .catch(() => undefined)
        .then(() => setAnswered(requested));
    };
    ask();
    return () => {
      cancelled = true;
      clearTimeout(poll);
    };
  }, [requested, resolved, catalogueReady, answered, catalogueKey, mutate]);
}

/**
 * Le titre que l'adresse demande, nommé pour le filet — le même nom des deux côtés.
 *
 * Une chaîne et non un objet : c'est une dépendance d'effet, et un objet neuf à chaque rendu
 * relancerait l'attente à chaque rendu.
 */
export function unresolvedSheetRequest(film: number | null, serie: number | null): string | null {
  if (film !== null) return `film=${film}`;
  if (serie !== null) return `serie=${serie}`;
  return null;
}
