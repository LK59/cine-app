"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Check, Download, Trash2, X } from "lucide-react";
import { ActionSheet } from "@/components/ActionSheet";
import { useT } from "@/components/TranslationProvider";
import type { BookSummary } from "@/lib/books/types";
import { displayTitle } from "@/lib/books/displayTitle";
import { NoRoomError, ensureOfflineBooks, offlineBooksSupported, removeOfflineBook, saveOfflineBook, useOfflineBooks } from "@/lib/books/offlineBooks";
import { coverUrl } from "./BookCover";

const noop = () => () => {};

/**
 * Retirer un livre de l'appareil, toujours confirmé, comme un film (28/10/2026) : le retélécharger
 * demande du réseau, justement ce qui manque quand on lit hors ligne. Rend le geste qui ouvre la
 * confirmation, et la confirmation à monter.
 */
export function useBookRemoval(id: string, title: string, poster: string | null = null): { ask: () => void; sheet: React.ReactNode } {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const sheet = (
    <ActionSheet
      open={confirming}
      onClose={() => setConfirming(false)}
      role="alertdialog"
      centerOnWide
      title={title}
      subtitle={t("player.downloads.confirmRemove")}
      poster={poster}
      actions={[
        { label: t("books.removeDownload"), icon: <Trash2 size={18} />, variant: "danger", onClick: () => void removeOfflineBook(id) },
        { label: t("common.cancel"), icon: <X size={18} />, onClick: () => {} },
      ]}
    />
  );
  return { ask: () => setConfirming(true), sheet };
}

/**
 * « Télécharger » sur la fiche d'un livre (DECISIONS.md §127) : le livre gardé sur l'appareil, pour le
 * lire sans réseau. Puis « Sur l'appareil », et de quoi l'en retirer. Rien quand le navigateur ne sait
 * pas garder de fichiers (OPFS) ; et la fiche elle-même n'existe que les livres affichés pour ce compte.
 */
export function BookDownloadButton({ book, className = "" }: { book: BookSummary; className?: string }) {
  const t = useT();
  const supported = useSyncExternalStore(noop, offlineBooksSupported, () => false);
  const { books, progress } = useOfflineBooks();
  const [problem, setProblem] = useState<null | "room" | "failed">(null);
  const removal = useBookRemoval(book.id, displayTitle(book), coverUrl(book));
  useEffect(() => {
    if (supported) void ensureOfflineBooks();
  }, [supported]);
  if (!supported) return null;
  const kept = books.some((b) => b.id === book.id);
  const arriving = progress.get(book.id);

  const start = async () => {
    setProblem(null);
    try {
      await saveOfflineBook(book, displayTitle(book), coverUrl(book));
    } catch (error) {
      setProblem(error instanceof NoRoomError ? "room" : "failed");
    }
  };

  return (
    <div className={`flex flex-col items-center gap-1.5 sm:items-start ${className}`} data-book-download>
      {kept ? (
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-sm text-muted">
            <Check size={15} aria-hidden /> {t("books.downloaded")}
          </span>
          <button
            type="button"
            onClick={removal.ask}
            aria-label={t("books.removeDownload")}
            title={t("books.removeDownload")}
            className="flex h-8 w-8 items-center justify-center rounded-full text-subtle transition-colors hover:bg-white/10 hover:text-white"
          >
            <Trash2 size={15} aria-hidden />
          </button>
        </div>
      ) : arriving !== undefined ? (
        <div className="flex items-center gap-2 text-sm text-muted" aria-live="polite">
          <div className="h-1 w-24 overflow-hidden rounded-full bg-white/15">
            <div className="h-full rounded-full bg-white transition-[width]" style={{ width: `${Math.round(arriving * 100)}%` }} />
          </div>
          {t("books.downloading", { pct: Math.round(arriving * 100) })}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void start()}
          className="flex items-center gap-2 rounded-full bg-white/10 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-white/15 active:scale-95"
        >
          <Download size={16} aria-hidden />
          {t("books.download")}
        </button>
      )}
      {problem && <p className="text-xs text-warning">{problem === "room" ? t("books.noRoom") : t("books.downloadFailed")}</p>}
      {removal.sheet}
    </div>
  );
}
