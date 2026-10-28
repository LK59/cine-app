"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Bookmark, ChevronLeft, List, Search, Type } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { usePointerCapture } from "@/lib/usePointerCapture";
import { isSanitizedType, sanitizeResource } from "@/lib/books/sanitize";
import { turnPage, type TurnSide } from "@/lib/books/pageTurn";
import {
  FONT_SIZE_RANGE,
  MARGIN_LAYOUT,
  THEME_COLORS,
  loadReaderPrefs,
  readerCss,
  zoomedFontSize,
  readerFontFaces,
  resolvedTheme,
  saveReaderPrefs,
  tapAction,
  type ReaderPrefs,
} from "@/lib/books/readerPrefs";
import type { FoliateBook, FoliateDataDetail, FoliateLoadDetail, FoliateRelocateDetail, FoliateSearchResult, FoliateTocItem, FoliateView } from "@/lib/books/foliate/view";
import {
  beaconProgress,
  flushOutbox,
  listenForReconnect,
  mergeBookmarks,
  outbox,
  pendingBookmarks,
  rememberBookmarks,
  rememberedBookmarks,
  rememberedPosition,
  rememberPosition,
  sendBookOp,
  type BookmarkBody,
  type ProgressBody,
  type StoredBookmark,
} from "@/lib/books/bookSync";
import { offlineBookFile, rememberedBookAccount } from "@/lib/books/offlineBooks";
import { preloadBookFile } from "@/lib/books/readerPreload";
import type { BookProgress } from "@/lib/books/types";
import { ReaderSearchPanel, ReaderSettingsPanel, ReaderTocPanel, type SearchGroup } from "./ReaderPanels";

/**
 * Le lecteur de livres (DECISIONS.md §127), plein écran, au-dessus de la fiche.
 *
 * Le livre est rendu par foliate-js, dans des cadres **sans** `allow-scripts` (correctif local,
 * `foliate/README.md`) : aucun écouteur posé par la page sur le document d'un chapitre ne se déclenche
 * dans WebKit, et rien de ce qui est dans le livre ne s'exécute nulle part. Tous les gestes passent
 * donc par une couche de cette page posée sur le livre — toucher à gauche ou à droite, glisser, la
 * molette, le clavier — et un lien touché est retrouvé sous le doigt (`elementFromPoint` sur le
 * document du chapitre, que la même origine permet de lire). Au défilement continu, la couche
 * s'efface pour que le doigt fasse défiler le texte : les barres se montrent en remontant, se cachent
 * en descendant.
 *
 * Avant d'exister comme page, chaque chapitre et chaque feuille de style passent par
 * `sanitizeResource`, et la page `/livres` a sa propre politique de sécurité, dont les chapitres
 * héritent : trois barrières, chacune suffisante pour l'essentiel.
 *
 * La position est envoyée au fil de la lecture (regroupée, 1,5 s) et à la fermeture, au masquage de
 * la page et à `pagehide` (`sendBeacon`, qui part même d'une page qu'iOS est en train de tuer). Sans
 * réseau, elle attend dans la file de l'appareil, comme les signets (`bookSync.ts`), et repart au
 * retour du réseau. Le livre s'ouvre de la copie gardée sur l'appareil quand il y en a une
 * (`offlineBooks.ts`) — sans réseau, c'est la seule source, et la page hors ligne des livres
 * (`/livres/hors-ligne`) n'ouvre que celle-là (`offline`).
 */

/** Au-delà, la recherche s'arrête : un mot courant ne doit pas dessiner des milliers de lignes. */
const SEARCH_MAX_RESULTS = 300;
const SEARCH_DEBOUNCE_MS = 350;

interface Page {
  start: string;
  end: string;
  fraction: number;
  chapter: string;
  excerpt: string;
}
type CfiTools = typeof import("@/lib/books/foliate/epubcfi.js");

/** Le signet de la page montrée, s'il y en a un : son adresse tombe entre le début et la fin de la page. */
function bookmarkOn(page: Page | null, list: readonly StoredBookmark[], cfi: CfiTools | null): string | null {
  if (!page || !cfi) return null;
  for (const b of list) {
    try {
      if (cfi.compare(b.cfi, page.start) >= 0 && cfi.compare(b.cfi, page.end) <= 0) return b.cfi;
    } catch {
      /* une adresse illisible n'est sur aucune page */
    }
  }
  return null;
}

const SAVE_DELAY_MS = 1500;
const CHROME_AUTOHIDE_MS = 3200;

function subscribeDark(listener: () => void): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", listener);
  return () => mq.removeEventListener("change", listener);
}
const darkSnapshot = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
const prefersReducedMotion = () => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

interface Place {
  fraction: number;
  chapter: string;
  minutesLeft: number | null;
  section: number;
}

