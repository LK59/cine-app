import type { ResumeIndex } from "./store";
import { RESUME_CACHE_MAX_AGE_MS } from "./diskChunks";
import { NORMAL_BUDGET, OPENING_TITLE_CHUNKS, RESUME_MINIMAL_MAX_CHUNKS, activeTitles, restingShare, type StorageBudget } from "./budget";

/**
 * Quels titres garder sur l'appareil, lesquels refaire, lesquels effacer — sans rien lire ni écrire.
 *
 * Les titres : les premiers de « Reprendre » (films et épisodes) et le premier épisode de « À suivre »,
 * ceux qu'on relance le plus souvent d'un geste. Peu nombreux exprès : c'est l'ouverture qu'on veut
 * instantanée, pas le catalogue qu'on veut télécharger.
 */

/**
 * Combien de titres de « Reprendre », et combien au total avec « À suivre ». Cinq et dix depuis le
 * 28/09/2026 (trois et quatre avant) : ce qu'on télécharge pour chacun au repos n'est que de quoi
 * démarrer (`budget.ts`), quelques mégaoctets.
 */
export const MAX_RESUME_TITLES = 5;
export const MAX_TITLES = 10;
/** La borne de sûreté, tous titres confondus, en mode normal — voir `budget.ts`. */
export const MAX_TOTAL_CHUNKS = NORMAL_BUDGET.totalChunks;
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
   * Commencé (« Reprendre ») : la reprise minimale, de l'image clé qui précède la position jusqu'à un
   * groupe après elle. Sinon (« À suivre ») : l'ouverture, `OPENING_TITLE_CHUNKS`.
   */
  started?: boolean;
}

/** Un titre à refaire, et la part d'avance qu'il peut garder — rien s'il n'est pas actif. */
export interface PlannedTitle extends ResumeTarget {
  shareChunks: number;
}

/** Le plus qu'un titre visé télécharge pour démarrer, au-delà de son en-tête et de son index. */
export function titleChunks(target: ResumeTarget): number {
  return target.started ? RESUME_MINIMAL_MAX_CHUNKS : OPENING_TITLE_CHUNKS;
}

export interface ResumeCachePlan {
  record: PlannedTitle[];
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
 * Efface ce qui n'est plus visé (fini, sorti de la liste) ou trop ancien ; refait ce qui manque, ce
 * que la position a quitté, ce dont la couverture n'est pas encore mesurée (gardé à l'arrêt), et ce
 * qui garde plus que sa part — un titre sorti des actifs, ou des actifs devenus plus nombreux. Un
 * titre refait n'est jamais agrandi au repos : sa part est un plafond, pas une cible (`budget.ts`).
 * L'ordre de `record` est celui de la priorité.
 */
export function planResumeCache(targets: ResumeTarget[], index: ResumeIndex, now = Date.now(), budget: StorageBudget = NORMAL_BUDGET): ResumeCachePlan {
  const wanted = new Set(targets.map((target) => target.itemId));
  const remove: string[] = [];
  for (const [itemId, entry] of Object.entries(index)) {
    const age = now - entry.savedAt;
    if (age > RESUME_CACHE_MAX_AGE_MS || (!wanted.has(itemId) && age > RECENT_GRACE_MS)) remove.push(itemId);
  }
  const active = activeTitles(index, now);
  const record: PlannedTitle[] = [];
  for (const target of targets) {
    const entry = index[target.itemId];
    const shareChunks = restingShare(target.itemId, active, budget);
    const planned = { ...target, shareChunks };
    if (!entry || remove.includes(target.itemId) || !covers(entry, target.startSeconds)) {
      record.push(planned);
      continue;
    }
    // Plus que sa part : réduit. `reserveChunks` absent — un titre gardé avant cette mesure — aussi,
    // une fois, pour l'écrire.
    const limit = Math.max(shareChunks, entry.minimalChunks ?? titleChunks(target));
    if (entry.reserveChunks === undefined || entry.reserveChunks > limit) record.push(planned);
  }
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
