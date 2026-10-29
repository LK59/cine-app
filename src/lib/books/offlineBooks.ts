"use client";

import { useSyncExternalStore } from "react";
import type { BookSummary } from "@/lib/books/types";
import { OFFLINE_BOOKS_BYTES_KEY, OFFLINE_BOOKS_COUNT_KEY, OFFLINE_BOOKS_SHOWN_KEY, WARM_OFFLINE_BOOKS_ENTRY, warmBooksOfflineEntries } from "@/lib/offline/offlineEntry";

/**
 * Les livres gardés sur l'appareil pour les lire sans réseau (DECISIONS.md §127).
 *
 * À part des téléchargements de films (`src/lib/offline/`), qui n'en savent rien : un EPUB pèse quelques
 * mégaoctets et arrive d'un coup, sans tâche côté serveur, sans reprise ni morceaux. Même rangement
 * pourtant — le système de fichiers privé du site (OPFS), un dossier par compte, un par livre :
 * `laterna-books/<compte>/<livre>/` avec `book.epub`, `meta.json` (ce que la liste et la fiche montrent)
 * et `cover`. Écrit d'un bloc (`createWritable`, qui n'écrit le fichier qu'à la fermeture : un livre à
 * moitié reçu n'existe pas). La place est demandée au navigateur avant (`navigator.storage.estimate`).
 *
 * Le compte est celui de la session, demandé une fois au serveur (`/api/books/me`) et retenu sur
 * l'appareil (`laterna:books:offline-account`) pour la page hors ligne, qui ne peut pas le demander. La
 * déconnexion l'oublie (`signOut.ts`) ; les fichiers restent, comme ceux des films.
 */

const ROOT = "laterna-books";
const ACCOUNT_KEY = "laterna:books:offline-account";
/** Combien de livres l'appareil garde : lu par la page des téléchargements sans rien charger d'autre. */
export const OFFLINE_COUNT_KEY = OFFLINE_BOOKS_COUNT_KEY;
/** La marge laissée au navigateur en plus du livre. */
const MARGIN_BYTES = 50 * 1024 * 1024;
/** Le message qui demande au service worker de garder la page hors ligne des livres. */
export const WARM_OFFLINE_BOOKS = WARM_OFFLINE_BOOKS_ENTRY;
export const OFFLINE_BOOKS_PATH = "/livres/hors-ligne";

export interface OfflineBook {
  id: string;
  name: string;
  title: string;
  authors: string[];
  seriesName: string | null;
  index: number | null;
  year: number | null;
  bytes: number;
  savedAt: number;
  fileTag: string | null;
  hasCover: boolean;
}

export function offlineBooksSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";
}

const safe = (account: string) => encodeURIComponent(account.toLowerCase());

async function dir(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
  let d = await navigator.storage.getDirectory();
  for (const p of parts) d = await d.getDirectoryHandle(p, { create });
  return d;
}

// ─── Le compte ───────────────────────────────────────────────────────────────────────────────

let accountPromise: Promise<string | null> | null = null;

export function rememberedBookAccount(): string | null {
  try {
    return localStorage.getItem(ACCOUNT_KEY);
  } catch {
    return null;
  }
}

/** Le compte de la session ; sans réseau, celui retenu sur l'appareil. */
export function bookAccount(): Promise<string | null> {
  accountPromise ??= fetch("/api/books/me", { cache: "no-store" })
    .then(async (res) => {
      if (!res.ok) return rememberedBookAccount();
      const { account } = (await res.json()) as { account?: string };
      if (!account) return null;
      try {
        localStorage.setItem(ACCOUNT_KEY, account);
      } catch {
        /* sans mémoire : la page hors ligne ne saura pas quel dossier montrer */
      }
      return account;
    })
    .catch(() => rememberedBookAccount());
  return accountPromise;
}

// ─── La liste, partagée par les écrans ───────────────────────────────────────────────────────

