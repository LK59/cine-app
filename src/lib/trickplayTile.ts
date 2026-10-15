/**
 * Une vignette de défilement (trickplay) de Jellyfin, à un instant du film.
 *
 * Chaque « tuile » téléchargée est une planche de `tileWidth × tileHeight` vignettes de
 * `width × height`, prises toutes les `intervalMs` : la vignette d'un instant est la n-ième de la
 * planche n / (tileWidth × tileHeight). Écrit une fois pour l'aperçu de la barre de lecture, les
 * chapitres (`PlayerControls`) et les répliques de la recherche (`DialogueResults`, §88).
 */
export interface TrickplayInfo {
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  thumbnailCount: number;
  intervalMs: number;
}

export function trickplayTileAt(info: TrickplayInfo, itemId: string, seconds: number): { url: string; bgX: number; bgY: number } {
  const thumbIndex = Math.min(info.thumbnailCount - 1, Math.max(0, Math.floor((seconds * 1000) / info.intervalMs)));
  const perTile = info.tileWidth * info.tileHeight;
  const tileIndex = Math.floor(thumbIndex / perTile);
  const posInTile = thumbIndex % perTile;
  const row = Math.floor(posInTile / info.tileWidth);
  const col = posInTile % info.tileWidth;
  return {
    url: `/api/jellyfin/trickplay/tile?itemId=${itemId}&width=${info.width}&index=${tileIndex}`,
    bgX: -(col * info.width),
    bgY: -(row * info.height),
  };
}

/** Le rang de la planche qui couvre `seconds`, borné aux `tileCount` planches. */
export function trickplayTileIndex(info: TrickplayInfo, seconds: number, tileCount: number): number {
  const thumbIndex = Math.max(0, Math.floor((Math.max(0, seconds) * 1000) / info.intervalMs));
  const index = Math.floor(thumbIndex / (info.tileWidth * info.tileHeight));
  return Math.min(Math.max(0, tileCount - 1), index);
}

/**
 * L'ordre de préchargement des planches (`PlayerControls`, LECTEUR-6) : celle de la position d'abord,
 * puis les plus proches — la suivante avant la précédente à égale distance : on avance plus souvent
 * qu'on ne recule.
 */
export function trickplayTileOrder(first: number, tileCount: number): number[] {
  const order: number[] = [];
  if (!(tileCount > 0)) return order;
  const start = Math.min(Math.max(0, first), tileCount - 1);
  order.push(start);
  for (let d = 1; order.length < tileCount; d++) {
    if (start + d < tileCount) order.push(start + d);
    if (start - d >= 0) order.push(start - d);
  }
  return order;
}
