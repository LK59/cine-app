import type { ResumeIndex } from "./store";
import { RESUME_CACHE_MAX_AGE_MS } from "./diskChunks";

/**
 * Quels titres garder sur l'appareil, lesquels refaire, lesquels effacer — sans rien lire ni écrire.
 *
 * Les titres : les premiers de « Reprendre » (films et épisodes) et le premier épisode de « À suivre »,
 * ceux qu'on relance le plus souvent d'un geste. Peu nombreux exprès : c'est l'ouverture qu'on veut
 * instantanée, pas le catalogue qu'on veut télécharger.
 */

/** Combien de titres de « Reprendre », et combien au total avec « À suivre ». */
export const MAX_RESUME_TITLES = 3;
export const MAX_TITLES = 4;
/** La borne totale, en Mio (un morceau = 1 Mio). */
export const MAX_TOTAL_CHUNKS = 100;
/**
 * Une position de reprise qui sort de ce que les octets couvrent — il a regardé plus loin — refait le
 * titre. Il faut au moins cette avance au-delà de la position pour qu'une ouverture n'aille pas tout
 * de suite au réseau.
 */
export const MIN_COVERED_AHEAD_SECONDS = 2;

export interface ResumeTarget {
  itemId: string;
  /** La position à laquelle le lecteur s'ouvrira — recul de reprise déjà appliqué. */
  startSeconds: number;
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
  for (const target of resume.slice(0, MAX_RESUME_TITLES)) push(target);
  for (const target of nextUp) {
    if (out.length >= MAX_TITLES) break;
    push(target);
  }
  return out;
}

/** Ce que les octets gardés couvrent-ils cette position ? Un titre partiel (en-tête seul) ne couvre rien. */
export function covers(entry: ResumeIndex[string], startSeconds: number): boolean {
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
    if (!wanted.has(itemId) || now - entry.savedAt > RESUME_CACHE_MAX_AGE_MS) remove.push(itemId);
  }
  const record = targets.filter((target) => {
    const entry = index[target.itemId];
    return !entry || remove.includes(target.itemId) || !covers(entry, target.startSeconds);
  });
  return { record, remove };
}

/** Ce qu'il reste de place, en morceaux, une fois retirés les titres effacés ou refaits. */
export function remainingChunks(index: ResumeIndex, plan: ResumeCachePlan): number {
  const leaving = new Set([...plan.remove, ...plan.record.map((target) => target.itemId)]);
  let used = 0;
  for (const [itemId, entry] of Object.entries(index)) {
    if (!leaving.has(itemId)) used += Math.ceil(entry.bytes / (1 << 20));
  }
  return Math.max(0, MAX_TOTAL_CHUNKS - used);
}
