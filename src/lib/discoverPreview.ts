/**
 * Ce que la carte savait d'un titre absent quand on l'a touchée — son titre, son année —, pour que
 * la fiche découverte du téléphone s'ouvre aussitôt sur eux plutôt que sur un écran vide
 * (06/11/2026, sixième film : ~1,3 s d'écran noir, une croix et une roue, puis la fiche d'un coup).
 *
 * Noté par l'ouverture (`openDiscoveryItem`), lu une fois par la fiche à son montage ; la réponse du
 * serveur le remplace dès qu'elle arrive. Une ouverture qui n'en a rien noté (une filmographie, une
 * recherche) ouvre la fiche sans eux, comme avant — le trajet depuis l'affiche reste le même.
 */
export type DiscoverPreview = { title: string; year: number | null };

const previews = new Map<string, DiscoverPreview>();
/** Quelques ouvertures suffisent : on ne garde que les dernières. */
const MAX = 20;

const keyOf = (type: "movie" | "series", tmdbId: number) => `${type}:${tmdbId}`;

export function noteDiscoverPreview(type: "movie" | "series", tmdbId: number, preview: DiscoverPreview): void {
  const key = keyOf(type, tmdbId);
  previews.delete(key);
  previews.set(key, preview);
  if (previews.size > MAX) previews.delete(previews.keys().next().value as string);
}

export function discoverPreview(type: "movie" | "series", tmdbId: number): DiscoverPreview | null {
  return previews.get(keyOf(type, tmdbId)) ?? null;
}
