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

/**
 * Le dossier du magasin. « cine-reprise-2 » depuis le 28/09/2026 : sous « cine-reprise », le tampon
 * d'avance avait écrit chaque morceau de 1 Mio avec toute la plage de 8 Mio dont il était une vue
 * (voir `writeFile`) — sept gigaoctets sur un iPhone après deux lectures, et des morceaux que le
 * lecteur refusait à la relecture. L'ancien dossier est effacé au premier accès (`LEGACY_ROOT_DIRS`).
 */
export const ROOT_DIR = "cine-reprise-2";
/** Les dossiers d'avant, effacés une fois par page au premier accès au magasin. */
const LEGACY_ROOT_DIRS = ["cine-reprise"];
let legacyCleared = false;

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
  /**
   * La position d'ouverture visée, et ce que les octets gardés couvrent, en secondes. `coveredTo`
   * négatif : gardé à l'arrêt d'une lecture (`keepOnStop`), couverture pas encore mesurée.
   */
  startSeconds: number;
  coveredFrom: number;
  coveredTo: number;
  /** Les morceaux gardés (indices de 1 Mio). */
  chunks: number[];
  bytes: number;
  /** Vrai quand seuls l'en-tête et l'index ont été gardés — le passage visé dépassait la borne. */
  partial: boolean;
  /**
   * Les morceaux de l'en-tête et de l'index, qu'aucune réduction n'efface (28/09/2026). Absent tant
   * qu'un passage d'arrière-plan n'a pas relu le fichier (un titre gardé à l'arrêt).
   */
  headerChunks?: number[];
  /** Quand une lecture de ce titre s'est arrêtée sur cet appareil pour la dernière fois. */
  playedAt?: number;
  /** Les morceaux, hors en-tête, du minimum de démarrage à la position visée. */
  minimalChunks?: number;
}

