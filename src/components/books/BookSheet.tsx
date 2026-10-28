"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import useSWR from "swr";
import { BookOpen, Check, X } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { fetcher } from "@/lib/swr";
import { displayTitle } from "@/lib/books/displayTitle";
import type { BookDetail, BookSummary } from "@/lib/books/types";
import { BookCover } from "./BookCover";

/** D'où la fiche part : la couverture touchée, à sa place à l'écran. */
export interface MorphOrigin {
  id: string;
  rect: DOMRect;
}

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

/** La transformation qui pose `el` (à sa place finale) sur `from`. */
function poseOn(el: HTMLElement, from: DOMRect): string {
  const to = el.getBoundingClientRect();
  if (to.width === 0 || from.width === 0) return "none";
  const sx = from.width / to.width;
  const sy = from.height / to.height;
  return `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${sx}, ${sy})`;
}

const reducedMotion = () => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

/**
 * La fiche d'un livre (DECISIONS.md §127) : couverture, titre, auteur, série et tome, année, résumé,
 * genres, et « Lire » / « Reprendre » avec l'avancement.
 *
 * La couverture touchée devient celle de la fiche, et la fiche y revient en se fermant — la même idée
 * que les fiches des films (§61), écrite ici en petit : ni rangées qui reculent, ni continuité de
 * bannière, rien de ce que le cinéma partage. Une fiche qui se ferme n'a plus d'avis : ni touches, ni
 * pointeur. Cachée sous le lecteur (`hidden`), elle reste montée pour réapparaître telle quelle.
 */
