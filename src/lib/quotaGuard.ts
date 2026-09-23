/**
 * Les appels à un service qui compte nos requêtes, faits au plus une fois par période.
 *
 * Relevé le 23/09/2026 : la vue d'ensemble de la gestion se rafraîchit toutes les quinze
 * secondes et vérifiait la clé OMDb à chaque fois — un onglet laissé ouvert quatre heures
 * épuisait les mille requêtes quotidiennes de l'offre gratuite. Et le contrôle d'état interrogeait
 * MDBList chaque minute : 1 440 appels par jour pour un quota de 1 000, à un service que rien
 * d'autre n'utilise.
 *
 * Le résultat est gardé, succès comme échec : un échec qu'on redemande toutes les quinze secondes
 * est exactement ce qui épuise un quota. Mais moins longtemps — une clé réparée doit se voir vite.
 */
const memo = new Map<string, { until: number; ok: boolean; value: unknown }>();

export const HOUR_MS = 3600_000;
export const FAILURE_MS = 5 * 60_000;

/** Pour les tests. */
export function resetQuotaGuard(): void {
  memo.clear();
}

export async function atMostEvery<T>(
  key: string,
  fn: () => Promise<T>,
  { okMs = HOUR_MS, failMs = FAILURE_MS, isOk = () => true }: { okMs?: number; failMs?: number; isOk?: (value: T) => boolean } = {}
): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() < hit.until) {
    if (hit.ok) return hit.value as T;
    // Un échec gardé : on renvoie la même réponse, sans rappeler le service.
    if (hit.value instanceof Error) throw hit.value;
    return hit.value as T;
  }
  try {
    const value = await fn();
    const ok = isOk(value);
    memo.set(key, { until: Date.now() + (ok ? okMs : failMs), ok, value });
    return value;
  } catch (err) {
    memo.set(key, { until: Date.now() + failMs, ok: false, value: err });
    throw err;
  }
}
