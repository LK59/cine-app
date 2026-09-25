/**
 * Le maître HLS d'une diffusion ne garde que sa variante HDR recopiée.
 *
 * Pour un fichier HDR dont l'image est recopiée, Jellyfin ajoute au maître deux variantes de
 * secours ré-encodées en SDR (HEVC, puis H.264), toutes déclarées au même débit que la copie — et
 * plus bas que ce qu'elle envoie réellement. *Ted Lasso* en 4K Dolby Vision sur une Apple TV
 * (25/09/2026) : à chaque saut, Jellyfin relance ffmpeg sur le fichier, le téléviseur se lasse
 * d'attendre son segment et bascule sur une variante de secours ; un ré-encodage 4K qui partage la
 * même tâche Jellyfin ne livre jamais à temps, et le téléviseur redemande le même segment en boucle.
 * Sans secours, il attend quelques secondes après un saut au lieu de s'y enfermer.
 *
 * Le prix : un téléviseur incapable de HDR ne trouve plus de version SDR de ces fichiers-là — les
 * fichiers SDR n'ont jamais qu'une variante et ne changent pas. Choix fait à l'œil, sur une Apple TV
 * qui lit le Dolby Vision.
 */
export function castMasterPlaylist(text: string): string {
  const lines = text.split("\n");
  const variants = lines.map((line, i) => (line.startsWith("#EXT-X-STREAM-INF:") ? i : -1)).filter((i) => i >= 0);
  if (variants.length < 2) return text;
  const range = (line: string) => /VIDEO-RANGE=([A-Z]+)/.exec(line)?.[1] ?? "SDR";
  // La copie HDR vient en tête, les secours SDR après : on ne touche qu'à cette forme-là.
  if (range(lines[variants[0]]) === "SDR" || variants.slice(1).some((i) => range(lines[i]) !== "SDR")) return text;
  const dropped = new Set<number>();
  for (const i of variants.slice(1)) {
    dropped.add(i);
    // L'adresse de la variante est la première ligne qui suit et n'est pas une balise.
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === "" || lines[j].startsWith("#")) continue;
      dropped.add(j);
      break;
    }
  }
  return lines.filter((_, i) => !dropped.has(i)).join("\n");
}
