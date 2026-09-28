import type { ResumeIndex } from "./store";
import { RESUME_CACHE_MAX_AGE_MS } from "./diskChunks";
import { NORMAL_BUDGET, OPENING_TITLE_CHUNKS, STARTED_TITLE_CHUNKS } from "./budget";

/**
 * Quels titres garder sur l'appareil, lesquels refaire, lesquels effacer — sans rien lire ni écrire.
 *
 * Les titres : les premiers de « Reprendre » (films et épisodes) et le premier épisode de « À suivre »,
 * ceux qu'on relance le plus souvent d'un geste. Peu nombreux exprès : c'est l'ouverture qu'on veut
 * instantanée, pas le catalogue qu'on veut télécharger.
 */

/**
 * Combien de titres de « Reprendre », et combien au total avec « À suivre ». Cinq et dix depuis le
 * 28/09/2026 (trois et quatre avant) : le budget se compte désormais en octets (`budget.ts`), et
 * c'est lui qui borne, pas le nombre de titres.
 */
export const MAX_RESUME_TITLES = 5;
export const MAX_TITLES = 10;
/** La borne commune de l'ouverture et de la reprise en mode normal, en Mio — voir `budget.ts`. */
export const MAX_TOTAL_CHUNKS = NORMAL_BUDGET.resumeChunks;
/**
 * Une position de reprise qui sort de ce que les octets couvrent — il a regardé plus loin — refait le
 * titre. Il faut au moins cette avance au-delà de la position pour qu'une ouverture n'aille pas tout
 * de suite au réseau.
 */
export const MIN_COVERED_AHEAD_SECONDS = 2;
/**
 * Un titre gardé il y a moins longtemps n'est pas effacé parce qu'il manque aux listes : c'est celui
 * qu'on vient d'arrêter (`keepOnStop`), et « Reprendre » ne le montre qu'une fois relu.
 */
export const RECENT_GRACE_MS = 5 * 60_000;

export interface ResumeTarget {
  itemId: string;
  /** La position à laquelle le lecteur s'ouvrira — recul de reprise déjà appliqué. */
  startSeconds: number;
  /**
   * Commencé (« Reprendre ») : la reprise, `STARTED_TITLE_CHUNKS`. Sinon (« À suivre ») : l'ouverture,
   * `OPENING_TITLE_CHUNKS`.
   */
  started?: boolean;
}

/** Ce qu'un titre visé garde au-delà de son en-tête et de son index. */
export function titleChunks(target: ResumeTarget): number {
  return target.started ? STARTED_TITLE_CHUNKS : OPENING_TITLE_CHUNKS;
}

export interface ResumeCachePlan {
  record: ResumeTarget[];
  remove: string[];
}

/** Les titres visés, dans l'ordre de priorité : « Reprendre » d'abord, puis « À suivre ». */
export function resumeTargets(resume: ResumeTarget[], nextUp: ResumeTarget[]): ResumeTarget[] {
  const out: ResumeTarget[] = [];
  const seen = new Set<string>();
  const push = (target: ResumeTarget) => {
    if (seen.has(target.itemId) || out.length >= MAX_TITLES) return;
    seen.add(target.itemId);
    out.push(target);
  };
  for (const target of resume.slice(0, MAX_RESUME_TITLES)) push({ ...target, started: true });
  for (const target of nextUp) {
    if (out.length >= MAX_TITLES) break;
    push({ ...target, started: target.started ?? false });
  }
  return out;
}

/** Ce que les octets gardés couvrent-ils cette position ? Un titre partiel (en-tête seul) ne couvre rien. */
export function covers(entry: ResumeIndex[string], startSeconds: number): boolean {
  // Gardé à l'arrêt d'une lecture, sans savoir encore ce que ça couvre : le prochain passage le mesure.
  if (entry.coveredTo < 0) return false;
  if (entry.partial) return Math.abs(entry.startSeconds - startSeconds) < 1;
  return startSeconds >= entry.coveredFrom - 0.5 && startSeconds <= entry.coveredTo - MIN_COVERED_AHEAD_SECONDS;
}

/**
 * Efface ce qui n'est plus visé (fini, sorti de la liste) ou trop ancien ; refait ce qui manque ou
 * ce que la position a quitté. L'ordre de `record` est celui de la priorité.
 */
export function planResumeCache(targets: ResumeTarget[], index: ResumeIndex, now = Date.now()): ResumeCachePlan {
  const wanted = new Set(targets.map((target) => target.itemId));
  const remove: string[] = [];
  for (const [itemId, entry] of Object.entries(index)) {
    const age = now - entry.savedAt;
    if (age > RESUME_CACHE_MAX_AGE_MS || (!wanted.has(itemId) && age > RECENT_GRACE_MS)) remove.push(itemId);
  }
  const record = targets.filter((target) => {
    const entry = index[target.itemId];
    return !entry || remove.includes(target.itemId) || !covers(entry, target.startSeconds);
  });
  return { record, remove };
}

/** Ce qu'il reste de place, en morceaux, une fois retirés les titres effacés ou refaits. */
export function remainingChunks(index: ResumeIndex, plan: ResumeCachePlan, totalChunks = MAX_TOTAL_CHUNKS): number {
  const leaving = new Set([...plan.remove, ...plan.record.map((target) => target.itemId)]);
  let used = 0;
  for (const [itemId, entry] of Object.entries(index)) {
    if (!leaving.has(itemId)) used += Math.ceil(entry.bytes / (1 << 20));
  }
  return Math.max(0, totalChunks - used);
}
