/**
 * Le mouvement du cadre des lecteurs plein écran ↔ mini-lecteur : position, taille et coins en
 * 300 ms. Une seule valeur pour le lecteur en ligne (`ExperimentalPlayerHost`) et celui des
 * téléchargements (`OfflinePlayerHost`), qui doivent s'agrandir et se réduire de la même façon
 * (relecture du design hors ligne, 19/10/2026 — le second passait d'une taille à l'autre d'un coup).
 */
export const PLAYER_FRAME_TRANSITION =
  "top 300ms cubic-bezier(0.4,0,0.2,1), left 300ms cubic-bezier(0.4,0,0.2,1), width 300ms cubic-bezier(0.4,0,0.2,1), height 300ms cubic-bezier(0.4,0,0.2,1), border-radius 300ms cubic-bezier(0.4,0,0.2,1)";
