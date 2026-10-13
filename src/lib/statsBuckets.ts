/**
 * Les catégories de la page Statistiques, tirées des noms que Radarr écrit dans `mediaInfo` et
 * `quality`. Sorties de la route et de la page pour qu'un test puisse les confronter aux valeurs
 * réellement relevées dans la bibliothèque (vérification du 13/10/2026) — chacune des trois avait
 * un cas que la page comptait de travers.
 */

/** Une piste française, quelle que soit la forme du code ISO 639-2 : Radarr écrit `fre` (forme
 *  bibliographique) pour la plupart des fichiers, mais `fra` (forme terminologique) quand le
 *  conteneur la porte ainsi. Chercher la seule sous-chaîne `fre` rangeait 3 films « fra » en
 *  « Autre », un « fra/spa » en « Autre » et un « eng/fra » en « VO uniquement ». */
const FRENCH = new Set(["fre", "fra"]);

export function langCategory(audioLangs: string): "vf" | "vfvo" | "vo" | "other" {
  if (!audioLangs) return "other";
  // Radarr sépare les pistes par « / », parfois entouré d'espaces : on compare des codes entiers
  // plutôt que des sous-chaînes, pour qu'un code ne soit jamais lu à l'intérieur d'un autre.
  const codes = audioLangs.toLowerCase().split("/").map((c) => c.trim()).filter(Boolean);
  const hasFre = codes.some((c) => FRENCH.has(c));
  const hasEng = codes.includes("eng");
  if (hasFre && hasEng) return "vfvo";
  if (hasFre) return "vf";
  if (hasEng) return "vo";
  return "other";
}

/** `AVC` est le nom MediaInfo du H.264 : Radarr le rend tel quel pour certains fichiers (1 film
 *  ici), que la recherche de « 264 » rangeait en « Autre ». */
export function codecCategory(codec: string): "hevc" | "h264" | "other" {
  const c = codec.toLowerCase();
  if (c.includes("265") || c === "hevc") return "hevc";
  if (c.includes("264") || c === "avc") return "h264";
  return "other";
}

/** Regroupe les qualités Radarr (« Bluray-2160p », « Remux-1080p »…) par définition.
 *  La résolution se lit avant le mot « remux » : un « Remux-1080p » est un 1080p, et le
 *  test sur « remux » placé avant celui sur « 1080 » rangeait les 2 remux 1080p de la
 *  bibliothèque en « 4K / UHD ». « DVD » est une définition standard : il formait sa propre
 *  barre (3 films) à côté de « SD ». « remux » seul (sans résolution) reste un 4K, ce que Radarr
 *  n'écrit d'ailleurs jamais sans définition. */
export function qualityBucket(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("2160") || n.includes("4k") || n.includes("uhd")) return "4K / UHD";
  if (n.includes("1080")) return "1080p";
  if (n.includes("720")) return "720p";
  if (n.includes("480") || n.includes("576") || n.includes("dvd")) return "SD";
  if (n.includes("remux")) return "4K / UHD";
  return name;
}
