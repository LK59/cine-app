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
export class SeekLifecycle {
  /** Demandé, pas encore servi. Une rafale en demande des dizaines : seul le dernier compte. */
  requested: number | null = null;
  /** La dernière cible que la source a servie ou posée — pour reconnaître ses propres déplacements. */
  lastTarget = -1;
  /** En route vers sa cible, depuis l'événement `seeking` jusqu'à l'arrivée. */
  intent: { target: number; since: number } | null = null;

  /** Un saut est demandé ; il remplace celui qui attendait encore. */
  request(seconds: number): void {
    this.requested = seconds;
  }

  /** La source commence à le servir : c'est désormais sa cible. */
  serving(seconds: number): void {
    this.lastTarget = seconds;
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
    if (this.intent) this.intent.target = seconds;
  }

  /** L'élément commence à sauter vers `seconds`. */
  started(seconds: number, now: number): void {
    this.intent = { target: seconds, since: now };
  }

  /** Ce `seeking` est-il le déplacement que la source vient elle-même de faire ? */
  isOwnMove(seconds: number): boolean {
    return Math.abs(seconds - this.lastTarget) < 0.25;
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
