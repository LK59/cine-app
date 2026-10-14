// Une zone illisible dans un fichier : le refus nommé du lecteur natif (DECISIONS.md §93).
//
// « Le Grinch » (14/10/2026) portait des blocs de zéros de 16 Kio au milieu de ses grappes — une
// release abîmée. Le lecteur Matroska s'y arrêtait sans rien dire : un en-tête illisible au
// milieu d'une grappe faisait sauter au suivant (l'image à moitié nulle partait quand même au
// navigateur : « Media failed to decode »), et un en-tête de grappe écrasé finissait la lecture —
// « le remultiplexeur ne produit plus de segment (fin du fichier) », `endOfStream`, aucune erreur,
// aucun repli. Mathis est resté 198 s devant une image figée ; le lecteur serveur (ffmpeg) franchit
// la même zone sans broncher.
//
// La détection est au **parsing** (`SampleReader`, option `unreadable: "throw"`) : un en-tête dont
// le premier octet n'a pas de bit de marque, lu avec une fenêtre complète, là où le fichier dit
// qu'il reste du film. Elle vaut donc quelle que soit l'origine des octets — réseau, réserve en
// mémoire, morceaux gardés sur l'appareil : des zéros y sont des données « valides », que seul le
// parsing peut juger.

/** Le début stable du motif — ce que le diagnostic « fichier ou appareil » reconnaît. */
export const UNREADABLE_ZONE_PREFIX = "zone illisible dans le fichier";

/** « 234,9 » : une décimale, virgule — la forme du motif, à ne pas changer (l'Activité groupe par elle). */
function frenchSeconds(seconds: number): string {
  return (Math.round(Math.max(0, seconds) * 10) / 10).toFixed(1).replace(".", ",");
}

/** Le motif exact : « zone illisible dans le fichier vers 234,9 s (octet 169510505) ». */
export function unreadableZoneMessage(seconds: number, byteOffset: number): string {
  return `${UNREADABLE_ZONE_PREFIX} vers ${frenchSeconds(seconds)} s (octet ${Math.round(byteOffset)})`;
}

/** L'instant d'un motif (« … vers 234,9 s … »), en secondes — 0 s'il n'en porte pas. */
export function zoneSecondsOf(reason: string): number {
  const match = /vers (\d+(?:,\d+)?) s/.exec(reason);
  return match ? Number(match[1].replace(",", ".")) : 0;
}

export function isUnreadableZoneReason(reason: unknown): boolean {
  return typeof reason === "string" && reason.startsWith(UNREADABLE_ZONE_PREFIX);
}

export class UnreadableZone extends Error {
  constructor(
    /** L'octet où l'en-tête illisible a été lu. */
    readonly byteOffset: number,
    /** Où le film en était, sur l'horloge du fichier : le dernier instant lu avant la zone. */
    readonly seconds: number,
    /**
     * Jusqu'où le film lu avant la zone est sûr, sur l'horloge du fichier : le début de la grappe
     * dont la fin a pu être touchée — celle où l'en-tête illisible a été trouvé, ou, pour un
     * en-tête de grappe écrasé, la grappe d'avant. Les zéros qui ont effacé un en-tête ont pu
     * commencer dans le contenu de l'image qui le précède.
     */
    readonly safeSeconds: number
  ) {
    super(unreadableZoneMessage(seconds, byteOffset));
    this.name = "UnreadableZone";
  }
}

export function isUnreadableZone(error: unknown): error is UnreadableZone {
  return error instanceof UnreadableZone || (error instanceof Error && error.name === "UnreadableZone" && isUnreadableZoneReason(error.message));
}
