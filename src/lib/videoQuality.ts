/**
 * Ce qu'on peut promettre d'un fichier sans mentir.
 *
 * La règle qui gouverne ce module : **une étiquette décrit ce que le spectateur recevra, pas ce
 * que le fichier contient.** La distinction n'est pas théorique. La vidéo traverse les deux
 * chemins de lecture **copiée telle quelle** — mesuré, `TranscodeReasons` ne cite jamais la vidéo
 * et le manifeste HLS porte bien `dvh1.08.06` : annoncer 4K ou Dolby Vision est donc exact. L'audio,
 * lui, est ré-encodé en AAC dans la plupart des cas ; une étiquette « Atmos » ou « 7.1 » serait
 * fausse au moment précis où elle compte, et c'est pourquoi il n'y en a pas ici.
 */
export interface VideoQuality {
  /** La hauteur en pixels telle que Radarr la classe : 2160, 1080, 720… */
  resolution?: number;
  /** Dolby Vision l'emporte sur HDR10 quand les deux sont présents, comme partout ailleurs. */
  dynamicRange?: "DV" | "HDR";
}

/** Ce que Radarr écrit dans `videoDynamicRangeType`, ramené à ce qui se dit à l'écran. */
export function toDynamicRange(raw: string | null | undefined): "DV" | "HDR" | undefined {
  if (!raw) return undefined;
  if (/DV|Dolby ?Vision/i.test(raw)) return "DV";
  if (/HDR|PQ|HLG/i.test(raw)) return "HDR";
  return undefined;
}

/**
 * Les étiquettes à afficher, dans l'ordre où on les lit.
 *
 * **Rien pour 1080p**, et c'est délibéré : c'est la moitié de cette bibliothèque, donc une
 * étiquette qui ne distingue rien et n'ajoute que du bruit sur chaque fiche. On ne signale que ce
 * qui sort de l'ordinaire — vers le haut comme vers le bas : savoir qu'un film est en 720p avant
 * de le lancer vaut bien mieux qu'apprendre qu'un autre est en 1080p comme tous les autres.
 */
export function qualityBadges(quality: VideoQuality | null | undefined): string[] {
  if (!quality) return [];
  const badges: string[] = [];
  const height = quality.resolution ?? 0;
  if (height >= 2160) badges.push("4K");
  else if (height > 0 && height < 720) badges.push("SD");
  else if (height > 0 && height < 1080) badges.push("720p");
  if (quality.dynamicRange === "DV") badges.push("Dolby Vision");
  else if (quality.dynamicRange === "HDR") badges.push("HDR");
  return badges;
}
