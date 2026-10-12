/**
 * Quel passage traduire maintenant (DECISIONS.md §69) — une fonction pure, sans horloge ni base,
 * pour que chaque règle se vérifie dans un test.
 *
 * **Priorité absolue aux spectateurs.** Un spectateur est actif s'il a sondé dans les 30 dernières
 * secondes ; on traduit à partir de sa position moins 10 s (la réplique qu'il vient de manquer en
 * sautant). Tant qu'un spectateur actif a moins de cinq minutes d'avance traduite devant lui, c'est
 * pour lui qu'on travaille — à tour de rôle s'ils sont plusieurs. Quand tous ont leur avance, on
 * continue devant eux jusqu'au bout, puis on revient au début combler les trous. Sans spectateur,
 * la tâche continue depuis là où le dernier s'était arrêté.
 *
 * Un saut ne coûte rien de perdu : la requête en cours continue (ses lignes serviront), et le lot
 * suivant part de la nouvelle position — la plus récente fait foi, parce qu'elle seule est lue ici.
 * Rien n'est jamais retraduit : une ligne faite ou en vol n'est jamais choisie.
 */

export const ACTIVE_MS = 30_000;
export const BEHIND_S = 10;
export const LEAD_S = 300;
/** Le premier lot, et celui d'un spectateur qui attend : petit, pour afficher vite. */
export const SMALL_BATCH = 8;
export const BATCH = 40;
/** Un spectateur « attend » quand la première ligne à faire est à moins de 30 s de sa position. */
const WAITING_S = 30;

export interface Viewer {
  key: string;
  position: number;
  seenAt: number;
}

export interface PlanInput {
  starts: readonly number[];
  ends: readonly number[];
  /** Faite (traduite ou gardée en source). */
  done: ArrayLike<number | boolean>;
  inflight: ReadonlySet<number>;
  viewers: readonly Viewer[];
  now: number;
  /** Compteur de tours de la tâche, pour l'alternance entre spectateurs. */
  turn: number;
  /** Où reprendre sans spectateur : la dernière position connue. */
  resumeFrom: number | null;
  /** Aucune ligne faite encore : le premier lot est petit, quoi qu'il arrive. */
  first: boolean;
}

export interface Plan {
  from: number;
  count: number;
  /** `viewer` : pour un spectateur en manque d'avance ; `ahead` : devant eux ; `fill` : les trous. */
  why: "viewer" | "ahead" | "fill";
  viewer?: string;
}

/** La première réplique encore à l'écran (ou à venir) à cette position, moins la marge arrière. */
export function anchorIndex(starts: readonly number[], ends: readonly number[], position: number): number {
  const from = position - BEHIND_S;
  for (let i = 0; i < starts.length; i++) if (ends[i] >= from) return i;
  return starts.length;
}

function open(input: PlanInput, i: number): boolean {
  return !input.done[i] && !input.inflight.has(i);
}

function firstOpen(input: PlanInput, from: number): number {
  for (let i = Math.max(0, from); i < input.starts.length; i++) if (open(input, i)) return i;
  return -1;
}

function run(input: PlanInput, from: number, size: number): number {
  let n = 0;
  while (from + n < input.starts.length && n < size && open(input, from + n)) n++;
  return n;
}

export function activeViewers(viewers: readonly Viewer[], now: number): Viewer[] {
  return viewers.filter((v) => now - v.seenAt <= ACTIVE_MS).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Ce qu'il manque à un spectateur : la première ligne ouverte devant lui, et son avance. */
export function viewerNeed(input: PlanInput, v: Viewer): { gap: number; lead: number } {
  const anchor = anchorIndex(input.starts, input.ends, v.position);
  const gap = firstOpen(input, anchor);
  return { gap, lead: gap === -1 ? Infinity : input.starts[gap] - v.position };
}

export function nextBatch(input: PlanInput): Plan | null {
  const active = activeViewers(input.viewers, input.now);
  const size = (urgent: boolean) => (input.first || urgent ? SMALL_BATCH : BATCH);

  const needing = active
    .map((v) => ({ v, ...viewerNeed(input, v) }))
    .filter((n) => n.gap !== -1 && n.lead < LEAD_S);
  if (needing.length > 0) {
    const pick = needing[input.turn % needing.length];
    const count = run(input, pick.gap, size(pick.lead < WAITING_S));
    return { from: pick.gap, count, why: "viewer", viewer: pick.v.key };
  }

  if (active.length > 0) {
    // Tous ont leur avance : on continue devant le plus en retard, jusqu'au bout.
    const lowest = Math.min(...active.map((v) => anchorIndex(input.starts, input.ends, v.position)));
    const ahead = firstOpen(input, lowest);
    if (ahead !== -1) return { from: ahead, count: run(input, ahead, size(false)), why: "ahead" };
  } else if (input.resumeFrom !== null) {
    const ahead = firstOpen(input, anchorIndex(input.starts, input.ends, input.resumeFrom));
    if (ahead !== -1) return { from: ahead, count: run(input, ahead, size(false)), why: "ahead" };
  }
  const gap = firstOpen(input, 0);
  if (gap === -1) return null;
  return { from: gap, count: run(input, gap, size(false)), why: "fill" };
}
