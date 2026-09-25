/**
 * Le magasin de la reprise instantanée, dans le système de fichiers privé du site (OPFS).
 *
 * Rangement : `cine-reprise/<compte>/<titre>/` — un manifeste (`manifest.json`) et un fichier par
 * morceau de 1 Mio (`c<n>`), alignés sur ceux de `HttpByteSource`, pour que le lecteur les prenne
 * tels quels. Un index par compte (`index.json`) dit ce qui est gardé sans avoir à parcourir les
 * dossiers — `keys()` n'est pas partout, et une ouverture de film ne doit pas attendre un parcours.
 *
 * Un compte par dossier : un iPad partagé ne rouvre jamais le film de quelqu'un d'autre depuis ses
 * octets, et la déconnexion efface tout (`clearResumeStore`).
 *
 * L'écriture : `createWritable` depuis la page quand le navigateur la propose, sinon un petit worker
 * créé en ligne (la CSP autorise `worker-src blob:`) qui écrit par `createSyncAccessHandle`, la seule
 * écriture OPFS garantie sur les Safari d'avant. Un worker **en ligne**, et non un fichier compilé :
 * Turbopack ne compile pas `new Worker(new URL("./x.worker.ts", import.meta.url))` — il en copie la
 * source telle quelle, et le worker ne démarre jamais (CLAUDE.md). Tout est asynchrone, et rien ne
 * lève vers l'appelant : sans OPFS, la reprise se fait par le réseau comme avant.
 */

export const ROOT_DIR = "cine-reprise";

/** Ce qu'on garde d'un titre : de quoi le rouvrir à une position, et de quoi savoir si c'est encore lui. */
export interface ResumeManifest {
  v: 1;
  itemId: string;
  streamUrl: string;
  /** La taille du fichier, telle que le serveur l'annonce. */
  size: number;
  /** La version du fichier selon Jellyfin (`DirectPlayInfo.fileVersion`). */
  fileVersion: string;
  /** Le `Last-Modified` du flux au moment de l'enregistrement, s'il y en avait un. */
  lastModified: string | null;
  savedAt: number;
  /** La position d'ouverture visée, et ce que les octets gardés couvrent, en secondes. */
  startSeconds: number;
  coveredFrom: number;
  coveredTo: number;
  /** Les morceaux gardés (indices de 1 Mio). */
  chunks: number[];
  bytes: number;
  /** Vrai quand seuls l'en-tête et l'index ont été gardés — le passage visé dépassait la borne. */
  partial: boolean;
}

/** Une ligne de l'index du compte — ce qu'il faut pour décider sans rien relire. */
export interface ResumeIndexEntry {
  savedAt: number;
  startSeconds: number;
  coveredFrom: number;
  coveredTo: number;
  bytes: number;
  partial: boolean;
}

export type ResumeIndex = Record<string, ResumeIndexEntry>;

// ---------------------------------------------------------------------------------------------
// Les poignées, réduites à ce qu'on en utilise : de quoi les imiter en mémoire dans les tests.

interface Writable {
  write(data: BufferSource | string): Promise<void>;
  close(): Promise<void>;
}
export interface FileHandleLike {
  getFile(): Promise<Blob>;
  createWritable?(): Promise<Writable>;
}
export interface DirHandleLike {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

type RootProvider = () => Promise<DirHandleLike | null>;

async function browserRoot(): Promise<DirHandleLike | null> {
  try {
    const storage = typeof navigator !== "undefined" ? navigator.storage : undefined;
    if (!storage || typeof storage.getDirectory !== "function") return null;
    return (await storage.getDirectory()) as unknown as DirHandleLike;
  } catch {
    return null;
  }
}

let rootProvider: RootProvider = browserRoot;
/** L'écriture par worker, remplaçable dans les tests. Null : pas d'écriture possible. */
let workerWrite: ((path: string[], data: Uint8Array) => Promise<void>) | null = defaultWorkerWrite;

/** Pour les tests : un OPFS en mémoire, et l'écriture de repli. */
export function setResumeStoreForTests(provider: RootProvider | null, fallbackWrite?: ((path: string[], data: Uint8Array) => Promise<void>) | null): void {
  rootProvider = provider ?? browserRoot;
  workerWrite = fallbackWrite === undefined ? defaultWorkerWrite : fallbackWrite;
  queue = Promise.resolve();
}

/** Nom de dossier sûr pour un compte ou un titre : jamais de séparateur ni de chemin relatif. */
export function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+/, "_").slice(0, 80) || "_";
}

async function accountDir(account: string, create: boolean): Promise<DirHandleLike | null> {
  const root = await rootProvider();
  if (!root) return null;
  const top = await root.getDirectoryHandle(ROOT_DIR, { create });
  return top.getDirectoryHandle(safeName(account), { create });
}

// ---------------------------------------------------------------------------------------------
// L'écriture de repli, par un worker en ligne.

const WORKER_SOURCE = `
self.onmessage = async (event) => {
  const { id, path, data } = event.data;
  try {
    let dir = await navigator.storage.getDirectory();
    for (const part of path.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
    const file = await dir.getFileHandle(path[path.length - 1], { create: true });
    const handle = await file.createSyncAccessHandle();
    try {
      handle.truncate(0);
      handle.write(data, { at: 0 });
      handle.flush();
    } finally {
      handle.close();
    }
    self.postMessage({ id, ok: true });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error) });
  }
};
`;

let worker: Worker | null = null;
let workerFailed = false;
let nextId = 0;
const pendingWrites = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();

