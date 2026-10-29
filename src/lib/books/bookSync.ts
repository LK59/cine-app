/**
 * Ce que le lecteur de livres envoie au serveur — la position et les signets (DECISIONS.md §127) — et
 * qui doit survivre à une absence de réseau : un livre lu hors ligne (dans le train, en avion) garde
 * sa position et ses signets, et les rend au serveur au retour.
 *
 * Une **file** dans `localStorage` (`laterna:books:outbox`), bornée : une écriture qui n'a pas abouti
 * (pas de réseau, ou une erreur 5xx — un redémarrage) y attend, et repart à la prochaine occasion — le
 * retour du réseau (`online`), l'ouverture d'un livre. Une position par livre (la dernière remplace les
 * précédentes, avec l'heure où elle a été lue : le serveur ne l'écrit pas par-dessus une plus récente) ;
 * les signets dans l'ordre. Un refus (4xx) n'est pas retenté.
 *
 * La dernière position et la liste des signets d'un livre sont aussi gardées sur l'appareil, pour
 * rouvrir un livre téléchargé sans réseau au bon endroit. Tout passe par `try` : un stockage refusé
 * (navigation privée) ne casse rien, la lecture marche, seulement sans mémoire hors ligne. Tout est rangé
 * sous `laterna:books:`, que la déconnexion efface (`signOut.ts`) — sauf les réglages du lecteur.
 */

export interface ProgressBody {
  cfi: string;
  fraction: number;
  finished: boolean;
  /** L'heure de lecture (ms) — le serveur ne remplace pas une position plus récente. */
  at: number;
}

export interface BookmarkBody {
  cfi: string;
  fraction?: number;
  chapter?: string;
  excerpt?: string;
  remove?: boolean;
}

export type BookOp = { kind: "progress"; id: string; body: ProgressBody } | { kind: "bookmark"; id: string; body: BookmarkBody };

const OUTBOX = "laterna:books:outbox";
const MAX_OUTBOX = 300;
const posKey = (id: string) => `laterna:books:pos:${id}`;
const marksKey = (id: string) => `laterna:books:marks:${id}`;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* stockage refusé ou plein : sans mémoire hors ligne */
  }
}

export function outbox(): BookOp[] {
  const list = read<unknown>(OUTBOX, []);
  return Array.isArray(list) ? (list as BookOp[]) : [];
}

function enqueue(op: BookOp): void {
  let list = outbox();
  // Une seule position par livre : la dernière.
  if (op.kind === "progress") list = list.filter((o) => !(o.kind === "progress" && o.id === op.id));
  // Un signet posé puis retiré (ou l'inverse) avant d'avoir pu partir : seule la dernière intention compte.
  if (op.kind === "bookmark") list = list.filter((o) => !(o.kind === "bookmark" && o.id === op.id && o.body.cfi === op.body.cfi));
  list.push(op);
  write(OUTBOX, list.slice(-MAX_OUTBOX));
}

const url = (op: BookOp) => `/api/books/${op.id}/${op.kind === "progress" ? "progress" : "bookmarks"}`;

/** Le corps envoyé : une position dit aussi son âge, mesuré maintenant (`readAt` côté serveur). */
const wire = (op: BookOp) => JSON.stringify(op.kind === "progress" ? { ...op.body, ageMs: Math.max(0, Date.now() - op.body.at) } : op.body);

/**
 * `true` : le serveur a répondu (accepté ou refusé pour de bon) ; `false` : à retenter. Une session
 * expirée (401) ou une limite (429) n'est pas un refus de l'écriture : elle attend la reconnexion. Tenue
 * pour « faite » (29/10/2026), une lecture hors ligne de plusieurs jours rendue après l'expiration de la
 * session perdait toutes ses positions et tous ses signets.
 */
async function deliver(op: BookOp): Promise<{ done: boolean; response: Response | null }> {
  try {
    const res = await fetch(url(op), { method: "POST", body: wire(op), headers: { "Content-Type": "application/json" }, keepalive: true });
    if (res.status >= 500 || res.status === 401 || res.status === 429) return { done: false, response: res };
    return { done: true, response: res };
  } catch {
    return { done: false, response: null };
  }
}

/**
 * Envoie une écriture ; si elle ne passe pas, elle attend dans la file. Rend la réponse du serveur
 * quand il y en a une (les signets renvoient la liste à jour).
 */
export async function sendBookOp(op: BookOp): Promise<Response | null> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    enqueue(op);
    return null;
  }
  const { done, response } = await deliver(op);
  if (!done) enqueue(op);
  return done ? response : null;
}

/** La page se ferme : la position part par `sendBeacon` si le réseau est là, et attend sinon. */
export function beaconProgress(id: string, body: ProgressBody): void {
  rememberPosition(id, body);
  const op: BookOp = { kind: "progress", id, body };
  if (typeof navigator === "undefined" || navigator.onLine === false || typeof navigator.sendBeacon !== "function") {
    enqueue(op);
    return;
  }
  if (!navigator.sendBeacon(url(op), new Blob([wire(op)], { type: "application/json" }))) enqueue(op);
}

let flushing: Promise<void> | null = null;

/** Renvoie ce qui attend, dans l'ordre ; s'arrête au premier échec de réseau (la suite attendra encore). */
export function flushOutbox(): Promise<void> {
  flushing ??= (async () => {
    try {
      for (const op of outbox()) {
        const { done } = await deliver(op);
        if (!done) return;
        const rest = outbox().filter((o) => !(o.kind === op.kind && o.id === op.id && JSON.stringify(o.body) === JSON.stringify(op.body)));
        write(OUTBOX, rest);
      }
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

/** Une fois par page : la file repart au retour du réseau. */
let listening = false;
export function listenForReconnect(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("online", () => void flushOutbox());
}

/** Les écritures de signets encore en attente pour ce livre (la liste affichée en tient compte). */
export function pendingBookmarks(id: string): BookmarkBody[] {
  return outbox().flatMap((o) => (o.kind === "bookmark" && o.id === id ? [o.body] : []));
}

// ─── Ce que l'appareil garde de chaque livre ────────────────────────────────────────────────

export function rememberPosition(id: string, body: ProgressBody): void {
  write(posKey(id), body);
}

export function rememberedPosition(id: string): ProgressBody | null {
  const p = read<ProgressBody | null>(posKey(id), null);
  return p && typeof p.cfi === "string" && typeof p.at === "number" ? p : null;
}

export interface StoredBookmark {
  cfi: string;
  fraction: number;
  chapter: string;
  excerpt: string;
  createdAt: number;
}

export function rememberBookmarks(id: string, list: StoredBookmark[]): void {
  write(marksKey(id), list);
}

export function rememberedBookmarks(id: string): StoredBookmark[] {
  const list = read<unknown>(marksKey(id), []);
  return Array.isArray(list) ? (list as StoredBookmark[]) : [];
}

/** La liste du serveur, corrigée de ce qui attend encore dans la file (ajouts et retraits pas encore partis). */
export function mergeBookmarks(server: StoredBookmark[], pending: BookmarkBody[], now = Date.now()): StoredBookmark[] {
  const byCfi = new Map(server.map((b) => [b.cfi, b]));
  for (const p of pending) {
    if (p.remove) byCfi.delete(p.cfi);
    else byCfi.set(p.cfi, { cfi: p.cfi, fraction: p.fraction ?? 0, chapter: p.chapter ?? "", excerpt: p.excerpt ?? "", createdAt: byCfi.get(p.cfi)?.createdAt ?? now });
  }
  return [...byCfi.values()].sort((a, b) => a.fraction - b.fraction || a.createdAt - b.createdAt);
}
