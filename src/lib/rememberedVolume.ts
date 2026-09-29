/**
 * Le volume et le muet du spectateur, gardés d'une séance à l'autre.
 *
 * `PlayerControls` les écrit à chaque `volumechange` ; les deux lecteurs les rendent à leur élément
 * par `restoreRememberedVolume`, une fois, quand l'élément est monté. Seul le lecteur serveur les
 * relisait : dans le lecteur natif — celui de presque toutes les séances — chaque film repartait à
 * plein volume, le son coupé oublié (audit du 29/09/2026). DECISIONS.md §35.
 */
export const VOLUME_STORAGE_KEY = "cine:player-volume";

/**
 * Rend à `video` le volume et le muet mémorisés. À appeler une fois par élément, au montage — pas
 * dans `PlayerControls`, qui se remonte à chaque passage plein écran ↔ réduit et reposerait
 * l'ancienne valeur par-dessus celle que le spectateur vient de régler, ni à chaque reconstruction
 * du lecteur natif, qui garde le même élément.
 */
export function restoreRememberedVolume(video: HTMLMediaElement | null): void {
  if (!video) return;
  try {
    const stored = localStorage.getItem(VOLUME_STORAGE_KEY);
    if (!stored) return;
    const { volume, muted } = JSON.parse(stored) as { volume?: unknown; muted?: unknown };
    // Hors de [0, 1], l'affectation lève (IndexSizeError) — et le muet, posé après, était perdu avec.
    if (typeof volume === "number" && volume >= 0 && volume <= 1) video.volume = volume;
    if (typeof muted === "boolean") video.muted = muted;
  } catch {
    // Illisible ou stockage indisponible : l'élément garde son propre volume.
  }
}
