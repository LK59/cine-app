// Le silence d'une piste copiée qui ne couvre pas toute l'image : devant (le son commence tard, §148) ou
// derrière (la piste s'arrête avant le film). DECISIONS.md §159.
//
// La règle 2.15 de la HLS Authoring Specification : « If you provide alternative audio […], you MUST
// provide it for the entire content duration, even if it only really exists for a portion of the main
// content » ; et 8.3 : « Audio and video playlists MUST contain the same duration of the content ». Une
// piste copiée qui commence à 30 s (*The Circle*) n'a pas de trame pour ses huit premiers segments ; une
// qui finit au générique n'en a pas pour le dernier. Les deux étaient refusées (`son-en-retard`,
// `son-plus-court`).
//
// **Le modèle est celui de la conversion** (5-conversion-son.md §5.4), sans ffmpeg et en copie :
// - **la grille des trames, ancrée sur la piste** : devant, les trames de silence sont placées à
//   L − k·F (k = 1, 2, …) où L est l'instant du premier bloc réel et F la durée exacte d'une trame
//   (échantillons ÷ fréquence, fractionnaire) — par leur nombre, jamais d'après un instant du conteneur —,
//   jusqu'à la première qui tombe à 0 ou avant ; derrière, à E + j·F, E étant la fin de la dernière trame
//   réelle (instant de son bloc + ses trames × F), jusqu'à couvrir la fin du film ;
// - **l'appartenance de §155** : une trame appartient au segment qui contient son propre instant ; les
//   trames de silence sont des trames comme les autres pour `audioSamples` (durée = écart à la suivante),
//   donc le dernier silence devant finit exactement sur L et la dernière trame réelle sur E ;
// - **sans état, déterministe** : tout vient de l'index (L, E, F, la trame), un segment se construit seul
//   et donne les mêmes octets à chaque fois ; `tfdt` = instant + D comme pour toute trame copiée.
// La trame elle-même (`aacStream.ts`, `dolbySilence.ts`) rend des zéros exacts et laisse le décodeur dans
// l'état d'un décodeur neuf : le son réel qui suit un silence devant se décode à l'identique.

/** Ce que l'index garde d'une piste à compléter. Sérialisable (clonage structuré). */
export interface LumenSilence {
  /** Une trame silencieuse aux paramètres de la piste, répétée telle quelle. */
  frame: Uint8Array;
  /** La durée exacte d'une trame (µs), fractionnaire : 1536 / 48 000 → 32 000 ; 1024 / 48 000 → 21 333,33… */
  frameUs: number;
  /** L'instant du premier bloc réel (µs) quand le silence le précède, sinon null. */
  leadUntilUs: number | null;
  /** La fin de la dernière trame réelle (µs) quand le silence la suit, sinon null. */
  tailFromUs: number | null;
  /** Jusqu'où le silence de fin va : la fin du film (µs). */
  endUs: number;
}

/** Le nombre de trames devant : la première tombe à 0 ou avant (au plus une trame avant l'origine). */
function leadCount(s: LumenSilence): number {
  return s.leadUntilUs === null || s.leadUntilUs <= 0 ? 0 : Math.ceil(s.leadUntilUs / s.frameUs - 1e-9);
}

/** Le nombre de trames derrière : la dernière commence avant la fin du film. */
function tailCount(s: LumenSilence): number {
  return s.tailFromUs === null || s.tailFromUs >= s.endUs ? 0 : Math.ceil((s.endUs - s.tailFromUs) / s.frameUs - 1e-9);
}

/**
 * Les instants des trames de silence dans [lower, upper), croissants. Les bornes des rangs sont calculées
 * large puis chaque instant comparé tel quel : deux segments voisins rangent la même trame du même côté.
 */
export function silentInstants(s: LumenSilence, lower: number, upper: number): number[] {
  const out: number[] = [];
  const lead = leadCount(s);
  if (lead > 0) {
    const L = s.leadUntilUs as number;
    const from = Number.isFinite(upper) ? Math.max(1, Math.floor((L - upper) / s.frameUs)) : 1;
    const to = Number.isFinite(lower) ? Math.min(lead, Math.ceil((L - lower) / s.frameUs) + 1) : lead;
    for (let k = to; k >= from; k--) {
      const t = L - k * s.frameUs;
      if (t >= lower && t < upper) out.push(t);
    }
  }
  const tail = tailCount(s);
  if (tail > 0) {
    const E = s.tailFromUs as number;
    const from = Number.isFinite(lower) ? Math.max(0, Math.floor((lower - E) / s.frameUs) - 1) : 0;
    const to = Number.isFinite(upper) ? Math.min(tail - 1, Math.ceil((upper - E) / s.frameUs) + 1) : tail - 1;
    for (let j = from; j <= to; j++) {
      const t = E + j * s.frameUs;
      if (t >= lower && t < upper) out.push(t);
    }
  }
  return out;
}

/** Le premier instant de silence à `from` ou après, ou null. */
export function nextSilentInstant(s: LumenSilence, from: number): number | null {
  const lead = leadCount(s);
  if (lead > 0) {
    const L = s.leadUntilUs as number;
    const k = Math.min(lead, Math.max(1, Math.floor((L - from) / s.frameUs) + 1));
    for (let i = k; i >= 1; i--) {
      const t = L - i * s.frameUs;
      if (t >= from) return t;
    }
  }
  const tail = tailCount(s);
  if (tail > 0) {
    const E = s.tailFromUs as number;
    for (let j = Math.max(0, Math.floor((from - E) / s.frameUs) - 1); j < tail; j++) {
      const t = E + j * s.frameUs;
      if (t >= from) return t;
    }
  }
  return null;
}
