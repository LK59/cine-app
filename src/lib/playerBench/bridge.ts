/**
 * Ce que le lecteur natif montre au banc d'essai, et rien d'autre.
 *
 * Le banc doit mesurer ce que vit le spectateur : il ne rejoue donc pas le lecteur, il le pilote.
 * Un saut passe par `noteSeekRequest` puis par `currentTime`, exactement comme les commandes ; un
 * changement de piste par `changeAudioTrack`, comme le menu. Le lecteur ne s'enregistre ici que
 * lorsque sa séance porte un identifiant de banc (`PlaybackSession.bench`) : un spectateur n'a
 * jamais de pont ouvert.
 */

export interface BenchTrack {
  id: number;
  label: string;
}

export interface BenchBridge {
  itemId: string;
  /** L'élément vidéo que les commandes pilotent. */
  media(): HTMLVideoElement | null;
  /** « remux », ou `null` tant que rien n'est choisi. */
  path(): string | null;
  /** Le pipeline en place a montré sa première image. Faux pendant une reconstruction. */
  ready(): boolean;
  /** L'erreur affichée au spectateur, s'il y en a une. */
  error(): string | null;
  duration(): number;
  seek(seconds: number): void;
  audioTracks(): BenchTrack[];
  currentAudio(): number | null;
  changeAudio(id: number): void;
  subtitleTracks(): BenchTrack[];
  currentSubtitle(): number | null;
  changeSubtitle(id: number | null): void;
  /** Le texte du sous-titre à l'écran, ou `null`. */
  subtitleText(): string | null;
  /** Images présentées depuis l'ouverture de l'élément, quand le navigateur le dit. */
  frames(): number | null;
  /** Images par seconde du fichier, quand on la connaît. */
  nominalFps(): number | null;
  /** La trace du lecteur sur les `ms` dernières millisecondes. */
  trace(ms: number): string;
  /** Faits de synchronisation et de reprise — ce que la ligne `stop` porte. */
  facts(): Record<string, unknown>;
}

let current: BenchBridge | null = null;
const listeners = new Set<() => void>();

/** Posé par le lecteur ; la fonction rendue le retire, et seulement s'il est encore le sien. */
export function registerBenchBridge(bridge: BenchBridge): () => void {
  current = bridge;
  listeners.forEach((listener) => listener());
  return () => {
    if (current !== bridge) return;
    current = null;
    listeners.forEach((listener) => listener());
  };
}

/**
 * Les films que le lecteur natif a laissés au lecteur serveur, pour cette session d'application.
 *
 * Posés ici par le lecteur, parce que le banc doit les connaître sans rien savoir de son état
 * interne. Sans cela, il ouvrait un film déjà confié au lecteur serveur, n'en voyait jamais la
 * première image et l'annonçait « en échec » au bout de 45 s — deux fois le 22/09/2026, après une
 * demande de diffusion. Ce n'est pas un échec du lecteur : c'est une question qui ne se pose pas.
 */
let handedOverItems: string[] = [];

export function publishHandedOver(itemIds: string[]): void {
  handedOverItems = itemIds;
}

export function benchHandedOver(itemId: string): boolean {
  return handedOverItems.includes(itemId);
}

export function benchBridge(): BenchBridge | null {
  return current;
}

export function onBenchBridgeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
