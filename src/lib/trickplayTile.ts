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
