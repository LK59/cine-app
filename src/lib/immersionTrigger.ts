/**
 * Le mode « Immersion » : un monde 3D caché, auquel on entre par une affiche.
 *
 * Chercher « immersion » fait apparaître, en tête des résultats, une affiche de plus — « Le
 * Chalet », au format de toutes les autres. On la presse comme un film ; au lieu d'une fiche, la
 * page part vers `/immersion`. C'est le langage de l'application (des affiches), et rien ne le
 * signale à qui ne cherche pas ce mot.
 *
 * Le mode lui-même est une page à part, construite par son propre projet (`immersion/` à la racine
 * du dépôt, `immersion/PROGRESS.md`) et servie par `src/app/immersion/route.ts`. Rien de son code
 * n'entre dans celui de l'application : tout ce que le cinéma en sait tient dans ce fichier.
 */
export const IMMERSION_PATH = "/immersion";

/** L'affiche, servie avec le build du mode (`immersion/public/poster.jpg`) — une image du vrai chalet. */
export const IMMERSION_POSTER = "/api/immersion/poster.jpg";

/** Un titre de film, donc un nom propre : il ne se traduit pas. */
export const IMMERSION_TITLE = "Le Chalet";
export const IMMERSION_SUBTITLE = "Laterna Experience";

const QUERY = "immersion";

/** Vrai si ce qui est cherché est exactement le mot, espaces et casse ignorés. */
export function isImmersionQuery(typed: string): boolean {
  return typed.trim().toLowerCase() === QUERY;
}

/**
 * Une navigation ordinaire, pas un changement de route : la page d'arrivée n'est pas une page de
 * l'application, et le cinéma doit se fermer comme pour n'importe quel départ (arrêt d'un film en
 * cours annoncé par `pagehide`).
 */
export function enterImmersion(): void {
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- voulu : `/immersion` n'est pas une page de l'application mais le `index.html` d'un autre projet (une route) ; le routeur n'a rien à y précharger, et il faut un vrai chargement de page.
  window.location.assign(IMMERSION_PATH);
}