export function BookSheet({
  id,
  summary,
  origin,
  hidden,
  onRead,
  onClose,
}: {
  id: string;
  summary: BookSummary | null;
  origin: MorphOrigin | null;
  hidden: boolean;
  onRead: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const { data: detail, error } = useSWR<BookDetail>(`/api/books/${id}`, fetcher);
  // La série telle que la grille l'a jugée (`withoutFolderSeries`) : la fiche seule ne voit pas les
  // voisins du livre, et répéterait le nom du dossier.
  const book: BookSummary | null = detail ? (summary ? { ...detail, seriesName: summary.seriesName } : detail) : summary;
  const coverRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // L'entrée : la couverture part de la carte, le reste de la fiche monte en fondu.
  useLayoutEffect(() => {
    if (reducedMotion()) return;
    const panel = panelRef.current;
    backdropRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: "ease-out" });
    panel?.animate([{ opacity: 0, transform: "translateY(24px)" }, { opacity: 1, transform: "none" }], { duration: 340, easing: EASE });
    const cover = coverRef.current;
    if (cover && origin) {
      cover.animate([{ transform: poseOn(cover, origin.rect), transformOrigin: "0 0" }, { transform: "none", transformOrigin: "0 0" }], { duration: 460, easing: EASE });
    }
    // À l'ouverture seulement : la fiche ne rejoue pas son entrée quand le livre arrive du réseau.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    if (closing) return;
    if (reducedMotion()) {
      onClose();
      return;
    }
    setClosing(true);
    const cover = coverRef.current;
    // La carte d'origine, si elle est encore à l'écran : la grille a pu défiler derrière la fiche.
    const card = origin ? document.querySelector(`[data-book-id="${origin.id}"] [data-book-cover]`) : null;
    const target = card?.getBoundingClientRect() ?? null;
    const visible = target && target.bottom > 0 && target.top < window.innerHeight;
    const runs: Promise<unknown>[] = [];
    if (cover && visible) {
      runs.push(cover.animate([{ transform: "none", transformOrigin: "0 0" }, { transform: poseOn(cover, target), transformOrigin: "0 0" }], { duration: 380, easing: EASE, fill: "forwards" }).finished);
    }
    const panel = panelRef.current;
    runs.push(panel?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: visible ? 260 : 200, easing: "ease-in", fill: "forwards" }).finished ?? Promise.resolve());
    runs.push(backdropRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: "ease-in", fill: "forwards" }).finished ?? Promise.resolve());
    void Promise.allSettled(runs).then(onClose);
  };

  useEffect(() => {
    if (hidden || closing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const progress = book?.progress ?? null;
  const pct = progress ? Math.round(progress.fraction * 100) : 0;
  const finished = progress?.finished === true || book?.played === true;
  const readLabel = progress && !progress.finished && pct > 0 ? t("books.resume", { pct }) : finished ? t("books.readAgain") : t("books.read");
  const overview = detail?.overview ?? "";
  const long = overview.length > 420;

  return (
    <div className="fixed inset-0 z-[200]" style={{ visibility: hidden ? "hidden" : "visible", pointerEvents: closing || hidden ? "none" : "auto" }} aria-hidden={hidden}>
      <div ref={backdropRef} className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={close} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={book ? displayTitle(book) : ""}
        className="pointer-events-none absolute inset-0 flex items-end justify-center sm:items-center sm:p-8"
      >
        <div
          ref={panelRef}
          className="pointer-events-auto relative flex max-h-[calc(100%-env(safe-area-inset-top)-2.5rem)] w-full flex-col overflow-hidden rounded-t-2xl bg-ink shadow-2xl shadow-black/60 sm:max-h-[88vh] sm:max-w-3xl sm:rounded-2xl"
        >
          {/* La couverture en grand, floue, derrière l'en-tête : la fiche prend la couleur du livre. */}
          {book?.coverTag && (
            <div className="pointer-events-none absolute inset-x-0 top-0 h-72 overflow-hidden opacity-50" aria-hidden>
              <div className="absolute inset-0 scale-125 blur-3xl">
                <BookCover book={book} className="h-full w-full !aspect-auto" eager />
              </div>
              <div className="absolute inset-0 bg-gradient-to-b from-transparent via-ink/60 to-ink" />
            </div>
          )}
          <button
            type="button"
            onClick={close}
            aria-label={t("books.close")}
            className="nav-glass absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full text-white"
          >
            <X size={18} aria-hidden />
          </button>

          <div className="relative overflow-y-auto overscroll-contain px-5 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-8 sm:px-8 sm:pb-8">
            <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start sm:gap-8">
              <div ref={coverRef} className="w-40 shrink-0 overflow-hidden rounded-lg shadow-2xl shadow-black/60 sm:w-56">
                {book ? <BookCover book={book} eager /> : <div className="aspect-[2/3] animate-pulse bg-surface" />}
              </div>
              <div className="min-w-0 flex-1 text-center sm:pt-2 sm:text-left">
                {book?.seriesName && (
                  <p className="text-sm font-medium uppercase tracking-wide text-subtle">
                    {book.index !== null ? t("books.seriesTome", { series: book.seriesName, n: book.index }) : book.seriesName}
                  </p>
                )}
                <h2 className="mt-1 text-balance font-display text-2xl font-semibold leading-tight sm:text-3xl">{book ? displayTitle(book) : ""}</h2>
                <p className="mt-2 text-muted">
                  {[book?.authors.length ? book.authors.join(", ") : null, book?.year ?? null].filter(Boolean).join(" · ")}
                </p>

                <div className="mt-5 flex flex-col items-center gap-3 sm:items-start">
                  <button
                    type="button"
                    onClick={onRead}
                    disabled={!book}
                    className="flex items-center gap-2 rounded-full bg-white px-6 py-2.5 font-semibold text-ink transition-transform active:scale-95 disabled:opacity-50"
                  >
                    <BookOpen size={18} aria-hidden />
                    {readLabel}
                  </button>
                  {progress && !progress.finished && pct > 0 && (
                    <div className="h-1 w-48 overflow-hidden rounded-full bg-white/15">
                      <div className="h-full rounded-full bg-white" style={{ width: `${pct}%` }} />
                    </div>
                  )}
                  {finished && (
                    <p className="flex items-center gap-1.5 text-sm text-subtle">
                      <Check size={15} aria-hidden /> {t("books.finished")}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {error && !detail && <p className="mt-8 text-center text-sm text-subtle">{t("books.detailError")}</p>}
            {overview && (
              <div className="mt-8">
                <p className={`whitespace-pre-line text-pretty leading-relaxed text-muted ${long && !expanded ? "line-clamp-6" : ""}`}>{overview}</p>
                {long && (
                  <button type="button" onClick={() => setExpanded((v) => !v)} className="mt-2 text-sm font-semibold text-white">
                    {expanded ? t("books.less") : t("books.more")}
                  </button>
                )}
              </div>
            )}
            {detail && detail.genres.length > 0 && (
              <div className="mt-6 flex flex-wrap justify-center gap-2 sm:justify-start">
                {detail.genres.map((g) => (
                  <span key={g} className="rounded-full bg-white/10 px-3 py-1 text-xs text-muted">
                    {g}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
