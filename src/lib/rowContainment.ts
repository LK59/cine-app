// Les rangées de l'accueil du bureau, mises en page seulement quand elles approchent (08/10/2026).
//
// L'accueil monte toutes ses rangées d'un coup : vingt-trois rangées, chacune avec tout son genre,
// soit près de deux mille cartes et autant d'images. Mesuré sur un processeur ralenti quatre fois,
// survoler douze affiches coûtait plus de quatre secondes de tâches longues : chaque image en
// chargement différé est suivie par le navigateur, et chaque image de chaque survol relançait le
// calcul d'intersection, le test de survol et la composition pour les deux mille — dont dix-neuf
// rangées sur vingt-trois hors de l'écran.
//
// `content-visibility: auto` laisse le navigateur sauter la mise en page, le dessin et le test de
// survol d'une rangée loin de l'écran. Les cartes restent dans le document : les flèches
// (`useTvGridNav`), le focus — qui rend la rangée visible —, le décodage anticipé
// (`useDecodeRowsAhead`) et l'accrochage du défilement les trouvent comme avant.
//
// La hauteur réservée n'est qu'une estimation jusqu'au premier affichage : `auto` retient ensuite la
// vraie. Celle d'une rangée d'affiches à sa plus grande taille (titre, affiche 2:3 de 144 px,
// marges du défilement) ; une rangée plus basse ne fait que se resserrer quand elle approche, sous le
// bord de l'écran, où rien de ce qu'on regarde ne bouge.

import type { CSSProperties } from "react";

export const ROW_CONTAINMENT: CSSProperties = {
  contentVisibility: "auto",
  containIntrinsicSize: "auto 272px",
};
