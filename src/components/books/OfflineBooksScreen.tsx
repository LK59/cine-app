"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { BookOpen, ChevronLeft, Trash2 } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import {
  bookAccount,
  loadOfflineBooks,
  offlineBookCover,
  offlineBooksSupported,
  rememberedBookAccount,
  removeOfflineBook,
  useOfflineBooks,
  warmOfflineBooksPage,
  type OfflineBook,
} from "@/lib/books/offlineBooks";
import { DrawnCover } from "./BookCover";
import { useBookRemoval } from "./BookDownload";
import { flushOutbox, listenForReconnect } from "@/lib/books/bookSync";

const BookReader = dynamic(() => import("./BookReader").then((m) => m.BookReader), { ssr: false });

/**
 * Les livres gardés sur l'appareil, lisibles sans réseau (DECISIONS.md §127) — la page `/livres/hors-ligne`.
 *
 * Publique et rendue sans session, comme l'entrée hors ligne des films (`/hors-ligne`) : le service
 * worker la garde avec tout son code et la sert quand le serveur ne répond pas. Elle ne montre que le
 * dossier du compte retenu sur l'appareil, et n'ouvre que les copies de l'appareil (`BookReader`,
 * `offline`) — sous la politique de sécurité des livres (`next.config.js`), sans laquelle le lecteur ne
 * peut pas afficher ses chapitres. La position et les signets écrits ici attendent le réseau
 * (`bookSync.ts`).
 */
function subscribeHash(listener: () => void): () => void {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}
const hashBook = () => /(?:^#|&)livre=([0-9a-f]{32})(?:&|$)/.exec(window.location.hash)?.[1] ?? null;
const noop = () => () => {};

export function OfflineBooksScreen() {
  const t = useT();
  const supported = useSyncExternalStore(noop, offlineBooksSupported, () => true);
  const reading = useSyncExternalStore(subscribeHash, hashBook, () => null);
  const { books } = useOfflineBooks();
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Le compte retenu d'abord (sans réseau, c'est tout ce qu'on a), puis celui de la session s'il répond.
    const remembered = rememberedBookAccount();
    void loadOfflineBooks(remembered).then(async () => {
      if (cancelled) return;
      setLoaded(true);
      const live = await bookAccount();
      if (!cancelled && live && live !== remembered) await loadOfflineBooks(live);
    });
    warmOfflineBooksPage();
    // Ce qui a été lu ici sans réseau repart dès qu'il revient — et tout de suite s'il est déjà là.
    listenForReconnect();
    void flushOutbox().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Le lecteur a son entrée d'historique : Retour le referme.
  const open = (id: string) => {
    window.history.pushState({ offlineBook: true }, "", `#livre=${id}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  };
  const close = () => {
    if ((window.history.state as { offlineBook?: boolean } | null)?.offlineBook) window.history.back();
    else {
      window.history.replaceState(null, "", window.location.pathname);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
  };
  const shown = reading ? books.find((b) => b.id === reading) : undefined;

  return (
    <div className="fixed inset-0 overflow-y-auto overscroll-contain bg-ink text-white" style={{ paddingTop: "env(safe-area-inset-top)" }}>
      <header className="sticky top-0 z-10 flex items-center gap-3 bg-gradient-to-b from-ink via-ink/95 to-ink/0 px-4 pb-5 pt-4 sm:px-8">
        {/* Un lien ordinaire : l'entrée hors ligne des téléchargements a sa propre page. */}
        <a href="/hors-ligne" aria-label={t("books.offlineBack")} className="nav-glass flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white">
          <ChevronLeft size={19} aria-hidden />
        </a>
        <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">{t("books.offlineTitle")}</h1>
      </header>
      <main className="px-4 pb-24 sm:px-8">
        {!supported && <p className="mt-16 text-center text-muted">{t("books.offlineUnavailable")}</p>}
        {supported && loaded && books.length === 0 && <p className="mx-auto mt-16 max-w-sm text-center text-muted">{t("books.offlineEmpty")}</p>}
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-x-3 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] sm:gap-x-5" data-offline-books>
          {books.map((b) => (
            <li key={b.id}>
              <OfflineBookCard book={b} onOpen={() => open(b.id)} />
            </li>
          ))}
        </ul>
      </main>
      {reading &&
        createPortal(<BookReader key={reading} id={reading} title={shown?.title ?? ""} offline onClose={close} />, document.body)}
    </div>
  );
}

/** Une carte de la page hors ligne : la couverture gardée, ou dessinée ; retirer de l'appareil d'un geste. */
export function OfflineBookCard({ book, onOpen }: { book: OfflineBook; onOpen: () => void }) {
  const t = useT();
  const [cover, setCover] = useState<string | null>(null);
  const removal = useBookRemoval(book.id, book.title, cover);
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    const account = rememberedBookAccount();
    if (book.hasCover && account) {
      void offlineBookCover(book.id, account).then((u) => {
        url = u;
        if (cancelled) {
          if (u) URL.revokeObjectURL(u);
          return;
        }
        setCover(u);
      });
    }
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [book.id, book.hasCover]);
  return (
    <div className="group relative">
      <button type="button" onClick={onOpen} data-offline-book={book.id} className="w-full text-left">
        <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-surface shadow-lg shadow-black/40 [container-type:inline-size]">
          {cover ? (
            // eslint-disable-next-line @next/next/no-img-element -- une image de l'appareil (adresse locale), rien à optimiser.
            <img src={cover} alt="" className="absolute inset-0 h-full w-full object-cover" />
          ) : (
            <DrawnCover book={{ name: book.name, seriesName: book.seriesName, index: book.index, authors: book.authors }} />
          )}
          <span className="absolute bottom-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/60" aria-hidden>
            <BookOpen size={13} />
          </span>
        </div>
        <p className="mt-2 line-clamp-2 text-sm font-medium leading-snug">{book.title}</p>
        {book.authors[0] && <p className="mt-0.5 truncate text-xs text-subtle">{book.authors[0]}</p>}
      </button>
      <button
        type="button"
        onClick={removal.ask}
        aria-label={t("books.removeDownload")}
        title={t("books.removeDownload")}
        className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white opacity-80 transition-opacity hover:opacity-100"
      >
        <Trash2 size={13} aria-hidden />
      </button>
      {removal.sheet}
    </div>
  );
}
