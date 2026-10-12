import { cueTextAt } from "@/lib/webcodecs/externalSubtitles";
import { stripSubtitleMarkup, type SubtitleCue } from "@/lib/webcodecs/subtitleMarkup";
import type { GeneratedCueWire } from "./client";

/**
 * Les lignes d'une génération en cours, en mémoire, cherchées par instant.
 *
 * Elles arrivent par morceaux, au fil des sondages, et pas dans l'ordre du film : le serveur traduit
 * d'abord autour de la tête de lecture, puis ailleurs après un saut. Elles sont donc **insérées
 * triées par début** et la recherche est celle des fichiers externes (`cueTextAt`, DECISIONS.md
 * §70) — binaire, non destructive : reculer retrouve sa ligne.
 *
 * Tenues au-dessus des chaînes de lecture, comme les fichiers externes : une reconstruction
 * (coupure réseau, changement de piste audio) ne doit pas faire redemander ce qu'on a déjà.
 */
export class GeneratedCues {
  /** Par rang dans la transcription : une ligne renvoyée (retraduite) remplace l'ancienne. */
  private readonly byIndex = new Map<number, SubtitleCue & { i: number }>();
  private sorted: (SubtitleCue & { i: number })[] = [];

  get count(): number {
    return this.sorted.length;
  }

  /** Les lignes, triées par début — pour en faire une piste finie sans rien redemander. */
  get cues(): readonly SubtitleCue[] {
    return this.sorted;
  }

  /** Ajoute un lot ; rend vrai si quelque chose a changé. */
  insert(batch: readonly GeneratedCueWire[]): boolean {
    let changed = false;
    for (const wire of batch) {
      if (!(wire.end >= wire.start)) continue;
      // Le même nettoyage que les fichiers à côté du film : un `<i>` d'un modèle de traduction n'a
      // pas plus sa place à l'écran que celui d'un fichier SubRip.
      const text = stripSubtitleMarkup(wire.text).trim();
      if (!text) continue;
      const known = this.byIndex.get(wire.i);
      if (known && known.text === text && known.startSeconds === wire.start && known.endSeconds === wire.end) continue;
      this.byIndex.set(wire.i, { i: wire.i, startSeconds: wire.start, endSeconds: wire.end, text });
      changed = true;
    }
    if (changed) {
      // Trié par début, puis par rang : deux lignes qui commencent au même instant gardent l'ordre
      // de la transcription. Quelques milliers de lignes pour un film : retrier à chaque lot coûte
      // moins qu'une image, et toutes les deux secondes au plus.
      this.sorted = [...this.byIndex.values()].sort((a, b) => a.startSeconds - b.startSeconds || a.i - b.i);
    }
    return changed;
  }

  textAt(seconds: number): string | null {
    return cueTextAt(this.sorted, seconds);
  }

  /**
   * L'instant est-il dans une zone déjà traduite — sur une ligne, ou dans le silence entre deux
   * lignes **consécutives** de la transcription ?
   *
   * C'est ce qui distingue un silence du film d'un passage pas encore fait : entre la ligne 41 et la
   * ligne 42, il n'y a rien à dire ; entre la 41 et la 90, il manque 48 lignes. Sans cette
   * distinction, « Préparation des sous-titres… » s'afficherait dans chaque silence, ou jamais.
   * `total` est le nombre de lignes de la transcription (0 : inconnu).
   */
  covers(seconds: number, total: number): boolean {
    const cues = this.sorted;
    if (cues.length === 0) return false;
    let low = 0;
    let high = cues.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (cues[mid].startSeconds <= seconds) low = mid + 1;
      else high = mid;
    }
    const before = low > 0 ? cues[low - 1] : null;
    const after = low < cues.length ? cues[low] : null;
    if (before && before.endSeconds >= seconds) return true;
    // Une ligne plus ancienne peut encore couvrir l'instant (un panneau long) : `cueTextAt` la
    // trouverait, et l'instant n'est alors pas un trou.
    if (this.textAt(seconds) !== null) return true;
    if (!before) return after !== null && after.i === 0;
    if (!after) return total > 0 && before.i >= total - 1;
    return after.i === before.i + 1;
  }
}
