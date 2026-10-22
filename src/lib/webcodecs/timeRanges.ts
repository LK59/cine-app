/**
 * La plage qui contient un instant : son rang dans `ranges`, ou -1.
 *
 * Écrite à la main dans chaque fonction qui en avait besoin, sous deux formes qui ne sont pas la
 * même question et restent donc distinctes ici par `slack`, que chaque appelant écrit en toutes
 * lettres :
 *
 * - `0`, stricte (`start ≤ x < end`) : la tête est-elle *sur* du média — `distanceToMedia`,
 *   `decodeDistance`, la garde.
 * - `0.1`, tolérante (`start ≤ x + 0,1 && x < end`) : une plage qui commence un dixième après la
 *   tête compte comme la sienne — l'arrondi d'un atterrissage, la tête posée au bord.
 *
 * La première plage qui répond, dans l'ordre. Avec `0`, des plages disjointes n'en laissent qu'une ;
 * avec `0.1`, deux plages séparées de moins d'un dixième peuvent répondre toutes deux — c'est
 * pourquoi `laneProgress` et `audioRoom`, qui les comptent toutes ou gardent la dernière, n'y
 * passent pas.
 */
export function rangeAround(ranges: TimeRanges, x: number, slack: number): number {
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= x + slack && x < ranges.end(i)) return i;
  }
  return -1;
}
