// Ce que la chaîne « Son par Lumen » (essai demux-son, 19/11/2026) a utilisé pour la dernière piste
// ouverte — pour la ligne `start`. Un module à part, sans rien d'autre : la page le lit sans charger
// le lecteur de paquets ni les décodeurs (ownAudio.ts l'écrit).
export interface LumenFacts {
  decoder: string;
  thread?: "worker" | "principal";
  workerRefusal?: string;
}

let last: LumenFacts | null = null;

export function noteLumenFacts(facts: LumenFacts): void {
  last = facts;
}

/** Lu (et oublié) par qui écrit la ligne `start` : rien quand ce chemin n'a pas servi. */
export function takeLumenFacts(): LumenFacts | null {
  const facts = last;
  last = null;
  return facts;
}

/**
 * Les décodeurs de la chaîne « Son par Lumen » ouverts et fermés, pour la ligne `stop` (19/11/2026) :
 * une fuite — un décodeur jamais refermé dans le worker après un saut — se verrait au premier soir au
 * lieu d'attendre qu'iOS tue une page. Compté depuis le dernier bilan (une page ne lit qu'un film à
 * la fois) ; `open` est l'instant présent, et doit retomber à zéro entre deux films.
 */
const counts = { opened: 0, closed: 0, open: 0, maxOpen: 0, workers: 0, lost: 0, mainThread: 0 };

export function noteLumenDecoderOpened(): void {
  counts.opened += 1;
  counts.open += 1;
  counts.maxOpen = Math.max(counts.maxOpen, counts.open);
}

export function noteLumenDecoderClosed(): void {
  counts.closed += 1;
  counts.open = Math.max(0, counts.open - 1);
}

/** Un worker AC-3/DTS créé, perdu (mort, refusé en route), ou un décodeur ouvert sur le fil principal. */
export function noteLumenWorker(event: "created" | "lost" | "mainThread"): void {
  if (event === "created") counts.workers += 1;
  else if (event === "lost") counts.lost += 1;
  else counts.mainThread += 1;
}

/**
 * Le champ du bilan, `lumenDec: "o12 c11 n1 m2 w1 l0 p0"` — ouverts, fermés, ouverts maintenant, au plus
 * en même temps, workers créés, perdus, décodeurs sur le fil principal —, absent quand rien ne s'est
 * ouvert : la ligne de toute séance sans son décodé ne change pas. Remis à zéro sauf `n`.
 */
export function takeLumenDecoderField(): { lumenDec?: string } {
  if (counts.opened === 0 && counts.closed === 0 && counts.open === 0 && counts.workers === 0 && counts.lost === 0) return {};
  const field = `o${counts.opened} c${counts.closed} n${counts.open} m${counts.maxOpen} w${counts.workers} l${counts.lost} p${counts.mainThread}`;
  Object.assign(counts, { opened: 0, closed: 0, maxOpen: counts.open, workers: 0, lost: 0, mainThread: 0 });
  return { lumenDec: field };
}

export const LUMEN_DEC_VALUE = /^o\d{1,5} c\d{1,5} n\d{1,4} m\d{1,4} w\d{1,4} l\d{1,4} p\d{1,4}$/;
