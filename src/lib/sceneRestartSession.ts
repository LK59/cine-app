/**
 * Ce que « Revenir au début de la scène » retient d'une séance (DECISIONS.md §142), hors des composants.
 *
 * Une séance survit à ce qui remonte les commandes : une reconstruction du lecteur natif, un passage de main
 * au lecteur serveur. Le bouton est proposé **une fois par séance** et jamais de nouveau après l'un ou
 * l'autre — d'où ce magasin, par élément, plutôt qu'un état de `PlayerControls`. Il garde :
 *
 * - **la dernière lecture selon Jellyfin**, gelée à l'ouverture : la réponse de `playback-state` (lue par le
 *   lecteur de toute façon, aucune requête de plus) est notée ici tant qu'aucune séance de cet élément ne vit
 *   — ou que la séance vivante ne la connaît pas encore. Pendant la séance, les rapports de progression
 *   avancent `LastPlayedDate` chez Jellyfin : une relecture (reconstruction, passage de main) dirait
 *   « regardé il y a une minute » ;
 * - **le verdict** (`aurait-proposé`, `proposé`, `non:<raison>`), la cible, et — le bouton montré — **ce qu'il
 *   en est advenu** (`utilisé`, `ignoré`, `saut`, `fermé`) : ce que la ligne `stop` porte (`sceneRestart`) ;
 * - la fin de la séance : la ligne `stop` partie (`endSceneRestart`), la prochaine ouverture repart de zéro.
 *
 * Chaque changement remplace l'entrée (jamais modifiée en place) : `useSyncExternalStore` la relit telle quelle.
 * Rien n'y est écrit sans les acteurs à l'écran — sans eux, aucun champ ne part au journal.
 */

export type SceneRestartOutcome = "utilisé" | "ignoré" | "saut" | "fermé";

export interface SceneRestartEntry {
  readonly lastPlayedAt?: string | null;
  readonly live: boolean;
  readonly ended: boolean;
  /** `aurait-proposé`, `proposé` ou `non:<raison>` ; absent tant que rien n'est décidé. */
  readonly verdict?: string;
  /** Proposé (montré ou non) : la position de la première image, la cible, le recul, la raison de la cible. */
  readonly at?: number;
  readonly target?: number;
  readonly back?: number;
  readonly why?: string;
  /** L'instant où le bouton a paru (ms) — il reste `SCENE_RESTART_SHOWN_MS`. */
  readonly shownAt?: number;
  readonly outcome?: SceneRestartOutcome;
  /** Un saut ou un changement de piste avant la décision. */
  readonly interrupted?: "saut" | "piste";
}

const entries = new Map<string, SceneRestartEntry>();
const listeners = new Set<() => void>();

function put(itemId: string, entry: SceneRestartEntry): void {
  entries.set(itemId, entry);
  if (entries.size > 50) {
    for (const [key, value] of entries) {
      if (!value.live || value.ended) {
        entries.delete(key);
        break;
      }
    }
  }
  for (const listener of listeners) listener();
}

export function subscribeSceneRestart(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function sceneRestartState(itemId: string): SceneRestartEntry | null {
  return entries.get(itemId) ?? null;
}

/** La réponse de `playback-state` pour cet élément : gardée si aucune séance vivante ne la tient déjà. */
export function noteLastPlayedAt(itemId: string, lastPlayedAt: string | null | undefined): void {
  if (lastPlayedAt === undefined) return;
  const entry = entries.get(itemId);
  if (!entry || entry.ended) {
    put(itemId, { live: false, ended: false, lastPlayedAt });
    return;
  }
  if (entry.live && entry.lastPlayedAt !== undefined) return;
  put(itemId, { ...entry, lastPlayedAt });
}

/** Les commandes d'une séance de cet élément sont montées (première fois, ou de nouveau après une reconstruction). */
export function beginSceneRestart(itemId: string): void {
  const entry = entries.get(itemId);
  if (entry && entry.live && !entry.ended) return;
  // Une séance finie ne lègue rien ; une note posée avant l'ouverture (la fiche, l'hôte) est gardée.
  const lastPlayedAt = entry && !entry.live && !entry.ended ? entry.lastPlayedAt : undefined;
  put(itemId, { live: true, ended: false, ...(lastPlayedAt !== undefined ? { lastPlayedAt } : {}) });
}

export function noteSceneRestartInterrupt(itemId: string, kind: "saut" | "piste"): void {
  const entry = entries.get(itemId);
  if (entry && entry.live && !entry.ended && !entry.verdict && !entry.interrupted) put(itemId, { ...entry, interrupted: kind });
}

export function noteSceneRestartVerdict(
  itemId: string,
  verdict: string,
  facts: { at?: number; target?: number; back?: number; why?: string; shownAt?: number } = {}
): void {
  const entry = entries.get(itemId);
  if (entry && entry.live && !entry.ended && !entry.verdict) put(itemId, { ...entry, verdict, ...facts });
}

/** Ce qu'il est advenu du bouton montré ; `false` si c'était déjà dit (une seule issue par séance). */
export function noteSceneRestartOutcome(itemId: string, outcome: SceneRestartOutcome): boolean {
  const entry = entries.get(itemId);
  if (!entry || entry.verdict !== "proposé" || entry.outcome) return false;
  put(itemId, { ...entry, outcome });
  return true;
}

/** Le champ de la ligne `stop` : rien si rien n'a été décidé (acteurs à l'écran absents, etc.). */
export function sceneRestartLogFields(itemId: string): { sceneRestart?: string } {
  const entry = entries.get(itemId);
  if (!entry?.verdict) return {};
  if (entry.verdict === "proposé") return { sceneRestart: `proposé:${entry.outcome ?? "fermé"}` };
  return { sceneRestart: entry.verdict };
}

/** La ligne `stop` est partie : la séance est finie, la prochaine ouverture repart de zéro. */
export function endSceneRestart(itemId: string): void {
  const entry = entries.get(itemId);
  if (entry && !entry.ended) put(itemId, { ...entry, ended: true });
}

/** Pour les tests, et à la sortie d'un compte. */
export function forgetSceneRestart(): void {
  entries.clear();
  for (const listener of listeners) listener();
}
