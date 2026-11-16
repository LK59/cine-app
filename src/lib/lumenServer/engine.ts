// Le moteur de Lumen serveur : ce que l'étape 3 (les routes `/api/lumen/…`) appellera, et rien d'autre.
//
//   const engine = lumenEngine();
//   const index = await engine.index(cheminLocal);        // gardé, partagé, revérifié par `stat`
//   lumenEligibility(index, pisteAudio);                   // ok, ou une raison stable
//   engine.master(index, { audioTrack, labels });          // texte de la liste maître
//   engine.playlist(index, rendition);                     // texte d'une liste média
//   engine.init(index, rendition);                         // octets de l'init
//   await engine.segment(index, rendition, n);             // octets du segment n
//   engine.resolve(index, "a3/12.m4s");                    // un nom servi → ce qu'il désigne
//
// Sans état entre les requêtes au sens du protocole : chaque réponse se reconstruit depuis le fichier
// seul ; l'index gardé et la file ne sont que des accélérations et des garde-fous. L'état du moteur —
// la file, l'exécutant — vit sur `globalThis` pour que toutes les routes (copies séparées du module,
// CLAUDE.md) partagent les mêmes bornes.

import { cachedLumenIndex } from "./indexCache";
import type { LumenIndexStore } from "./indexStore";
import { inlineExecutor, LumenQueue, type LumenExecutor, type QueueOptions } from "./pool";
import { masterPlaylist, mediaPlaylist, type MasterOptions } from "./playlists";
import { segmentSpec, type SegmentResult } from "./segment";
import { LumenError, parseLumenPath, type LumenIndex, type LumenPath, type LumenRendition } from "./format";
import type { ReadCost } from "./jobs";

const STATE = Symbol.for("cine-app.lumenServer.engine");

/** Ce qu'une construction d'index tient en mémoire au pire : l'en-tête et l'index d'un film (Cues de 3 h). */
const INDEX_COST = 16 * 1024 * 1024;
/** Un segment audio : quelques centaines de Ko lus et produits. */
const AUDIO_SEGMENT_COST = 4 * 1024 * 1024;

export interface LumenEngineOptions extends QueueOptions {
  executor?: LumenExecutor;
  /**
   * Le cache des index sur le disque (`indexStore.ts`, étape 3) : lu avant toute construction, écrit
   * après. Sans lui, chaque redémarrage du processus relit l'index de chaque fichier (2 à 25 s à froid).
   */
  store?: LumenIndexStore;
}

/** D'où vient l'index d'une construction, pour le journal et les tests. */
export interface IndexBuildStats {
  /** Construits depuis le média. */
  built: number;
  /** Relus sur le disque (`store`). */
  fromStore: number;
}

export class LumenEngine {
  readonly queue: LumenQueue;
  readonly executor: LumenExecutor;
  readonly store: LumenIndexStore | null;
  readonly builds: IndexBuildStats = { built: 0, fromStore: 0 };

  constructor(options: LumenEngineOptions = {}) {
    this.queue = new LumenQueue(options);
    this.executor = options.executor ?? inlineExecutor();
    this.store = options.store ?? null;
  }

  /**
   * L'index du fichier local `path`, pour sa version actuelle : en mémoire, sinon sur le disque, sinon
   * construit par la file. Lu sur le disque **hors** de la file : quelques millisecondes, qui n'ont pas
   * à attendre derrière trois segments 4K.
   */
  index(path: string, targetUs?: number): Promise<LumenIndex> {
    return cachedLumenIndex(path, async (p, identity) => {
      const kept = await this.store?.get(identity, targetUs).catch(() => null);
      if (kept) {
        this.builds.fromStore += 1;
        return kept;
      }
      const index = await this.queue.run(INDEX_COST, async () => {
        const result = await this.executor.run({ type: "index", path: p, targetUs });
        if (result.type !== "index") throw new Error("Réponse inattendue du fil de calcul.");
        return result.index;
      });
      this.builds.built += 1;
      // Rangé sous l'identité que le fil a lue sur son descripteur : si le fichier a changé entre le
      // `stat` et l'ouverture, c'est l'index de la nouvelle version, rangé sous sa propre clé.
      // Attendu : la séance suivante doit le trouver, et l'écriture coûte quelques millisecondes.
      await this.store?.put(index, targetUs).catch(() => {});
      return index;
    });
  }

  master(index: LumenIndex, options: MasterOptions): string {
    return masterPlaylist(index, options);
  }

  playlist(index: LumenIndex, rendition: LumenRendition): string {
    this.assertServed(index, rendition);
    return mediaPlaylist(index, rendition);
  }

  init(index: LumenIndex, rendition: LumenRendition): Uint8Array {
    const init = rendition.kind === "video" ? index.inits.video : index.inits.audio[rendition.track];
    if (!init) throw new LumenError("piste-inconnue", "Pas d'init pour cette piste.");
    return init;
  }

  /** Les octets du segment `n`, construits par la file. */
  async segment(index: LumenIndex, rendition: LumenRendition, n: number): Promise<SegmentResult & { cost: ReadCost }> {
    const spec = segmentSpec(index, rendition, n);
    // Deux fois le poids : ce qui est lu et ce qui est produit coexistent (2-serveur.md §2.4).
    const cost = rendition.kind === "video" ? Math.max(AUDIO_SEGMENT_COST, 2 * spec.segment.bytes) : AUDIO_SEGMENT_COST;
    const result = await this.queue.run(cost, () => this.executor.run({ type: "segment", spec }));
    if (result.type !== "segment") throw new Error("Réponse inattendue du fil de calcul.");
    return { ...result.result, cost: result.cost };
  }

  /** Ce que désigne un nom servi (`master.m3u8`, `v.m3u8`, `init-a3.mp4`, `a3/12.m4s`), ou null. */
  resolve(index: LumenIndex, name: string): LumenPath | null {
    const path = parseLumenPath(name);
    if (!path || path.kind === "master") return path;
    if (!this.served(index, path.rendition)) return null;
    if (path.kind === "segment" && path.n >= index.segments.length) return null;
    return path;
  }

  private served(index: LumenIndex, rendition: LumenRendition): boolean {
    if (rendition.kind === "video") return !!index.video && index.segments.length > 0;
    return index.audio.some((a) => a.number === rendition.track && !a.refusal && !!index.inits.audio[a.number]);
  }

  private assertServed(index: LumenIndex, rendition: LumenRendition): void {
    if (!this.served(index, rendition)) throw new LumenError("piste-inconnue", "Piste non servie.");
  }

  close(): Promise<void> {
    return this.executor.close();
  }
}

/**
 * Le moteur du processus, créé à la première demande. `options` ne compte qu'à la création — d'où la
 * forme fonction : la route (`service.ts`) passe un exécutant à fils, et le construire à chaque appel
 * lancerait trois `worker_threads` par requête pour les jeter aussitôt.
 */
export function lumenEngine(options?: LumenEngineOptions | (() => LumenEngineOptions)): LumenEngine {
  const g = globalThis as unknown as Record<symbol, LumenEngine | undefined>;
  return (g[STATE] ??= new LumenEngine(typeof options === "function" ? options() : options));
}

/** Oublie le moteur du processus (tests) ; ses fils sont arrêtés. */
export async function resetLumenEngine(): Promise<void> {
  const g = globalThis as unknown as Record<symbol, LumenEngine | undefined>;
  const engine = g[STATE];
  g[STATE] = undefined;
  await engine?.close();
}
