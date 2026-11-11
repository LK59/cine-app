/**
 * La couche d'entrées : ce que le visiteur **veut faire**, pas la touche qu'il a pressée.
 *
 * Le monde et l'interface ne connaissent que ceci :
 * - des **intentions** ponctuelles (« ouvrir le panneau », « s'asseoir », « lecture / pause »…),
 *   émises par un périphérique et reçues par les actions (`state/actions.ts`) ;
 * - un **mouvement** continu (avancer, se décaler, courir) et un **regard** (lacet, tangage), que le
 *   périphérique tient à jour et que le visiteur (`world/Player.tsx`) lit à chaque image.
 *
 * Aujourd'hui un seul périphérique existe : le clavier et la souris (`keyboardMouse.ts`), pour qui
 * « viser » veut dire tourner la tête au pointeur verrouillé. Des manettes ou un casque en seraient
 * un autre, sans rien changer au reste — c'est la raison de ce fichier (voir `docs/VR.md`).
 */
export type Intent =
  /** Agir sur ce qui est devant soi : ouvrir le panneau près d'une télévision. */
  | "interact"
  /** Valider ce que l'on vise (le clic principal) : une télévision visée s'ouvre. */
  | "select"
  | "sit"
  | "playPause"
  | "mute"
  | "seekBack"
  | "seekForward"
  /** Revenir d'un cran : fermer une fiche, vider la recherche, fermer le panneau. */
  | "back"
  /** Ouvrir le menu (pause). */
  | "menu"
  /** Accepter l'invite du moment : passer l'intro ou le récap, lancer l'épisode suivant (`media/upNext.ts`). */
  | "accept"
  /** Écarter la carte de l'épisode suivant (« Regarder le générique »). */
  | "dismiss";

/** Le mouvement voulu, dans le repère du visiteur : −1 à 1 sur chaque axe. */
export const motion = {
  forward: 0,
  strafe: 0,
  run: false,
};

/**
 * Le cadrage voulu quand on est installé (canapé, lit, bain) : 0, la vue normale ; 1, la télévision la plus
 * proche remplit l'image. `scale` est ce que le visiteur (`Player`) en a fait — le champ réel rapporté au
 * champ réglé —, pour que le regard tourne moins vite quand l'image est rapprochée.
 */
export const view = {
  zoom: 0,
  scale: 1,
};

/** Rapproche (positif) ou éloigne l'image d'un cran. */
export function zoomBy(step: number): void {
  view.zoom = Math.max(0, Math.min(1, view.zoom + step));
}

type Handler = (intent: Intent) => void;
const handlers = new Set<Handler>();

/** S'abonne aux intentions. Rend la fonction de désabonnement. */
export function onIntent(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/** Émet une intention — appelé par les périphériques, et par les tests. */
export function emit(intent: Intent): void {
  for (const handler of [...handlers]) handler(intent);
}

export function resetMotion(): void {
  motion.forward = 0;
  motion.strafe = 0;
  motion.run = false;
}

/**
 * Ce qu'un périphérique sait faire pour le reste du programme : prendre la main sur le regard (pour
 * la souris : verrouiller le pointeur) et la rendre. Posé par le périphérique actif.
 */
export interface Device {
  /** À appeler depuis un geste de l'utilisateur. */
  capture(): void;
  release(): void;
  /** Le périphérique tient-il le regard en ce moment ? */
  captured(): boolean;
}

const none: Device = { capture: () => {}, release: () => {}, captured: () => false };
export const device: { current: Device } = { current: none };
