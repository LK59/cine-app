// La découpe d'un fichier en segments HLS : une fonction pure des images clés vérifiées.
//
// **Déterministe** : même fichier, même version du format (`LUMEN_FORMAT_VERSION`), mêmes segments —
// un déploiement au milieu d'une séance relit l'index et retombe sur les mêmes frontières, numéros et
// durées que la liste servie avant lui (2-serveur.md §2.5, risque 3). Rien ici ne dépend de l'heure,
// de l'ordre des requêtes ou d'une mesure : seulement des instants lus dans le fichier.
//
// La règle (DECISIONS.md §155) : on coupe à la première image clé **admise** au moins `targetUs` après
// la coupe précédente. Un segment ne descend donc jamais sous un groupe d'images, et ne commence
// jamais sur une clé refusée — une CRA suivie de RASL, une clé H.264 non IDR suivie d'images de tête,
// un point d'index qui ne désigne pas une image d'accès aléatoire (voir `lumenIndex.ts`).

import { FRAGMENT_BYTES, FRAGMENT_SAMPLES, type LumenSegment } from "./format";

export interface CutPoint {
  /** L'instant de présentation de l'image clé (µs). */
  timeUs: number;
  /** Où la relire : grappe (Matroska) ou rang d'échantillon (MP4). */
  at: number;
}

/**
 * Les segments, de bout en bout du fichier. `cuts` : les clés admises, dans l'ordre du temps.
 * Le premier segment commence à 0 (ou plus tôt, si le fichier a des instants négatifs) ; le dernier
 * finit à la durée du fichier, ou une image après sa dernière clé si la durée annoncée est plus
 * courte. `bytes` est laissé à 0 : l'appelant le connaît, pas la découpe.
 */
export function planSegments(cuts: readonly CutPoint[], durationUs: number, frameUs: number, targetUs: number): LumenSegment[] {
  const kept: CutPoint[] = [];
  for (const cut of cuts) {
    const last = kept[kept.length - 1];
    if (last && cut.timeUs <= last.timeUs) continue; // deux points au même instant : le premier
    if (!last || cut.timeUs - last.timeUs >= targetUs) kept.push(cut);
  }
  if (kept.length === 0) return [];
  const end = Math.max(durationUs, kept[kept.length - 1].timeUs + frameUs);
  return kept.map((cut, i) => ({
    startUs: i === 0 ? Math.min(0, cut.timeUs) : cut.timeUs,
    endUs: i + 1 < kept.length ? kept[i + 1].timeUs : end,
    keyUs: cut.timeUs,
    at: cut.at,
    bytes: 0,
  }));
}

/**
 * Quels échantillons vont dans quel fragment : la règle de `planFragments` du remuxeur (au plus
 * `FRAGMENT_BYTES` et `FRAGMENT_SAMPLES`, au moins un échantillon), recopiée plutôt qu'importée :
 * importer `remuxer.ts` tirerait dans le fil de calcul tout le lecteur du navigateur (MediaSource,
 * WebCodecs, décodeurs WebAssembly). Un test les compare forme par forme : elles ne divergent pas.
 */
export function fragmentRanges(count: number, byteLengthOf: (index: number) => number): [number, number][] {
  const out: [number, number][] = [];
  let from = 0;
  while (from < count) {
    let to = from;
    let bytes = 0;
    do {
      bytes += byteLengthOf(to);
      to += 1;
    } while (to < count && to - from < FRAGMENT_SAMPLES && bytes < FRAGMENT_BYTES);
    out.push([from, to]);
    from = to;
  }
  return out;
}

/** La durée la plus longue, arrondie à l'entier le plus proche — `EXT-X-TARGETDURATION` (rfc8216bis §4.4.3.1). */
export function targetDurationOf(segments: readonly LumenSegment[]): number {
  let longest = 1;
  for (const s of segments) longest = Math.max(longest, Math.round((s.endUs - s.startUs) / 1e6));
  return longest;
}
