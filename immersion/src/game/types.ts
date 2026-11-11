import type { QuizView } from "../../../salons/src/quiz";

/**
 * L'état de « Devine le film » dans le store — à part, sans autre import, pour la même raison que `net/types.ts`.
 *
 * `mode` : `solo` (le moteur tourne dans la page, sans service) ou `salon` (le service le fait tourner pour tous ;
 * les heures de la vue sont alors celles du service — `serverNow()`).
 */
export interface QuizUi {
  mode: "solo" | "salon";
  view: QuizView;
  /** L'identifiant du joueur de la page dans la vue (le membre du salon, ou « moi » seul). */
  you: string;
  /** Ce que la page a répondu à la manche en cours, ou rien. */
  choice: number | null;
  /** Le score enregistré à la fin (records), quand l'application l'a confirmé. */
  recorded: boolean;
}
