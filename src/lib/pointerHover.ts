/**
 * Un survol ne désigne une affiche que si le pointeur a bougé (12/10/2026, DECISIONS.md §71).
 *
 * Les cartes du cinéma du bureau prêtent la bannière à deux gestes : le focus (les flèches, la
 * télécommande) et le survol (`onMouseEnter`). Or le navigateur envoie aussi `mouseenter` quand
 * c'est le *contenu* qui glisse sous un pointeur immobile : une flèche fait défiler la rangée, et la
 * carte qui passe sous la souris posée là prend la bannière à la place de celle qui a le focus. La
 * bannière montre alors un film, Entrée en ouvre un autre — deux sélections pour un seul écran.
 *
 * Sur la Fire TV de Timothé c'est la règle plutôt que l'exception : en mode immersif de Silk (la
 * navigation spatiale), le curseur reste là où on l'avait laissé en mode curseur — souvent posé au
 * bord, justement pour faire défiler —, invisible, et chaque défilement fait passer des affiches
 * dessous. Au bureau, une souris posée sur les rangées pendant qu'on navigue au clavier fait pareil.
 *
 * La règle : un `mouseenter` désigne quand la souris vient de bouger (moins de `MOVED_WITHIN_MS`),
 * ou quand il arrive à une position que l'on n'a pas encore vue — l'ordre des évènements n'est pas
 * le même partout (`mouseenter` avant ou après le `mousemove` qui l'amène), les deux cas sont donc
 * couverts. Un pointeur dont on ne sait rien encore désigne : le premier survol de la page marche.
 *
 * Seul `mousemove` est suivi, pas `pointermove` : au doigt, le `mouseenter` d'émulation arrive
 * avant son `mousemove`, à une position neuve, et désigne donc comme avant.
 */
const MOVED_WITHIN_MS = 150;

let tracking: Window | null = null;
let lastX = Number.NaN;
let lastY = Number.NaN;
let lastMovedAt = Number.NEGATIVE_INFINITY;

function onMove(e: MouseEvent): void {
  // Un `mousemove` à la même position (le navigateur en fabrique après un défilement, pour remettre
  // l'état de survol à jour) n'est pas un mouvement.
  if (Math.abs(e.clientX - lastX) < 1 && Math.abs(e.clientY - lastY) < 1) return;
  lastX = e.clientX;
  lastY = e.clientY;
  lastMovedAt = performance.now();
}

/** Pose le suivi du pointeur — une fois par fenêtre ; appelé de lui-même au premier survol. */
export function trackPointer(win: Window = window): void {
  if (tracking === win) return;
  tracking?.removeEventListener("mousemove", onMove, { capture: true });
  tracking = win;
  win.addEventListener("mousemove", onMove, { capture: true, passive: true });
}

/** Pour les tests : oublier le pointeur et le suivi. */
export function resetPointerTracking(): void {
  tracking?.removeEventListener("mousemove", onMove, { capture: true });
  tracking = null;
  lastX = Number.NaN;
  lastY = Number.NaN;
  lastMovedAt = Number.NEGATIVE_INFINITY;
}

/** Ce `mouseenter` vient-il d'un pointeur qui bouge, et non d'un contenu qui glisse dessous ? */
export function hoverDesignates(e: { clientX: number; clientY: number }): boolean {
  if (typeof window === "undefined") return true;
  trackPointer(window);
  if (Number.isNaN(lastX)) return true;
  if (Math.abs(e.clientX - lastX) >= 1 || Math.abs(e.clientY - lastY) >= 1) return true;
  return performance.now() - lastMovedAt < MOVED_WITHIN_MS;
}

/** Le gestionnaire `onMouseEnter` d'une carte : `designate` seulement pour un vrai survol. */
export function onRealHover(designate: () => void): (e: { clientX: number; clientY: number }) => void {
  return (e) => {
    if (hoverDesignates(e)) designate();
  };
}
