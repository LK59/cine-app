/**
 * Les téléchargements hors ligne sur l'appareil (bêta, 19/10/2026) : le système de fichiers privé
 * du site (OPFS), un dossier par compte, un par téléchargement — `cine-offline/<compte>/<id>/` avec
 * `video.mp4`, `meta.json` et `poster`.
 *
 * Tout passe par un worker et ses `FileSystemSyncAccessHandle` : écrire à une position d'un fichier
 * de plusieurs gigaoctets sans le recopier. `createWritable` (ce que la reprise instantanée utilise
 * pour ses morceaux de 1 Mo) écrit dans une copie qu'il substitue à la fermeture — à chaque morceau
 * de 8 Mo, la copie entière du film. La lecture passe par le même worker : un fichier ouvert en
 * accès synchrone est verrouillé, et le lecteur lit pendant que le téléchargement écrit.
 *
 * Le worker est écrit en ligne (Blob) pour la même raison que celui de la reprise instantanée :
 * Turbopack ne compile pas `new Worker(new URL(...))`, et la CSP permet `worker-src blob:`.
 */

const ROOT = "cine-offline";

const WORKER_SOURCE = `
const handles = new Map();
const timers = new Map();
async function dir(parts, create) {
  let d = await navigator.storage.getDirectory();
  for (const p of parts) d = await d.getDirectoryHandle(p, { create });
  return d;
}
// \`create\` faux pour lire : un lecteur ou un rangement arrivé après une suppression recréait le
// dossier, vide de \`meta.json\`, que rien ne voyait plus ni n'effaçait (relecture du 19/10/2026).
// Un fichier ouvert en accès synchrone est verrouillé pour tout le navigateur : la page d'avant un
// rechargement (une nouvelle version, iPhone, 19/10/2026) le tenait encore quand la nouvelle voulait le
// lire — « InvalidStateError », un épisode affiché à 0 Mo et illisible. On attend qu'il se libère,
// jusqu'à cinq secondes, avant de renoncer.
const LOCKED = new Set(["InvalidStateError", "NoModificationAllowedError"]);
async function open(f) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await f.createSyncAccessHandle();
    } catch (error) {
      if (!(error && LOCKED.has(error.name)) || attempt >= 25) throw error;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}
async function handle(path, create = true) {
  const key = path.join("/");
  let h = handles.get(key);
  if (!h) {
    const d = await dir(path.slice(0, -1), create);
    const f = await d.getFileHandle(path[path.length - 1], { create });
    h = await open(f);
    handles.set(key, h);
  }
  clearTimeout(timers.get(key));
  // Fermé après cinq secondes sans usage : un fichier ouvert reste verrouillé pour les autres pages.
  timers.set(key, setTimeout(() => close(key), 5000));
  return h;
}
function close(key) {
  const h = handles.get(key);
  if (h) { try { h.flush(); h.close(); } catch {} }
  handles.delete(key);
  clearTimeout(timers.get(key));
  timers.delete(key);
}
function closeUnder(prefix) {
  for (const key of [...handles.keys()]) if (key === prefix || key.startsWith(prefix + "/")) close(key);
}
// Une opération à la fois, dans l'ordre d'arrivée : entrecroisées, une écriture partie avant une
// suppression rouvrait un fichier que la suppression venait de fermer (19/10/2026).
let chain = Promise.resolve();
self.onmessage = (event) => { chain = chain.then(() => run(event)); };
async function run(event) {
  const { id, op, path, at, length, data } = event.data;
  try {
    let result = null;
    if (op === "write") {
      const h = await handle(path);
      let done = 0;
      while (done < data.byteLength) done += h.write(data.subarray(done), { at: at + done });
      h.flush();
      result = done;
    } else if (op === "read") {
      const h = await handle(path, false);
      const size = h.getSize();
      const n = Math.max(0, Math.min(length, size - at));
      const buffer = new Uint8Array(n);
      let got = 0;
      while (got < n) { const r = h.read(buffer.subarray(got), { at: at + got }); if (!r) break; got += r; }
      result = got === n ? buffer : buffer.slice(0, got);
    } else if (op === "size") {
      result = (await handle(path, false)).getSize();
    } else if (op === "truncate") {
      const h = await handle(path); h.truncate(at); h.flush(); result = at;
    } else if (op === "writeText") {
      const h = await handle(path);
      const bytes = new TextEncoder().encode(data);
      h.truncate(0); h.write(bytes, { at: 0 }); h.flush(); close(path.join("/"));
      result = bytes.byteLength;
    } else if (op === "writeBytes") {
      const h = await handle(path);
      h.truncate(0); h.write(data, { at: 0 }); h.flush(); close(path.join("/"));
      result = data.byteLength;
    } else if (op === "readText") {
      try {
        const d = await dir(path.slice(0, -1), false);
        const f = await d.getFileHandle(path[path.length - 1]);
        result = await (await f.getFile()).text();
      } catch { result = null; }
    } else if (op === "readBlob") {
      try {
        const d = await dir(path.slice(0, -1), false);
        const f = await d.getFileHandle(path[path.length - 1]);
        result = await f.getFile();
      } catch { result = null; }
    } else if (op === "list") {
      result = [];
      try { const d = await dir(path, false); for await (const [name, h] of d.entries()) if (h.kind === "directory") result.push(name); } catch {}
    } else if (op === "remove") {
      closeUnder(path.join("/"));
      try { const d = await dir(path.slice(0, -1), false); await d.removeEntry(path[path.length - 1], { recursive: true }); } catch {}
    } else if (op === "close") {
      closeUnder(path.join("/"));
    } else if (op === "closeAll") {
      for (const key of [...handles.keys()]) close(key);
    } else if (op === "files") {
      result = [];
      try { const d = await dir(path, false); for await (const [name, h] of d.entries()) if (h.kind === "file") result.push(name); } catch {}
    }
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: String(error && error.name ? error.name + ": " : "") + String(error && error.message || error) });
  }
}
`;