let books: OfflineBook[] = [];
let loadedFor: string | null = null;
const progress = new Map<string, number>();
const listeners = new Set<() => void>();
let snapshot = { books, progress: new Map(progress) };
const emit = () => {
  snapshot = { books, progress: new Map(progress) };
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const EMPTY = { books: [] as OfflineBook[], progress: new Map<string, number>() };

/** Les livres de l'appareil et ceux qui arrivent (avancement de 0 à 1). */
export function useOfflineBooks(): { books: OfflineBook[]; progress: Map<string, number> } {
  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
}

function noteCount(): void {
  try {
    localStorage.setItem(OFFLINE_COUNT_KEY, String(books.length));
    localStorage.setItem(OFFLINE_BOOKS_BYTES_KEY, String(books.reduce((sum, b) => sum + (b.bytes || 0), 0)));
  } catch {
    /* rien */
  }
}

/** Relit le dossier du compte. */
export async function loadOfflineBooks(account: string | null): Promise<OfflineBook[]> {
  if (!account || !offlineBooksSupported()) return [];
  const out: OfflineBook[] = [];
  try {
    const root = await dir([ROOT, safe(account)], true);
    for await (const [name, handle] of (root as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (handle.kind !== "directory") continue;
      // Un livre qui arrive en ce moment n'a pas encore sa description : il n'est pas interrompu. Pris
      // pour tel (29/10/2026), ouvrir la page des téléchargements pendant qu'un livre arrivait l'effaçait.
      if (progress.has(name)) continue;
      try {
        const meta = await (await (handle as FileSystemDirectoryHandle).getFileHandle("meta.json")).getFile();
        const parsed = JSON.parse(await meta.text()) as OfflineBook;
        if (parsed.id === name) out.push(parsed);
      } catch {
        // Un dossier sans description : un livre interrompu en route. Il part.
        await root.removeEntry(name, { recursive: true }).catch(() => {});
      }
    }
  } catch {
    return [];
  }
  out.sort((a, b) => b.savedAt - a.savedAt);
  books = out;
  loadedFor = account;
  noteCount();
  emit();
  return out;
}

export async function ensureOfflineBooks(): Promise<void> {
  const account = await bookAccount();
  if (account && loadedFor !== account) await loadOfflineBooks(account);
}

/**
 * Au lancement en ligne, quand l'appareil ne se croit sans livre : relit ce qu'il garde vraiment. La
 * déconnexion efface le compte et le compteur (`signOut.ts`) mais laisse les fichiers — après une
 * reconnexion, les livres gardés manquaient aux téléchargements et au lancement sans réseau jusqu'à
 * la fiche d'un livre rouverte (29/10/2026). Rien du tout sans dossier des livres sur l'appareil.
 */
export async function recountOfflineBooks(): Promise<number> {
  if (!offlineBooksSupported()) return 0;
  try {
    await (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT);
  } catch {
    return 0;
  }
  await ensureOfflineBooks();
  return books.length;
}

export function offlineBook(id: string): OfflineBook | null {
  return books.find((b) => b.id === id) ?? null;
}

// ─── Garder, lire, retirer ───────────────────────────────────────────────────────────────────

export class NoRoomError extends Error {
  constructor() {
    super("pas assez de place");
  }
}

/** Garde ce livre sur l'appareil. Lève `NoRoomError` quand le navigateur n'a pas la place. */
export async function saveOfflineBook(book: BookSummary, title: string, coverUrl: string | null): Promise<void> {
  const account = await bookAccount();
  if (!account || !offlineBooksSupported()) throw new Error("indisponible");
  progress.set(book.id, 0);
  emit();
  // Un livre déjà gardé (sa fiche ouverte avant que la liste ne soit relue) : un nouvel essai qui échoue
  // ne doit pas emporter la bonne copie (29/10/2026). `createWritable` n'écrit qu'à la fermeture.
  const keptBefore = await dir([ROOT, safe(account), book.id], false)
    .then((d) => d.getFileHandle("meta.json"))
    .then(() => true)
    .catch(() => false);
  try {
    const res = await fetch(`/api/books/${book.id}/file`);
    if (!res.ok || !res.body) throw new Error(`fichier ${res.status}`);
    const size = Number(res.headers.get("Content-Length") ?? 0);
    try {
      const { quota, usage } = await navigator.storage.estimate();
      if (typeof quota === "number" && typeof usage === "number" && quota - usage < size + MARGIN_BYTES) {
        await res.body.cancel().catch(() => {});
        throw new NoRoomError();
      }
    } catch (error) {
      if (error instanceof NoRoomError) throw error;
      /* le navigateur ne dit rien de sa place : on essaie */
    }
    // Les livres gardés ne doivent pas partir au premier ménage du navigateur.
    void navigator.storage.persist?.().catch(() => false);
    const folder = await dir([ROOT, safe(account), book.id], true);
    const file = await (await folder.getFileHandle("book.epub", { create: true })).createWritable();
    const reader = res.body.getReader();
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await file.write(value);
        received += value.byteLength;
        if (size > 0) {
          progress.set(book.id, Math.min(0.99, received / size));
          emit();
        }
      }
      await file.close();
    } catch (error) {
      await file.abort?.().catch(() => {});
      throw error;
    }
    let hasCover = false;
    if (coverUrl) {
      try {
        const cover = await fetch(coverUrl);
        if (cover.ok) {
          const w = await (await folder.getFileHandle("cover", { create: true })).createWritable();
          await w.write(await cover.blob());
          await w.close();
          hasCover = true;
        }
      } catch {
        /* sans couverture : la couverture dessinée la remplace */
      }
    }
    const meta: OfflineBook = {
      id: book.id,
      name: book.name,
      title,
      authors: book.authors,
      seriesName: book.seriesName,
      index: book.index,
      year: book.year,
      bytes: received,
      savedAt: Date.now(),
      fileTag: book.fileTag,
      hasCover,
    };
    // La description en dernier : un dossier sans elle est un livre interrompu.
    const m = await (await folder.getFileHandle("meta.json", { create: true })).createWritable();
    await m.write(JSON.stringify(meta));
    await m.close();
    books = [meta, ...books.filter((b) => b.id !== book.id)];
    noteCount();
    // Les deux entrées hors ligne, pas seulement celle des livres : lancée sans réseau, l'app ouvre
    // `offline.html`, dont le bouton « Accéder aux téléchargements » ne paraît que si `/hors-ligne` est
    // gardée — et elle ne l'était que pour un appareil qui gardait un film (29/10/2026).
    warmBooksOfflineEntries();
    try {
      // Un livre vient d'arriver : les livres sont affichés pour ce compte, la page hors ligne doit le savoir.
      localStorage.setItem(OFFLINE_BOOKS_SHOWN_KEY, "1");
    } catch {
      /* rien */
    }
  } catch (error) {
    if (!keptBefore) await removeFolder(account, book.id);
    throw error;
  } finally {
    progress.delete(book.id);
    emit();
  }
}

