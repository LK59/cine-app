// Le cache des index de Lumen serveur : une construction par version de fichier, partagée.
//
// Une séance commence par une rafale — liste maître, listes média, init, trois segments, vidéo et son
// en parallèle — qui toutes ont besoin de l'index : sans partage, l'index serait lu six fois. Les
// demandes en vol sont donc partagées (le motif d'`assertVisible`), et le résultat gardé.
//
// - **Sur `globalThis`** (`Symbol.for("cine-app.lumenServer.index")`), comme `server-cache.ts` : les
//   routes et `instrumentation.ts` sont des points d'entrée séparés, chacun avec sa copie du module, et
//   chaque route de Lumen (liste, init, segment) doit lire la même instance (CLAUDE.md, « The cache's
//   state lives on globalThis »).
// - **Borné en octets**, pas en entrées : l'index d'un film 4K de trois heures pèse cent fois celui
//   d'un épisode. Le plus ancien utilisé part d'abord ; un index oublié deux heures part aussi.
// - **Clé : chemin + taille + mtime + inode**, vérifiée par un `stat` à chaque demande (quelques
//   microsecondes) : un fichier remplacé est relu sans attendre l'expiration, et un segment demandé
//   pour l'ancienne version ne reçoit jamais les octets de la nouvelle (`segmentSpec` porte la clé, et
//   le fil de calcul la revérifie sur le descripteur qu'il ouvre).
//
// - **Une entrée par fichier et par découpe** (`variant`, §157) : l'index d'une découpe expérimentale
//   (`cra`) vit à côté de celui de la règle, jamais à sa place — une page de test qui lit `cra` ne doit ni
//   chasser ni, surtout, remplacer l'index que sert une vraie lecture.
//
// Sans état au sens du protocole : n'importe quel segment se reconstruit depuis le fichier seul. Le
// cache n'est qu'une accélération — après un déploiement, la première requête relit l'index.

import { stat } from "node:fs/promises";
import { identityKey, type FileIdentity, type LumenIndex } from "./format";

const STATE = Symbol.for("cine-app.lumenServer.index");

/** 32 Mo : l'index d'un épisode pèse quelques dizaines de Ko, celui d'un film 4K quelques centaines. */
export const INDEX_CACHE_BYTES = 32 * 1024 * 1024;
/** Un index que personne n'a demandé depuis deux heures n'est plus gardé. */
export const INDEX_IDLE_MS = 2 * 60 * 60 * 1000;

interface Entry {
  key: string;
  index: LumenIndex;
  bytes: number;
  usedAt: number;
}

interface CacheState {
  /** Par chemin (et découpe) : une seule version gardée par fichier. */
  entries: Map<string, Entry>;
  inflight: Map<string, Promise<LumenIndex>>;
  bytes: number;
  builds: number;
  hits: number;
}

function state(): CacheState {
  const g = globalThis as unknown as Record<symbol, CacheState | undefined>;
  return (g[STATE] ??= { entries: new Map(), inflight: new Map(), bytes: 0, builds: 0, hits: 0 });
}

/** Le poids estimé d'un index en mémoire : ses tableaux d'octets, et un forfait par segment et par piste. */
export function indexBytes(index: LumenIndex): number {
  let bytes = 2048 + index.segments.length * 96 + index.audio.length * 512;
  if (index.video) bytes += index.video.codecPrivate.length + (index.video.dolbyVision?.record.length ?? 0);
  if (index.inits.video) bytes += index.inits.video.length;
  for (const init of Object.values(index.inits.audio)) bytes += init.length;
  for (const a of index.audio) bytes += (a.codecPrivate?.length ?? 0) + (a.firstFrame?.length ?? 0);
  return bytes;
}

export interface IndexCacheOptions {
  budgetBytes?: number;
  idleMs?: number;
  now?: () => number;
  /** L'identité du fichier — `stat` par défaut ; remplaçable dans les tests. */
  identify?: (path: string) => Promise<FileIdentity>;
  /**
   * Ce qui distingue deux index du même fichier (la découpe, `lumenFormatTag`). Vide : l'entrée est
   * celle d'avant — le chemin seul.
   */
  variant?: string;
}

async function statIdentity(path: string): Promise<FileIdentity> {
  const st = await stat(path);
  return { path, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino };
}

/**
 * L'index de `path` pour sa version actuelle : gardé, en cours de construction (partagé), ou construit
 * par `build`. Une construction qui échoue n'est pas gardée : la suivante réessaie.
 */
export async function cachedLumenIndex(path: string, build: (path: string, identity: FileIdentity) => Promise<LumenIndex>, options: IndexCacheOptions = {}): Promise<LumenIndex> {
  const s = state();
  const now = options.now ?? Date.now;
  const identity = await (options.identify ?? statIdentity)(path);
  const fileKey = identityKey(identity);
  const variant = options.variant ?? "";
  // L'entrée et la construction en vol, par découpe ; la clé d'identité, elle, reste celle du fichier.
  const slot = variant ? `${path}\u0000${variant}` : path;
  const key = variant ? `${fileKey}\u0000${variant}` : fileKey;
  sweep(s, now(), options.idleMs ?? INDEX_IDLE_MS);

  const held = s.entries.get(slot);
  if (held && held.key === key) {
    held.usedAt = now();
    // Remis en tête de l'ordre d'éviction.
    s.entries.delete(slot);
    s.entries.set(slot, held);
    s.hits += 1;
    return held.index;
  }
  if (held) forget(s, slot); // une autre version : celle-ci ne servira plus

  const pending = s.inflight.get(key);
  if (pending) return pending;
  const promise = (async () => {
    try {
      const index = await build(path, identity);
      // Construit sur un descripteur ouvert après le `stat` : si le fichier a changé entre les deux,
      // l'index dit l'autre version — on ne le range pas sous cette clé.
      if (identityKey(index.identity) !== fileKey) return index;
      s.builds += 1;
      const bytes = indexBytes(index);
      forget(s, slot);
      s.entries.set(slot, { key, index, bytes, usedAt: now() });
      s.bytes += bytes;
      const budget = options.budgetBytes ?? INDEX_CACHE_BYTES;
      while (s.bytes > budget && s.entries.size > 1) forget(s, s.entries.keys().next().value!);
      return index;
    } finally {
      s.inflight.delete(key);
    }
  })();
  s.inflight.set(key, promise);
  return promise;
}

function forget(s: CacheState, path: string): void {
  const entry = s.entries.get(path);
  if (!entry) return;
  s.entries.delete(path);
  s.bytes -= entry.bytes;
}

function sweep(s: CacheState, at: number, idleMs: number): void {
  for (const [path, entry] of s.entries) if (at - entry.usedAt > idleMs) forget(s, path);
}

/** Ce que le cache tient, pour le journal et les tests. */
export function lumenIndexCacheStats(): { entries: number; bytes: number; inflight: number; builds: number; hits: number } {
  const s = state();
  return { entries: s.entries.size, bytes: s.bytes, inflight: s.inflight.size, builds: s.builds, hits: s.hits };
}

/** Vide le cache (tests). */
export function clearLumenIndexCache(): void {
  const s = state();
  s.entries.clear();
  s.inflight.clear();
  s.bytes = 0;
  s.builds = 0;
  s.hits = 0;
}
