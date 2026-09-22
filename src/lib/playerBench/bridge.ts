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
  /** L'élément que les commandes pilotent : la vraie balise <video>, ou la façade du chemin canevas. */
  media(): HTMLVideoElement | null;
  /** « remux », « webcodecs », ou `null` tant que rien n'est choisi. */
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

export function benchBridge(): BenchBridge | null {
  return current;
}

export function onBenchBridgeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
