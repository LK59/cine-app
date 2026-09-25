"use client";

import type { Middleware } from "swr";
import { MOVIES_CATALOGUE_KEY, SERIES_CATALOGUE_KEY } from "@/lib/catalogueKeys";
import { geckoVersion } from "@/lib/webcodecs/bufferBudget";
import { APP_BUILD } from "@/lib/appBuild";

/**
 * Le catalogue de la dernière visite, gardé sur l'appareil pour s'afficher dès l'ouverture.
 *
 * Chaque lancement redemandait tout au serveur, parce que le cache de SWR ne vit qu'en mémoire :
 * icône, écran de chargement, puis les affiches — une à deux secondes pour un téléphone en 5G
 * itinérante en Suisse face à un serveur en Finlande, pour un catalogue de 118 Ko compressés qui
 * n'avait le plus souvent pas changé. Les affiches, elles, sont déjà dans le cache HTTP pour un an.
 *
 * Donc : la dernière réponse de chaque flux listé ici est gardée dans IndexedDB, **par compte**, et
 * relue au démarrage avant que le cinéma ne s'affiche. SWR la tient alors pour une donnée périmée
 * et la redemande aussitôt (`revalidateIfStale`) : rien n'est jamais montré sans être rafraîchi
 * dans la foulée. La réponse fraîche est réécrite pour la fois suivante.
 *
 * Garde-fous, chacun pour une panne précise :
 *  - un cache par compte, effacé à la déconnexion : un iPad partagé ne montre jamais la reprise
 *    d'un autre ;
 *  - sept jours au plus : au-delà, on repart du réseau comme avant ;
 *  - une version de format (`PERSISTED_CACHE_SCHEMA`), liée aux types des réponses par un test
 *    (`persistentCache-schema.test.ts`) : une forme d'hier ne doit jamais faire tomber l'écran
 *    d'aujourd'hui ;
 *  - tout accès à IndexedDB est gardé : en navigation privée, ou stockage bloqué, tout se passe
 *    comme avant, sans cache.
 */

/** À changer avec les types des réponses gardées — le test de format le rappelle. */
export const PERSISTED_CACHE_SCHEMA = 2;

/**
 * Ce qui se garde. Rien d'autre : ce sont les flux de l'écran d'accueil, et eux seuls — plus la
 * configuration publique du lecteur (version 2, 25/09/2026). Sans elle, le bouton « Lire » d'une
 * fiche n'apparaissait qu'un instant après la fiche : `usePlayerEnabled` répond « non » tant que
 * `/api/config/public` n'a pas répondu, et cette réponse-là n'était gardée nulle part.
 */
export const PERSISTED_KEYS: readonly string[] = [
  MOVIES_CATALOGUE_KEY,
  SERIES_CATALOGUE_KEY,
  // Écrites en toutes lettres plutôt qu'importées de `swr.ts`, qui importe ce module : les mêmes
  // chaînes, et un test vérifie qu'elles le restent.
  "/api/jellyfin/resume",
  "/api/cinema/next-up",
  "/api/player/lists",
  "/api/watchlist?status=to_watch",
  "/api/player/discover",
  "/api/config/public",
];

export const MAX_AGE_MS = 7 * 24 * 3600_000;

/** L'attente au démarrage : au-delà, le cinéma s'affiche sans cache, comme avant. */
export const HYDRATION_BUDGET_MS = 150;

/** Les écritures sont regroupées : plusieurs réponses au démarrage, une seule transaction. */
const WRITE_DELAY_MS = 1000;

const DB_NAME = "cine-cache";
const STORE = "entries";

export interface PersistedEntry {
  account: string;
  key: string;
  savedAt: number;
  schema: number;
  data: unknown;
}

export function isPersistedKey(key: unknown): key is string {
  return typeof key === "string" && PERSISTED_KEYS.includes(key);
}

// ---------------------------------------------------------------------------------------------
// IndexedDB, au plus près : ouvrir, tout lire, écrire, effacer. Jamais une exception qui sorte.

