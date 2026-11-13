/**
 * « À l'écran » ouvert ou fermé, le temps d'une séance (13/11/2026, demande de Louis).
 *
 * Masquée par défaut — affichée avec les commandes à chaque fois, la rangée chargeait l'écran et cachait les
 * sous-titres. Le bouton de gauche (ou le glissement, ou la touche I) l'ouvre ou la ferme, et ce choix tient
 * **toute la séance** — sauf une minute de commandes cachées, qui la replie sans bruit : une pause, une reconstruction du lecteur natif ou un passage au lecteur serveur remontent
 * les commandes sans la finir — d'où ce magasin par élément, hors des composants, comme `xrayUsage.ts`. La ligne
 * `stop` partie (`endOnScreenSession`), la prochaine ouverture repart masquée.
 */

/** Commandes cachées depuis une minute : on regarde le film, la rangée se replie (Louis, 13/11/2026). */
export const ONSCREEN_FOLD_HIDDEN_MS = 60_000;

const sessions = new Map<string, { open: boolean; ended: boolean }>();
const MAX_SESSIONS = 20;

export function onScreenOpenFor(itemId: string): boolean {
  const entry = sessions.get(itemId);
  return !!entry && !entry.ended && entry.open;
}

export function setOnScreenOpen(itemId: string, open: boolean): void {
  sessions.delete(itemId);
  sessions.set(itemId, { open, ended: false });
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string);
}

/** La ligne `stop` est partie : la prochaine ouverture de l'élément repart masquée. */
export function endOnScreenSession(itemId: string): void {
  const entry = sessions.get(itemId);
  if (entry) entry.ended = true;
}

/** Pour les tests, et à la sortie d'un compte. */
export function forgetOnScreenSessions(): void {
  sessions.clear();
}
