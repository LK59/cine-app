/**
 * Le registre des tentatives d'une séance de lecture — DECISIONS.md §67.
 *
 * Chaque chemin de reprise du lecteur compte à sa façon : neuf compteurs, quatre notions de « ça
 * remarche » (inventaire du 11/10/2026). Presque tous sont bornés, mais trois peuvent rejouer la même
 * tentative sans fin : l'échelle du son du lecteur serveur, dont le compteur retombe à zéro à chaque
 * `loadeddata` ; la récupération d'hls.js, remise à zéro par chaque fragment ; la reconstruction sur
 * la piste voulue, hors budget. Et deux boucles du repli AAC à PCE l'ont fait en vrai le même jour.
 *
 * La règle que ce registre porte : **une nouvelle tentative doit changer quelque chose.** Une
 * tentative se décrit par une signature — son motif et la configuration qu'elle rejoue (piste,
 * codecs exclus, transcodage forcé, position arrondie) ; si la même signature a déjà échoué depuis la
 * dernière preuve que le film joue, rejouer est inutile (`mayRetry` faux).
 *
 * **En observation seulement.** Rien ici ne décide : les hôtes notent les échecs et la lecture, le
 * registre compte les tentatives identiques, et le bilan `stop` les rapporte (`identicalRetries`,
 * `retryMotif`). L'activation, chemin par chemin, viendra quand le journal aura dit si la signature
 * est assez fine — trop grossière, elle bloquerait une reprise légitime (deux causes au même endroit).
 *
 * La preuve que le film joue : trois secondes réellement jouées depuis le dernier échec — et non
 * `loadeddata` ni la première image, qui arrivent justement avant l'échec qui se répète.
 */

/** Trois secondes jouées depuis le dernier échec : le film a vraiment repris. */
export const PROGRESS_PROOF_SECONDS = 3;

/**
 * La position, arrondie à la dizaine de secondes. L'hôte ne connaît pas les images clés du fichier ;
 * un groupe d'images dure rarement plus de dix secondes, si bien que deux reprises au même passage
 * tombent dans la même case, et deux passages différents rarement.
 */
export const POSITION_BUCKET_SECONDS = 10;

export function positionBucket(seconds: number | null | undefined): number | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  return Math.floor(seconds / POSITION_BUCKET_SECONDS) * POSITION_BUCKET_SECONDS;
}

/**
 * Le motif d'une tentative sans ce qui change à chaque fois : les numéros d'essai entre parenthèses,
 * les positions, et ce qui suit une virgule ou un tiret (le détail du message).
 */
export function retryMotif(why: string): string {
  return why
    .replace(/\s*\(\d+\)/g, "")
    .split(/[,—]/)[0]
    .replace(/\d+(?:[.,]\d+)?\s*s\b/g, "")
    .trim()
    .slice(0, 80);
}

export type RetryConfig = Record<string, string | number | boolean | null | undefined>;

/** La signature d'une tentative : son motif et sa configuration, clés triées. */
export function retrySignature(motif: string, config: RetryConfig = {}): string {
  const parts = Object.keys(config)
    .sort()
    .filter((key) => config[key] !== undefined)
    .map((key) => `${key}=${String(config[key])}`);
  return [retryMotif(motif), ...parts].join("|");
}

export interface RetrySummary {
  /** Les tentatives qui en rejouaient une déjà échouée, sans que le film ait joué entre-temps. */
  identicalRetries?: number;
  /** Le motif le plus rejoué à l'identique. */
  retryMotif?: string;
}

export class RetryLedger {
  /** Les signatures échouées depuis la dernière preuve de lecture, et combien de fois chacune. */
  private failed = new Map<string, number>();
  private identical = 0;
  private repeatsByMotif = new Map<string, number>();
  private playedSinceFailure = 0;
  private lastPosition: number | null = null;

  /** Rejouer cette tentative changerait-il quelque chose ? Calculé, jamais appliqué (§67). */
  mayRetry(signature: string): boolean {
    return !this.failed.has(signature);
  }

  /**
   * Une tentative va être rejouée après un échec. Rend son rang parmi les tentatives identiques
   * depuis la dernière preuve de lecture : 1 la première fois, 2 et plus pour une répétition.
   */
  noteFailure(signature: string): number {
    const count = (this.failed.get(signature) ?? 0) + 1;
    this.failed.set(signature, count);
    this.playedSinceFailure = 0;
    if (count > 1) {
      this.identical += 1;
      const motif = signature.split("|")[0];
      this.repeatsByMotif.set(motif, (this.repeatsByMotif.get(motif) ?? 0) + 1);
    }
    return count;
  }

  /**
   * La position de lecture, à chaque `timeupdate`. Seule une avance continue compte comme jouée
   * (moins de deux secondes entre deux relevés) : un saut ou une reprise ailleurs ne prouve rien.
   */
  notePosition(seconds: number): void {
    if (!Number.isFinite(seconds)) return;
    const previous = this.lastPosition;
    this.lastPosition = seconds;
    if (previous === null || this.failed.size === 0) return;
    const delta = seconds - previous;
    if (delta <= 0 || delta >= 2) return;
    this.playedSinceFailure += delta;
    if (this.playedSinceFailure >= PROGRESS_PROOF_SECONDS) this.noteProgress();
  }

  /** Le film joue : les échecs passés ne disent plus rien des tentatives à venir. */
  noteProgress(): void {
    this.failed.clear();
    this.playedSinceFailure = 0;
  }

  /** Pour le bilan `stop` : rien quand rien ne s'est répété — le journal garde son budget de champs. */
  summary(): RetrySummary {
    if (this.identical === 0) return {};
    let top: [string, number] | null = null;
    for (const entry of this.repeatsByMotif) if (!top || entry[1] > top[1]) top = entry;
    return { identicalRetries: this.identical, ...(top ? { retryMotif: top[0] } : {}) };
  }
}
