// Les segments de Lumen serveur partagés entre requêtes : en vol, et préparés d'avance (étape 3).
//
// Deux cas, un seul mécanisme :
// - **la même adresse demandée deux fois en même temps** — Safari relance une requête qu'il juge lente,
//   un saut redemande le segment en cours : sans partage, deux constructions du même segment 4K
//   occupaient deux places de la file de trois ;
// - **le segment de reprise préparé à l'appui sur Lire** (`POST …/prepare`, appelé par l'étape 4) : il
//   est construit pendant que la page s'ouvre, et gardé deux minutes pour la première requête de
//   Safari. Seuls ceux-là sont gardés ; un segment ordinaire ne l'est pas — Safari ne redemande pas ce
//   qu'il a reçu, et une mémoire de segments 4K tenue « au cas où » coûterait des centaines de Mo dans
//   un conteneur de 2 Gio.
//
// Sur `globalThis` (chaque route a sa copie du module), borné à 64 Mo : deux ou trois reprises 4K
// préparées en même temps. Au-delà, le plus ancien part — il sera reconstruit à la demande.

const STATE = Symbol.for("cine-app.lumenServer.segments");
export const PREPARED_BYTES = 64 * 1024 * 1024;
export const PREPARED_TTL_MS = 2 * 60 * 1000;

export interface BuiltSegment {
  bytes: Uint8Array;
  /** Construction dans le fil de calcul. */
  buildMs: number;
  /** Attente dans la file avant la construction. */
  waitMs: number;
  /** Attente du disque pendant la construction. */
  diskMs: number;
}

interface State {
  held: Map<string, { segment: BuiltSegment; at: number }>;
  inflight: Map<string, Promise<BuiltSegment>>;
  bytes: number;
}

function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  return (g[STATE] ??= { held: new Map(), inflight: new Map(), bytes: 0 });
}

function drop(s: State, key: string): void {
  const held = s.held.get(key);
  if (!held) return;
  s.held.delete(key);
  s.bytes -= held.segment.bytes.length;
}

/**
 * Le segment `key` : gardé, en construction (partagé), ou construit par `build`. `keep` : le garder
 * pour une requête à venir (la préparation). `reused` dit si cette requête l'a payé ou non.
 */
export async function sharedSegment(key: string, build: () => Promise<BuiltSegment>, options: { keep?: boolean; now?: number } = {}): Promise<{ segment: BuiltSegment; reused: boolean }> {
  const s = state();
  const now = options.now ?? Date.now();
  for (const [k, h] of s.held) if (now - h.at > PREPARED_TTL_MS) drop(s, k);
  const held = s.held.get(key);
  if (held) return { segment: held.segment, reused: true };
  const pending = s.inflight.get(key);
  if (pending) {
    const segment = await pending;
    return { segment, reused: true };
  }
  const promise = build();
  s.inflight.set(key, promise);
  try {
    const segment = await promise;
    if (options.keep && segment.bytes.length <= PREPARED_BYTES) {
      drop(s, key);
      s.held.set(key, { segment, at: now });
      s.bytes += segment.bytes.length;
      while (s.bytes > PREPARED_BYTES && s.held.size > 1) drop(s, s.held.keys().next().value!);
    }
    return { segment, reused: false };
  } finally {
    s.inflight.delete(key);
  }
}

/** Ce que tient le partage, pour les tests et le banc. */
export function sharedSegmentStats(): { held: number; bytes: number; inflight: number } {
  const s = state();
  return { held: s.held.size, bytes: s.bytes, inflight: s.inflight.size };
}

/** Pour les tests. */
export function forgetSharedSegments(): void {
  const s = state();
  s.held.clear();
  s.inflight.clear();
  s.bytes = 0;
}
