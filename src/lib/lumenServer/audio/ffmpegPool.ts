// Le pool de ffmpeg pré-lancés de la conversion du son (DECISIONS.md §161, le levier de lancement de §163).
//
// La question de Louis (17/11/2026) : combien coûte le **lancement** d'un ffmpeg — créer le processus, initialiser le
// décodeur et l'encodeur, rendre le premier octet —, et un processus déjà lancé, qui attend ses données, le
// retirerait-il du chemin d'un segment demandé ? Un processus pré-lancé ne peut porter que des arguments connus
// d'avance ; ceux d'une conversion ordinaire dépendent de la fenêtre (`atrim`, `adelay`, `apad`, `convert.ts`). Le
// pool sert donc une conversion **en deux processus génériques** : un décodeur par (format d'entrée, décodeur,
// canaux, cible) qui rend le PCM replié (`pan` → f32le), un encodeur par cible qui encode un PCM f32le ; la fenêtre
// est posée par Node entre les deux, à l'échantillon (`windowPcm`). Les deux voies donnent les mêmes trames — le banc
// le vérifie octet par octet (`lumen-audio-bench.spec.ts`, « leviers de lancement ») — et le cache ne sait pas
// laquelle a servi.
//
// Borné : un processus au repos par clé, `MAX_IDLE` en tout ; tué après `IDLE_MS` sans servir, à l'arrêt du processus
// Node (et, au déploiement, avec le conteneur). Chaque processus sert une conversion, puis un autre le remplace.
// Les mêmes protections que `runFfmpeg` : `spawn` sans shell, environnement vide, tubes seulement.

import { startFfmpeg, type FfmpegProcess } from "./ffmpeg";

/** Processus au repos au plus, toutes clés confondues : deux cibles, quelques formats d'entrée. */
export const MAX_IDLE = 8;
/** Un processus pré-lancé qui ne sert pas en une minute est tué : rien ne tourne au repos. */
export const IDLE_MS = 60_000;

interface Idle {
  process: FfmpegProcess;
  at: number;
}

export class FfmpegPool {
  private readonly idle = new Map<string, Idle[]>();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  /** Servis par un processus déjà lancé, ou lancés à la demande faute de mieux. */
  readonly stats = { warm: 0, cold: 0, spawned: 0, expired: 0 };

  constructor(private readonly path: () => string) {}

  /**
   * Un processus pour `args` : un pré-lancé s'il y en a un vivant, sinon lancé maintenant ; et un remplaçant lancé
   * aussitôt pour la conversion suivante.
   */
  take(args: readonly string[]): FfmpegProcess {
    const key = args.join("\u0000");
    const list = this.idle.get(key) ?? [];
    let taken: FfmpegProcess | null = null;
    while (list.length > 0 && !taken) {
      const held = list.shift()!;
      if (!held.process.exited) taken = held.process;
    }
    if (list.length === 0) this.idle.delete(key);
    if (taken) this.stats.warm += 1;
    else {
      this.stats.cold += 1;
      taken = startFfmpeg(this.path(), args);
    }
    setImmediate(() => this.refill(key, args));
    return taken;
  }

  private refill(key: string, args: readonly string[]): void {
    const list = this.idle.get(key) ?? [];
    if (list.length >= 1 || this.size() >= MAX_IDLE) return;
    list.push({ process: startFfmpeg(this.path(), args), at: Date.now() });
    this.stats.spawned += 1;
    this.idle.set(key, list);
    this.sweeper ??= setInterval(() => this.sweep(), IDLE_MS / 2);
    this.sweeper.unref?.();
  }

  size(): number {
    let n = 0;
    for (const list of this.idle.values()) n += list.length;
    return n;
  }

  /** Tue ce qui attend depuis plus d'une minute. */
  sweep(now = Date.now()): void {
    for (const [key, list] of this.idle) {
      const keep = list.filter((i) => {
        if (now - i.at <= IDLE_MS && !i.process.exited) return true;
        i.process.kill();
        this.stats.expired += 1;
        return false;
      });
      if (keep.length) this.idle.set(key, keep);
      else this.idle.delete(key);
    }
    if (this.idle.size === 0 && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }

  /** Tue tout (arrêt, tests). */
  close(): void {
    for (const list of this.idle.values()) for (const i of list) i.process.kill();
    this.idle.clear();
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }
}

const STATE = Symbol.for("cine-app.lumenServer.ffmpegPool");

/** Le pool du processus : tué avec lui. */
export function ffmpegPool(path: () => string): FfmpegPool {
  const g = globalThis as unknown as Record<symbol, FfmpegPool | undefined>;
  if (!g[STATE]) {
    const pool = new FfmpegPool(path);
    g[STATE] = pool;
    process.once("exit", () => pool.close());
  }
  return g[STATE] as FfmpegPool;
}
