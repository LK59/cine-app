// Le décodeur TrueHD tel que la lecture s'en sert : un lot à la fois, dans un worker — ou sur le fil
// principal quand le worker ne peut pas naître.
//
// Le worker, depuis le 06/11/2026. Un quart de seconde de TrueHD 7.1 se décode en ~4 ms dans Node et
// une dizaine sur un téléphone, et le lecteur en remplit dix secondes d'un coup : quarante lots, donc
// quatre cents millisecondes de fil principal en tâches courtes, à chaque remplissage, pendant tout
// le film — ce que le doigt, les commandes et l'envoi des segments se partageaient sur un iPhone.
//
// Il y en avait déjà eu un, et le build de production l'avait trahi le 21/09/2026 : Turbopack n'a
// pas compilé `new Worker(new URL("./….worker.ts", …))`, il a copié le fichier TypeScript tel quel
// dans les ressources statiques — un worker qui n'aurait jamais démarré. Celui-ci est écrit en
// JavaScript (truehdWorker.mjs), que le build copie tel quel, comme le module WebAssembly, et il est
// lancé par un module en ligne (voir `createHost`) ; la sortie du build a été lue pour le vérifier
// (DOC-TECH, « Audio delivery »).
//
// Un worker pour la page, partagé par les décodeurs ouverts (un par piste TrueHD d'un pipeline, en
// pratique un seul à la fois), et non un par pipeline : un changement de piste ou une reconstruction
// ferme le décodeur puis en rouvre un, et le module de 466 Ko n'est pas réinstancié à chaque fois.
// Il est terminé quand plus aucun décodeur n'est ouvert et que rien n'attend, après IDLE_MS : une
// reconstruction le retrouve, la fermeture du lecteur rend sa mémoire. Il ne s'accumule donc jamais.
import { TrueHdCore, type DecodedBatch } from "./truehdCore";

export type { DecodedBatch };

export interface TrueHdDecoder {
  decode(blocks: Uint8Array[]): Promise<DecodedBatch>;
  reset(): void;
  close(): void;
  /** Où ce décodeur tourne — pour la ligne `start` du journal du lecteur. */
  readonly thread: "worker" | "principal";
  /** Pourquoi pas dans un worker, quand il tourne sur le fil principal. */
  readonly workerRefusal?: string;
}

/**
 * Rend la main au navigateur — une vraie tâche, pas une microtâche : une chaîne de promesses
 * résolues tout de suite ne laisse ni peindre ni répondre au doigt. MessageChannel plutôt que
 * setTimeout, que les navigateurs retardent à 4 ms quand on l'enchaîne.
 */
export function yieldToBrowser(): Promise<void> {
  if (typeof MessageChannel === "undefined") return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/**
 * Le chemin d'avant le worker, inchangé : le même décodage sur le fil principal, un lot à la fois,
 * suivi d'un retour au navigateur — aucune tâche ne dépasse quelques millisecondes.
 */
async function openOnMainThread(mlp: boolean, workerRefusal: string): Promise<TrueHdDecoder> {
  const core = await TrueHdCore.create(mlp);
  return {
    async decode(blocks) {
      const batch = core.decode(blocks);
      await yieldToBrowser();
      return batch;
    },
    reset: () => core.reset(),
    close: () => core.close(),
    thread: "principal",
    workerRefusal,
  };
}

/** Le worker prêt, ou rien : au-delà, il ne répondra plus. Le module vient du cache d'ordinaire. */
const READY_TIMEOUT_MS = 20_000;
/** Combien un worker sans décodeur ouvert est gardé — de quoi traverser une reconstruction. */
const IDLE_MS = 10_000;

interface Host {
  worker: Worker;
  ready: Promise<void>;
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  /** Décodeurs ouverts, ou en train de s'ouvrir. */
  users: number;
  idle: ReturnType<typeof setTimeout> | null;
  dead: Error | null;
}

let host: Host | null = null;
/**
 * Pourquoi le worker n'a pas pu naître dans cette page (CSP, navigateur sans worker de module,
 * module introuvable, délai) : retenu pour la vie de la page — réessayer, c'était payer le même
 * échec, et jusqu'à vingt secondes, à chaque reconstruction.
 */
let refusedHere: string | null = null;
let requests = 0;
let decoders = 0;

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 160);

const lost = (error: Error) => new Error(`worker TrueHD perdu (${error.message})`);

function retire(h: Host, error: Error): void {
  if (h.dead) return;
  h.dead = error;
  if (h.idle) clearTimeout(h.idle);
  h.idle = null;
  for (const entry of h.pending.values()) entry.reject(lost(error));
  h.pending.clear();
  h.worker.terminate();
  if (host === h) host = null;
}

