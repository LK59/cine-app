// La coupe de « Jusqu'ici » (DECISIONS.md §139) — une seule fonction, lue par le serveur (ce qui part au
// modèle, la clé du texte gardé) et par le client (la file des préparations, les textes déjà lus) : les deux
// coupent au même endroit. Sans dépendance, pour entrer dans le paquet du lecteur.
//
// **La coupe tombe au début de la scène en cours** (10.30.1, consigne du propriétaire) : le texte dit tout ce qui
// précède la scène qu'on regarde. La règle d'avant (10.27.2 : la dernière scène commencée avant la marque des
// cinq minutes) laissait le texte loin derrière l'image — *Ted Lasso* S01E09, Rebecca à 13 min 43 : coupe à
// 7 min 31, sa confession à Ted (10 min 57 à 13 min 10) absente. **Une longue scène avance par pas de deux
// minutes** (`SOFAR_SCENE_STEP_S`) depuis son début : la confession est dans la scène 11 min 02 – 13 min 55 ;
// coupée à son seul début, elle manquait encore à 13 min 43. Les coupes restent peu nombreuses (une par scène,
// une de plus par tranche de deux minutes d'une longue scène) : le texte gardé sert à tous ceux qui sont au
// même endroit. Entre deux scènes (un trou de l'analyse), la fin de la précédente. Les répliques partent
// jusqu'à la coupe, rien après.
//
// Sans scènes (titre non analysé, analyse périmée), quand l'analyse ne va pas encore jusqu'à la position, ou
// avant la première scène, la marque des cinq minutes (`sofarMark`), comme avant 10.27.2.

/** Sans scènes, le rythme de « Jusqu'ici » : une coupe par tranche de cinq minutes. */
export const SOFAR_BUCKET_S = 300;

/** Ce que la coupe lit des scènes d'« À l'écran » (`XrayPlayerPayload`). */
export interface SofarScenes {
  complete: boolean;
  analyzedUntil: number;
  scenes: readonly { start: number; end?: number }[];
}

/** La marque des cinq minutes : le début de la tranche de la position. */
export function sofarMark(positionS: number | null | undefined): number {
  if (positionS == null || !Number.isFinite(positionS) || positionS <= 0) return 0;
  return Math.floor(positionS / SOFAR_BUCKET_S) * SOFAR_BUCKET_S;
}

/** Dans une longue scène, la coupe avance par ce pas depuis le début de la scène. */
export const SOFAR_SCENE_STEP_S = 120;

/** Ce que la coupe lit d'une scène : son début, et sa fin quand on la connaît. */
type CutScene = { start: number; end?: number };

/**
 * La coupe, en secondes entières : le début de la scène qui contient la position (plus les pas de deux minutes
 * déjà passés dans une longue scène), sinon la marque des cinq minutes. Jamais après la position, jamais
 * négative.
 */
export function sofarCut(positionS: number | null | undefined, scenes?: SofarScenes | null): number {
  if (positionS == null || !Number.isFinite(positionS) || positionS <= 0) return 0;
  // La seconde entière, comme le serveur la reçoit (`readSofarBody`) : le client, qui a la position exacte, coupe
  // au même endroit — sinon un début de scène à 662,2 s et une position à 662,5 donnaient deux coupes, deux clés.
  positionS = Math.floor(positionS);
  const mark = sofarMark(positionS);
  if (!scenes || scenes.scenes.length === 0) return mark;
  if (!scenes.complete && !(scenes.analyzedUntil >= positionS)) return mark;
  let cur: CutScene | null = null;
  for (const s of scenes.scenes as readonly CutScene[]) {
    if (Number.isFinite(s.start) && s.start >= 0 && s.start <= positionS && (!cur || s.start > cur.start)) cur = s;
  }
  if (!cur) return mark;
  // Une scène finie avant la position (un trou entre deux scènes) : vue en entier, la coupe à sa fin.
  if (typeof cur.end === "number" && Number.isFinite(cur.end) && cur.end > cur.start && cur.end <= positionS) return Math.floor(cur.end);
  const steps = Math.floor((positionS - cur.start) / SOFAR_SCENE_STEP_S);
  return Math.floor(Math.min(cur.start + steps * SOFAR_SCENE_STEP_S, positionS));
}
