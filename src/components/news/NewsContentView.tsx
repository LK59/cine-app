"use client";

import { ChevronRight, Wrench } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { continuesTitle, hasFixes, joinContinuation, type NewsContent, type NewsEntry } from "@/lib/news/content";
import { NEWS_ICON_COMPONENTS } from "./newsIcons";

/**
 * Le contenu d'une page de Nouveautés — le même dessin dans la fenêtre et dans Compte → Nouveautés
 * (DECISIONS.md §73), pour que ce qu'on retrouve dans le Compte soit bien ce qu'on a vu.
 *
 * Une entrée : une icône au trait dans un carré de verre, un titre en gras, une phrase courte. Les
 * titres de section en petites capitales discrètes. Rien d'autre — pas d'emoji, pas d'image : la
 * fenêtre doit se lire en dix secondes.
 */

/** Un titre de section, en petites capitales. */
export function NewsSectionTitle({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <h3 id={id} className="mb-3.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-subtle">
      {children}
    </h3>
  );
}

function EntryIcon({ icon: Icon }: { icon: React.ElementType }) {
  return (
    <span aria-hidden className="mt-px flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.07] text-white/85 ring-1 ring-inset ring-white/10">
      <Icon size={18} strokeWidth={1.75} />
    </span>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="ml-1.5 inline-block translate-y-[-1px] rounded-full bg-accent-500/20 px-1.5 py-px align-middle text-[10px] font-semibold uppercase tracking-wide text-accent-400">
      {children}
    </span>
  );
}

/**
 * L'hôte de `link` rendu cliquable là où il paraît dans un texte de l'entrée — l'adresse s'ouvre dans
 * une nouvelle fenêtre (depuis l'application installée, le navigateur), le reste du texte inchangé.
 */
function withLink(text: string, link: string | undefined): React.ReactNode {
  if (!link) return text;
  const host = new URL(link).host;
  const parts = text.split(host);
  if (parts.length === 1) return text;
  return parts.flatMap((part, i) =>
    i === 0
      ? [part]
      : [
          <a key={i} href={link} target="_blank" rel="noopener noreferrer" className="underline decoration-white/40 underline-offset-2 hover:decoration-white">
            {host}
          </a>,
          part,
        ],
  );
}

export function NewsEntryRow({ entry }: { entry: NewsEntry }) {
  const inline = continuesTitle(entry.text);
  return (
    <li className="flex gap-3.5">
      <EntryIcon icon={NEWS_ICON_COMPONENTS[entry.icon]} />
      <p className="min-w-0 pt-[7px] text-[15px] leading-snug text-white/75">
        <strong className="font-semibold text-white">{withLink(entry.title, entry.link)}</strong>
        {entry.badge && <Badge>{entry.badge}</Badge>}
        {inline && entry.text ? withLink(joinContinuation(entry.text), entry.link) : null}
        {!inline && entry.text && <span className="mt-1 block text-[14px] leading-snug text-muted">{withLink(entry.text, entry.link)}</span>}
      </p>
    </li>
  );
}

/**
 * Les sections d'une page. `onSeeMore` : la fenêtre — l'entrée « Optimisations et corrections de
 * bugs » porte « Voir plus › » ; sans lui (la page Compte), la liste complète est déroulée dessous,
 * sous l'ancre `fixesId`.
 */
export function NewsContentView({
  content,
  onSeeMore,
  fixesId,
}: {
  content: NewsContent;
  onSeeMore?: () => void;
  fixesId?: string;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-7">
      {content.sections.map((section, i) => (
        <section key={`${i}:${section.title}`}>
          {section.title && <NewsSectionTitle>{section.title}</NewsSectionTitle>}
          <ul className="flex flex-col gap-4">
            {section.entries.map((entry, j) => (
              <NewsEntryRow key={`${j}:${entry.title}`} entry={entry} />
            ))}
          </ul>
        </section>
      ))}
      {hasFixes(content) && (
        <section>
          <NewsSectionTitle>{t("news.improvements")}</NewsSectionTitle>
          <div className="flex gap-3.5">
            <EntryIcon icon={Wrench} />
            <div className="min-w-0 flex-1 pt-[7px] text-[15px] leading-snug">
              <p className="font-semibold text-white">{t("news.fixesTitle")}</p>
              {content.fixesSummary && <p className="mt-1 text-[14px] text-muted">{content.fixesSummary}</p>}
              {onSeeMore && content.fixes.length > 0 && (
                <button
                  type="button"
                  onClick={onSeeMore}
                  className="-mx-2 mt-1.5 inline-flex items-center gap-0.5 rounded-lg px-2 py-1 text-[14px] font-medium text-accent-400 transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-accent-400"
                >
                  {t("news.seeMore")}
                  <ChevronRight size={15} aria-hidden />
                </button>
              )}
            </div>
          </div>
          {!onSeeMore && content.fixes.length > 0 && (
            <div id={fixesId} className="mt-5 flex scroll-mt-24 flex-col gap-5 rounded-2xl bg-white/[0.04] px-4 py-4 ring-1 ring-inset ring-white/8 sm:px-5">
              {content.fixes.map((group, i) => (
                <div key={`${i}:${group.title}`}>
                  {group.title && <h4 className="mb-2 text-sm font-semibold text-white">{group.title}</h4>}
                  <ul className="flex flex-col gap-1.5">
                    {group.items.map((item, j) => (
                      <li key={j} className="flex gap-2.5 text-[14px] leading-snug text-white/75">
                        <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-white/35" />
                        <span className="min-w-0">{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
