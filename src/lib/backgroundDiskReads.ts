/**
 * Une seule tâche de fond lit les disques de la bibliothèque à la fois (DECISIONS.md §93).
 *
 * Deux tâches les relisent : l'indexation des répliques (§88) et la vérification de l'intégrité des
 * fichiers (§93). Chacune est déjà polie seule — une lecture à la fois, un débit plafonné, en pause
 * pendant qu'on regarde un film —, mais les deux ensemble feraient aller et venir la tête de lecture
 * entre deux fichiers, et doubleraient la charge que chacune s'interdit. Ce verrou les fait alterner :
 * un propriétaire à la fois (`repliques` ou `integrite`), qui peut le tenir plusieurs fois (les files
 * de l'indexation sur des disques prouvés distincts), et qui le cède dès qu'il le relâche — l'autre,
 * s'il attend, passe avant une nouvelle prise du premier (pas de famine).
 *
 * Sur `globalThis` : Next charge les modules deux fois (le démarrage, les routes), et deux copies du
 * verrou n'en seraient pas un — même raison que l'état des moteurs (§88).
 */

export type DiskReader = "repliques" | "integrite";

interface Waiter {
  owner: DiskReader;
  grant: () => void;
}

type LockState = { owner: DiskReader | null; count: number; waiters: Waiter[] };
const KEY = Symbol.for("cine.backgroundDiskReads");
const shared = globalThis as typeof globalThis & { [KEY]?: LockState };
const state: LockState = (shared[KEY] ??= { owner: null, count: 0, waiters: [] });

/** Une prise du verrou : à relâcher une fois, quoi qu'il arrive. */
export interface DiskLease {
  release(): void;
  /** Quelqu'un d'autre attend : à l'appelant de relâcher puis reprendre, s'il peut s'interrompre. */
  readonly contended: boolean;
}

function grantNext(): void {
  if (state.count > 0 || state.waiters.length === 0) return;
  const owner = state.waiters[0].owner;
  // Tous ceux du même propriétaire qui attendent passent ensemble ; les autres gardent leur rang.
  const granted = state.waiters.filter((w) => w.owner === owner);
  state.waiters = state.waiters.filter((w) => w.owner !== owner);
  state.owner = owner;
  state.count = granted.length;
  for (const w of granted) w.grant();
}

/** Prend le verrou pour `owner` — tout de suite s'il est libre (ou déjà à lui, personne d'autre n'attendant). */
export function acquireDiskReads(owner: DiskReader): Promise<DiskLease> {
  const lease = (): DiskLease => {
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        state.count = Math.max(0, state.count - 1);
        if (state.count === 0) state.owner = null;
        grantNext();
      },
      get contended() {
        return state.waiters.some((w) => w.owner !== owner);
      },
    };
  };
  const othersWaiting = state.waiters.some((w) => w.owner !== owner);
  if (state.owner === null || (state.owner === owner && !othersWaiting)) {
    state.owner = owner;
    state.count += 1;
    return Promise.resolve(lease());
  }
  return new Promise<DiskLease>((resolve) => state.waiters.push({ owner, grant: () => resolve(lease()) }));
}

/** Le temps d'une opération, verrou pris puis relâché quoi qu'il arrive. */
export async function withDiskReads<T>(owner: DiskReader, run: () => Promise<T>): Promise<T> {
  const lease = await acquireDiskReads(owner);
  try {
    return await run();
  } finally {
    lease.release();
  }
}

/** Qui lit en ce moment (pour la page), et qui attend. */
export function diskReadsState(): { owner: DiskReader | null; waiting: DiskReader[] } {
  return { owner: state.owner, waiting: state.waiters.map((w) => w.owner) };
}

export const __testing = {
  reset(): void {
    state.owner = null;
    state.count = 0;
    state.waiters = [];
  },
};
