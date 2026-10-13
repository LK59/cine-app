import { normaliseLanguage } from "@/lib/trackPreferences";
import { originalLanguageCode } from "@/lib/originalLanguage";

/**
 * Les catégories de la page Statistiques, tirées des noms que Radarr écrit dans `mediaInfo` et
 * `quality`. Sorties de la route et de la page pour qu'un test puisse les confronter aux valeurs
 * réellement relevées dans la bibliothèque (vérification du 13/10/2026) — chacune des trois avait
 * un cas que la page comptait de travers.
 */

/**
 * La catégorie de langue d'un film, d'après ses pistes audio **et sa langue de tournage**.
 *
 * - `vfvo` : film étranger, doublage français + piste originale ;
 * - `vf` : film étranger, doublage français sans la piste originale ;
 * - `vo` : film étranger, piste originale sans doublage français ;
 * - `vofr` : film français, en français — sa VO ;
 * - `other` : rien de tout cela (pistes `und`, absentes, ou seulement un doublage tiers).
 *
 * Les pistes seules ne suffisent pas (13/10/2026) : « VF uniquement » comptait 89 films français
 * qui n'ont que leur piste d'origine — de la VO, pas un doublage — et « VF + VO » ne regardait que
 * l'anglais, si bien qu'un film coréen « fre/kor » passait pour « VF uniquement » et un film
 * espagnol « fre/eng » (doublages français et anglais, sans l'espagnol) pour « VF + VO ». La langue
 * de tournage est celle que Radarr tient de TMDB (`originalLanguage.name`, « Korean »…).
 *
 * Les codes se comparent normalisés (`normaliseLanguage`) : Radarr écrit `fre` pour la plupart des
 * fichiers mais `fra` quand le conteneur la porte ainsi, et chercher la sous-chaîne `fre` rangeait
 * des films ailleurs. Une langue de tournage inconnue (nom absent de `originalLanguageCode`) garde
 * la règle d'avant, élargie : toute piste non française passe pour l'originale.
 */
export type LangCategory = "vfvo" | "vf" | "vo" | "vofr" | "other";

export function langCategory(audioLangs: string, originalLanguageName?: string | null): LangCategory {
  // Radarr sépare les pistes par « / », parfois entouré d'espaces : des codes entiers, jamais des
  // sous-chaînes. `und` et consorts tombent (normaliseLanguage les rend null).
  const codes = (audioLangs ?? "")
    .split("/")
    .map((c) => normaliseLanguage(c))
    .filter((c): c is string => c !== null);
  const hasFrench = codes.includes("fr");
  const original = originalLanguageCode(originalLanguageName);
  if (original === "fr") return hasFrench ? "vofr" : "other";
  const hasOriginal = original ? codes.includes(original) : codes.some((c) => c !== "fr");
  if (hasFrench && hasOriginal) return "vfvo";
  if (hasFrench) return "vf";
  if (hasOriginal) return "vo";
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
