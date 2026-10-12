"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useLocale, useT } from "@/components/TranslationProvider";
import { normalizeKey } from "@/lib/remoteKeys";
import { scrollBehavior } from "@/lib/reducedMotion";
import { contentFor, type NewsPageView } from "@/lib/news/content";
import { markNewsSeen, sendNewsEvent, watchVisibleTime, type NewsClosedBy } from "@/lib/news/events";
import { NewsContentView } from "./NewsContentView";

/**
 * La fenêtre des Nouveautés (DECISIONS.md §73) — une carte de verre centrée sur l'accueil assombri,
 * quasi plein écran sur téléphone, qui défile avec OK toujours visible en bas.
 *
 * Plusieurs pages en retard : elles sont empilées, de la plus récente à la plus ancienne, chacune
 * sous sa version en intertitre. Le drapeau du compte s'éteint à l'affichage (`markNewsSeen`), et
 * non à la fermeture : la fenêtre ne revient pas, quelle que soit la façon dont on la quitte.
 *
 * Le clavier et la télécommande : Entrée valide le bouton qui a le focus — OK au départ —, Échap et
 * la touche Retour ferment ; haut et bas font défiler le texte, puis passent d'un bouton à l'autre
 * quand il n'y a plus rien à faire défiler ; Tab reste dans la fenêtre. Les touches sont prises en
 * capture sur la fenêtre du navigateur et arrêtées là : la grille dessous écoute aussi les flèches,
 * et déplaçait son focus sur des affiches que la fenêtre cachait.
 *
 * `preview` : l'aperçu de l'éditeur — rien n'est mesuré, rien n'est marqué vu.
 */
export function NewsDialog({
  pages,
  auto,
  preview = false,
  lang,
  onClose,
}: {
  pages: NewsPageView[];
  auto: boolean;
  preview?: boolean;
  /** La langue à montrer à la place de celle de l'interface — l'aperçu d'une traduction. */
  lang?: string;
  onClose: (closedBy: NewsClosedBy) => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const scrolledRef = useRef(false);
  const closedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof watchVisibleTime> | null>(null);
  // Les rappels lus par l'écouteur clavier, posé une seule fois.
  const closeRef = useRef<(by: NewsClosedBy) => void>(() => {});

  const ids = pages.map((p) => p.id);
  const idsKey = ids.join(",");

  const close = (by: NewsClosedBy) => {
    if (closedRef.current) return;
    closedRef.current = true;
    if (!preview) {
      sendNewsEvent("fenêtre", {
        noteIds: ids,
        shownMs: timerRef.current?.read() ?? 0,
        closedBy: by,
        scrolled: scrolledRef.current,
        auto,
      });
      if (by === "voir-plus") sendNewsEvent("voir-plus", { noteIds: ids });
    }
    onClose(by);
  };
  useEffect(() => {
    closeRef.current = close;
  });

  // L'affichage : le drapeau s'éteint, le chronomètre part.
  useEffect(() => {
    timerRef.current = watchVisibleTime();
    if (!preview && idsKey) markNewsSeen(idsKey.split(",").map(Number));
    return () => timerRef.current?.stop();
  }, [preview, idsKey]);

  // Le focus sur OK à l'ouverture, rendu à l'élément d'avant à la fermeture.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    okRef.current?.focus({ preventScroll: true });
    return () => {
      if (before && document.contains(before)) before.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const focusables = () =>
      Array.from(cardRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])") ?? []);
    const move = (step: 1 | -1) => {
      const list = focusables();
      if (list.length === 0) return;
      const at = list.indexOf(document.activeElement as HTMLElement);
      const next = list[(at + step + list.length) % list.length];
      next.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      const key = normalizeKey(e);
      if (!key) return;
      const body = bodyRef.current;
      if (key === "Escape" || key === "GoBack" || key === "BrowserBack") {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current("echap");
        return;
      }
      if (key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        move(e.shiftKey ? -1 : 1);
        return;
      }
      if (key === "ArrowDown" || key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const down = key === "ArrowDown";
        const canScroll = body && (down ? body.scrollTop + body.clientHeight < body.scrollHeight - 2 : body.scrollTop > 2);
        if (canScroll && body) body.scrollBy({ top: (down ? 1 : -1) * Math.round(body.clientHeight * 0.4), behavior: scrollBehavior() });
        else move(down ? 1 : -1);
        return;
      }
      if (key === "ArrowLeft" || key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        move(key === "ArrowRight" ? 1 : -1);
        return;
      }
      if (key === "Enter") {
        // Sur un bouton, l'activation native fait le travail ; ailleurs (le focus perdu dans le
        // texte, ou resté dehors), Entrée vaut OK.
        e.stopPropagation();
        const active = document.activeElement as HTMLElement | null;
        if (!active || !cardRef.current?.contains(active) || !active.matches("button, a[href]")) {
          e.preventDefault();
          closeRef.current("ok");
        }
        return;
      }
      // Tout le reste (lettres, « / », touches médias) : la grille dessous n'en a pas l'usage tant
      // que la fenêtre est là.
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  if (typeof document === "undefined") return null;
  const merged = pages.length > 1;
  const newest = pages[0];

  return createPortal(
    <div
      className="fixed inset-0 flex animate-fade-in items-stretch justify-center bg-black/65 sm:items-center"
      style={{
        zIndex: 70,
        padding:
          "calc(env(safe-area-inset-top, 0px) + 0.75rem) calc(env(safe-area-inset-right, 0px) + 0.75rem) calc(env(safe-area-inset-bottom, 0px) + 0.75rem) calc(env(safe-area-inset-left, 0px) + 0.75rem)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close("dehors");
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="news-card glass-pop flex w-full max-w-[29rem] flex-col overflow-hidden rounded-[28px] sm:max-h-[min(46rem,calc(100dvh-3rem))]"
      >
        <div
          ref={bodyRef}
          onScroll={(e) => {
            if (e.currentTarget.scrollTop > 8) scrolledRef.current = true;
          }}
          className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-5 pt-8 sm:px-8"
        >
          <header className="mb-7">
            <h2 id={titleId} className="font-display text-[28px] font-semibold leading-tight text-white">
              {t("news.title")}
            </h2>
            {newest && <p className="mt-1 text-sm text-muted">{t("news.subtitle", { version: newest.version })}</p>}
          </header>
          <div className="flex flex-col gap-9">
            {pages.map((page) => (
              <div key={page.id}>
                {/* Plusieurs pages en retard : chacune sous sa version, la plus récente d'abord. */}
                {merged && (
                  <p className="mb-5 flex items-center gap-3 text-[13px] font-semibold text-white/90">
                    {t("news.subtitle", { version: page.version })}
                    <span aria-hidden className="h-px flex-1 bg-white/10" />
                  </p>
                )}
                <NewsContentView content={contentFor(page.content, lang ?? locale)} onSeeMore={() => close("voir-plus")} />
              </div>
            ))}
          </div>
        </div>
        <div className="shrink-0 border-t border-white/8 px-6 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 sm:px-8 sm:pb-6">
          <p className="mb-3.5 text-center text-xs leading-snug text-subtle">{t("news.footer")}</p>
          <button
            ref={okRef}
            type="button"
            onClick={() => close("ok")}
            className="flex w-full items-center justify-center rounded-full bg-white px-4 py-3.5 text-base font-semibold text-ink transition-transform active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            {t("news.ok")}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
