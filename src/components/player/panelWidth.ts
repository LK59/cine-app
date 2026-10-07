/**
 * La largeur des onglets faits de grilles d'affiches — Recherche, Ma liste, Parcourir : ils
 * s'étalent avec l'écran, et un grand écran y gagne des colonnes, pas des affiches géantes
 * (`player-grid-fluid`, globals.css). Bornée tout de même : sur un écran ultra-large, une rangée
 * de vingt affiches ne se parcourt plus d'un regard.
 */
export const PANEL_WIDE = "120rem";

// À part de `PlayerPanelFrame` : les tests des panneaux remplacent ce composant par une doublure,
// et une constante exportée à côté de lui y manquait.
