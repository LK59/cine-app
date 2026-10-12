import type { CinemaRoute } from "@/lib/cinemaRoute";
import { coversGrid } from "@/lib/cinemaGridTop";

/**
 * Faut-il ouvrir la fenêtre des Nouveautés maintenant ? (DECISIONS.md §73)
 *
 * La seule réponse, pour le bureau comme pour le téléphone : la fenêtre est montée par la coquille
 * du cinéma (`PlayerShell`), commune aux deux, et c'est d'ici qu'elle tient sa décision. Les règles
 * de Louis :
 *  - il reste au moins une page publiée que ce compte n'a pas vue ;
 *  - sur l'accueil du cinéma seulement — ni l'assistant, ni la connexion, ni la gestion (la coquille
 *    n'y est pas montée ; l'adresse est vérifiée quand même) ;
 *  - jamais pendant un film, plein écran ou réduit ;
 *  - jamais par-dessus une fiche, un panneau ou la grille complète — une fiche ouverte par lien
 *    profond reste seule à l'écran ; la fenêtre attend qu'on revienne à l'accueil ;
 *  - jamais par-dessus l'écran d'accueil d'un nouveau compte, ni tant qu'on ne sait pas s'il en a un :
 *    ses réglages d'abord, les nouveautés au lancement suivant.
 *
 * Une seule fois par chargement : c'est l'appelant qui le retient (`NewsGate`), et le drapeau du
 * compte s'éteint de toute façon dès l'affichage.
 */
export interface NewsGateFacts {
  /** Pages publiées non vues par ce compte ; `null` tant que la réponse n'est pas arrivée. */
  unseen: number | null;
  /** L'écran d'accueil du compte est à faire ; `undefined` tant qu'on ne le sait pas. */
  onboardingPending: boolean | undefined;
  playback: "closed" | "full" | "mini";
  route: CinemaRoute;
  pathname: string;
}

export function shouldOfferNews(f: NewsGateFacts): boolean {
  if (!f.unseen) return false;
  if (f.pathname !== "/") return false;
  if (f.onboardingPending !== false) return false;
  if (f.playback !== "closed") return false;
  if (coversGrid(f.route) || f.route.episodes) return false;
  return true;
}

/** Le temps laissé à l'accueil pour se poser avant la fenêtre — l'entrée des affiches d'abord. */
export const NEWS_SHOW_DELAY_MS = 1200;
