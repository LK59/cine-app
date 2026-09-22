import { seekArrived } from "./seekArrival";

/**
 * L'état d'un saut, en un seul endroit : demandé, servi, en route, arrivé.
 *
 * Trois variables vivaient à part dans `MseSource` jusqu'au 22/09/2026 — le saut demandé, la
 * dernière cible servie, le saut en route —, lues et écrites à vingt-deux endroits, et l'audit de
 * ce jour-là a trouvé leurs croisements plutôt que leurs rôles. Elles sont réunies ici, avec les
 * transitions qui les font changer ; ce qui *agit* sur un saut (servir, reprendre, atterrir)
 * reste dans la source, qui interroge cet état au lieu de le recomposer.
 */
/** Combien de temps un déplacement de la source attend son `seeking`. */
const OWN_MOVE_MS = 2000;

export class SeekLifecycle {
  /** Demandé, pas encore servi. Une rafale en demande des dizaines : seul le dernier compte. */
  requested: number | null = null;
  /** La dernière cible que la source a servie ou posée. */
  lastTarget = -1;
  /**
   * Le déplacement que la source vient de faire, attendu une seule fois, et brièvement.
   *
   * Reconnu jusqu'au 22/09/2026 par la seule proximité de `lastTarget` — durable, elle : tout saut
   * du spectateur à moins de 0,25 s de la dernière position posée par la source passait pour le
   * sien, des heures après. « Revoir » à la fin d'un film restait ainsi figé à 0:00, la source ayant
   * posé la tête à 0,24 s à l'ouverture. Un jeton, pris au premier `seeking` qui lui correspond, et
   * qui expire : le `seeking` d'une écriture de `currentTime` suit en quelques millisecondes.
   */
  private ownMove: { at: number; until: number } | null = null;
  /** En route vers sa cible, depuis l'événement `seeking` jusqu'à l'arrivée. */
  intent: { target: number; since: number } | null = null;

  /** Un saut est demandé ; il remplace celui qui attendait encore. */
  request(seconds: number): void {
    this.requested = seconds;
  }

  /** La source commence à le servir : c'est désormais sa cible. */
  serving(seconds: number): void {
    this.lastTarget = seconds;
    this.expectOwnMove(seconds);
  }

  /** Servi : la demande est satisfaite, sauf si une autre l'a remplacée entre-temps. */
  served(seconds: number): void {
    if (this.requested === seconds) this.requested = null;
  }

  /**
   * Un pas volontaire de la source autour de la cible — atterrissage, poussée, position de pause
   * réaffirmée : la cible le suit, ce n'est pas un départ.
   */
  moved(seconds: number): void {
    this.lastTarget = seconds;
    this.expectOwnMove(seconds);
    if (this.intent) this.intent.target = seconds;
  }

  private expectOwnMove(seconds: number): void {
    this.ownMove = { at: seconds, until: Date.now() + OWN_MOVE_MS };
  }

  /** L'élément commence à sauter vers `seconds`. */
  started(seconds: number, now: number): void {
    this.intent = { target: seconds, since: now };
  }

  /** Ce `seeking` est-il le déplacement que la source vient elle-même de faire ? */
  isOwnMove(seconds: number): boolean {
    const own = this.ownMove;
    if (!own || Date.now() > own.until || Math.abs(seconds - own.at) >= 0.25) return false;
    this.ownMove = null;
    return true;
  }

  /**
   * L'élément dit le saut fini, la tête à `current`. Arrivé si elle est à sa cible ; sinon le saut
   * reste en route, et c'est la surveillance de la tête hors de sa place qui tranchera.
   */
  arrive(current: number): boolean {
    if (this.intent && !seekArrived(current, this.intent.target)) return false;
    this.intent = null;
    return true;
  }

  /** Le saut en route est abandonné — la source le redemande autrement. */
  drop(): void {
    this.intent = null;
  }

  /** Demandé et pas encore servi, ou servi et pas encore arrivé. */
  get pending(): boolean {
    return this.intent !== null || this.requested !== null;
  }
}

/** Jusqu'où, après sa cible, un saut ou une ouverture peut aller chercher le média qu'il a produit. */
export const LANDING_REACH_SECONDS = 15;

/** Un pas dans le média plutôt que son premier instant — voir `landingFor`. */
export const LANDING_INSET = 0.04;

/**
 * Où poser la tête pour rejoindre `target` : `target` si le média le couvre ; sinon un pas dans le
 * premier média qui commence après lui, à `reach` secondes au plus ; sinon `null`, rien à rejoindre.
 *
 * **Un seul atterrissage pour l'ouverture et pour le saut** (22/09/2026). Il y en avait deux :
 * après un saut (`nudgeIntoBuffer`) et à l'ouverture en cours de film (`placePendingStart`), qui
 * ne s'accordaient ni sur la portée — quinze secondes contre une — ni sur l'endroit : l'ouverture
 * posait la tête pile au bord du média, ce qui laisse WebKit dans un saut qu'il ne résout pas —
 * un épisode figé à 0:00 avec vingt secondes en tampon, corrigé pour les sauts seulement. Et un
 * index creux, dont le média commence quelques secondes après la position demandée, ne se
 * rejoignait à l'ouverture que par une reprise qui relisait le fichier.
 *
 * Un pas, parce que le premier instant d'une plage est justement ce qui ne se résout pas ; une
 * image, imperceptible, et jamais au-delà de la fin de la plage.
 */
export function landingFor(ranges: TimeRanges, target: number, reach: number): number | null {
  let start: number | null = null;
  let end = 0;
  for (let i = 0; i < ranges.length; i++) {
    // Une plage vide n'a rien où poser la tête — et y atterrir, c'est le bord exact.
    if (ranges.end(i) <= ranges.start(i)) continue;
    if (ranges.start(i) <= target && target < ranges.end(i)) return target;
    if (ranges.start(i) > target && (start === null || ranges.start(i) < start)) {
      start = ranges.start(i);
      end = ranges.end(i);
    }
  }
  if (start === null || start - target > reach) return null;
  return Math.min(start + LANDING_INSET, Math.max(start, end - 0.05));
}