/** Plus personne : le worker est terminé après IDLE_MS, sauf si un décodeur s'ouvre d'ici là. */
function releaseIfIdle(h: Host): void {
  if (h.dead || h.users > 0 || h.pending.size > 0 || h.idle) return;
  h.idle = setTimeout(() => {
    h.idle = null;
    if (h.users === 0 && h.pending.size === 0) retire(h, new Error("worker TrueHD terminé"));
  }, IDLE_MS);
}

/**
 * Le worker : un petit module en ligne (`blob:`, que la CSP permet déjà — `worker-src 'self' blob:`)
 * qui importe truehdWorker.mjs tel que le build l'a copié, et non `new Worker(new URL("./x", …))`.
 *
 * Turbopack (Next 16.4.3) reconnaît désormais cette forme-là et en fait un worker à lui : le fichier
 * recompilé et minifié dans ses propres morceaux, chargés par `importScripts` dans un worker classique
 * dont il retire le `type: "module"`, et des modules évalués après une attente — un message posté
 * trop tôt pouvait s'y perdre. Lu dans la sortie du build le 06/11/2026 ; il fonctionnerait sans doute,
 * mais ce serait un autre fichier que celui que Node a prouvé, et le chargeur d'un outil qui a déjà
 * trompé ce dépôt une fois. Le `blob:` ne laisse rien à reconnaître : le worker exécute les octets
 * mêmes de truehdWorker.mjs (copie conforme dans `static/media`, vérifiée dans la sortie du build).
 *
 * Et le worker dit quand il écoute (`listening`) avant qu'on lui parle : aucun message ne peut
 * arriver avant son `onmessage`, quelle que soit la façon dont il a été chargé.
 */
/**
 * Une adresse complète. Turbopack remplace `new URL("./x", import.meta.url)` par un objet à lui dont
 * `href` est relatif (« /_next/static/media/… », sans origine — lu dans son code d'exécution). Le
 * module en ligne a une adresse `blob:`, contre laquelle rien de relatif ne se résout : le premier
 * essai dans Firefox, sur l'instance du banc, a échoué ainsi (« le worker n'a pas démarré ») et s'est
 * replié sur le fil principal (06/11/2026). Dans Node, l'adresse est déjà complète (`file:`).
 */
export function absoluteHref(url: { href: string }): string {
  const base = (globalThis as { location?: { href: string } }).location?.href;
  return base ? new URL(url.href, base).href : new URL(url.href).href;
}

function createHost(): Host {
  // Les deux fichiers sont copiés tels quels par le build ; le module WebAssembly est donné au worker
  // par son adresse, qu'un import relatif ne retrouverait pas sous le nom haché de la copie.
  const workerUrl = new URL("./truehdWorker.mjs", import.meta.url);
  const wasmUrl = new URL("./truehd-wasm.mjs", import.meta.url);
  const bootstrap = URL.createObjectURL(new Blob([`import ${JSON.stringify(absoluteHref(workerUrl))};\n`], { type: "text/javascript" }));
  let worker: Worker;
  try {
    worker = new Worker(bootstrap, { type: "module", name: "truehd" });
  } catch (error) {
    URL.revokeObjectURL(bootstrap);
    throw error;
  }
  let settle!: { resolve: () => void; reject: (error: Error) => void };
  const h: Host = {
    worker,
    ready: new Promise<void>((resolve, reject) => (settle = { resolve, reject })),
    pending: new Map(),
    users: 0,
    idle: null,
    dead: null,
  };
  const fail = (error: Error) => {
    settle.reject(error);
    retire(h, error);
  };
  h.ready.catch(() => {});
  const timer = setTimeout(() => fail(new Error(`pas prêt en ${READY_TIMEOUT_MS / 1000} s`)), READY_TIMEOUT_MS);
  const settled = () => {
    clearTimeout(timer);
    URL.revokeObjectURL(bootstrap);
  };
  h.ready.then(settled, settled);
  worker.onmessage = (event: MessageEvent) => {
    const data = event.data as { listening?: boolean; ready?: boolean; error?: string; req?: number; ok?: unknown };
    if (data.listening) {
      worker.postMessage({ op: "init", wasm: absoluteHref(wasmUrl) });
      return;
    }
    if (data.ready !== undefined) {
      if (data.ready) settle.resolve();
      else fail(new Error(data.error ?? "module non chargé"));
      return;
    }
    const entry = h.pending.get(data.req ?? -1);
    if (!entry) return;
    h.pending.delete(data.req!);
    if (data.error !== undefined) entry.reject(new Error(data.error));
    else entry.resolve(data.ok);
    releaseIfIdle(h);
  };
  // Un worker qui ne démarre pas (script refusé, `type: "module"` inconnu d'un vieux navigateur) ou
  // qui meurt : tout ce qui attendait échoue, au lieu d'attendre pour toujours — le pipeline voit
  // une erreur de son, et la reconstruction en rouvre un neuf.
  worker.onerror = (event: ErrorEvent) => {
    event.preventDefault();
    fail(new Error(event.message || "le worker n'a pas démarré"));
  };
  worker.onmessageerror = () => fail(new Error("message illisible"));
  return h;
}

