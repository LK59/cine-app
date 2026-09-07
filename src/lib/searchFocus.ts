/**
 * Ouvrir la recherche, et ouvrir le clavier, sont deux gestes différents.
 *
 * Le panneau prenait le focus dès son montage, donc le clavier surgissait à chaque fois qu'on
 * touchait l'onglet. Parcourir les quatre onglets au pouce faisait apparaître et disparaître un
 * clavier au passage, ce qui hache la navigation pour une frappe qu'on n'a pas demandée.
 *
 * Les applications natives d'iOS séparent les deux : l'onglet montre l'écran de recherche — ses
 * suggestions, ses dernières requêtes — et le clavier n'arrive que si on vise le champ, ou si on
 * réappuie sur l'onglet alors qu'on y est déjà. Le second appui devient l'intention de taper.
 *
 * Un module minuscule plutôt qu'un contexte : celui qui demande est la barre de navigation, celui
 * qui écoute est un panneau chargé à la demande, et ils n'ont aucun ancêtre commun qui ne soit pas
 * la racine de l'application. Passer une intention par tout l'arbre pour un événement sans état
 * serait cher payé.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

/** Le panneau s'annonce tant qu'il est à l'écran. */
export function onSearchFocusRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * « Je veux taper. »
 *
 * Sans effet si le panneau n'est pas monté — c'est voulu : la demande naît d'un appui sur un
 * onglet déjà actif, donc le panneau est forcément là. Si un jour elle vient d'ailleurs, ne rien
 * faire vaut mieux que d'ouvrir un clavier sur un écran qui n'a pas de champ.
 */
export function requestSearchFocus(): void {
  for (const listener of listeners) listener();
}