function idb(): IDBFactory | null {
  try {
    return typeof indexedDB !== "undefined" ? indexedDB : null;
  } catch {
    return null;
  }
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  const factory = idb();
  if (!factory) return Promise.resolve(null);
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const request = factory.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: ["account", "key"] });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<boolean> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

async function allEntries(): Promise<PersistedEntry[]> {
  const db = await openDb();
  if (!db) return [];
  try {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).getAll();
    const entries = await new Promise<PersistedEntry[]>((resolve) => {
      request.onsuccess = () => resolve((request.result as PersistedEntry[]) ?? []);
      request.onerror = () => resolve([]);
    });
    return entries;
  } catch {
    return [];
  }
}

/**
 * Ce que ce compte a gardé, encore valable. Les enregistrements périmés ou d'une autre version
 * sont effacés au passage ; ceux des autres comptes ne sont ni lus ni touchés.
 */
export async function readAccountCache(account: string, now = Date.now()): Promise<PersistedEntry[]> {
  const entries = await allEntries();
  const valid: PersistedEntry[] = [];
  const stale: PersistedEntry[] = [];
  for (const entry of entries) {
    if (entry.account !== account) continue;
    if (entry.schema !== PERSISTED_CACHE_SCHEMA || now - entry.savedAt > MAX_AGE_MS || !isPersistedKey(entry.key)) stale.push(entry);
    else valid.push(entry);
  }
  if (stale.length > 0) void removeEntries(stale);
  return valid;
}

async function removeEntries(entries: PersistedEntry[]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const entry of entries) store.delete([entry.account, entry.key]);
    await done(tx);
  } catch {
    /* le prochain passage réessaiera */
  }
}

export async function writeEntries(entries: PersistedEntry[]): Promise<boolean> {
  if (entries.length === 0) return true;
  const db = await openDb();
  if (!db) return false;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const entry of entries) store.put(entry);
    return await done(tx);
  } catch {
    // Quota plein, objet que le clonage refuse : on garde l'ancien, rien de plus.
    return false;
  }
}

/**
 * Tout effacer — à la déconnexion. Tous les comptes, et non seulement celui qui part : la page de
 * connexion ne sait pas encore qui viendra, et un appareil qu'on quitte n'a pas à garder la
 * bibliothèque de qui que ce soit.
 */
export async function clearPersistedCache(): Promise<void> {
  pendingWrites.clear();
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await done(tx);
  } catch {
    /* rien à faire de plus */
  }
}

// ---------------------------------------------------------------------------------------------
// L'état de cette page : le compte, ce qui a été relu, ce qui attend sa version fraîche.

let currentAccount: string | null = null;
/** Les objets relus du disque : les revoir passer n'est pas une réponse fraîche. */
const hydratedObjects = new WeakSet<object>();
/** Les clés montrées depuis le cache et pas encore rafraîchies — voir `isAwaitingFresh`. */
const awaitingFresh = new Set<string>();
const pendingWrites = new Map<string, unknown>();
/** La dernière réponse notée par clé — voir `noteResponse`. */
const lastNoted = new Map<string, unknown>();
let writeTimer: ReturnType<typeof setTimeout> | null = null;

let resolveReady: (() => void) | null = null;
const readyPromise = new Promise<void>((resolve) => {
  resolveReady = resolve;
});

/**
 * Relu et pas encore rafraîchi. `PlaybackProvider` redemande ces clés-là à la fermeture d'un
 * film : une requête sautée pendant qu'un film tient l'écran n'est jamais rejouée par SWR, et une
 * clé déjà pourvue — par le cache — n'aurait plus été redemandée du tout (CLAUDE.md, « a paused
 * query is dropped, not deferred »).
 */
export function isAwaitingFresh(key: string): boolean {
  return awaitingFresh.has(key);
}

/**
 * Le compte de cette page, tel que l'hydratation l'a reçu — null avant, ou sans session. Lu par la
 * reprise instantanée (`src/lib/resumeCache/`), qui range ses octets par compte comme ce cache-ci
 * range ses listes : un appareil partagé ne rouvre jamais le film de quelqu'un d'autre.
 */
