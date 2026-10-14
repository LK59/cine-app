/**
 * `Promise.all` par lots, avec une vraie respiration de la boucle d'évènements entre deux lots.
 *
 * Écrit le 14/10/2026 pour deux appelants qui pouvaient lancer des centaines de requêtes d'un coup :
 * `jellyfinOnlySeries` — une requête par série candidate, « quelques-unes » tant que Sonarr revendique
 * presque tout, mais **toutes** sur une installation sans Sonarr — et le contrôle de la bibliothèque,
 * qui lit Sonarr et Jellyfin série par série. Un lot à la fois : Jellyfin et Sonarr ne reçoivent
 * jamais plus de `size` requêtes ensemble, et le travail synchrone fait sur leurs réponses (analyse
 * JSON, comparaisons) rend la main entre deux lots plutôt que de tenir la boucle d'un trait.
 *
 * L'ordre du résultat est celui de l'entrée. Une erreur rejette le tout, comme `Promise.all` : à
 * l'appelant de rattraper chaque élément s'il veut continuer sans lui.
 */
export async function mapInBatches<T, R>(items: readonly T[], size: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  const step = Math.max(1, Math.floor(size));
  for (let start = 0; start < items.length; start += step) {
    const batch = items.slice(start, start + step);
    const results = await Promise.all(batch.map((item, i) => fn(item, start + i)));
    for (let i = 0; i < results.length; i++) out[start + i] = results[i];
    if (start + step < items.length) await yieldToLoop();
  }
  return out;
}

/** Rend la main à la boucle d'évènements : les requêtes en attente passent avant la suite. */
export function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
