import { INTERVALS } from "@/lib/refresh-intervals";

/**
 * Quand la page Statistiques redemande une de ses sources (13/11/2026).
 *
 * Les quatre calculs lourds de la page (disque, analyse du stockage, acteurs et réalisateurs,
 * prévision de saturation) répondent tout de suite et calculent en arrière-plan : la première
 * réponse après un déploiement est vide, avec `computing: true` (ou `pending` pour la prévision).
 * La page ne repassait pourtant que toutes les deux minutes (`INTERVALS.SLOW`) : relevé dans le
 * journal du proxy le 13/11, le stockage arrivait en 290 octets, les acteurs en 66, la prévision
 * disait « Historique insuffisant — revient dans quelques jours », et rien ne bougeait avant deux
 * minutes alors que l'analyse finit en 8 à 13 s. Même chose après « Actualiser » : la roue tournait
 * jusqu'au passage suivant. Tant qu'un calcul est en cours, la page revient donc toutes les quelques
 * secondes ; ensuite, le rythme lent d'avant.
 */
export const STATS_PENDING_POLL_MS = 4_000;

export function statsRefreshInterval(data: { computing?: boolean; pending?: boolean } | undefined): number {
  return data?.computing || data?.pending ? STATS_PENDING_POLL_MS : INTERVALS.SLOW;
}
