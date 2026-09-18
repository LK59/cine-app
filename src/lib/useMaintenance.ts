"use client";

import { usePathname } from "next/navigation";
import useSWR from "swr";
import { fetcher, playerBootstrapOptions } from "@/lib/swr";
import { isPublicPath } from "@/lib/publicPaths";

export const MAINTENANCE_KEY = "/api/maintenance";

/**
 * À quelle cadence chaque écran redemande l'état d'exploitation.
 *
 * Quinze secondes est un compromis assumé entre deux choses. L'avis de redémarrage imminent doit
 * arriver assez vite pour être un avertissement et non un constat — l'administrateur appuie, puis
 * redéploie. Et la requête doit rester assez rare pour ne pas peser : la réponse fait une
 * cinquantaine d'octets et la route lit une seule ligne par clé primaire, mais better-sqlite3 est
 * synchrone et tient la boucle d'événements, donc la question mérite d'être posée.
 */
const POLL_MS = 15_000;

export interface MaintenanceState {
  active: boolean;
  /** Date du dernier avis de redémarrage imminent, en ms, ou null. */
  noticeAt: number | null;
  /**
   * Quand le bandeau s'éteindra de lui-même, en ms.
   *
   * Le serveur évalue l'échéance à chaque lecture, donc aucun écran n'a de décompte à tenir : le
   * sondage suffit à faire disparaître le bandeau à l'heure dite, même resté ouvert toute la nuit.
   */
  expiresAt: number | null;
}

/**
 * L'état d'exploitation, sur tous les écrans — **y compris ceux qui jouent un film**.
 *
 * C'est la raison d'être de `playerBootstrapOptions` ici, et elle n'est pas décorative :
 * `SWRProvider` suspend toute requête tant qu'un film occupe l'écran entier, et une requête
 * suspendue est *abandonnée, pas différée* — SWR ne la rejoue jamais. Sans cette option, les seuls
 * écrans que l'avis n'atteindrait pas seraient exactement ceux qu'il vise : les lecteurs en cours.
 *
 * Le coût de cette exception est une requête de cinquante octets toutes les quinze secondes
 * pendant un film. C'est ce que la pause existe pour éviter, et c'est ici négligeable devant les
 * dix mégabits par seconde que le film lui-même consomme.
 */
export function useMaintenance(): MaintenanceState {
  /**
   * Muet sur les pages publiques.
   *
   * La racine monte ce composant partout, y compris sur la connexion et sur l'état des services,
   * qui n'exigent pas de session : la route y répondrait 401 toutes les quinze secondes, à vie,
   * pour une bannière qu'aucun visiteur non connecté ne verra. `noteUnauthorized` sait déjà se
   * taire sur ces adresses — la page d'état restait donc accessible —, mais se taire n'est pas
   * une raison de continuer à demander.
   *
   * `usePathname` et non une lecture directe de `location` : l'adresse change aussi par navigation
   * côté client, et une valeur lue au rendu sans abonnement ne suivrait pas.
   */
  const pathname = usePathname();
  const { data } = useSWR<MaintenanceState>(isPublicPath(pathname ?? "") ? null : MAINTENANCE_KEY, fetcher, {
    refreshInterval: POLL_MS,
    ...playerBootstrapOptions,
  });
  // Un état inconnu n'est pas une maintenance : tant que la réponse n'est pas là, rien ne s'affiche.
  return { active: data?.active ?? false, noticeAt: data?.noticeAt ?? null, expiresAt: data?.expiresAt ?? null };
}
