// Où en est le film selon ce que le spectateur a demandé, pas seulement selon ce qu'il a vu — la
// position de la ligne `stop` et du rapport à Jellyfin (battements, arrêt), pour les deux lecteurs.
//
// Pendant un saut qui charge, la position suivie ne bouge plus (le lecteur serveur ignore les
// `timeupdate` d'un élément sans image ; le natif ne la relit qu'à l'arrivée) : fermer à ce moment
// envoyait la position d'*avant* le saut, et « Reprendre » y revenait. Le natif l'a corrigé le
// 22/09/2026 (`HostSeek.intendedPosition`) ; le serveur l'avait gardé jusqu'au 23/10/2026 (audit des
// fusions, F1-4, DECISIONS.md §115). Une seule règle désormais :
// - la cible que les commandes ont demandée et pas encore atteinte (le natif seul la connaît —
//   `HostSeek` ; le serveur passe `null`) ;
// - sinon, un saut lancé par autre chose que les commandes (le système, la télécommande, un saut du
//   lecteur serveur) : l'élément dit déjà où il va ;
// - sinon, la position que l'hôte suit.
export function intendedPosition(
  requested: number | null,
  element: { seeking: boolean; currentTime: number } | null | undefined,
  position: number
): number {
  if (requested !== null) return requested;
  if (element?.seeking && Number.isFinite(element.currentTime)) return element.currentTime;
  return position;
}