export function persistedCacheAccount(): string | null {
  return currentAccount;
}

/**
 * Le cinéma attend ceci avant de s'afficher, et jamais plus de `HYDRATION_BUDGET_MS` : au-delà,
 * il s'affiche comme avant, sans cache. Résolu tout de suite pour une page sans compte.
 */
export function catalogueCacheReady(budgetMs = HYDRATION_BUDGET_MS): Promise<void> {
  return Promise.race([readyPromise, new Promise<void>((resolve) => setTimeout(resolve, budgetMs))]);
}

export interface Hydrator {
  /** L'état actuel d'une clé dans SWR — `undefined` quand aucun écran ne l'a encore demandée. */
  has(key: string): boolean;
  /** Pose la donnée sans la redemander : c'est le montage de l'écran qui la redemandera. */
  set(key: string, data: unknown): void;
}

/**
 * Relit le cache du compte et le pose dans SWR. Une clé que SWR connaît déjà — un écran l'a
 * demandée avant la fin de la lecture — n'est pas touchée : y poser une donnée ferait jeter à SWR
 * la réponse de la requête en cours, commencée avant cette « mutation ».
 */
export async function hydrateFromDisk(account: string | null, target: Hydrator, now = Date.now()): Promise<number> {
  currentAccount = account;
  timing.startedAt = nowMs();
  if (!account) {
    resolveReady?.();
    return 0;
  }
  let count = 0;
  try {
    const entries = await readAccountCache(account, now);
    for (const entry of entries) {
      if (target.has(entry.key)) continue;
      if (entry.data && typeof entry.data === "object") hydratedObjects.add(entry.data);
      awaitingFresh.add(entry.key);
      target.set(entry.key, entry.data);
      count += 1;
      if (entry.key === MOVIES_CATALOGUE_KEY) {
        timing.cacheUsed = true;
        timing.cacheAgeMs = now - entry.savedAt;
        timing.cacheMs = nowMs();
      }
    }
  } catch {
    /* sans cache, comme avant */
  }
  resolveReady?.();
  return count;
}

/**
 * Une réponse est passée pour une clé gardée. Relue du disque, ce n'en est pas une ; fraîche, elle
 * est réécrite — regroupée avec les autres de la même seconde.
 */
export function noteResponse(key: string, data: unknown): void {
  if (!isPersistedKey(key) || data === undefined) return;
  if (data && typeof data === "object" && hydratedObjects.has(data)) return;
  // Le même objet revu à chaque rendu de l'écran n'est pas une nouvelle réponse : sans ceci, un
  // écran qui se redessine réécrirait le catalogue toutes les secondes.
  if (lastNoted.get(key) === data) return;
  lastNoted.set(key, data);
  awaitingFresh.delete(key);
  if (key === MOVIES_CATALOGUE_KEY && timing.networkMs === null) {
    timing.networkMs = nowMs();
    reportTiming();
  }
  if (!currentAccount) return;
  pendingWrites.set(key, data);
  if (writeTimer) return;
  writeTimer = setTimeout(flushWrites, WRITE_DELAY_MS);
}

function flushWrites(): void {
  writeTimer = null;
  const account = currentAccount;
  if (!account || pendingWrites.size === 0) return;
  const savedAt = Date.now();
  const entries = [...pendingWrites].map(([key, data]) => ({ account, key, savedAt, schema: PERSISTED_CACHE_SCHEMA, data }));
  pendingWrites.clear();
  void writeEntries(entries);
}

/**
 * Le branchement dans SWR : toute réponse d'une clé gardée passe par `noteResponse`.
 *
 * Deux voies, parce qu'une seule ne suffit pas :
 *  - le récupérateur est enveloppé : c'est la voie normale, et la seule qui voit une réponse
 *    identique à celle du cache — SWR garde alors l'ancien objet, que l'effet ci-dessous ne
 *    distinguerait pas d'une donnée relue, et le cache ne serait jamais daté à nouveau ;
 *  - la donnée affichée est observée : un préchargement (`preload`, le réchauffage des séries) ne
 *    passe pas par le récupérateur du crochet.
 */
