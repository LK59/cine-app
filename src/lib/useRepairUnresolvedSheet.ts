"use client";

import { useEffect } from "react";
import { cinemaNavigate } from "@/lib/cinemaRoute";

/**
 * Le temps laissé au catalogue pour démentir avant qu'on efface l'adresse.
 *
 * Généreux à dessein : une revalidation SWR en vol doit pouvoir arriver la première. Effacer une
 * adresse valable parce qu'on n'a pas attendu serait pire que le défaut qu'on répare.
 */
const GRACE_MS = 2000;

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
export function useRepairUnresolvedSheet(addressed: boolean, resolved: boolean, catalogueReady: boolean): void {
  useEffect(() => {
    if (!addressed || resolved || !catalogueReady) return;
    const timer = setTimeout(() => {
      cinemaNavigate({ film: null, serie: null, episodes: false }, "replace");
    }, GRACE_MS);
    return () => clearTimeout(timer);
  }, [addressed, resolved, catalogueReady]);
}
