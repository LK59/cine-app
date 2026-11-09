// La coupe de « Jusqu'ici » (DECISIONS.md §139) — une seule fonction, lue par le serveur (ce qui part au
// modèle, la clé du texte gardé) et par le client (la file des préparations, les textes déjà lus) : les deux
// coupent au même endroit. Sans dépendance, pour entrer dans le paquet du lecteur.
//
// **Le rythme reste de cinq minutes** (`SOFAR_BUCKET_S`, 10.27.1) ; **la coupe tombe sur un début de scène**
// (10.27.2, consigne du propriétaire) : le début de la dernière scène d'« À l'écran » qui commence au plus tard
// à la marque des cinq minutes — un texte ne s'arrête jamais au milieu d'une conversation. Les répliques
// partent jusqu'à ce début, rien après.
//
// Sans scènes (titre non analysé, analyse périmée), ou quand l'analyse ne va pas encore jusqu'à la marque (une
// scène lointaine couperait des minutes vues), la marque elle-même.

/** Le rythme de « Jusqu'ici » : une coupe par tranche de cinq minutes. */
export const SOFAR_BUCKET_S = 300;

/** Ce que la coupe lit des scènes d'« À l'écran » (`XrayPlayerPayload`). */
export interface SofarScenes {
  complete: boolean;
  analyzedUntil: number;
  scenes: readonly { start: number }[];
}

/** La marque des cinq minutes : le début de la tranche de la position. */
export function sofarMark(positionS: number | null | undefined): number {
  if (positionS == null || !Number.isFinite(positionS) || positionS <= 0) return 0;
  return Math.floor(positionS / SOFAR_BUCKET_S) * SOFAR_BUCKET_S;
}

/**
 * La coupe, en secondes entières : le début de la dernière scène qui commence au plus tard à la marque, sinon
 * la marque. Jamais après la marque, jamais négative.
 */
export function sofarCut(positionS: number | null | undefined, scenes?: SofarScenes | null): number {
  const mark = sofarMark(positionS);
  if (mark <= 0 || !scenes || scenes.scenes.length === 0) return mark;
  if (!scenes.complete && !(scenes.analyzedUntil >= mark)) return mark;
  let best = -1;
  for (const s of scenes.scenes) {
    if (Number.isFinite(s.start) && s.start >= 0 && s.start <= mark && s.start > best) best = s.start;
  }
  return best >= 0 ? Math.floor(best) : mark;
}
