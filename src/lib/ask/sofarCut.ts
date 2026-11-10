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
//
// **Une personne qui paraît pour la première fois dans la scène en cours** (10.30.2, consigne du propriétaire) : la
// coupe devient la position arrondie à la demi-minute en dessous (`SOFAR_PRESENT_STEP_S`), si c'est plus tard que la
// coupe ordinaire. *Ted Lasso* S01E09, Trent Crimm à 5 min 40, dans la conférence de presse 5 min 20 – 5 min 48 :
// coupé à 5 min 20, il n'avait rien avant, et le texte disait « Trent Crimm n'a pas encore eu de moment à lui. » —
// juste, et inutile. Ce qui a été vu de la scène l'a déjà été : rien d'après la position ne part. « Première fois »
// se lit **des seules présences d'« À l'écran »** (aucune scène commencée avant la scène en cours ne la porte), que
// le client et le serveur ont tous deux : les répliques nommées (« qui parle ») et les résumés des épisodes d'avant
// ne sont qu'au serveur, et une coupe que le client ne saurait pas refaire donnerait deux clés. D'où deux écarts
// voulus : un personnage récurrent qui paraît pour la première fois de l'épisode dans la scène en cours a la coupe
// fine (plus de contexte, jamais de divulgation), et une présence dans la scène vaut présence, même si la personne
// n'y a pas encore parlé.

/** Sans scènes, le rythme de « Jusqu'ici » : une coupe par tranche de cinq minutes. */
export const SOFAR_BUCKET_S = 300;

/** Ce que la coupe lit des scènes d'« À l'écran » (`XrayPlayerPayload`). */
export interface SofarScenes {
  complete: boolean;
  analyzedUntil: number;
  scenes: readonly { start: number; end?: number; people?: readonly { personId?: number }[] }[];
}

/** La marque des cinq minutes : le début de la tranche de la position. */
export function sofarMark(positionS: number | null | undefined): number {
  if (positionS == null || !Number.isFinite(positionS) || positionS <= 0) return 0;
  return Math.floor(positionS / SOFAR_BUCKET_S) * SOFAR_BUCKET_S;
}

/** Dans une longue scène, la coupe avance par ce pas depuis le début de la scène. */
export const SOFAR_SCENE_STEP_S = 120;

/** La coupe fine d'une personne qui paraît pour la première fois dans la scène en cours (10.30.2). */
export const SOFAR_PRESENT_STEP_S = 30;

/** Ce que la coupe lit d'une scène : son début, sa fin quand on la connaît, et qui y paraît. */
type CutScene = { start: number; end?: number; people?: readonly { personId?: number }[] };

/**
 * Pourquoi la coupe tombe là (`cutWhy` au journal) : `scene` — le début de la scène en cours, ou la fin de la
 * précédente entre deux scènes ; `step` — un pas de deux minutes dans une longue scène ; `present` — la
 * demi-minute de la position, la personne paraissant pour la première fois dans la scène en cours ; `fallback` —
 * la marque des cinq minutes, sans scènes utilisables.
 */
export type SofarCutWhy = "scene" | "step" | "present" | "fallback";

const hasPerson = (s: CutScene, personId: number) => !!s.people?.some((p) => p.personId === personId);

/**
 * La coupe et sa raison. La coupe, en secondes entières : le début de la scène qui contient la position (plus les
 * pas de deux minutes déjà passés dans une longue scène), sinon la marque des cinq minutes ; pour une personne
 * (`personId`) qui paraît dans la scène en cours et dans aucune avant, la demi-minute de la position quand elle
 * tombe plus tard. Jamais après la position, jamais négative.
 */
export function sofarCutDetail(positionS: number | null | undefined, scenes?: SofarScenes | null, personId?: number | null): { cutS: number; why: SofarCutWhy } {
  if (positionS == null || !Number.isFinite(positionS) || positionS <= 0) return { cutS: 0, why: "fallback" };
  // La seconde entière, comme le serveur la reçoit (`readSofarBody`) : le client, qui a la position exacte, coupe
  // au même endroit — sinon un début de scène à 662,2 s et une position à 662,5 donnaient deux coupes, deux clés.
  positionS = Math.floor(positionS);
  const fallback = { cutS: sofarMark(positionS), why: "fallback" as const };
  if (!scenes || scenes.scenes.length === 0) return fallback;
  if (!scenes.complete && !(scenes.analyzedUntil >= positionS)) return fallback;
  const all = scenes.scenes as readonly CutScene[];
  let cur: CutScene | null = null;
  for (const s of all) {
    if (Number.isFinite(s.start) && s.start >= 0 && s.start <= positionS && (!cur || s.start > cur.start)) cur = s;
  }
  if (!cur) return fallback;
  // Une scène finie avant la position (un trou entre deux scènes) : vue en entier, la coupe à sa fin.
  if (typeof cur.end === "number" && Number.isFinite(cur.end) && cur.end > cur.start && cur.end <= positionS) return { cutS: Math.floor(cur.end), why: "scene" };
  const steps = Math.floor((positionS - cur.start) / SOFAR_SCENE_STEP_S);
  const cutS = Math.floor(Math.min(cur.start + steps * SOFAR_SCENE_STEP_S, positionS));
  const why = steps > 0 ? ("step" as const) : ("scene" as const);
  if (personId != null && hasPerson(cur, personId)) {
    const start = cur.start;
    const before = all.some((s) => Number.isFinite(s.start) && s.start < start && hasPerson(s, personId));
    const fine = Math.floor(positionS / SOFAR_PRESENT_STEP_S) * SOFAR_PRESENT_STEP_S;
    if (!before && fine > cutS) return { cutS: fine, why: "present" };
  }
  return { cutS, why };
}

/** La coupe seule (`sofarCutDetail`) — ce qui entre dans le message, donc dans la clé. */
export function sofarCut(positionS: number | null | undefined, scenes?: SofarScenes | null, personId?: number | null): number {
  return sofarCutDetail(positionS, scenes, personId).cutS;
}
