"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { ChevronDown } from "lucide-react";
import { PlayerPanelFrame } from "./PlayerPanelFrame";
import { useLocale, useT } from "@/components/TranslationProvider";
import { LoadingState, ErrorState } from "@/components/StateViews";
import { fetcher } from "@/lib/swr";
import { getDateLocale } from "@/lib/i18n";
import { contentFor, type NewsPageView, type NewsPayload } from "@/lib/news/content";
import { NEWS_KEY, sendNewsEvent, watchVisibleTime, type NewsPageSection } from "@/lib/news/events";
import { NewsContentView, NewsSectionTitle } from "@/components/news/NewsContentView";

/** `#nouveautes=1`, ou `corrections:<id>` : arriver sur la liste des corrections de cette page. */
export function decodeNewsTarget(raw: string): number | null {
  if (!raw.startsWith("corrections:")) return null;
  const id = Number(raw.slice(12));
  return Number.isInteger(id) && id > 0 ? id : null;
}

export const fixesAnchor = (id: number) => `nouveautes-corrections-${id}`;

const SECTION_RANK: Record<NewsPageSection, number> = { "nouveautés": 0, corrections: 1, historique: 2 };

/**
 * Compte → Nouveautés (DECISIONS.md §73) : tout ce que montre la fenêtre, plus la liste complète des
 * optimisations et corrections, et les pages précédentes. Le même dessin que la fenêtre
 * (`NewsContentView`), pour bureau et téléphone.
 *
 * Mesuré : le temps passé (page visible seulement) et la section la plus loin atteinte, envoyés à la
 * sortie de l'écran.
 */
export function PlayerNewsPanel({ raw, leaving }: { raw: string; leaving?: boolean }) {
  const t = useT();
  const { locale } = useLocale();
  const { data, error, isLoading, mutate } = useSWR<NewsPayload>(NEWS_KEY, fetcher, { revalidateOnFocus: false });
  const target = decodeNewsTarget(raw);
  const reached = useRef<NewsPageSection>(target !== null ? "corrections" : "nouveautés");
  const rootRef = useRef<HTMLDivElement>(null);

  // Le temps passé, et jusqu'où : envoyés quand l'écran s'en va.
  useEffect(() => {
    const timer = watchVisibleTime();
    return () => {
      timer.stop();
      sendNewsEvent("page", { shownMs: timer.read(), section: reached.current, noteIds: target !== null ? [target] : [] });
    };
  }, [target]);

  const pages = data?.pages ?? [];
  const latest = pages[0] ?? null;
  const older = pages.slice(1);

  // Arriver par « Voir plus » : sur la liste des corrections de la page demandée, une fois.
  const scrolledTo = useRef(false);
  useEffect(() => {
    if (scrolledTo.current || target === null || pages.length === 0) return;
    const el = document.getElementById(fixesAnchor(target));
    if (!el) return;
    scrolledTo.current = true;
    el.scrollIntoView({ block: "start" });
  }, [target, pages.length]);

  // La section la plus loin atteinte, lue à l'écran plutôt que supposée.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        // La liste des corrections porte son ancre (`fixesAnchor`) ; le haut et l'historique, un repère.
        const el = entry.target as HTMLElement;
        const section = el.id.startsWith("nouveautes-corrections-") ? "corrections" : (el.dataset.newsSection as NewsPageSection | undefined);
        if (section && section in SECTION_RANK && SECTION_RANK[section] > SECTION_RANK[reached.current]) reached.current = section;
      }
    });
    root.querySelectorAll('[data-news-section], [id^="nouveautes-corrections-"]').forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [pages.length]);

  return (
    <PlayerPanelFrame contentWidth="42rem" title={t("news.title")} back leaving={leaving}>
      <div ref={rootRef} className="mx-auto w-full max-w-2xl pb-6 pt-2">
        {isLoading && !data ? (
          <LoadingState />
        ) : error && !data ? (
          <ErrorState message={t("news.loadError")} onRetry={() => mutate()} />
        ) : !latest ? (
          <p className="py-10 text-center text-sm text-muted">{t("news.empty")}</p>
        ) : (
          <>
            <PageBlock page={latest} locale={locale} />
            {older.length > 0 && (
              <div className="mt-12" data-news-section="historique">
                <NewsSectionTitle>{t("news.history")}</NewsSectionTitle>
                <div className="flex flex-col gap-3">
                  {older.map((page) => (
                    <OlderPage key={page.id} page={page} locale={locale} initiallyOpen={page.id === target} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </PlayerPanelFrame>
  );
}

function PageBlock({ page, locale }: { page: NewsPageView; locale: string }) {
  const t = useT();
  const content = contentFor(page.content, locale);
  return (
    <article>
      <header className="mb-6" data-news-section="nouveautés">
        <p className="font-display text-2xl font-semibold text-white">{t("news.subtitle", { version: page.version })}</p>
        <p className="mt-1 text-xs text-subtle">{t("news.publishedOn", { date: publishedOn(page, locale) })}</p>
      </header>
      <NewsContentView content={content} fixesId={fixesAnchor(page.id)} />
    </article>
  );
}

function OlderPage({ page, locale, initiallyOpen }: { page: NewsPageView; locale: string; initiallyOpen: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <div className="rounded-2xl bg-white/4 ring-1 ring-inset ring-white/8">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left sm:px-5"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-white">{t("news.subtitle", { version: page.version })}</span>
          <span className="mt-0.5 block text-xs text-subtle">{t("news.publishedOn", { date: publishedOn(page, locale) })}</span>
        </span>
        <ChevronDown size={16} aria-hidden className={`shrink-0 text-subtle transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="border-t border-white/8 px-4 py-5 sm:px-5">
          <NewsContentView content={contentFor(page.content, locale)} fixesId={fixesAnchor(page.id)} />
        </div>
      )}
    </div>
  );
}

function publishedOn(page: NewsPageView, locale: string): string {
  return new Date(page.publishedAt).toLocaleDateString(getDateLocale(locale), { day: "numeric", month: "long", year: "numeric" });
}
