// Le cache des segments son convertis, en deux étages (décision de Louis du 16/11/2026, DECISIONS.md §162).
//
// **En mémoire** (`MemoryTier`, sur `globalThis`, `LUMEN_AUDIO_RAM_MB`, 512 Mo par défaut) : la fenêtre des séances
// actives — les quelques minutes que la tête de lecture vient de quitter (un retour en arrière de dix secondes ne
// relance pas ffmpeg) et l'avance convertie devant elle. Le moins récemment lu part le premier : derrière la tête,
// Safari ne redemande rien, et l'avance vient d'être écrite. 512 Mo, c'est quatre heures de 5.1 à 640 kb/s.
//
// **Sur le disque** (`DiskTier`, `DATA_DIR/lumen-audio` sur le NVMe, `LUMEN_AUDIO_CACHE_DIR` pour un autre volume,
// `LUMEN_AUDIO_CACHE_GB`, 10 Go par défaut ≈ 35 h de films en 5.1) : ce qui a déjà été converti survit au
// redémarrage du conteneur — plusieurs par jour — et à l'éviction de la mémoire. Le moins récemment lu part le
// premier ; la date de lecture est tenue en mémoire, relue au démarrage d'après les `mtime` (touchés à la lecture
// au plus une fois par heure : pas une écriture de métadonnées par segment). Le balayage passe toutes les dix
// minutes et efface par lots sous un budget de temps — la règle de `db.ts` pour la boucle d'événements.
// Le disque n'est pas lent pour autant : **le cache de pages de Linux garde chaud ce qu'on vient d'écrire ou de
// lire**, en RAM, hors du compte de l'application et rendu au système dès qu'il en a besoin ; un segment relu
// quelques minutes après sa conversion ne touche pas le NVMe.
//
// **La clé** porte tout ce qui fixe les octets : la version de l'adresse (format, découpe, empreinte du fichier
// — chemin, taille, mtime, inode), la piste, la cible et ses réglages (`targetTag` : débit, disposition,
// pré-roulements), l'identité de la conversion (`cid` : `LUMEN_AUDIO_VERSION`, version de ffmpeg, empreinte du
// binaire) et le numéro du segment. Changer l'un d'eux change la clé : jamais les octets d'une autre version.
//
// **Écriture atomique** (temporaire puis renommage) et **enveloppe vérifiée** : 4 octets « LAC1 », la longueur, le
// SHA-256 du contenu, puis le contenu. Un fichier tronqué (conteneur tué en pleine écriture), corrompu ou d'une
// autre enveloppe se lit comme une absence, il est effacé et le segment se reconvertit. Rien n'est écrit hors de
// ce dossier ; il est hors de la sauvegarde quotidienne (un cache se régénère).

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Ce qui nomme un segment converti. */
export interface ConvertKey {
  /** `lumenVersionOf(index)` : format, découpe, empreinte du fichier. */
  version: string;
  track: number;
  /** `targetTag(target)`. */
  target: string;
  /** L'identité de la conversion (`conversionId`). */
  cid: string;
  n: number;
}

/** Les caractères admis dans un morceau de chemin : ceux que nos clés produisent, rien d'autre. */
const SAFE = /^[A-Za-z0-9._-]{1,80}$/;

export function keyString(k: ConvertKey): string {
  return `${k.version}/${k.track}-${k.target}-${k.cid}/${k.n}`;
}

/** Le chemin relatif d'un segment dans le cache disque, ou null si la clé contient autre chose que prévu. */
export function relativePathOf(k: ConvertKey): string | null {
  const dir = `${k.track}-${k.target}-${k.cid}`;
  if (!SAFE.test(k.version) || !SAFE.test(dir) || !Number.isInteger(k.n) || k.n < 0) return null;
  return join(k.version, dir, `${k.n}.seg`);
}

// ── En mémoire ───────────────────────────────────────────────────────────────

