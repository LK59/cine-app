/**
 * Le repère de temps d'un segment de sous-titres HLS, remis à celui de nos segments vidéo.
 *
 * Jellyfin écrit toujours `X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000` en tête des
 * segments WebVTT qu'il découpe — dix secondes, en 90 kHz : le décalage que le multiplexeur
 * MPEG-TS ajoute aux segments `.ts`. Nos flux HLS sont en fMP4 (`deviceProfile.ts`), et ffmpeg y
 * garde l'horodatage du fichier (`-copyts -start_at_zero`, relevé dans les journaux de Jellyfin
 * pour une copie comme pour un réencodage) : aucun décalage. Un lecteur qui applique ce repère à
 * la lettre — l'Apple TV en diffusion — affichait chaque sous-titre dix secondes après sa réplique
 * (26/09/2026). Le téléphone ne le voyait pas : il dessine lui-même les sous-titres.
 *
 * Seule la valeur de Jellyfin est remplacée ; tout autre repère est laissé tel quel.
 */
export function fixVttTimestampMap(text: string): string {
  return text.replace(/^(X-TIMESTAMP-MAP=)MPEGTS:900000(,LOCAL:00:00:00\.000)/m, "$1MPEGTS:0$2");
}