/** Une ligne de l'index du compte — ce qu'il faut pour décider sans rien relire. */
export interface ResumeIndexEntry {
  savedAt: number;
  startSeconds: number;
  coveredFrom: number;
  coveredTo: number;
  bytes: number;
  partial: boolean;
  playedAt?: number;
  /** Les morceaux au-delà de l'en-tête et de l'index — la réserve et le minimum de démarrage. */
  reserveChunks?: number;
  minimalChunks?: number;
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
  legacyCleared = false;
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
  if (!legacyCleared) {
    legacyCleared = true;
    for (const name of LEGACY_ROOT_DIRS) await root.removeEntry(name, { recursive: true }).catch(() => {});
  }
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

/**
 * Une vue exactement de sa taille. Un morceau découpé dans une plage plus grande (`subarray`) est une
 * vue sur tout le tampon de la plage : écrit tel quel dans l'OPFS, Safari y a écrit la plage entière
 * — huit fois la taille du morceau (28/09/2026, iPhone : 7 Go pour ~800 Mo téléchargés, et des
 * morceaux que le lecteur refusait parce qu'ils n'avaient pas la bonne longueur). Copié quand ce
 * n'est pas déjà le cas, par les deux voies d'écriture.
 */
export function exactBytes(data: Uint8Array): Uint8Array {
  return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice();
}

async function writeFile(dir: DirHandleLike, path: string[], name: string, input: Uint8Array | string): Promise<void> {
  const data = typeof input === "string" ? input : exactBytes(input);
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

/**
 * La génération du magasin : `clearResumeStore` (déconnexion, « Vider le cache ») la fait avancer.
 * Une écriture demandée avant — un passage d'arrière-plan en route, l'arrêt d'une lecture — attendait
 * son tour dans la file, passait *après* l'effacement et recréait le dossier : un titre regardé par le
 * compte précédent, gardé sur l'appareil du suivant (chasse aux défauts du 28/09).
 */
let generation = 0;
/** Pour un travail plus long qu'une écriture (`recordTitle`) : s'arrêter si elle a changé depuis son début. */
export function resumeStoreGeneration(): number {
  return generation;
}

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

/** Efface un morceau gardé (de mauvaise taille, par exemple), sans toucher au manifeste. Ne lève jamais. */
export function dropResumeChunk(account: string, itemId: string, index: number): Promise<void> {
  return serial(async () => {
    try {
      const dir = await accountDir(account, false);
      if (!dir) return;
      const item = await dir.getDirectoryHandle(safeName(itemId));
      await item.removeEntry(`c${index}`);
    } catch {
      /* déjà absent */
    }
  });
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
  const asked = generation;
  return serial(async () => {
    if (asked !== generation) return false;
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
      await writeIndexLine(dir, account, manifest);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Un morceau de plus pour un titre, écrit tout de suite — sans toucher au manifeste. Un enregistrement
 * interrompu laisse l'ancien manifeste, qui ne décrit que des morceaux encore là (rien n'est effacé
 * avant `commitResumeEntry`). Rend vrai si le morceau est écrit.
 */
export function writeResumeChunk(account: string, itemId: string, index: number, bytes: Uint8Array): Promise<boolean> {
  const asked = generation;
  return serial(async () => {
    if (asked !== generation) return false;
    try {
      const dir = await accountDir(account, true);
      if (!dir) return false;
      const name = safeName(itemId);
      const item = await dir.getDirectoryHandle(name, { create: true });
      await writeFile(item, [ROOT_DIR, safeName(account), name], `c${index}`, bytes);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Le manifeste d'un titre dont les morceaux sont déjà écrits (`writeResumeChunk`, ou gardés d'un
 * enregistrement précédent du même fichier) : les morceaux de `drop` sont effacés, puis le manifeste
 * et l'index sont écrits. Rend vrai si tout est écrit.
 *
 * @param basedOn le `savedAt` du manifeste que l'appelant a lu avant de commencer (null : il n'y en
 *   avait pas). Si un autre l'a remplacé entre-temps — l'arrêt d'une lecture (`mergeResumeEntry`) —,
 *   rien n'est écrit et le résultat est faux : le remplacer en entier perdait les morceaux de l'autre.
 *   Le prochain passage refait le titre sur ce qui est vraiment là. Absent : pas de vérification.
 */
export function commitResumeEntry(account: string, manifest: ResumeManifest, drop: Iterable<number>, basedOn?: number | null): Promise<boolean> {
  const asked = generation;
  return serial(async () => {
    if (asked !== generation) return false;
    try {
      const dir = await accountDir(account, true);
      if (!dir) return false;
      const name = safeName(manifest.itemId);
      const item = await dir.getDirectoryHandle(name, { create: true });
      if (basedOn !== undefined) {
        const found = await readJson<ResumeManifest>(item, "manifest.json");
        const current = found && found.v === 1 && found.itemId === manifest.itemId ? found.savedAt : null;
        if (current !== basedOn) return false;
      }
      const keep = new Set(manifest.chunks);
      for (const index of drop) {
        if (!keep.has(index)) await item.removeEntry(`c${index}`).catch(() => {});
      }
      await writeFile(item, [ROOT_DIR, safeName(account), name], "manifest.json", JSON.stringify(manifest));
      await writeIndexLine(dir, account, manifest);
      return true;
    } catch {
      return false;
    }
  });
}

async function writeIndexLine(dir: DirHandleLike, account: string, manifest: ResumeManifest): Promise<void> {
  const index = (await readJson<ResumeIndex>(dir, "index.json")) || {};
  const header = new Set(manifest.headerChunks ?? []);
  index[manifest.itemId] = {
    savedAt: manifest.savedAt,
    startSeconds: manifest.startSeconds,
    coveredFrom: manifest.coveredFrom,
    coveredTo: manifest.coveredTo,
    bytes: manifest.bytes,
    partial: manifest.partial,
    ...(manifest.playedAt !== undefined ? { playedAt: manifest.playedAt } : {}),
    reserveChunks: manifest.chunks.filter((index) => !header.has(index)).length,
    ...(manifest.minimalChunks !== undefined ? { minimalChunks: manifest.minimalChunks } : {}),
  };
  await writeFile(dir, [ROOT_DIR, safeName(account)], "index.json", JSON.stringify(index));
}

/** L'identité d'un fichier, telle qu'un manifeste la porte. */
export interface ResumeFile {
  itemId: string;
  streamUrl: string;
  size: number;
  fileVersion: string;
  lastModified: string | null;
}

/**
 * Change la liste des morceaux d'un titre par différence : `add` (déjà écrits par
 * `writeResumeChunk`) rejoint ce que le manifeste décrit, `remove` le quitte et ses fichiers sont
 * effacés. Le manifeste est relu *dans* la file des opérations : le tampon d'une lecture, l'arrêt et
 * une reconstruction du lecteur y écrivent chacun à leur tour sans jamais défaire ce que l'autre a
 * écrit — un manifeste réécrit en entier par chacun perdait les morceaux des autres.
 *
 * Un manifeste d'un autre fichier est remplacé, ses morceaux effacés. `patch` précise les autres
 * champs (couverture, date de lecture). Rend vrai si tout est écrit. Ne lève jamais.
 */
export function mergeResumeEntry(
  account: string,
  file: ResumeFile,
  add: Iterable<number>,
  remove: Iterable<number>,
  patch: Partial<Pick<ResumeManifest, "startSeconds" | "coveredFrom" | "coveredTo" | "playedAt" | "partial">> = {}
): Promise<boolean> {
  const asked = generation;
  return serial(async () => {
    if (asked !== generation) return false;
    try {
      const dir = await accountDir(account, true);
      if (!dir) return false;
      const name = safeName(file.itemId);
      const item = await dir.getDirectoryHandle(name, { create: true });
      const found = await readJson<ResumeManifest>(item, "manifest.json");
      const same =
        found && found.v === 1 && found.itemId === file.itemId && found.size === file.size && found.fileVersion === file.fileVersion && found.streamUrl === file.streamUrl
          ? found
          : null;
      if (found && !same) {
        // Un autre fichier : ce qui était gardé ne vaut plus rien — sauf ce que l'appelant vient
        // d'écrire pour le nouveau, qu'on retire alors aussi (son dossier est vidé).
        await dir.removeEntry(name, { recursive: true }).catch(() => {});
        await removeIndexLine(dir, account, file.itemId);
        return false;
      }
      const drop = new Set(remove);
      const chunks = new Set(same?.chunks ?? []);
      for (const index of add) chunks.add(index);
      for (const index of drop) {
        if (!chunks.has(index)) continue;
        chunks.delete(index);
        await item.removeEntry(`c${index}`).catch(() => {});
      }
      const list = [...chunks].sort((a, b) => a - b);
      const bytes = list.reduce((sum, index) => sum + Math.max(0, Math.min(1 << 20, file.size - index * (1 << 20))), 0);
      const manifest: ResumeManifest = {
        ...(same ?? { startSeconds: -1, coveredFrom: -1, coveredTo: -1, partial: false }),
        v: 1,
        itemId: file.itemId,
        streamUrl: file.streamUrl,
        size: file.size,
        fileVersion: file.fileVersion,
        lastModified: file.lastModified ?? same?.lastModified ?? null,
        savedAt: Date.now(),
        chunks: list,
        bytes,
        ...patch,
      } as ResumeManifest;
      if (manifest.headerChunks) manifest.headerChunks = manifest.headerChunks.filter((index) => chunks.has(index));
      await writeFile(item, [ROOT_DIR, safeName(account), name], "manifest.json", JSON.stringify(manifest));
      await writeIndexLine(dir, account, manifest);
      return true;
    } catch {
      return false;
    }
  });
}

async function removeIndexLine(dir: DirHandleLike, account: string, itemId: string): Promise<void> {
  const index = await readJson<ResumeIndex>(dir, "index.json");
  if (index && itemId in index) {
    delete index[itemId];
    await writeFile(dir, [ROOT_DIR, safeName(account)], "index.json", JSON.stringify(index));
  }
}

/** Un dossier qu'on peut parcourir — `keys()` n'existe pas dans tous les navigateurs. */
type ListableDir = DirHandleLike & { keys?: () => AsyncIterable<string> };

/** Les noms d'un dossier, ou null quand le navigateur ne sait pas les lister. */
async function namesOf(dir: DirHandleLike): Promise<string[] | null> {
  const keys = (dir as ListableDir).keys;
  if (typeof keys !== "function") return null;
  const names: string[] = [];
  for await (const name of keys.call(dir)) names.push(name);
  return names;
}

/** L'âge d'un fichier en millisecondes, ou null quand le navigateur ne le dit pas. */
async function ageOf(dir: DirHandleLike, name: string, now: number): Promise<number | null> {
  try {
    const file = await (await dir.getFileHandle(name)).getFile();
    const modified = (file as Blob & { lastModified?: number }).lastModified;
    return typeof modified === "number" ? now - modified : null;
  } catch {
    return null;
  }
}

/** Ce qu'un balayage épargne : de quoi finir d'écrire un titre et son manifeste. */
export const SWEEP_MIN_AGE_MS = 10 * 60_000;

/**
 * Le balayage : ce qu'aucun manifeste ne décrit, effacé (28/09/2026).
 *
 * Un morceau n'est connu que de son manifeste, et un manifeste que de l'index. Ce qui a été écrit
 * sans y être inscrit — une application tuée entre l'écriture d'un morceau et la mise à jour du
 * manifeste, la réserve d'avance sur l'appareil des versions du 28/09/2026 au matin — n'était plus
 * lu par personne, et plus jamais effacé tant que le titre restait gardé. Effacé ici : les morceaux
 * absents du manifeste de leur titre, et les dossiers de titres absents de l'index.
 *
 * Prudent : seulement ce qui a plus de `SWEEP_MIN_AGE_MS` — un arrêt qui vient d'écrire ses morceaux
 * et n'a pas encore écrit son manifeste ne perd rien —, et seulement là où le navigateur sait lister
 * un dossier et dater un fichier. Ailleurs, rien ne change. Rend le nombre de fichiers et de dossiers
 * effacés. Ne lève jamais.
 */
export function sweepResumeStore(account: string, now = Date.now()): Promise<number> {
  return serial(async () => {
    let removed = 0;
    try {
      const dir = await accountDir(account, false);
      if (!dir) return 0;
      const names = await namesOf(dir);
      if (!names) return 0;
      const index = (await readJson<ResumeIndex>(dir, "index.json")) || {};
      const known = new Set(Object.keys(index).map(safeName));
      for (const name of names) {
        if (name === "index.json") continue;
        let item: DirHandleLike;
        try {
          item = await dir.getDirectoryHandle(name);
        } catch {
          continue;
        }
        const files = (await namesOf(item)) ?? [];
        const manifest = await readJson<ResumeManifest>(item, "manifest.json");
        // Un titre de l'index dont le manifeste ne se lit pas — maintenant : ne rien juger sur une
        // lecture manquée. Sans cette garde, tous ses morceaux passaient pour orphelins.
        if (known.has(name) && !manifest) continue;
        const listed = new Set(known.has(name) && manifest ? manifest.chunks.map((index) => `c${index}`) : []);
        let kept = 0;
        for (const file of files) {
          if (file === "manifest.json" || listed.has(file)) {
            kept += 1;
            continue;
          }
          const age = await ageOf(item, file, now);
          if (age === null || age < SWEEP_MIN_AGE_MS) {
            kept += 1;
            continue;
          }
          await item.removeEntry(file).catch(() => {});
          removed += 1;
        }
        // Un titre que l'index ignore et dont il ne reste rien de récent : le dossier part.
        if (!known.has(name) && (kept === 0 || (kept === 1 && files.includes("manifest.json") && ((await ageOf(item, "manifest.json", now)) ?? 0) >= SWEEP_MIN_AGE_MS))) {
          await dir.removeEntry(name, { recursive: true }).catch(() => {});
          removed += 1;
        }
      }
    } catch {
      /* ce qui a pu être balayé */
    }
    return removed;
  });
}

/** Efface un titre, et sa ligne de l'index. Ne lève jamais. */
export function removeResumeEntry(account: string, itemId: string): Promise<void> {
  return serial(async () => {
    try {
      const dir = await accountDir(account, false);
      if (!dir) return;
      await dir.removeEntry(safeName(itemId), { recursive: true }).catch(() => {});
      await removeIndexLine(dir, account, itemId);
    } catch {
      /* rien à effacer */
    }
  });
}

/** Tout, tous comptes confondus — la déconnexion. Ne lève jamais. */
export function clearResumeStore(): Promise<void> {
  // Tout de suite, pas à son tour : ce qui attend dans la file derrière lui ne doit plus écrire.
  generation += 1;
  return serial(async () => {
    try {
      const root = await rootProvider();
      for (const name of [ROOT_DIR, ...LEGACY_ROOT_DIRS]) await root?.removeEntry(name, { recursive: true }).catch(() => {});
    } catch {
      /* déjà vide */
    }
  });
}
