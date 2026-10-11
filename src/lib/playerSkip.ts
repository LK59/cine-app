/**
 * Les gestes du lecteur décidés hors du composant, pour être éprouvés sans navigateur — DECISIONS.md §65.
 */

export interface SkipSpan {
  start: number;
  end: number;
}

/** Le bouton de saut à montrer maintenant : son libellé et où il mène. */
export interface ActiveSkip {
  kind: "intro" | "recap";
  end: number;
}

/**
 * Quel bouton « Passer… » montrer à cet instant — un seul, à un seul endroit.
 *
 * Le récap précède presque toujours l'intro (« Shōgun » S01E06 : récap 6–61 s, intro 324–414 s) ;
 * s'ils se chevauchaient, c'est celui qui finit le plus tard qui l'emporte, pour qu'un seul appui
 * passe les deux plutôt que de faire paraître un second bouton juste après le premier.
 */
export function activeSkip(time: number, intro: SkipSpan | null, recap: SkipSpan | null): ActiveSkip | null {
  const inside = (s: SkipSpan | null) => !!s && time >= s.start && time < s.end;
  const candidates: ActiveSkip[] = [];
  if (inside(recap)) candidates.push({ kind: "recap", end: recap!.end });
  if (inside(intro)) candidates.push({ kind: "intro", end: intro!.end });
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (b.end > a.end ? b : a));
}

/** Ce qu'un appui sur la surface vide du lecteur doit faire. */
export type SurfaceAction = "toggle-play" | "toggle-controls" | "ignore";

/**
 * Le clic sur l'image : lecture/pause à la souris, afficher/masquer au doigt ou au stylet (11/10/2026).
 *
 * Décidé par l'appui lui-même (`pointerType`), jamais par l'appareil : un PC Windows à écran tactile
 * reçoit les deux, et chacun doit garder son geste — le doigt montre les commandes, la souris met en
 * pause ; un iPad répond au doigt comme un téléphone, et à son trackpad (« mouse ») comme un
 * ordinateur, ce que son curseur annonce déjà. Une media query (`hover`, `pointer: fine`) décrit
 * l'appareil et se trompe sur les deux.
 *
 * Un clic au-delà du double (triple clic) ne fait rien : les deux premiers ont déjà basculé puis
 * rebasculé, et le double-clic passe en plein écran.
 */
export function surfaceAction(pointerType: string, detail: number, onEmptySurface: boolean): SurfaceAction {
  if (pointerType !== "mouse" || !onEmptySurface) return "toggle-controls";
  if (detail > 2) return "ignore";
  return "toggle-play";
}

/**
 * Ce qui n'est pas la surface vide : un contrôle, une carte posée sur l'image, ou ce qui se déclare
 * tel (`data-player-surface-ignore`). Le reste — l'image, les voiles, les vides entre les boutons —
 * est la surface.
 */
const NOT_SURFACE = 'button, a, input, select, textarea, label, [role="menu"], [role="dialog"], [data-player-surface-ignore]';

export function isEmptySurface(target: EventTarget | null, root: Element | null): boolean {
  if (!(target instanceof Element) || !root || !root.contains(target)) return false;
  const hit = target.closest(NOT_SURFACE);
  return !hit || !root.contains(hit);
}

/**
 * Le clavier (ou la télécommande) a le focus dans ces commandes. Les boutons du lecteur ne prennent
 * pas le focus à la souris (`onMouseDown` de la racine) ; seuls les curseurs le gardent après un
 * glisser — `:focus-visible` les écarte, puisqu'un navigateur ne l'allume que pour le clavier.
 */
export function keyboardFocusWithin(root: Element | null): boolean {
  const active = typeof document !== "undefined" ? document.activeElement : null;
  if (!root || !active || active === root || !root.contains(active)) return false;
  try {
    return active.matches(":focus-visible");
  } catch {
    // Un moteur qui ne connaît pas le sélecteur : le focus dans les commandes compte.
    return true;
  }
}