export const persistMiddleware: Middleware = (useSWRNext) => (key, fetcher, config) => {
  const persisted = isPersistedKey(key) ? key : null;
  const wrapped =
    persisted && fetcher
      ? (...args: unknown[]) => {
          const result = (fetcher as (...a: unknown[]) => unknown)(...args);
          if (result && typeof (result as Promise<unknown>).then === "function") {
            return (result as Promise<unknown>).then((data) => {
              noteResponse(persisted, data);
              return data;
            });
          }
          noteResponse(persisted, result);
          return result;
        }
      : fetcher;
  const swr = useSWRNext(key, wrapped as typeof fetcher, config);
  // Lu seulement pour une clé gardée : lire `data` abonne l'écran à ses changements, ce que les
  // écrans de ces clés font déjà de toute façon.
  const data = persisted ? swr.data : undefined;
  if (persisted && data !== undefined) queueMicrotask(() => noteResponse(persisted, data));
  return swr;
};

// ---------------------------------------------------------------------------------------------
// Ne pas laisser iOS vider ce cache sous pression.

/**
 * Demandé une fois, et seulement là où c'est silencieux : WebKit et Chromium répondent sans rien
 * demander à personne, Firefox peut afficher une demande d'autorisation — et une invite sortie de
 * nulle part à l'ouverture du cinéma serait pire que le cache perdu. Jamais redemandé quand c'est
 * déjà accordé.
 */
export async function requestPersistence(
  userAgent: string,
  storage: { persisted?: () => Promise<boolean>; persist?: () => Promise<boolean> } | undefined
): Promise<"accordé" | "déjà" | "refusé" | "ignoré"> {
  try {
    if (!storage?.persist || !storage.persisted) return "ignoré";
    if (geckoVersion(userAgent) !== null) return "ignoré";
    if (await storage.persisted()) return "déjà";
    return (await storage.persist()) ? "accordé" : "refusé";
  } catch {
    return "ignoré";
  }
}

// ---------------------------------------------------------------------------------------------
// Le journal des vitesses : ce que le cache a fait gagner, mesuré plutôt que supposé.

const timing: {
  startedAt: number | null;
  cacheUsed: boolean;
  cacheAgeMs: number | null;
  cacheMs: number | null;
  networkMs: number | null;
  sent: boolean;
} = { startedAt: null, cacheUsed: false, cacheAgeMs: null, cacheMs: null, networkMs: null, sent: false };

/** Depuis le début de la navigation : c'est ce que la personne a attendu, chargement compris. */
function nowMs(): number {
  try {
    return Math.round(performance.now());
  } catch {
    return 0;
  }
}

function reportTiming(): void {
  if (timing.sent || !currentAccount) return;
  timing.sent = true;
  const body = JSON.stringify({
    build: APP_BUILD,
    cacheUsed: timing.cacheUsed,
    cacheAgeMs: timing.cacheAgeMs,
    cacheMs: timing.cacheMs,
    networkMs: timing.networkMs,
    standalone: typeof window !== "undefined" && window.matchMedia?.("(display-mode: standalone)").matches === true,
  });
  try {
    void fetch("/api/startup-timing", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
  } catch {
    /* un journal ne vaut pas une erreur */
  }
}

/** Pour les tests : repartir d'une page neuve. */
export function resetPersistentCacheForTests(): void {
  currentAccount = null;
  awaitingFresh.clear();
  lastNoted.clear();
  pendingWrites.clear();
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = null;
  dbPromise = null;
  Object.assign(timing, { startedAt: null, cacheUsed: false, cacheAgeMs: null, cacheMs: null, networkMs: null, sent: false });
}

/** Pour les tests : écrire tout de suite ce qui attend. */
export function flushPersistentWritesForTests(): void {
  if (writeTimer) clearTimeout(writeTimer);
  flushWrites();
}
