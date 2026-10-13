"use client";

import { usePathname } from "next/navigation";
import useSWR, { mutate } from "swr";
import { fetcher, playerBootstrapOptions } from "@/lib/swr";
import { isPublicPath } from "@/lib/publicPaths";
import { isWatchingFullScreen } from "@/lib/playbackBusy";
import { progressBeatFresh } from "@/lib/progressBeat";

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
/**
 * Pendant un film, une fois la minute au plus (08/10/2026) — et **plus du tout tant que le battement
 * de lecture passe** (13/10/2026) : il rapporte déjà l'état (`noteMaintenanceState`), toutes les
 * 30 s en lecture, 60 s en pause. Le relevé du 13/10 comptait encore 60 requêtes `/api/maintenance`
 * par heure de film, toutes redondantes. Le sondage n'est plus qu'un filet, qui ne se réveille que si
 * le battement cesse (`progressBeatFresh`) — le lecteur serveur arrêté sur une erreur, un battement
 * qui ne passe pas. Le prix : l'avis de redémarrage arrive pendant un film en 30 s au plus au lieu
 * de 10 ; hors film, rien ne change (15 s).
 */
const POLL_DURING_FILM_MS = 60_000;

/** Pendant un film dont le battement passe, l'état vient de lui : le sondage se tait. */
export function maintenanceFedByPlayback(): boolean {
  return isWatchingFullScreen() && progressBeatFresh();
}

/** L'état d'exploitation rapporté par une autre réponse — le battement de lecture. */
export function noteMaintenanceState(state: unknown): void {
  const s = state as Partial<MaintenanceState> | null;
  if (!s || typeof s.active !== "boolean") return;
  void mutate(MAINTENANCE_KEY, { active: s.active, noticeAt: s.noticeAt ?? null, expiresAt: s.expiresAt ?? null }, { revalidate: false });
}

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
 * Le coût de cette exception était une requête toutes les quinze secondes pendant un film, puis
 * une par minute (08/10/2026) ; depuis le 13/10/2026, aucune tant que le battement de lecture passe
 * — il porte l'état (`maintenanceFedByPlayback`) — et l'exception ne sert plus que de filet.
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
    refreshInterval: () => (isWatchingFullScreen() ? POLL_DURING_FILM_MS : POLL_MS),
    ...playerBootstrapOptions,
    // Après `playerBootstrapOptions` : cette requête-ci n'est suspendue que lorsque le battement de
    // lecture la remplace. SWR reprogramme quand même le tour suivant (une requête suspendue rend
    // `false` et la minuterie continue) : le filet reprend seul si le battement cesse.
    isPaused: maintenanceFedByPlayback,
  });
  // Un état inconnu n'est pas une maintenance : tant que la réponse n'est pas là, rien ne s'affiche.
  return { active: data?.active ?? false, noticeAt: data?.noticeAt ?? null, expiresAt: data?.expiresAt ?? null };
}
