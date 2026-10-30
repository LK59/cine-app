import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir";
import { logError } from "@/lib/logger";
import { EpubDefectError, metaOf, readEpubCover, readEpubMeta, recordMeta } from "@/lib/books/epubMeta";

/**
 * La couverture tirée de l'EPUB, pour les livres dont Jellyfin n'a pas d'image (DECISIONS.md §127).
 *
 * Faite **à la demande** — quand une carte entre dans le champ et demande son image, jamais en masse ni
 * au lancement : l'image déclarée par l'OPF (`meta name="cover"` ou `properties="cover-image"`), lue par
 * plages à travers Jellyfin, réduite par `sharp` (360 px de large, WebP — hors de la boucle, dans les
 * fils de libuv) et gardée sur le disque sous `DATA_DIR/book-covers`, nommée par le livre et l'empreinte
 * de son fichier. Un EPUB sans couverture déclarée le reste aussi (`.none`) : on ne le relit pas. Le
 * dossier est borné (nombre et octets), les plus anciennes d'abord. Deux fabrications à la fois au plus ;
 * deux demandes de la même attendent la même.
 *
 * Sans couverture du tout, l'écran dessine la sienne (titre et auteur sur une couleur tirée du titre) :
 * la route répond 404, gardé une heure par le navigateur.
 */

const DIR = path.join(DATA_DIR, "book-covers");
const WIDTH = 360;
const MAX_FILES = 20_000;
const MAX_BYTES = 400 * 1024 * 1024;
const CONCURRENCY = 2;
/** Un échec passager (Jellyfin absent) : pas de marque sur le disque, seulement un répit en mémoire. */
const RETRY_MS = 10 * 60_000;
const PRUNE_EVERY = 50;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

interface State {
  inflight: Map<string, Promise<Buffer | null>>;
  failedAt: Map<string, number>;
  running: number;
  waiters: (() => void)[];
  writes: number;
}
const KEY = Symbol.for("laterna.books.covers");
function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  return (g[KEY] ??= { inflight: new Map(), failedAt: new Map(), running: 0, waiters: [], writes: 0 });
}

const stem = (id: string, fileTag: string) => `${id}-${createHash("sha256").update(fileTag).digest("hex").slice(0, 12)}`;

async function slot<T>(work: () => Promise<T>): Promise<T> {
  const s = state();
  if (s.running >= CONCURRENCY) await new Promise<void>((resolve) => s.waiters.push(resolve));
  s.running += 1;
  try {
    return await work();
  } finally {
    s.running -= 1;
    s.waiters.shift()?.();
  }
}

/** La couverture réduite de ce livre, ou `null` s'il n'en déclare pas (ou qu'elle est illisible). */
export async function epubCover(id: string, fileTag: string): Promise<Buffer | null> {
  const s = state();
  const name = stem(id, fileTag);
  const file = path.join(DIR, `${name}.webp`);
  try {
    return await fs.promises.readFile(file);
  } catch {
    /* pas encore faite */
  }
  if (fs.existsSync(path.join(DIR, `${name}.none`))) return null;
  const failed = s.failedAt.get(name);
  if (failed && Date.now() - failed < RETRY_MS) return null;
  const running = s.inflight.get(name);
  if (running) return running;
  const job = slot(() => make(id, fileTag, name)).finally(() => s.inflight.delete(name));
  s.inflight.set(name, job);
  return job;
}

