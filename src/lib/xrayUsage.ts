/**
 * L'usage des acteurs à l'écran pendant une séance (DECISIONS.md §138, 11/11/2026), hors des composants.
 *
 * Pourquoi : à l'ouverture de l'option à tous les comptes, rien ne disait qui s'en servait. Le relevé `xray-ui`
 * (`xrayUiDiag.ts`) est un diagnostic d'affichage — écrans tactiles seulement, douze lignes par séance — et
 * rien ne partait à la souris. Les questions et « Jusqu'ici » ont leurs lignes dans `recherche.log` ; la
 * rangée et les touchers n'avaient rien.
 *
 * **Aucune ligne de plus** : trois compteurs, portés par le bilan `stop` que la séance envoie de toute façon
 * (`xray: "s3 t2 p2"` — scènes où la rangée a paru avec quelqu'un, touchers d'un acteur, personnes touchées).
 * Rien n'est écrit tant que l'option n'est pas proposée à la séance : sans elle, le bilan reste identique au
 * mot près (les empreintes du lecteur ne le voient pas).
 *
 * Par élément, comme `sceneRestartSession.ts` : une reconstruction du lecteur natif ou un passage au lecteur
 * serveur remonte les commandes sans finir la séance ; la ligne `stop` partie (`endXrayUsage`), la prochaine
 * ouverture repart de zéro.
 */

interface Usage {
  scenes: Set<number>;
  taps: number;
  people: Set<number>;
  ended: boolean;
}

const sessions = new Map<string, Usage>();
/** Bornes : quelques éléments par onglet, et des compteurs qui ne grossissent pas sans fin. */
const MAX_SESSIONS = 20;
const MAX_COUNT = 9999;

function fresh(): Usage {
  return { scenes: new Set(), taps: 0, people: new Set(), ended: false };
}

/** L'option est proposée à cette séance : le bilan portera ses compteurs, même à zéro. */
export function noteXrayOffered(itemId: string): void {
  const known = sessions.get(itemId);
  if (known && !known.ended) return;
  sessions.delete(itemId);
  sessions.set(itemId, fresh());
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string);
}

/** La rangée a paru, avec au moins une personne, sur la scène qui commence à `sceneStart`. */
export function noteXrayScene(itemId: string, sceneStart: number): void {
  const usage = sessions.get(itemId);
  if (!usage || usage.ended || usage.scenes.size >= MAX_COUNT) return;
  usage.scenes.add(Math.round(sceneStart * 10));
}

/** Un acteur touché (ou cliqué) dans la rangée. */
export function noteXrayTap(itemId: string, personId: number): void {
  const usage = sessions.get(itemId);
  if (!usage || usage.ended) return;
  usage.taps = Math.min(MAX_COUNT, usage.taps + 1);
  if (usage.people.size < 999) usage.people.add(personId);
}

/** Le champ du bilan : rien si l'option n'a pas été proposée à la séance. */
export function xrayLogFields(itemId: string): { xray?: string } {
  const usage = sessions.get(itemId);
  if (!usage) return {};
  return { xray: `s${usage.scenes.size} t${usage.taps} p${usage.people.size}` };
}

/** La ligne `stop` est partie : la prochaine ouverture de l'élément repart de zéro. */
export function endXrayUsage(itemId: string): void {
  const usage = sessions.get(itemId);
  if (usage) usage.ended = true;
}

/** Pour les tests, et à la sortie d'un compte. */
export function forgetXrayUsage(): void {
  sessions.clear();
}

/** La forme exacte que le serveur accepte (`playerLog.ts`). */
export const XRAY_USAGE_VALUE = /^s\d{1,4} t\d{1,4} p\d{1,3}$/;