export class MemoryTier {
  private readonly entries = new Map<string, Uint8Array>();
  bytes = 0;
  hits = 0;
  misses = 0;

  constructor(private readonly capBytes: () => number) {}

  get(key: string): Uint8Array | null {
    const held = this.entries.get(key);
    if (!held) {
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    // Réinséré : une `Map` garde l'ordre d'insertion, le plus ancien est donc le moins récemment lu.
    this.entries.delete(key);
    this.entries.set(key, held);
    return held;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  put(key: string, bytes: Uint8Array): void {
    const cap = this.capBytes();
    if (bytes.length > cap) return;
    const held = this.entries.get(key);
    if (held) {
      this.entries.delete(key);
      this.bytes -= held.length;
    }
    this.entries.set(key, bytes);
    this.bytes += bytes.length;
    while (this.bytes > cap && this.entries.size > 0) {
      const [oldest, value] = this.entries.entries().next().value as [string, Uint8Array];
      this.entries.delete(oldest);
      this.bytes -= value.length;
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}

// ── Sur le disque ────────────────────────────────────────────────────────────

const MAGIC = [0x4c, 0x41, 0x43, 0x31]; // « LAC1 »
const HEADER = 4 + 4 + 32;
const TOUCH_EVERY_MS = 60 * 60 * 1000;
/** Une passe d'éviction n'occupe pas plus que ça d'affilée ; elle reprend au tour suivant de la boucle. */
const SWEEP_BUDGET_MS = 25;
export const SWEEP_EVERY_MS = 10 * 60 * 1000;

/** L'enveloppe d'un segment sur le disque. */
export function envelope(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER + bytes.length);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(4, bytes.length, false);
  out.set(createHash("sha256").update(bytes).digest(), 8);
  out.set(bytes, HEADER);
  return out;
}

/** Le contenu d'une enveloppe, ou null si elle est tronquée, corrompue ou d'un autre format. */
export function openEnvelope(raw: Uint8Array): Uint8Array | null {
  if (raw.length < HEADER || MAGIC.some((b, i) => raw[i] !== b)) return null;
  const length = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(4, false);
  if (raw.length !== HEADER + length) return null;
  const body = raw.subarray(HEADER);
  const digest = createHash("sha256").update(body).digest();
  for (let i = 0; i < 32; i++) if (digest[i] !== raw[8 + i]) return null;
  return body;
}

interface DiskEntry {
  size: number;
  /** Dernière lecture ou écriture connue (ms). */
  at: number;
  /** Dernier `utimes` écrit sur le disque. */
  touched: number;
}

export interface DiskStats {
  files: number;
  bytes: number;
  scanned: boolean;
  hits: number;
  misses: number;
  corrupt: number;
  evicted: number;
  writeErrors: number;
}

export class DiskTier {
  private readonly entries = new Map<string, DiskEntry>();
  private scanning: Promise<void> | null = null;
  private sweeping: Promise<void> | null = null;
  private lastSweep = 0;
  readonly stats: DiskStats = { files: 0, bytes: 0, scanned: false, hits: 0, misses: 0, corrupt: 0, evicted: 0, writeErrors: 0 };

  constructor(
    readonly dir: string,
    private readonly capBytes: () => number,
    private readonly now: () => number = Date.now
  ) {}

  /** Relit le dossier une fois (au premier usage) : tailles et dates, pour l'éviction. */
  scan(): Promise<void> {
    this.scanning ??= (async () => {
      const versions = await readdir(this.dir).catch(() => [] as string[]);
      for (const version of versions) {
        const vdir = join(this.dir, version);
        const tracks = await readdir(vdir).catch(() => [] as string[]);
        for (const track of tracks) {
          const tdir = join(vdir, track);
          const names = await readdir(tdir).catch(() => [] as string[]);
          for (const name of names) {
            const path = join(tdir, name);
            const st = await stat(path).catch(() => null);
            if (!st) continue;
            if (name.endsWith(".tmp")) {
              // Le temporaire d'une écriture que le conteneur n'a pas finie.
              await unlink(path).catch(() => {});
              continue;
            }
            if (!name.endsWith(".seg")) continue;
            const rel = join(version, track, name);
            if (!this.entries.has(rel)) {
              this.entries.set(rel, { size: st.size, at: st.mtimeMs, touched: st.mtimeMs });
              this.stats.bytes += st.size;
            }
          }
        }
      }
      this.stats.files = this.entries.size;
      this.stats.scanned = true;
    })();
    return this.scanning;
  }

  has(rel: string): boolean {
    return this.entries.has(rel);
  }

  async get(rel: string): Promise<Uint8Array | null> {
    const path = join(this.dir, rel);
    let raw: Buffer;
    try {
      raw = await readFile(path);
    } catch {
      this.stats.misses += 1;
      this.forget(rel);
      return null;
    }
    const body = openEnvelope(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
    if (!body) {
      this.stats.corrupt += 1;
      this.forget(rel);
      await unlink(path).catch(() => {});
      return null;
    }
    this.stats.hits += 1;
    const now = this.now();
    const entry = this.entries.get(rel);
    if (entry) {
      entry.at = now;
      if (now - entry.touched > TOUCH_EVERY_MS) {
        entry.touched = now;
        const date = new Date(now);
        await utimes(path, date, date).catch(() => {});
      }
    } else {
      this.entries.set(rel, { size: raw.length, at: now, touched: now });
      this.stats.bytes += raw.length;
      this.stats.files = this.entries.size;
    }
    return new Uint8Array(body);
  }

  async put(rel: string, bytes: Uint8Array): Promise<void> {
    if (this.capBytes() <= 0) return;
    const path = join(this.dir, rel);
    const data = envelope(bytes);
    try {
      await mkdir(join(path, ".."), { recursive: true });
      const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, path).catch(async (error) => {
        await unlink(tmp).catch(() => {});
        throw error;
      });
    } catch {
      // Disque plein, dossier en lecture seule : le segment reste en mémoire, rien de plus.
      this.stats.writeErrors += 1;
      return;
    }
    const now = this.now();
    this.forget(rel);
    this.entries.set(rel, { size: data.length, at: now, touched: now });
    this.stats.bytes += data.length;
    this.stats.files = this.entries.size;
    if (this.stats.bytes > this.capBytes() || now - this.lastSweep > SWEEP_EVERY_MS) void this.sweep();
  }

  private forget(rel: string): void {
    const held = this.entries.get(rel);
    if (!held) return;
    this.entries.delete(rel);
    this.stats.bytes -= held.size;
    this.stats.files = this.entries.size;
  }

  /** Évince le moins récemment lu jusqu'à repasser sous le plafond, par lots sous un budget de temps. */
  sweep(): Promise<void> {
    this.sweeping ??= (async () => {
      try {
        await this.scan();
        this.lastSweep = this.now();
        const cap = this.capBytes();
        if (this.stats.bytes <= cap) return;
        const order = [...this.entries.entries()].sort((x, y) => x[1].at - y[1].at);
        let budgetFrom = performance.now();
        for (const [rel] of order) {
          if (this.stats.bytes <= cap) break;
          this.forget(rel);
          await unlink(join(this.dir, rel)).catch(() => {});
          this.stats.evicted += 1;
          if (performance.now() - budgetFrom > SWEEP_BUDGET_MS) {
            await new Promise((resolve) => setImmediate(resolve));
            budgetFrom = performance.now();
          }
        }
      } finally {
        this.sweeping = null;
      }
    })();
    return this.sweeping;
  }

  /** Vide le cache disque (tests, bouton éventuel). */
  async clear(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true }).catch(() => {});
    this.entries.clear();
    this.stats.bytes = 0;
    this.stats.files = 0;
  }
}
