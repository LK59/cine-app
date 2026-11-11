/**
 * La télévision commune d'un salon (étape 3 de `immersion/docs/MULTIJOUEUR.md`) : ce qui joue, où, et quand chacun
 * doit démarrer. Sans réseau ni horloge propre, comme le moteur du jeu.
 *
 * Chacun lit **son propre flux** (sa séance Jellyfin, négociée pour son navigateur) ; seul cet état est partagé. Le
 * principe : **démarrer quand tout le monde est prêt**.
 *
 * - Lancer un titre, reprendre après une pause ou sauter ouvre une phase **préparation** (`preparing`) à une position
 *   donnée : chacun ouvre ou cale son flux là, en pause, le précharge, et répond « prêt » pour cette préparation
 *   (`epoch`).
 * - Quand tous les présents sont prêts — ou au bout de `READY_TIMEOUT_MS`, les retardataires suivront seuls —, la
 *   phase passe à **lecture** (`playing`) avec une **heure de départ** (`anchor`) un peu dans le futur : chacun
 *   démarre à cet instant, et la position attendue est ensuite `position + (maintenant − anchor)`.
 * - Une pause fige la position (`paused`) ; reprendre rouvre une préparation à cette position.
 *
 * Les heures sont celles du service : chaque client connaît son décalage avec lui (`ping`/`pong`).
 */
export type TvPhase = "preparing" | "playing" | "paused";

export interface TvView {
  itemId: string;
  title: string;
  phase: TvPhase;
  /** Secondes dans le titre : à `anchor` en lecture, figée sinon. */
  position: number;
  /** Heure du service où `position` est atteinte (lecture), ou où la phase a commencé. */
  anchor: number;
  /** Numéro de la préparation en cours : un « prêt » d'une préparation passée ne compte pas. */
  epoch: number;
  /** Qui est prêt pour cette préparation. */
  ready: string[];
}

/** Au-delà, la lecture démarre sans attendre les retardataires (ils rattrapent en route). */
export const READY_TIMEOUT_MS = 20_000;
/** L'avance donnée au départ : le temps que l'ordre arrive partout. */
export const START_LEAD_MS = 1200;

export class SharedTv {
  itemId: string;
  title: string;
  phase: TvPhase = "preparing";
  position: number;
  anchor: number;
  epoch = 1;
  private ready = new Set<string>();

  constructor(itemId: string, title: string, position: number, now: number) {
    this.itemId = itemId;
    this.title = title;
    this.position = Math.max(0, position);
    this.anchor = now;
  }

  /** La position à cet instant (en lecture, elle avance avec le temps). */
  positionAt(now: number): number {
    return this.phase === "playing" ? Math.max(0, this.position + (now - this.anchor) / 1000) : this.position;
  }

  /** Une nouvelle préparation à `position` (lancer, reprendre, sauter). */
  prepare(position: number, now: number): void {
    this.phase = "preparing";
    this.position = Math.max(0, position);
    this.anchor = now;
    this.epoch += 1;
    this.ready = new Set();
  }

  /**
   * « Prêt » d'un participant pour la préparation `epoch`. Rend `true` si la lecture peut partir : tous les présents
   * (`present`) sont prêts.
   */
  markReady(memberId: string, epoch: number, present: string[]): boolean {
    if (this.phase !== "preparing" || epoch !== this.epoch) return false;
    this.ready.add(memberId);
    return this.allReady(present);
  }

  allReady(present: string[]): boolean {
    return this.phase === "preparing" && present.length > 0 && present.every((id) => this.ready.has(id));
  }

  /** Le départ, pour tous, à `now + START_LEAD_MS`. */
  start(now: number): void {
    if (this.phase !== "preparing") return;
    this.phase = "playing";
    this.anchor = now + START_LEAD_MS;
  }

  pause(now: number): void {
    if (this.phase === "paused") return;
    this.position = this.positionAt(now);
    this.phase = "paused";
    this.anchor = now;
  }

  view(): TvView {
    return { itemId: this.itemId, title: this.title, phase: this.phase, position: this.position, anchor: this.anchor, epoch: this.epoch, ready: [...this.ready] };
  }
}

/**
 * L'apparence d'un avatar (étape 5) : `[couleur, chapeau, écharpe, lunettes]` — des indices dans des listes que le
 * chalet connaît (`immersion/src/world/avatarLook.ts`). Bornés ici : le service ne relaie rien d'autre.
 */
export type Look = [number, number, number, number];
export const LOOK_LIMITS = { colors: 10, hats: 4, scarves: 10, glasses: 2 } as const;

export function parseLook(value: unknown): Look | null {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((n) => Number.isInteger(n))) return null;
  const [color, hat, scarf, glasses] = value as number[];
  if (color < 0 || color >= LOOK_LIMITS.colors) return null;
  if (hat < 0 || hat >= LOOK_LIMITS.hats) return null;
  // L'écharpe : -1 pour aucune.
  if (scarf < -1 || scarf >= LOOK_LIMITS.scarves) return null;
  if (glasses < 0 || glasses >= LOOK_LIMITS.glasses) return null;
  return [color, hat, scarf, glasses];
}
