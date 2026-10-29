"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import useSWR, { useSWRConfig } from "swr";
import { BookOpen, FileDown, X } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { fetcher } from "@/lib/swr";
import { arrivedByBack, cinemaClose, useCinemaRoute } from "@/lib/cinemaRoute";
import { useSheetTransition } from "@/lib/sheetMorph/desktopContinuity";
import { useSwipeToDismiss, NOT_THE_HANDLE } from "@/lib/useSwipeToDismiss";
import { useSheetExit } from "@/lib/useSheetExit";
import { useExitDelay } from "@/lib/useExitDelay";
import { SHEET_OUT_MS, SHEET_UNMOUNT_SLACK_MS, detailColumnMotion, phoneSheetCorner, phoneSheetShadow, sheetMotionClass } from "@/lib/sheetMotion";
import { useIsMobile } from "@/lib/useIsMobile";
import { setOfflineSheetOpen } from "@/lib/offline/offlineSheetOpen";
import { displayTitle } from "@/lib/books/displayTitle";
import { readPercent, type BookDetail, type BookSummary } from "@/lib/books/types";
import { BookCover, coverUrl } from "./BookCover";
import { BookDownloadButton } from "./BookDownload";
import { MarkReadButton, ReadingListButton } from "./ReadingList";
import { isInstalledApp } from "@/lib/iosInstall";
import { useCoverWash } from "./coverWash";
import { preloadBookFile, saveData } from "@/lib/books/readerPreload";
import { BOOKS_PROGRESS_EVENT } from "@/lib/books/readerFrame";

const noopSubscribe = () => () => {};

/**
 * La fiche d'un livre (DECISIONS.md §127), dans le cycle de vie des fiches de l'application
 * (CLAUDE.md, « The sheet lifecycle ») — les mêmes pièces que la fiche d'un titre, réutilisées telles
 * quelles :
 *
 * - l'adresse : `#livre=<id>` (`cinemaRoute`), ouverte d'une entrée d'historique, refermée par
 *   `cinemaClose` — Retour, Échap et le bouton Retour d'Android la referment comme une fiche de film,
 *   un seul `history.back()` en vol ;
 * - l'entrée et la sortie : `useSheetTransition` (§61) — sur téléphone et iPad la couverture touchée
 *   devient la fiche, et la fiche y retourne ; sur un ordinateur, la continuité du bureau ;
 * - `arrivedByBack` lu une fois au montage : revenue par un retour (du lecteur), elle se découvre ;
 * - le glisser vers le bas (`useSwipeToDismiss`, dont la prise de pointeur est `usePointerCapture`) ;
 * - `useSheetExit` : une fiche qui sort n'écoute plus ni touches ni pointeur ;
 * - montée par `BookSheetHost` avec `useExitDelay`, une instance par livre (`key`).
 */

const EXIT_DESKTOP_MS = 200;
/** Combien de temps sur une fiche avant de préparer la lecture. */
const READ_INTENT_MS = 600;

/** « Lire » est probable : ce que l'hôte prépare pour la lecture, et la fonction qui le défait. */
export type ReadIntent = (id: string) => () => void;

/**
 * La fiche d'après l'adresse : montée tant qu'elle est nommée, gardée le temps de sa sortie.
 * `onReadIntent` : dans le cinéma, le lecteur posé dans un cadre se prépare (`standbyReaderFrame`, §128).
 */
export function BookSheetHost({
  books,
  onRead,
  onReadIntent,
}: {
  books: readonly BookSummary[];
  onRead: (book: BookSummary | null, id: string, cover: HTMLElement | null) => void;
  onReadIntent?: ReadIntent;
}) {
  const route = useCinemaRoute();
  const isMobile = useIsMobile();
  const open = !!route.book && !route.reading;
  const exit = useExitDelay(open, isMobile ? SHEET_OUT_MS + SHEET_UNMOUNT_SLACK_MS : EXIT_DESKTOP_MS);
  // Le livre montré : retenu pendant la sortie, quand l'adresse ne le nomme plus.
  const [shown, setShown] = useState<string | null>(route.book ?? null);
  if (route.book && route.book !== shown) setShown(route.book);
  if (!exit.render || !shown) return null;
  const summary = books.find((b) => b.id === shown) ?? null;
  return <BookSheet key={shown} id={shown} summary={summary} leaving={exit.leaving} hidden={!!route.reading} onRead={(cover) => onRead(summary, shown, cover)} onReadIntent={onReadIntent} />;
}