async function make(id: string, fileTag: string, name: string): Promise<Buffer | null> {
  const s = state();
  let coverPath: string | null;
  try {
    const known = metaOf(id);
    // Un fichier déjà reconnu illisible : rien à relire, la grille l'a d'ailleurs masqué.
    if (known && known.etag === fileTag && known.defect) return null;
    if (known && known.etag === fileTag && known.meta) coverPath = known.meta.coverPath;
    else {
      const meta = await readEpubMeta(id);
      recordMeta(id, fileTag, meta);
      coverPath = meta.coverPath;
    }
  } catch (error) {
    s.failedAt.set(name, Date.now());
    if (error instanceof EpubDefectError) recordMeta(id, fileTag, null, true);
    logError("books/cover", error, { itemId: id, where: "lecture de l'OPF" });
    return null;
  }
  await fs.promises.mkdir(DIR, { recursive: true });
  if (!coverPath) {
    await fs.promises.writeFile(path.join(DIR, `${name}.none`), "");
    return null;
  }
  let source: Buffer | null;
  try {
    source = await readEpubCover(id, coverPath);
  } catch (error) {
    s.failedAt.set(name, Date.now());
    logError("books/cover", error, { itemId: id, where: "lecture de l'image" });
    return null;
  }
  if (!source) {
    await fs.promises.writeFile(path.join(DIR, `${name}.none`), "");
    return null;
  }
  try {
    const { default: sharp } = await import("sharp");
    const out = await sharp(source, { failOn: "none", limitInputPixels: 50_000_000 })
      .resize({ width: WIDTH, withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();
    const tmp = path.join(DIR, `${name}.${process.pid}.tmp`);
    await fs.promises.writeFile(tmp, out);
    await fs.promises.rename(tmp, path.join(DIR, `${name}.webp`));
    s.writes += 1;
    if (s.writes % PRUNE_EVERY === 0) void prune().catch(() => {});
    return out;
  } catch (error) {
    // Une image que `sharp` ne lit pas ne se lira pas mieux demain.
    await fs.promises.writeFile(path.join(DIR, `${name}.none`), "").catch(() => {});
    logError("books/cover", error, { itemId: id, where: "réduction de l'image" });
    return null;
  }
}

/**
 * La couverture de Google Books (option, `googleBooks.ts`), quand ni Jellyfin ni l'EPUB n'en ont : l'image
 * publique du volume (sans la clé), réduite et gardée comme celles des EPUB, nommée par son adresse. Rien
 * ne part l'option coupée ; une image qui ne vient pas n'est pas redemandée avant dix minutes.
 */
export async function googleCover(id: string, url: string): Promise<Buffer | null> {
  const s = state();
  const name = `${id}-g-${createHash("sha256").update(url).digest("hex").slice(0, 12)}`;
  try {
    return await fs.promises.readFile(path.join(DIR, `${name}.webp`));
  } catch {
    /* pas encore faite */
  }
  const failed = s.failedAt.get(name);
  if (failed && Date.now() - failed < RETRY_MS) return null;
  const running = s.inflight.get(name);
  if (running) return running;
  const job = slot(async () => {
    try {
      if (!/^https:\/\/[a-z0-9.-]+\.(google|googleusercontent|gstatic)\.com\//i.test(url)) return null;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000), cache: "no-store" });
      if (!res.ok) throw new Error(`image ${res.status}`);
      const source = Buffer.from(await res.arrayBuffer());
      if (source.byteLength > MAX_SOURCE_BYTES) throw new Error("image trop grande");
      const { default: sharp } = await import("sharp");
      const out = await sharp(source, { failOn: "none", limitInputPixels: 50_000_000 }).resize({ width: WIDTH, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
      await fs.promises.mkdir(DIR, { recursive: true });
      const tmp = path.join(DIR, `${name}.${process.pid}.tmp`);
      await fs.promises.writeFile(tmp, out);
      await fs.promises.rename(tmp, path.join(DIR, `${name}.webp`));
      return out;
    } catch {
      s.failedAt.set(name, Date.now());
      return null;
    }
  }).finally(() => s.inflight.delete(name));
  s.inflight.set(name, job);
  return job;
}

/** Garde le dossier sous ses bornes : les plus anciennes partent d'abord. */
export async function prune(maxFiles = MAX_FILES, maxBytes = MAX_BYTES): Promise<number> {
  let names: string[];
  try {
    names = await fs.promises.readdir(DIR);
  } catch {
    return 0;
  }
  const files: { file: string; size: number; at: number }[] = [];
  for (const n of names) {
    try {
      const st = await fs.promises.stat(path.join(DIR, n));
      files.push({ file: n, size: st.size, at: st.mtimeMs });
    } catch {
      /* partie entre-temps */
    }
  }
  files.sort((a, b) => a.at - b.at);
  let bytes = files.reduce((sum, f) => sum + f.size, 0);
  let count = files.length;
  let removed = 0;
  for (const f of files) {
    if (count <= maxFiles && bytes <= maxBytes) break;
    await fs.promises.rm(path.join(DIR, f.file), { force: true });
    count -= 1;
    bytes -= f.size;
    removed += 1;
  }
  return removed;
}

export const __testing = { state, DIR };