/** Les attributs de mise en page du paginateur : défilement ou pages, marges, colonnes, glissement. */
function applyLayout(view: FoliateView, prefs: ReaderPrefs): void {
  const r = view.renderer;
  if (!r) return;
  const layout = MARGIN_LAYOUT[prefs.margin];
  r.setAttribute("flow", prefs.turn === "scroll" ? "scrolled" : "paginated");
  r.setAttribute("margin", layout.margin);
  r.setAttribute("gap", layout.gap);
  // Une page : une colonne de largeur de lecture, centrée par foliate-js même sur un grand écran.
  // Deux pages : la largeur d'une colonne est bornée plus court, pour que deux tiennent dès qu'un
  // écran couché le permet (un iPad), au lieu d'attendre la largeur d'un ordinateur.
  r.setAttribute("max-inline-size", prefs.layout === "double" ? `min(${layout.maxInlineSize}, 520px)` : layout.maxInlineSize);
  r.setAttribute("max-column-count", prefs.layout === "single" ? "1" : "2");
  if (prefs.turn === "slide" || prefs.turn === "scroll") r.setAttribute("animated", "");
  else r.removeAttribute("animated");
}

/** Le lien sous le doigt, s'il mène ailleurs dans le livre ; on y va et on le dit. Un lien externe ne s'ouvre jamais. */
function followLinkAt(view: FoliateView, x: number, y: number): boolean {
  for (const { doc, index } of view.renderer.getContents()) {
    const frame = doc.defaultView?.frameElement as HTMLElement | null | undefined;
    if (!frame) continue;
    const rect = frame.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
    const anchor = doc.elementFromPoint(x - rect.left, y - rect.top)?.closest("a[href]");
    const raw = anchor?.getAttribute("href");
    if (!raw) return false;
    const href = view.book.sections[index]?.resolveHref?.(raw) ?? raw;
    if (view.book.isExternal?.(href) ?? /^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
    void view.goTo(href).catch(() => {});
    return true;
  }
  return false;
}

/** Les marques de chapitre sur la barre d'avancement : le début de chaque entrée de premier niveau. */
function chapterMarks(view: FoliateView, toc: FoliateTocItem[]): number[] {
  try {
    const fractions = view.getSectionFractions();
    const marks = new Set<number>();
    for (const item of toc) {
      if (!item.href) continue;
      const index = view.resolveNavigation(item.href)?.index;
      const f = index === undefined ? undefined : fractions[index];
      if (typeof f === "number" && f > 0.001 && f < 0.999) marks.add(Math.round(f * 1000) / 1000);
    }
    return [...marks].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export function BookReader({ id, title, onClose, onSaved, offline = false }: { id: string; title: string; onClose: () => void; onSaved?: () => void; offline?: boolean }) {
  const t = useT();
  const systemDark = useSyncExternalStore(subscribeDark, darkSnapshot, () => true);
  const [prefs, setPrefs] = useState<ReaderPrefs>(() => loadReaderPrefs(prefersReducedMotion()));
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [chrome, setChrome] = useState(true);
  const [panel, setPanel] = useState<null | "toc" | "bookmarks" | "settings" | "search">(null);
  const [bookmarks, setBookmarks] = useState<StoredBookmark[]>([]);
  const [markedCfi, setMarkedCfi] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchGroups, setSearchGroups] = useState<SearchGroup[]>([]);
  const [searchProgress, setSearchProgress] = useState<number | null>(null);
  const [place, setPlace] = useState<Place>({ fraction: 0, chapter: "", minutesLeft: null, section: -1 });
  const [toc, setToc] = useState<FoliateTocItem[]>([]);
  const [marks, setMarks] = useState<number[]>([]);
  const [currentHref, setCurrentHref] = useState<string | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  // Le titre de la grille (`displayTitle`) dès qu'elle est là ; celui du fichier en attendant, si la
  // page s'est ouverte directement sur le lecteur.
  const [metaTitle, setMetaTitle] = useState("");
  const bookTitle = title || metaTitle;

  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const shadeRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateView | null>(null);
  const prefsRef = useRef(prefs);
  const turning = useRef(false);
  const queued = useRef<TurnSide | null>(null);
  const sectionRef = useRef(-1);
  const lastFraction = useRef(0);
  const pending = useRef<ProgressBody | null>(null);
  const pageRef = useRef<Page | null>(null);
  const bookmarksRef = useRef<StoredBookmark[]>([]);
  const cfiRef = useRef<CfiTools | null>(null);
  const searchRun = useRef(0);
  const searchIter = useRef<AsyncGenerator<FoliateSearchResult, void, undefined> | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sent = useRef<string>("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSavedRef = useRef(onSaved);

  useEffect(() => {
    prefsRef.current = prefs;
    onSavedRef.current = onSaved;
  });

  const theme = resolvedTheme(prefs.theme, systemDark);
  const colors = THEME_COLORS[theme];

  // ── La position ────────────────────────────────────────────────────────────────────────────
  const flush = useCallback(
    (beacon: boolean) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      const p = pending.current;
      if (!p) return;
      const signature = `${p.cfi}|${p.finished}`;
      if (signature === sent.current) return;
      sent.current = signature;
      rememberPosition(id, p);
      if (beacon) {
        beaconProgress(id, p);
        return;
      }
      // Sans réseau, ou le serveur en panne : la position attend dans la file de l'appareil.
      void sendBookOp({ kind: "progress", id, body: p }).then((res) => {
        if (res?.ok) onSavedRef.current?.();
      });
    },
    [id]
  );

  // ── Les barres ─────────────────────────────────────────────────────────────────────────────
  const showChrome = useCallback((autohide: boolean) => {
    setChrome(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = autohide ? setTimeout(() => setChrome(false), CHROME_AUTOHIDE_MS) : null;
  }, []);
  const hideChrome = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setChrome(false);
  }, []);

  // ── Les signets ──────────────────────────────────────────────────────────────────────────
  // La liste montrée : celle du serveur, corrigée de ce qui attend encore dans la file de l'appareil.
  const applyBookmarks = useCallback((list: StoredBookmark[]) => {
    bookmarksRef.current = list;
    setBookmarks(list);
    setMarkedCfi(bookmarkOn(pageRef.current, list, cfiRef.current));
  }, []);
  const fromServer = useCallback(
    (list: StoredBookmark[]) => {
      rememberBookmarks(id, list);
      applyBookmarks(mergeBookmarks(list, pendingBookmarks(id)));
    },
    [id, applyBookmarks]
  );
  const loadBookmarks = useCallback(() => {
    applyBookmarks(mergeBookmarks(rememberedBookmarks(id), pendingBookmarks(id)));
    if (offline) return;
    void fetch(`/api/books/${id}/bookmarks`)
      .then((r) => (r.ok ? (r.json() as Promise<{ bookmarks: StoredBookmark[] }>) : null))
      .then((data) => {
        if (data) fromServer(data.bookmarks);
      })
      .catch(() => {});
  }, [id, offline, applyBookmarks, fromServer]);
  const writeBookmark = useCallback(
    (body: BookmarkBody) => {
      applyBookmarks(mergeBookmarks(bookmarksRef.current, [body]));
      void sendBookOp({ kind: "bookmark", id, body }).then(async (res) => {
        if (!res?.ok) return;
        try {
          fromServer(((await res.json()) as { bookmarks: StoredBookmark[] }).bookmarks);
        } catch {
          /* la liste montrée reste celle d'avant la réponse */
        }
      });
    },
    [id, applyBookmarks, fromServer]
  );
  const toggleBookmark = useCallback(() => {
    if (markedCfi) {
      writeBookmark({ cfi: markedCfi, remove: true });
      return;
    }
    const page = pageRef.current;
    if (!page) return;
    writeBookmark({ cfi: page.start, fraction: page.fraction, chapter: page.chapter, excerpt: page.excerpt });
  }, [markedCfi, writeBookmark]);

  // ── L'ouverture du livre ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let view: FoliateView | null = null;
    let book: FoliateBook | null = null;
    const stage = stageRef.current;

    const onRelocate = (e: Event) => {
      const d = (e as CustomEvent<FoliateRelocateDetail>).detail;
      if (!d) return;
      const fraction = typeof d.fraction === "number" ? Math.min(1, Math.max(0, d.fraction)) : 0;
      const section = d.section?.current ?? -1;
      sectionRef.current = section;
      setPlace({
        fraction,
        chapter: d.tocItem?.label?.trim() ?? "",
        minutesLeft: typeof d.time?.section === "number" ? d.time.section : null,
        section,
      });
      setCurrentHref(d.tocItem?.href ?? null);
      // Au défilement continu : descendre cache les barres, remonter les montre.
      if (prefsRef.current.turn === "scroll") {
        if (fraction > lastFraction.current + 0.0005) setChrome(false);
        else if (fraction < lastFraction.current - 0.0005) setChrome(true);
      }
      lastFraction.current = fraction;
      if (d.cfi) {
        const finished = fraction >= 0.995 || view?.renderer.atEnd === true;
        pending.current = { cfi: d.cfi, fraction, finished, at: Date.now() };
        // La page montrée, pour son signet : son début, sa fin, quelques mots de son texte.
        const tools = cfiRef.current;
        if (tools) {
          let excerpt = "";
          try {
            excerpt = (d.range?.toString() ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
          } catch {
            /* pas de texte lisible sur cette page */
          }
          try {
            pageRef.current = { start: tools.collapse(d.cfi), end: tools.collapse(d.cfi, true), fraction, chapter: d.tocItem?.label?.trim() ?? "", excerpt };
          } catch {
            pageRef.current = null;
          }
          setMarkedCfi(bookmarkOn(pageRef.current, bookmarksRef.current, tools));
        }
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => flush(false), finished ? 0 : SAVE_DELAY_MS);
      }
    };
    // Un lien externe ne s'ouvre jamais depuis un livre ; foliate-js l'ouvrirait dans un onglet.
    const onExternal = (e: Event) => e.preventDefault();
    // Hors WebKit, les écouteurs posés sur un chapitre se déclenchent : au défilement continu (où la
    // couche de gestes s'efface), un toucher au milieu montre ou cache les barres, et les touches du
    // clavier restent au lecteur même quand le chapitre a pris le focus.
    const onDocLoad = (e: Event) => {
      const doc = (e as CustomEvent<{ doc: Document }>).detail?.doc;
      if (!doc) return;
      doc.addEventListener("keydown", (ke) => window.dispatchEvent(new KeyboardEvent("keydown", { key: ke.key, shiftKey: ke.shiftKey })));
      doc.addEventListener("click", () => {
        if (prefsRef.current.turn === "scroll") setChrome((v) => !v);
      });
    };

    async function open() {
      try {
        listenForReconnect();
        // Tout part en même temps (mesuré le 28/10/2026 : le fichier n'était demandé qu'après le code du
        // lecteur, le compte et la copie de l'appareil, l'un après l'autre — près d'une seconde perdue).
        // La copie de l'appareil d'abord, cherchée sous le compte retenu (sans réseau, quelques
        // millisecondes) ; sinon le fichier, peut-être déjà demandé par la fiche (`readerPreload.ts`).
        const remembered = rememberedBookAccount();
        let local = remembered ? await offlineBookFile(id, remembered).catch(() => null) : null;
        if (!local && offline) local = await offlineBookFile(id).catch(() => null);
        const file: Promise<Blob | null> = local ? Promise.resolve(local) : offline ? Promise.resolve(null) : preloadBookFile(id);
        // Ce qui attendait d'un livre lu hors ligne part avant de lire la position du serveur, qui en
        // tient compte — seulement s'il y a quelque chose, et jamais attendu sur la page hors ligne.
        if (offline) void flushOutbox().catch(() => {});
        else if (outbox().length > 0) await flushOutbox().catch(() => {});
        const [progressRes, blob, foliate, cfiTools] = await Promise.all([
          offline
            ? { progress: null }
            : fetch(`/api/books/${id}/progress`).then((r) => (r.ok ? (r.json() as Promise<{ progress: BookProgress | null }>) : { progress: null })).catch(() => ({ progress: null })),
          file,
          import("@/lib/books/foliate/view.js"),
          import("@/lib/books/foliate/epubcfi.js"),
        ]);
        cfiRef.current = cfiTools;
        if (!blob) throw new Error(offline ? "pas de copie sur l'appareil" : "fichier indisponible");
        if (cancelled || !stage) return;
        loadBookmarks();
        book = await foliate.makeBook(new File([blob], `${id}.epub`, { type: "application/epub+zip" }));
        if (cancelled) return;
        // La première barrière, avant que le moindre chapitre ne devienne un document.
        book.transformTarget?.addEventListener("load", (ev) => {
          const detail = (ev as CustomEvent<FoliateLoadDetail>).detail;
          if (detail.isScript) detail.allow = false;
        });
        book.transformTarget?.addEventListener("data", (ev) => {
          const detail = (ev as CustomEvent<FoliateDataDetail>).detail;
          if (!isSanitizedType(detail.type)) return;
          const type = detail.type;
          detail.data = Promise.resolve(detail.data).then((value) => (typeof value === "string" ? sanitizeResource(value, type) : value));
        });

        view = document.createElement("foliate-view") as FoliateView;
        view.style.display = "block";
        view.style.width = "100%";
        view.style.height = "100%";
        view.style.willChange = "transform, opacity";
        view.style.backfaceVisibility = "hidden";
        view.addEventListener("relocate", onRelocate);
        view.addEventListener("external-link", onExternal);
        view.addEventListener("load", onDocLoad);
        stage.append(view);
        await view.open(book);
        if (cancelled) return;
        viewRef.current = view;
        const p = prefsRef.current;
        applyLayout(view, p);
        view.renderer.setStyles?.(readerCss(p, darkSnapshot(), location.origin));
        const items = book.toc ?? [];
        setToc(items);
        const fileTitle = book.metadata?.title;
        if (typeof fileTitle === "string" && fileTitle.trim()) setMetaTitle(fileTitle.trim());
        // La position la plus récente : celle du serveur, ou celle de l'appareil si on a lu ici depuis, hors ligne.
        const server = progressRes.progress;
        const kept = rememberedPosition(id);
        let cfi = server && !server.finished ? server.cfi : null;
        if (kept && !kept.finished && (!server || kept.at > server.updatedAt)) cfi = kept.cfi;
        try {
          await view.init({ lastLocation: cfi, showTextStart: !cfi });
        } catch {
          // Une position que le livre ne reconnaît plus (fichier remplacé) : le début du texte.
          await view.init({ showTextStart: true });
        }
        if (cancelled) return;
        setMarks(chapterMarks(view, items));
        setStatus("ready");
        showChrome(true);
        rootRef.current?.focus({ preventScroll: true });
      } catch {
        if (!cancelled) setStatus("error");
      }
    }
    void open();

    const onHide = () => flush(true);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush(true);
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      flush(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      viewRef.current = null;
      if (view) {
        view.removeEventListener("relocate", onRelocate);
        try {
          view.close();
        } catch {
          /* déjà défait */
        }
        view.remove();
      }
      try {
        book?.destroy?.();
      } catch {
        /* rien à libérer */
      }
    };
  }, [id, flush, showChrome, offline, loadBookmarks]);

  // ── La recherche dans le livre ─────────────────────────────────────────────────────────────
  // foliate-js parcourt les chapitres un à un (un `await` entre deux : la page reste vive) ; chaque
  // nouvelle frappe arrête la recherche en cours, et l'on s'arrête de soi-même passé quelques centaines
  // de trouvailles. Les trouvailles sont soulignées sur la page (`Overlayer.outline` de foliate-js).
  const stopSearch = useCallback(() => {
    searchRun.current += 1;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    void searchIter.current?.return(undefined).catch(() => {});
    searchIter.current = null;
    setSearchProgress(null);
  }, []);
  const runSearch = useCallback(
    (query: string) => {
      stopSearch();
      setSearchGroups([]);
      const view = viewRef.current;
      if (!view) return;
      if (query.trim().length < 2) {
        view.clearSearch();
        return;
      }
      const run = searchRun.current;
      setSearchProgress(0);
      // Les trouvailles cernées d'ambre sur la page, comme dans la liste — le rouge de foliate-js criait.
      const iter = view.search({ query: query.trim(), drawOptions: { color: "rgb(217 160 38)" } });
      searchIter.current = iter;
      void (async () => {
        let found = 0;
        try {
          for await (const result of iter) {
            if (run !== searchRun.current) return;
            if (result === "done") break;
            if ("progress" in result) setSearchProgress(result.progress);
            else {
              const items = result.subitems.slice(0, SEARCH_MAX_RESULTS - found).map((x) => ({ cfi: x.cfi, ...x.excerpt }));
              found += items.length;
              setSearchGroups((g) => [...g, { label: result.label, items }]);
              if (found >= SEARCH_MAX_RESULTS) break;
            }
          }
        } catch {
          /* un chapitre illisible arrête la recherche ; ce qui est trouvé reste */
        } finally {
          if (run === searchRun.current) {
            setSearchProgress(null);
            searchIter.current = null;
          }
        }
      })();
    },
    [stopSearch]
  );
  const onSearchQuery = useCallback(
    (query: string) => {
      setSearchQuery(query);
      if (searchTimer.current) clearTimeout(searchTimer.current);
      searchTimer.current = setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS);
    },
    [runSearch]
  );
  useEffect(() => () => stopSearch(), [stopSearch]);

  // ── Le zoom : la taille du texte, au pincement ou au Ctrl/⌘ ────────────────────────────────
  // Pas un agrandissement de l'image : le même réglage que le curseur, borné comme lui et gardé de
  // même. Pendant le geste, la page n'est que mise à l'échelle (le compositeur s'en charge) ; le texte
  // n'est repaginé qu'une fois, au lâcher — repaginer à chaque image ferait sauter la page. La
  // position (la CFI) est celle que foliate-js garde à toute nouvelle mise en page.
  const zoomPreview = useRef(false);
  const showZoom = useCallback((ratio: number, x: number, y: number) => {
    const view = viewRef.current;
    if (!view) return;
    const base = prefsRef.current.fontSize;
    // L'aperçu s'arrête aux bornes du curseur : au-delà, rien ne changerait au lâcher.
    const shown = zoomedFontSize(base, ratio) / base;
    const exact = Math.min(Math.max(ratio, shown - 0.05), shown + 0.05);
    view.style.transformOrigin = `${x}px ${y}px`;
    view.style.transform = `scale(${exact})`;
    zoomPreview.current = true;
  }, []);
  const commitZoom = useCallback((ratio: number) => {
    const view = viewRef.current;
    const base = prefsRef.current.fontSize;
    const next = zoomedFontSize(base, ratio);
    if (next === base) {
      zoomPreview.current = false;
      if (view) {
        view.style.transform = "";
        view.style.transformOrigin = "";
      }
      return;
    }
    setPrefs((p) => ({ ...p, fontSize: next }));
  }, []);

  // Ctrl/⌘ + molette (et le pincement d'un pavé tactile, que les navigateurs envoient ainsi), et le
  // pincement de Safari (`gesturestart`) : jamais le zoom de la page, ici. Écouteurs natifs, non
  // passifs — ceux de React le sont, et ne peuvent rien empêcher.
  useEffect(() => {
    if (status !== "ready") return;
    let ratio = 1;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      ratio *= Math.exp(-e.deltaY / 400);
      showZoom(ratio, e.clientX, e.clientY);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        commitZoom(ratio);
        ratio = 1;
      }, 260);
    };
    const stopPageZoom = (e: Event) => e.preventDefault();
    window.addEventListener("wheel", onWheel, { passive: false });
    document.addEventListener("gesturestart", stopPageZoom, { passive: false });
    document.addEventListener("gesturechange", stopPageZoom, { passive: false });
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("wheel", onWheel);
      document.removeEventListener("gesturestart", stopPageZoom);
      document.removeEventListener("gesturechange", stopPageZoom);
    };
  }, [status, showZoom, commitZoom]);

  // ── Les réglages, appliqués en direct (regroupés : un curseur en envoie des dizaines par seconde) ──
  useEffect(() => {
    saveReaderPrefs(prefs);
    const view = viewRef.current;
    if (!view || status !== "ready") return;
    const handle = setTimeout(() => {
      // L'aperçu d'un zoom (une simple mise à l'échelle) laisse la place au texte repaginé — retiré
      // **avant** la nouvelle mise en page, dans la même tâche (rien n'est peint entre les deux) :
      // foliate-js mesure ses colonnes à l'écran, et sous une mise à l'échelle il se plaçait de travers
      // (une page blanche après un pincement, vu le 28/10/2026).
      if (zoomPreview.current) {
        zoomPreview.current = false;
        view.style.transform = "";
        view.style.transformOrigin = "";
      }
      applyLayout(view, prefs);
      view.renderer.setStyles?.(readerCss(prefs, systemDark, location.origin));
    }, 40);
    return () => clearTimeout(handle);
  }, [prefs, systemDark, status]);

  // ── Tourner la page ────────────────────────────────────────────────────────────────────────
  // Un toucher pendant une animation n'est pas perdu : il attend (un seul), et part à la fin de celle-ci.
  const turn = useCallback(async (first: TurnSide) => {
    const view = viewRef.current;
    if (!view) return;
    if (turning.current) {
      queued.current = first;
      return;
    }
    turning.current = true;
    hideChrome();
    let side: TurnSide | null = first;
    while (side) {
      const current: TurnSide = side;
      try {
        const before = sectionRef.current;
        await turnPage(
          prefsRef.current.turn,
          view,
          shadeRef.current,
          current,
          () => (current === "right" ? view.goRight() : view.goLeft()),
          () => sectionRef.current !== before
        );
      } catch {
        /* foliate-js refuse (début ou fin du livre) */
      }
      side = queued.current;
      queued.current = null;
    }
    turning.current = false;
  }, [hideChrome]);

  const close = useCallback(() => {
    flush(false);
    onClose();
  }, [flush, onClose]);

  // ── Le clavier ─────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (panel) setPanel(null);
        else close();
        return;
      }
      // Ctrl/⌘ + « + », « - », « 0 » : la taille du texte, pas le zoom de la page.
      if ((e.ctrlKey || e.metaKey) && ["+", "=", "-", "0"].includes(e.key) && status === "ready") {
        e.preventDefault();
        const step = e.key === "-" ? -FONT_SIZE_RANGE.step : FONT_SIZE_RANGE.step;
        setPrefs((p) => ({ ...p, fontSize: e.key === "0" ? 100 : zoomedFontSize(p.fontSize + step, 1) }));
        return;
      }
      if (panel || status !== "ready") return;
      const rtl = viewRef.current?.book?.dir === "rtl";
      const forward: TurnSide = rtl ? "left" : "right";
      const backward: TurnSide = rtl ? "right" : "left";
      if (e.key === "ArrowRight") turn("right");
      else if (e.key === "ArrowLeft") turn("left");
      else if (e.key === "PageDown" || (e.key === " " && !e.shiftKey)) turn(forward);
      else if (e.key === "PageUp" || (e.key === " " && e.shiftKey)) turn(backward);
      else if (prefsRef.current.turn === "scroll" && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        void (e.key === "ArrowDown" ? viewRef.current?.next(80) : viewRef.current?.prev(80));
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel, status, turn, close]);

  // ── Les gestes, sur la couche posée sur le livre ───────────────────────────────────────────
  // La prise du pointeur passe par le crochet commun, qui la rend au démontage (règle 3 des fiches).
  const capture = usePointerCapture();
  const gesture = useRef<{ x: number; y: number; t: number; id: number; dragging: boolean } | null>(null);
  const wheel = useRef({ acc: 0, at: 0 });
  // Les doigts posés, pour le pincement : deux doigts, c'est un zoom — jamais une page tournée ni un
  // toucher au milieu, même quand le premier se lève avant l'autre.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d0: number; ratio: number } | null>(null);
  const spread = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const s0 = spread();
      // Le glissement d'un doigt commencé s'annule : la page revient à sa place.
      gesture.current = null;
      capture.release();
      if (viewRef.current) viewRef.current.style.transform = "";
      if (s0 && s0.d > 10) pinch.current = { d0: s0.d, ratio: 1 };
      return;
    }
    if (pinch.current || pointers.current.size > 2) return;
    gesture.current = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, dragging: false };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current) {
      const now = spread();
      if (now) {
        pinch.current.ratio = now.d / pinch.current.d0;
        showZoom(pinch.current.ratio, now.x, now.y);
      }
      return;
    }
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x;
    if (!g.dragging && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(e.clientY - g.y)) {
      g.dragging = true;
      capture.take(e);
    }
    // Au glissement, la page suit un peu le doigt : on sent qu'elle va partir.
    if (g.dragging && prefsRef.current.turn === "slide" && viewRef.current) viewRef.current.style.transform = `translateX(${dx * 0.25}px)`;
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pinch.current) {
      if (pointers.current.size < 2) {
        commitZoom(pinch.current.ratio);
        pinch.current = null;
      }
      return;
    }
    const g = gesture.current;
    gesture.current = null;
    if (!g || g.id !== e.pointerId) return;
    capture.release();
    const view = viewRef.current;
    if (view && view.style.transform) {
      view.animate?.([{ transform: view.style.transform }, { transform: "none" }], { duration: 140, easing: "ease-out" });
      view.style.transform = "";
    }
    const dx = e.clientX - g.x;
    const dt = Math.max(1, performance.now() - g.t);
    if (g.dragging) {
      if (Math.abs(dx) > 48 || Math.abs(dx) / dt > 0.35) void turn(dx < 0 ? "right" : "left");
      return;
    }
    if (panel) {
      setPanel(null);
      return;
    }
    if (view && followLinkAt(view, e.clientX, e.clientY)) return;
    const width = e.currentTarget.clientWidth;
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const action = tapAction(x, width, prefs.tapTurns, chrome);
    if (action === "left" || action === "right") void turn(action);
    else if (action === "hide") hideChrome();
    else showChrome(false);
  };
  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    // Avec Ctrl/⌘ c'est un zoom, traité plus haut.
    if (e.ctrlKey || e.metaKey) return;
    const now = performance.now();
    if (now - wheel.current.at > 300) wheel.current.acc = 0;
    wheel.current.at = now;
    wheel.current.acc += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(wheel.current.acc) > 60 && !turning.current) {
      void turn(wheel.current.acc > 0 ? "right" : "left");
      wheel.current.acc = 0;
    }
  };

  const update = useCallback((patch: Partial<ReaderPrefs>) => setPrefs((p) => ({ ...p, ...patch })), []);

  const shownFraction = scrub ?? place.fraction;
  const pct = Math.round(shownFraction * 100);
  const minutes = place.minutesLeft;
  const timeLabel = minutes === null ? "" : minutes < 1 ? t("books.reader.lessThanMinute") : Math.ceil(minutes) === 1 ? t("books.reader.minuteLeft") : t("books.reader.minutesLeft", { n: Math.ceil(minutes) });
  const scrolled = prefs.turn === "scroll";
  const barStyle = useMemo(
    () => ({
      background: colors.dark ? "rgb(20 20 22 / 0.78)" : "rgb(255 255 255 / 0.8)",
      color: colors.fg,
      borderColor: colors.dark ? "rgb(255 255 255 / 0.08)" : "rgb(0 0 0 / 0.08)",
    }),
    [colors]
  );
  const chromeShown = chrome || panel !== null || status !== "ready";

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={bookTitle}
      className="fixed inset-0 z-[300] overflow-hidden outline-none"
      style={{ background: colors.bg, color: colors.fg, transition: "background-color 300ms ease, color 300ms ease" }}
    >
      {/* Les polices du lecteur pour les aperçus du panneau ; les chapitres déclarent les leurs. */}
      <style>{readerFontFaces(typeof location === "undefined" ? "" : location.origin)}</style>

      <div
        className="absolute inset-0"
        style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)", paddingLeft: "env(safe-area-inset-left)", paddingRight: "env(safe-area-inset-right)", perspective: "2200px" }}
      >
        <div ref={stageRef} className="relative h-full w-full" style={{ transformStyle: "preserve-3d" }} />
        <div ref={shadeRef} className="pointer-events-none absolute inset-0 bg-black opacity-0" aria-hidden />
      </div>

      {/* La couche des gestes. Au défilement continu, elle laisse passer le doigt jusqu'au texte. */}
      {status === "ready" && (
        <div
          className="absolute inset-0 touch-none select-none"
          style={{ pointerEvents: scrolled && !panel ? "none" : "auto", cursor: "default" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={(e) => {
            pointers.current.delete(e.pointerId);
            gesture.current = null;
            if (pinch.current && pointers.current.size < 2) {
              commitZoom(pinch.current.ratio);
              pinch.current = null;
            } else if (viewRef.current && !zoomPreview.current) viewRef.current.style.transform = "";
          }}
          onWheel={onWheel}
          data-reader-gestures
        />
      )}

      {/* Lumière et chaleur : deux voiles sur la page, jamais sur les barres. */}
      <div className="pointer-events-none absolute inset-0 bg-black" style={{ opacity: (1 - prefs.brightness) * 0.85, transition: "opacity 200ms" }} aria-hidden />
      <div className="pointer-events-none absolute inset-0" style={{ background: "rgb(255 138 30)", mixBlendMode: "multiply", opacity: prefs.warmth * 0.3, transition: "opacity 200ms" }} aria-hidden />

      {status === "loading" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-current border-t-transparent opacity-60" />
          <p className="font-display text-lg opacity-70">{bookTitle}</p>
        </div>
      )}
      {status === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center">
          <p className="max-w-sm opacity-80">{t("books.reader.openError")}</p>
          <button type="button" onClick={close} className="rounded-full px-5 py-2 text-sm font-semibold" style={{ background: colors.fg, color: colors.bg }}>
            {t("books.close")}
          </button>
        </div>
      )}

      {/* La barre du haut. */}
      <div
        className="absolute inset-x-0 top-0 z-10 border-b backdrop-blur-xl transition-[transform,opacity] duration-300 ease-out"
        // Un peu plus bas que la zone sûre là où elle existe (iPhone, app installée) : le flou que Safari
        // pose sous la barre d'état mordait sur les boutons (28/10/2026). Rien de plus sur un écran sans encoche.
        style={{ ...barStyle, paddingTop: "calc(env(safe-area-inset-top) + min(0.5rem, env(safe-area-inset-top)))", transform: chromeShown ? "none" : "translateY(-100%)", opacity: chromeShown ? 1 : 0 }}
        aria-hidden={!chromeShown}
      >
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 px-3">
          <button type="button" onClick={close} aria-label={t("books.close")} className="flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-black/10">
            <ChevronLeft size={22} aria-hidden />
          </button>
          <div className="min-w-0 flex-1 text-center">
            <p className="truncate font-display text-[15px] font-semibold">{bookTitle}</p>
            {place.chapter && <p className="truncate text-xs opacity-60">{place.chapter}</p>}
          </div>
          <button
            type="button"
            onClick={toggleBookmark}
            disabled={status !== "ready"}
            aria-label={markedCfi ? t("books.reader.bookmarkRemove") : t("books.reader.bookmarkAdd")}
            aria-pressed={markedCfi !== null}
            data-reader-bookmark
            className="flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-black/10 disabled:opacity-40"
          >
            <Bookmark size={20} aria-hidden fill={markedCfi ? "currentColor" : "none"} />
          </button>
          <button
            type="button"
            onClick={() => setPanel(panel === "search" ? null : "search")}
            disabled={status !== "ready"}
            aria-label={t("books.reader.search")}
            className="flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-black/10 disabled:opacity-40"
          >
            <Search size={20} aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setPanel(panel === "toc" ? null : "toc")}
            disabled={status !== "ready"}
            aria-label={t("books.reader.contents")}
            className="flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-black/10 disabled:opacity-40"
          >
            <List size={20} aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setPanel(panel === "settings" ? null : "settings")}
            disabled={status !== "ready"}
            aria-label={t("books.reader.settings")}
            className="flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-black/10 disabled:opacity-40"
          >
            <Type size={20} aria-hidden />
          </button>
        </div>
      </div>

      {/* La barre du bas : où l'on en est, les chapitres marqués, le temps qui reste au chapitre. */}
      <div
        className="absolute inset-x-0 bottom-0 z-10 border-t backdrop-blur-xl transition-[transform,opacity] duration-300 ease-out"
        style={{ ...barStyle, paddingBottom: "env(safe-area-inset-bottom)", transform: chromeShown && panel !== "settings" ? "none" : "translateY(100%)", opacity: chromeShown && panel !== "settings" ? 1 : 0 }}
        aria-hidden={!chromeShown}
      >
        <div className="mx-auto max-w-5xl px-5 pb-3 pt-3">
          <div className="relative h-6">
            <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full" style={{ background: colors.dark ? "rgb(255 255 255 / 0.15)" : "rgb(0 0 0 / 0.12)" }} />
            <div className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full" style={{ width: `${shownFraction * 100}%`, background: colors.fg }} />
            {marks.map((m) => (
              <span key={m} className="absolute top-1/2 h-2.5 w-px -translate-y-1/2" style={{ left: `${m * 100}%`, background: colors.fg, opacity: 0.45 }} aria-hidden />
            ))}
            <input
              type="range"
              min={0}
              max={1000}
              step={1}
              value={Math.round(shownFraction * 1000)}
              aria-label={t("books.reader.position")}
              disabled={status !== "ready"}
              onChange={(e) => setScrub(Number(e.target.value) / 1000)}
              onPointerUp={(e) => {
                const f = Number((e.target as HTMLInputElement).value) / 1000;
                setScrub(null);
                void viewRef.current?.goToFraction(f);
              }}
              onKeyUp={(e) => {
                const f = Number((e.target as HTMLInputElement).value) / 1000;
                setScrub(null);
                void viewRef.current?.goToFraction(f);
              }}
              className="reader-range absolute inset-0 h-6 w-full cursor-pointer opacity-0"
            />
          </div>
          <div className="mt-1 flex items-center justify-between text-xs opacity-70">
            <span>{t("books.reader.percent", { pct })}</span>
            <span>{timeLabel}</span>
          </div>
        </div>
      </div>

      {(panel === "toc" || panel === "bookmarks") && (
        <ReaderTocPanel
          toc={toc}
          currentHref={currentHref}
          colors={colors}
          initialTab={panel === "bookmarks" ? "bookmarks" : "toc"}
          bookmarks={bookmarks}
          onPick={(href) => {
            setPanel(null);
            void viewRef.current?.goTo(href).catch(() => {});
          }}
          onPickBookmark={(cfi) => {
            setPanel(null);
            void viewRef.current?.goTo(cfi).catch(() => {});
          }}
          onRemoveBookmark={(cfi) => writeBookmark({ cfi, remove: true })}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === "search" && (
        <ReaderSearchPanel
          colors={colors}
          query={searchQuery}
          onQuery={onSearchQuery}
          groups={searchGroups}
          progress={searchProgress}
          onPick={(cfi) => {
            setPanel(null);
            void viewRef.current?.goTo(cfi).catch(() => {});
          }}
          onStop={stopSearch}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === "settings" && <ReaderSettingsPanel prefs={prefs} colors={colors} onChange={update} onClose={() => setPanel(null)} />}
    </div>
  );
}