function call<T>(h: Host, message: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
  if (h.dead) return Promise.reject(lost(h.dead));
  const req = ++requests;
  return new Promise<T>((resolve, reject) => {
    // Une erreur du décodeur lui-même (« mémoire épuisée… », « …n'a pas pu s'ouvrir ») revient avec
    // son texte exact, celui du fil principal ; seule la perte du worker est nommée comme telle.
    h.pending.set(req, { resolve: resolve as (value: unknown) => void, reject });
    h.worker.postMessage({ ...message, req }, transfer);
  });
}

async function openInWorker(h: Host, mlp: boolean): Promise<TrueHdDecoder> {
  const id = ++decoders;
  await call(h, { op: "open", id, mlp });
  let closed = false;
  return {
    decode(blocks) {
      // Bout à bout dans un tampon neuf, transféré : les blocs sont des vues sur le cache d'octets
      // du lecteur, qu'un transfert viderait. Une seule copie, celle que le module faisait déjà
      // vers sa mémoire ; la réponse revient par transfert, sans copie.
      const sizes = new Uint32Array(blocks.length);
      let total = 0;
      blocks.forEach((block, i) => {
        sizes[i] = block.length;
        total += block.length;
      });
      const data = new ArrayBuffer(total);
      const bytes = new Uint8Array(data);
      let at = 0;
      for (const block of blocks) {
        bytes.set(block, at);
        at += block.length;
      }
      return call<DecodedBatch>(h, { op: "decode", id, data, sizes }, [data, sizes.buffer]);
    },
    // Sans réponse : le worker traite ses messages dans l'ordre, donc ce `reset` passe après le lot
    // déjà envoyé et avant ceux du nouvel endroit — comme sur le fil principal. Les lots d'avant le
    // saut qui reviennent encore sont jetés par truehdAudio.ts (`generation`).
    reset() {
      if (!closed && !h.dead) h.worker.postMessage({ op: "reset", id });
    },
    close() {
      // Une seule fois : fermer deux fois, c'est libérer deux fois la même mémoire.
      if (closed) return;
      closed = true;
      if (!h.dead) h.worker.postMessage({ op: "close", id });
      h.users--;
      releaseIfIdle(h);
    },
    thread: "worker",
  };
}

export async function openTrueHdDecoder(mlp: boolean): Promise<TrueHdDecoder> {
  if (refusedHere !== null) return openOnMainThread(mlp, refusedHere);
  if (typeof Worker === "undefined") return openOnMainThread(mlp, "pas de Worker");
  let h: Host;
  try {
    h = host ?? (host = createHost());
  } catch (error) {
    refusedHere = reasonOf(error);
    return openOnMainThread(mlp, refusedHere);
  }
  // Réservé tout de suite : le worker ne doit pas être terminé pendant qu'on attend qu'il soit prêt.
  h.users++;
  if (h.idle) clearTimeout(h.idle);
  h.idle = null;
  try {
    await h.ready;
  } catch (error) {
    h.users--;
    refusedHere = reasonOf(error);
    return openOnMainThread(mlp, refusedHere);
  }
  try {
    return await openInWorker(h, mlp);
  } catch (error) {
    h.users--;
    releaseIfIdle(h);
    throw error;
  }
}

/**
 * Télécharge sans les exécuter ce que le worker chargera — lui-même et le module (466 Ko, 191
 * compressés) : le service worker les garde, et le premier film en TrueHD ne les attend plus. Pour
 * le préchauffage — voir decoderWarmup.ts. Le module empaqueté du fil principal n'est pas
 * téléchargé : il ne sert qu'au repli.
 */
export async function warmTrueHd(): Promise<void> {
  await Promise.all(
    [new URL("./truehdWorker.mjs", import.meta.url), new URL("./truehd-wasm.mjs", import.meta.url)].map(async (url) => {
      const response = await fetch(url);
      await response.arrayBuffer();
    })
  );
}