let worker: Worker | null = null;

/**
 * La page s'en va (rechargement, fermeture) ou passe derrière : ses fichiers sont rendus tout de
 * suite, pour qu'une autre page — la même après un rechargement — puisse les ouvrir. Rouverts au
 * besoin par l'opération suivante.
 */
if (typeof window !== "undefined") {
  const release = () => {
    if (worker) worker.postMessage({ id: 0, op: "closeAll", path: [] });
  };
  window.addEventListener("pagehide", release);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") release();
  });
}
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
  worker = new Worker(url);
  worker.onmessage = (event: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);
    if (event.data.error !== undefined) entry.reject(Object.assign(new Error(event.data.error), { deviceStore: true }));
    else entry.resolve(event.data.result);
  };
  return worker;
}

/**
 * Repartir d'un worker neuf, comme le fait un redémarrage de l'application : un fichier resté
 * verrouillé dans l'ancien (Safari, 19/10/2026 — un nouveau téléchargement après une suppression
 * restait sur « Préparation » jusqu'au redémarrage) est libéré avec lui. Ce qui attendait une
 * réponse échoue, et sera redemandé.
 */
export function resetDeviceStore(): void {
  worker?.terminate();
  worker = null;
  for (const [, entry] of pending) entry.reject(new Error("stockage de l'appareil relancé"));
  pending.clear();
}

function call<T>(op: string, path: string[], extra: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    getWorker().postMessage({ id, op, path, ...extra }, transfer);
  });
}

/**
 * Une erreur venue du stockage de l'appareil (et non du réseau ou du serveur) : seules celles-là
 * justifient de relancer le worker (`downloads.ts`).
 */
export function isDeviceStoreError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { deviceStore?: boolean }).deviceStore === true;
}

/** Le dossier d'un compte : son nom, rendu sûr comme celui de la reprise instantanée. */
export function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+/, "_").slice(0, 80) || "_";
}

/** Cet appareil peut-il garder des téléchargements ? OPFS et les workers, rien d'autre. */
export function deviceStoreSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function" && typeof Worker !== "undefined";
}

export const offlinePaths = (account: string, id?: string) => (id ? [ROOT, safeName(account), id] : [ROOT, safeName(account)]);

export const deviceStore = {
  /** Les téléchargements de ce compte sur cet appareil (noms de dossiers). */
  list: (account: string) => call<string[]>("list", offlinePaths(account)),
  /** Les fichiers d'un téléchargement (noms), sans rien ouvrir. */
  files: (account: string, id: string) => call<string[]>("files", offlinePaths(account, id)),
  readMeta: async <T>(account: string, id: string): Promise<T | null> => {
    const text = await call<string | null>("readText", [...offlinePaths(account, id), "meta.json"]);
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  },
  writeMeta: (account: string, id: string, meta: unknown) => call<number>("writeText", [...offlinePaths(account, id), "meta.json"], { data: JSON.stringify(meta) }),
  writePoster: (account: string, id: string, bytes: Uint8Array) => {
    const copy = bytes.slice();
    return call<number>("writeBytes", [...offlinePaths(account, id), "poster"], { data: copy }, [copy.buffer]);
  },
  readPoster: (account: string, id: string) => call<Blob | null>("readBlob", [...offlinePaths(account, id), "poster"]),
  /** Un petit fichier rangé à côté du film (sous-titres) : écrit d'un coup, relu en entier. */
  writeFile: (account: string, id: string, name: string, bytes: Uint8Array) => {
    const copy = bytes.slice();
    return call<number>("writeBytes", [...offlinePaths(account, id), name], { data: copy }, [copy.buffer]);
  },
  readFile: (account: string, id: string, name: string) => call<Blob | null>("readBlob", [...offlinePaths(account, id), name]),
  /** Écrit à la position donnée du film (une copie transférée : jamais la vue d'un tampon plus grand). */
  writeVideo: (account: string, id: string, at: number, bytes: Uint8Array) => {
    const copy = bytes.slice();
    return call<number>("write", [...offlinePaths(account, id), "video.mp4"], { at, data: copy }, [copy.buffer]);
  },
  readVideo: (account: string, id: string, at: number, length: number) => call<Uint8Array>("read", [...offlinePaths(account, id), "video.mp4"], { at, length }),
  videoSize: (account: string, id: string) => call<number>("size", [...offlinePaths(account, id), "video.mp4"]),
  truncateVideo: (account: string, id: string, size: number) => call<number>("truncate", [...offlinePaths(account, id), "video.mp4"], { at: size }),
  remove: (account: string, id: string) => call<null>("remove", offlinePaths(account, id)),
  /** Tous les téléchargements d'un compte sur cet appareil (son dossier entier). */
  removeAccount: (account: string) => call<null>("remove", offlinePaths(account)),
};