async function removeFolder(account: string, id: string): Promise<void> {
  try {
    const root = await dir([ROOT, safe(account)], false);
    await root.removeEntry(id, { recursive: true });
  } catch {
    /* déjà parti */
  }
}

export async function removeOfflineBook(id: string): Promise<void> {
  const account = (await bookAccount()) ?? rememberedBookAccount();
  if (!account) return;
  await removeFolder(account, id);
  books = books.filter((b) => b.id !== id);
  noteCount();
  emit();
}

/** Le fichier gardé de ce livre, ou `null`. */
export async function offlineBookFile(id: string, account?: string | null): Promise<File | null> {
  const who = account ?? (await bookAccount());
  if (!who || !offlineBooksSupported()) return null;
  try {
    return await (await (await dir([ROOT, safe(who), id], false)).getFileHandle("book.epub")).getFile();
  } catch {
    return null;
  }
}

/** L'image de couverture gardée, en adresse locale, ou `null`. */
export async function offlineBookCover(id: string, account: string): Promise<string | null> {
  try {
    const f = await (await (await dir([ROOT, safe(account), id], false)).getFileHandle("cover")).getFile();
    return URL.createObjectURL(f);
  } catch {
    return null;
  }
}

/** Demande au service worker de garder la page hors ligne des livres et son code (une fois par build). */
export function warmOfflineBooksPage(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.ready.then((r) => r.active?.postMessage({ type: WARM_OFFLINE_BOOKS })).catch(() => {});
}

export const __testing = {
  reset: () => {
    books = [];
    loadedFor = null;
    accountPromise = null;
    progress.clear();
    emit();
  },
};