function defaultWorkerWrite(path: string[], data: Uint8Array): Promise<void> {
  if (workerFailed || typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") {
    return Promise.reject(new Error("écriture OPFS indisponible"));
  }
  if (!worker) {
    try {
      const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
      worker = new Worker(url);
      worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; error?: string }>) => {
        const pending = pendingWrites.get(event.data.id);
        if (!pending) return;
        pendingWrites.delete(event.data.id);
        if (event.data.ok) pending.resolve();
        else pending.reject(new Error(event.data.error ?? "écriture refusée"));
      };
      worker.onerror = () => {
        workerFailed = true;
        for (const pending of pendingWrites.values()) pending.reject(new Error("worker d'écriture arrêté"));
        pendingWrites.clear();
      };
    } catch {
      workerFailed = true;
      return Promise.reject(new Error("écriture OPFS indisponible"));
    }
  }
  const id = nextId++;
  return new Promise<void>((resolve, reject) => {
    pendingWrites.set(id, { resolve, reject });
    // Copié : le tampon transféré serait inutilisable pour l'appelant.
    worker!.postMessage({ id, path, data: data.slice() });
  });
}

async function writeFile(dir: DirHandleLike, path: string[], name: string, data: Uint8Array | string): Promise<void> {
  const file = await dir.getFileHandle(name, { create: true });
  if (typeof file.createWritable === "function") {
    const writable = await file.createWritable();
    await writable.write(data as BufferSource | string);
    await writable.close();
    return;
  }
  if (!workerWrite) throw new Error("écriture OPFS indisponible");
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  await workerWrite([...path, name], bytes);
}

async function readFile(dir: DirHandleLike, name: string): Promise<Uint8Array | null> {
  try {
    const file = await (await dir.getFileHandle(name)).getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

async function readJson<T>(dir: DirHandleLike, name: string): Promise<T | null> {
  const bytes = await readFile(dir, name);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Une opération à la fois : l'index est relu puis réécrit, deux écritures croisées en perdraient une.

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

/** L'index du compte : ce qui est gardé. Vide si rien, ou sans OPFS. */
export function readResumeIndex(account: string): Promise<ResumeIndex> {
  return serial(async () => {
    try {
      const dir = await accountDir(account, false);
      return (dir && (await readJson<ResumeIndex>(dir, "index.json"))) || {};
    } catch {
      return {};
    }
  });
}

/** Le manifeste d'un titre, ou null. */
export async function readResumeManifest(account: string, itemId: string): Promise<ResumeManifest | null> {
  try {
    const dir = await accountDir(account, false);
    if (!dir) return null;
    const item = await dir.getDirectoryHandle(safeName(itemId));
    const manifest = await readJson<ResumeManifest>(item, "manifest.json");
    return manifest && manifest.v === 1 && manifest.itemId === itemId ? manifest : null;
  } catch {
    return null;
  }
}

/** Un morceau gardé, ou null. */
export async function readResumeChunk(account: string, itemId: string, index: number): Promise<Uint8Array | null> {
  try {
    const dir = await accountDir(account, false);
    if (!dir) return null;
    const item = await dir.getDirectoryHandle(safeName(itemId));
    return await readFile(item, `c${index}`);
  } catch {
    return null;
  }
}

/**
 * Enregistre un titre : les morceaux d'abord, le manifeste ensuite, l'index en dernier — un
 * enregistrement interrompu laisse au pire des morceaux sans manifeste, que rien ne lira et que le
 * prochain nettoyage efface. Rend vrai si tout est écrit.
 */
export function saveResumeEntry(account: string, manifest: ResumeManifest, chunks: Map<number, Uint8Array>): Promise<boolean> {
  return serial(async () => {
    try {
      const dir = await accountDir(account, true);
      if (!dir) return false;
      const name = safeName(manifest.itemId);
      // Repart d'un dossier vide : des morceaux d'une position précédente n'ont rien à y faire.
      await dir.removeEntry(name, { recursive: true }).catch(() => {});
      const item = await dir.getDirectoryHandle(name, { create: true });
      const path = [ROOT_DIR, safeName(account), name];
      for (const [index, bytes] of chunks) await writeFile(item, path, `c${index}`, bytes);
      await writeFile(item, path, "manifest.json", JSON.stringify(manifest));
      const index = (await readJson<ResumeIndex>(dir, "index.json")) || {};
      index[manifest.itemId] = {
        savedAt: manifest.savedAt,
        startSeconds: manifest.startSeconds,
        coveredFrom: manifest.coveredFrom,
        coveredTo: manifest.coveredTo,
        bytes: manifest.bytes,
        partial: manifest.partial,
      };
      await writeFile(dir, [ROOT_DIR, safeName(account)], "index.json", JSON.stringify(index));
      return true;
    } catch {
      return false;
    }
  });
}

/** Efface un titre, et sa ligne de l'index. Ne lève jamais. */
export function removeResumeEntry(account: string, itemId: string): Promise<void> {
  return serial(async () => {
    try {
      const dir = await accountDir(account, false);
      if (!dir) return;
      await dir.removeEntry(safeName(itemId), { recursive: true }).catch(() => {});
      const index = await readJson<ResumeIndex>(dir, "index.json");
      if (index && itemId in index) {
        delete index[itemId];
        await writeFile(dir, [ROOT_DIR, safeName(account)], "index.json", JSON.stringify(index));
      }
    } catch {
      /* rien à effacer */
    }
  });
}

/** Tout, tous comptes confondus — la déconnexion. Ne lève jamais. */
export function clearResumeStore(): Promise<void> {
  return serial(async () => {
    try {
      const root = await rootProvider();
      await root?.removeEntry(ROOT_DIR, { recursive: true });
    } catch {
      /* déjà vide */
    }
  });
}