function BookSheet({
  id,
  summary,
  leaving,
  hidden,
  onRead,
  onReadIntent,
}: {
  id: string;
  summary: BookSummary | null;
  leaving: boolean;
  hidden: boolean;
  onRead: (cover: HTMLElement | null) => void;
  onReadIntent?: ReadIntent;
}) {
  const t = useT();
  const isMobile = useIsMobile();
  const { data: detail, error, mutate } = useSWR<BookDetail>(`/api/books/${id}`, fetcher);
  const { mutate: mutateKey } = useSWRConfig();
  const [removing, setRemoving] = useState(false);
  // Lu après le premier rendu : le serveur ne sait pas si la page est l'app installée.
  const installed = useSyncExternalStore(noopSubscribe, isInstalledApp, () => true);
  const book: BookSummary | null = detail ?? summary;
  const containerRef = useRef<HTMLDivElement>(null);
  const coverRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);

  const close = () => cinemaClose({ book: null, reading: false });
  const exit = useSheetExit(close, { leaving, listening: !hidden });
  const swipe = useSwipeToDismiss(exit.requestClose, { addressed: true });
  // Revenue sur elle par un retour (le lecteur refermé) : elle se découvre, rien ne vole.
  const [revealed] = useState(() => arrivedByBack());
  const morph = useSheetTransition({
    layout: isMobile ? "phone" : "desktop",
    rootRef: containerRef,
    imageRef: isMobile ? coverRef : containerRef,
    active: !hidden,
    leaving,
    revealed,
    // Ce que la carte savait suffit pour paraître : la fiche n'attend plus sa propre réponse (un aller-
    // retour de plus pour chaque livre sans couverture de Jellyfin, mesuré le 28/10/2026).
    ready: !!summary || !!detail,
  });

  // Rester un instant sur la fiche, c'est souvent lire : le fichier du livre est demandé d'avance
  // (`readerPreload.ts`, et gardé une heure par le navigateur) — « Lire » n'attend plus que la page.
  // Seulement le fichier, du réseau : pas le code du lecteur, que la page des livres demande elle-même
  // dès son premier rendu — l'analyser ici prenait le fil principal pendant que la fiche s'animait
  // (mesuré le 28/10/2026). Pas sur une connexion qui demande l'économie de données.
  // Dans le cinéma, le lecteur se prépare aussi dans son cadre (`onReadIntent`), après l'animation de la
  // fiche : c'est un autre document, mais il partage le fil de celui-ci (§128).
  const intentRef = useRef(onReadIntent);
  useEffect(() => {
    intentRef.current = onReadIntent;
  });
  useEffect(() => {
    if (leaving || hidden || saveData()) return;
    let undo: (() => void) | null = null;
    const timer = window.setTimeout(() => {
      void preloadBookFile(id);
      undo = intentRef.current?.(id) ?? null;
    }, READ_INTENT_MS);
    return () => {
      window.clearTimeout(timer);
      undo?.();
    };
  }, [id, leaving, hidden]);

  // La barre du bas du téléphone s'efface sous une fiche ; elle ne lit que les fiches de films dans
  // l'adresse, et ce signal, posé pour les fiches qui n'y sont pas (`offlineSheetOpen.ts`).

  useEffect(() => {
    if (leaving) return;
    setOfflineSheetOpen(true);
    return () => setOfflineSheetOpen(false);
  }, [leaving]);

  const progress = book?.progress ?? null;
  const pct = progress && !progress.finished ? readPercent(progress.fraction) : 0;
  const finished = progress?.finished === true || book?.played === true;
  const readLabel = progress && !progress.finished && pct > 0 ? t("books.resume", { pct }) : finished ? t("books.readAgain") : t("books.read");
  const overview = detail?.overview ?? "";
  const long = overview.length > 420;
  const genres = book?.genres ?? [];

  // Seule celle de Jellyfin existe à coup sûr ; celle de l'EPUB peut manquer, et `BookCover` sait alors en dessiner une.
  const url = book?.coverTag ? coverUrl(book) : null;
  const washed = useCoverWash(url);

  if (typeof document === "undefined") return null;

  const info = (
    <div className={detailColumnMotion({ leaving, revealed: revealed || morph.handlesEntry })} data-sheet-content="">
      {book?.seriesName && (
        <p className="text-sm font-medium uppercase tracking-wide text-subtle">
          {book.index !== null ? t("books.seriesTome", { series: book.seriesName, n: book.index }) : book.seriesName}
        </p>
      )}
      <h2 className="mt-1 text-balance font-display text-2xl font-semibold leading-tight sm:text-3xl">{book ? displayTitle(book) : ""}</h2>
      <p className="mt-2 text-muted">{[book?.authors.length ? book.authors.join(", ") : null, book?.year ?? null].filter(Boolean).join(" · ")}</p>
      {/* Centrés dans la feuille du téléphone et de l'iPad, comme le titre ; calés à gauche sur ordinateur. Selon
          la largeur (`sm:`), l'iPad mêlait couverture et boutons à gauche, titre et auteur au centre (29/10/2026). */}
      <div className={`mt-5 flex flex-col gap-3 ${isMobile ? "items-center" : "items-start"}`}>
        <button
          type="button"
          {...NOT_THE_HANDLE}
          // Le lecteur refermé rend le focus ici (`ReaderFrame`).
          data-book-read=""
          onClick={() => onRead(coverRef.current)}
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
        {/* Retirer de « Continuer la lecture » : la position reste, le livre revient à la prochaine page lue. */}
        {progress && !progress.finished && !progress.dismissed && pct > 0 && (
          <button
            type="button"
            {...NOT_THE_HANDLE}
            disabled={removing}
            onClick={() => {
              setRemoving(true);
              void fetch(`/api/books/${id}/progress`, { method: "DELETE" })
                .then((res) => {
                  if (!res.ok) return;
                  void mutate();
                  void mutateKey("/api/books/home");
                })
                .catch(() => {})
                .finally(() => setRemoving(false));
            }}
            className="flex items-center gap-1.5 text-sm text-subtle transition-colors hover:text-white disabled:opacity-50"
          >
            <X size={15} aria-hidden /> {t("books.removeFromContinue")}
          </button>
        )}
        {/* « Ma liste de lecture » (§129) et le livre gardé sur l'appareil, côte à côte et avec les boutons des
            fiches de films (`btn btn-ghost`, `btn-mine` dans la liste) : le premier était un lien gris, le second
            une pilule à part (29/10/2026, « un peu d'uniformité »). */}
        {book && (
          <div className={`flex flex-wrap items-start gap-2 ${isMobile ? "justify-center" : ""}`}>
            {/* « Lu » dit aussi ce que disait la ligne « Terminé » d'avant : un seul endroit. */}
            <MarkReadButton
              book={book}
              read={finished}
              onChanged={() => {
                void mutate();
                void mutateKey("/api/books/home");
                window.dispatchEvent(new Event(BOOKS_PROGRESS_EVENT));
              }}
            />
            <ReadingListButton book={book} finished={finished} />
            <BookDownloadButton book={book} />
          </div>
        )}
        {/* Le fichier d'origine, pour une liseuse (câble, Calibre…) : dans un navigateur seulement — l'app
            installée, sur iPhone surtout, n'a pas de gestionnaire de téléchargements où le retrouver. */}
        {book && !installed && (
          <a
            {...NOT_THE_HANDLE}
            href={`/api/books/${id}/file?telecharger=1`}
            download
            className="flex items-center gap-1.5 text-sm text-subtle transition-colors hover:text-white"
          >
            <FileDown size={15} aria-hidden /> {t("books.downloadEpub")}
          </a>
        )}
      </div>
      {error && !detail && <p className="mt-8 text-sm text-subtle">{t("books.detailError")}</p>}
      {overview && (
        <div className="mt-8 text-left">
          <p className={`whitespace-pre-line text-pretty leading-relaxed text-muted ${long && !expanded ? "line-clamp-6" : ""}`}>{overview}</p>
          {long && (
            <button type="button" {...NOT_THE_HANDLE} onClick={() => setExpanded((v) => !v)} className="mt-2 text-sm font-semibold text-white">
              {expanded ? t("books.less") : t("books.more")}
            </button>
          )}
        </div>
      )}
      {genres.length > 0 && (
        <div className="mt-6 flex flex-wrap justify-center gap-2 sm:justify-start">
          {genres.map((g) => (
            <span key={g} className="chip text-xs">
              {g}
            </span>
          ))}
        </div>
      )}
    </div>
  );

  const closeButton = (
    <button type="button" {...NOT_THE_HANDLE} onClick={exit.requestClose} aria-label={t("books.close")} className="nav-glass absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full text-white">
      <X size={18} aria-hidden />
    </button>
  );

  // La couverture : c'est elle qui vole depuis la carte touchée (`data-sheet-photo`), et elle encore
  // qui grandit en première page à l'ouverture du lecteur (`readerOpening`).
  const cover = (
    <div ref={coverRef} data-book-sheet-cover className={`relative ${isMobile ? "mx-auto" : ""} w-40 shrink-0 overflow-hidden rounded-lg shadow-2xl shadow-black/60 sm:w-56`} style={{ aspectRatio: "2 / 3" }}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- relais d'images déjà dimensionné par Jellyfin.
        <img src={url} alt="" data-sheet-photo="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
      ) : book ? (
        <BookCover book={book} eager />
      ) : (
        <div className="absolute inset-0 animate-pulse bg-surface" />
      )}
    </div>
  );

  // La couverture floue derrière l'en-tête : la fiche prend la couleur du livre. Un lavis fait une fois
  // (`useCoverWash`) plutôt qu'un flou CSS repeint à chaque ouverture et fermeture.
  const backdrop = washed ? (
    <div className="pointer-events-none absolute inset-x-0 top-0 h-80 overflow-hidden opacity-50" aria-hidden data-sheet-veil="">
      {/* eslint-disable-next-line @next/next/no-img-element -- une image de 16 × 24 points (`blob:`), étirée. */}
      <img src={washed} alt="" className="absolute inset-0 h-full w-full scale-125 object-cover" />
      <div className="absolute inset-0 bg-linear-to-b from-transparent via-ink/60 to-ink" />
    </div>
  ) : null;

  if (isMobile) {
    return createPortal(
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label={book ? displayTitle(book) : ""}
        aria-hidden={hidden}
        className={`phone-sheet-frame safe-x fixed inset-x-0 overflow-y-auto overscroll-contain bg-ink ring-1 ring-white/10 ${sheetMotionClass({ swipe, leaving, revealed: revealed || morph.handlesEntry, out: "" })}`}
        style={{
          zIndex: 48,
          visibility: hidden ? "hidden" : undefined,
          ...exit.style,
          transform: swipe.touched ? `translateY(${swipe.offset}px)` : undefined,
          transition: swipe.dragging ? "none" : "transform 280ms cubic-bezier(0.32, 0.72, 0, 1), border-radius 200ms ease-out",
          borderTopLeftRadius: phoneSheetCorner(swipe.offset),
          borderTopRightRadius: phoneSheetCorner(swipe.offset),
          boxShadow: phoneSheetShadow(swipe.offset),
        }}
      >
        {/* La poignée du geste : tout l'en-tête, la couverture comprise. */}
        <div className="relative px-5 pb-2 pt-8" {...swipe.handlers} style={{ touchAction: "none" }}>
          {backdrop}
          <div className="relative">{cover}</div>
        </div>
        {closeButton}
        <div className="relative px-5 pb-[calc(env(safe-area-inset-bottom)+2rem)] pt-4 text-center">{info}</div>
      </div>,
      document.body
    );
  }

  return createPortal(
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={book ? displayTitle(book) : ""}
      aria-hidden={hidden}
      className={`fixed inset-0 flex items-center justify-center bg-black/70 p-8 backdrop-blur-sm ${revealed || morph.handlesEntry ? "" : "animate-fade-in"}`}
      style={{ zIndex: 48, visibility: hidden ? "hidden" : undefined, ...exit.style }}
      onClick={(e) => {
        if (e.target === e.currentTarget) exit.requestClose();
      }}
    >
      <div className="relative flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-ink shadow-2xl shadow-black/60">
        {backdrop}
        {closeButton}
        <div className="relative overflow-y-auto overscroll-contain px-8 pb-8 pt-8">
          <div className="flex items-start gap-8">
            {cover}
            <div className="min-w-0 flex-1 pt-2">{info}</div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

