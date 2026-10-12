"use client";

// Le simulateur de connexion (page « Tests animations » de l'administrateur, DECISIONS.md §78).
//
// Il bride, côté navigateur, ce que le lecteur reçoit : un débit réglé à la main, une coupure totale, une
// coupure de quelques secondes — pour voir en vrai, sur le vrai lecteur et un vrai film, l'indice, le
// préchauffage, la bascule et les messages d'une connexion lente. Le bridage tient en deux points de la
// réception : `HttpByteSource` (lecteur natif) et le chargeur d'hls.js (lecteur serveur).
//
// HORS SIMULATEUR, RIEN NE CHANGE : il n'est actif que si la page de test l'a armé dans CET onglet
// (`sessionStorage`, effacé avec l'onglet) ET si la page l'a ouvert dans ce même chargement (`armed`).
// Tant qu'il ne l'est pas, `simulatorActive()` rend faux et aucun délai, aucune branche du bridage n'est
// prise — un test le vérifie. Rien ici ne lève hors de la coupure simulée elle-même.

const FLAG = "cine:link-simulator";

interface SimState {
  /** Le débit simulé, en bits par seconde. */
  bps: number;
  /** Coupure totale en cours. */
  cut: boolean;
  /** Fin d'une coupure brève (`Date.now()`), ou 0. */
  cutUntil: number;
}

let armed = false;
let state: SimState = { bps: 50_000_000, cut: false, cutUntil: 0 };
/** Ce qui a réellement été livré, pour le tableau de la page (octets, instants). */
const delivered: [number, number][] = [];
const listeners = new Set<() => void>();

/** Le simulateur est-il actif dans cet onglet ? Faux partout ailleurs que sur la page de test. */
export function simulatorActive(): boolean {
  if (!armed) return false;
  try {
    return sessionStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
}

/** Armé par la page de test (administrateur), pour cet onglet seulement. */
export function armLinkSimulator(): void {
  armed = true;
  try {
    sessionStorage.setItem(FLAG, "1");
  } catch {
    /* sans stockage, le simulateur ne s'arme pas */
  }
  emit();
}

/** Désarmé : la réception redevient exactement celle d'avant. */
export function disarmLinkSimulator(): void {
  armed = false;
  try {
    sessionStorage.removeItem(FLAG);
  } catch {
    /* rien */
  }
  emit();
}

export function setSimulatedLink(next: { mbps?: number; cut?: boolean; cutForMs?: number }): void {
  state = {
    bps: typeof next.mbps === "number" && next.mbps > 0 ? next.mbps * 1e6 : state.bps,
    cut: typeof next.cut === "boolean" ? next.cut : state.cut,
    cutUntil: typeof next.cutForMs === "number" ? Date.now() + next.cutForMs : state.cutUntil,
  };
  emit();
}

export function simulatedLink(): SimState & { active: boolean } {
  return { ...state, active: simulatorActive() };
}

/** Les Mbit/s réellement livrés sur les `ms` dernières millisecondes (horloge murale). */
export function deliveredMbps(ms = 5000): number {
  const from = Date.now() - ms;
  let bytes = 0;
  for (const [at, b] of delivered) if (at > from) bytes += b;
  return Math.round(((bytes * 8) / (ms / 1000) / 1e6) * 100) / 100;
}

export function subscribeLinkSimulator(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* rien */
    }
  }
}

function cutNow(): boolean {
  return state.cut || Date.now() < state.cutUntil;
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Avant une requête : une coupure la fait échouer comme un réseau tombé. */
export function simulateRequestGate(): void {
  if (cutNow()) throw new TypeError("coupure simulée");
}

/**
 * Après réception d'un corps de `bytes` octets dont les en-têtes sont arrivés à `headersAt`
 * (`performance.now()`) : attendre ce qu'il aurait fallu à ce débit. Une coupure survenue pendant le
 * transfert le fait échouer.
 */
export async function simulateTransfer(bytes: number, headersAt: number, signal?: AbortSignal | null): Promise<void> {
  const due = (bytes * 8 * 1000) / state.bps;
  const spent = performance.now() - headersAt;
  await sleep(due - spent, signal);
  if (cutNow()) throw new TypeError("coupure simulée");
  delivered.push([Date.now(), bytes]);
  if (delivered.length > 2000) delivered.splice(0, 1000);
  emit();
}

/** Ce que l'hôte du lecteur serveur reçoit du chargeur bridé : en-têtes, octets, fin — pour son compteur. */
export interface SimMeter {
  headers(): void;
  received(bytes: number): void;
  end(): void;
}

/**
 * Un chargeur hls.js bridé, autour du chargeur par défaut (`Base`). `meter` ouvre une requête suivie
 * (le compteur du lecteur serveur) : sans bridage, c'est `xhrSetup` qui compte ; avec, c'est ici, au
 * rythme simulé — la mesure voit le débit simulé, pas celui du réseau local.
 */
export function throttledHlsLoader<T extends new (config: never) => unknown>(Base: T, meter: () => SimMeter | null): T {
  // Les types d'hls.js ne sont pas importés ici : le chargeur reste une boîte noire dont seuls `load`
  // et les rappels `onSuccess` / `onError` sont interceptés.
  type Callbacks = { onSuccess: (response: { data: unknown }, stats: unknown, context: unknown, details?: unknown) => void; onError: (error: { code: number; text: string }, context: unknown, details?: unknown, stats?: unknown) => void };
  const Throttled = class extends (Base as unknown as new (config: unknown) => { load(context: unknown, config: unknown, callbacks: Callbacks): void }) {
    load(context: unknown, config: unknown, callbacks: Callbacks): void {
      try {
        simulateRequestGate();
      } catch {
        setTimeout(() => callbacks.onError({ code: 0, text: "coupure simulée" }, context, undefined, undefined), 0);
        return;
      }
      const request = meter();
      const startedAt = performance.now();
      request?.headers();
      super.load(context, config, {
        ...callbacks,
        onSuccess: (response, stats, ctx, details) => {
          const data = response?.data;
          const bytes = typeof data === "string" ? data.length : data instanceof ArrayBuffer ? data.byteLength : 0;
          simulateTransfer(bytes, startedAt).then(
            () => {
              request?.received(bytes);
              request?.end();
              callbacks.onSuccess(response, stats, ctx, details);
            },
            () => {
              request?.end();
              callbacks.onError({ code: 0, text: "coupure simulée" }, ctx, details, stats);
            }
          );
        },
      });
    }
  };
  return Throttled as unknown as T;
}

/** Pour les tests. */
export function resetLinkSimulator(): void {
  armed = false;
  state = { bps: 50_000_000, cut: false, cutUntil: 0 };
  delivered.length = 0;
  try {
    sessionStorage.removeItem(FLAG);
  } catch {
    /* rien */
  }
}
